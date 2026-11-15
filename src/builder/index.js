// Сборка приложения Qlik из spec.json: приложение → загрузка → мастер-элементы → объекты → листы.
const { withSession, deleteAppsByName } = require('../engine');
const { generateScript } = require('../qvs-generator');
const qrs = require('../qrs');
const objects = require('./objects');
const archetypes = require('./archetypes');
const T = require('./templates');

// Диагноз после неудачного reload: поля, которые нужны мерам/измерениям,
// против полей, реально появившихся в модели. Текст уходит в ИИ на самоисправление.
async function diagnoseReloadFailure(app, spec) {
  const present = new Set();
  try {
    const res = await app.getFields();
    for (const f of (res && res.qFields) || []) present.add(String(f.qName).toLowerCase());
  } catch (_) { /* модель пуста — не критично для диагноза */ }
  const needed = new Set();
  const QLIK_WORDS = new Set(['sum', 'count', 'distinct', 'avg', 'min', 'max', 'only', 'if', 'aggr', 'num', 'date', 'month', 'year', 'quarter', 'week', 'day', 'floor', 'ceil', 'round', 'and', 'or', 'not', 'total']);
  const addFromFormula = text => {
    const clean = String(text || '').replace(/'[^']*'|"[^"]*"/g, "''");
    for (const b of clean.match(/\[([^\]]+)\]/g) || []) needed.add(b.slice(1, -1).toLowerCase());
    for (const id of clean.match(/[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*/g) || []) {
      const lid = id.toLowerCase();
      if (!QLIK_WORDS.has(lid)) needed.add(lid); // функции Qlik (sum, count…) — не поля, шум из диагноза убираем
    }
  };
  for (const m of spec.measures || []) addFromFormula(m.formula);
  for (const d of spec.dimensions || []) if (d.field) needed.add(String(d.field).toLowerCase());
  const missing = [...needed].filter(f => !present.has(f));
  if (missing.length) {
    return `Загрузка не прошла. В модели нет полей: ${missing.join(', ')}. ` +
      `Полей в модели: ${present.size ? [...present].join(', ') : 'ни одного (таблица не создалась)'}. ` +
      `Проверьте, что формулы мер и поля измерений используют только колонки из source.fields.`;
  }
  return 'Загрузка не прошла без расхождений по полям — вероятно, проблема в типе данных или синтаксисе скрипта.';
}

// build(spec, cfg, log) → { appId, appName, objects: [{id, type, title}], sheets: n }
// log — куда пишется журнал сборки (консоль CLI или интерфейс)
async function build(spec, cfg, log = console.log) {
  // Базовый макет: spec.design.layout + design.fill → готовые sheets с позициями слотов
  if (spec.design && spec.design.layout) spec = archetypes.applyLayout(spec, log);
  return withSession(cfg, async global => {
    const removed = await deleteAppsByName(global, spec.appName);
    if (removed.length) log('Удалено старых приложений с тем же именем: ' + removed.length);

    const created = await global.createApp(spec.appName);
    let app = await global.openDoc(created.qAppId);
    log('Приложение создано: ' + created.qAppId);

    await app.setScript(generateScript(spec));

    // Перезагрузка: сначала обычный doReload; на серверах со стандартным режимом
    // движка он мгновенно возвращает false — тогда QRS-задача (cfg.reload: 'qrs' — сразу задача).
    let reloaded = false;
    if ((cfg.reload || 'auto') !== 'qrs') reloaded = await app.doReload(0, false, false);
    if (!reloaded) {
      log('doReload недоступен (стандартный режим движка) — перезагрузка через QRS-задачу…');
      await app.doSave(); // задача читает скрипт из сохранённого приложения
      const taskId = await qrs.createReloadTask(cfg, created.qAppId, 'Dashgen reload — ' + spec.appName);
      let res;
      try {
        await qrs.startTask(cfg, taskId);
        res = await qrs.waitForTask(cfg, taskId, { timeoutMin: cfg.reloadTimeoutMin || 30 });
      } finally {
        await qrs.deleteReloadTask(cfg, taskId); // задача одноразовая
      }
      if (!res.ok) {
        const tail = (res.messages || []).filter(Boolean).slice(-4).join('\n');
        const diagnosis = tail || await diagnoseReloadFailure(app, spec);
        const err = new Error('QRS-перезагрузка не удалась (status=' + res.status + '): ' + diagnosis.split('\n')[0]);
        err.qlikReloadFailure = true;
        err.diagnosis = diagnosis;
        throw err;
      }
      log('Данные загружены (QRS-задача)');
      app = await global.openDoc(created.qAppId); // свежий хэндл после внешней перезагрузки
    } else {
      log('Данные загружены');
    }

    const dimMap = {}, meaMap = {};
    for (const d of spec.dimensions || []) dimMap[d.id] = await objects.createMasterDimension(app, d);
    for (const m of spec.measures || []) meaMap[m.id] = await objects.createMasterMeasure(app, m);
    log('Мастер-элементы: измерений ' + Object.keys(dimMap).length + ', мер ' + Object.keys(meaMap).length);

    const createdObjects = [];
    for (let si = 0; si < spec.sheets.length; si++) {
      const sheet = spec.sheets[si];
      const cells = [];
      for (const ospec of sheet.objects) {
        const { id } = await objects.createObjectBySpec(app, ospec, dimMap, meaMap);
        createdObjects.push({ id, type: ospec.type, title: ospec.title || '' });
        const [dc, dr] = T.DEFAULT_SIZE[ospec.type] || [4, 3];
        cells.push(T.cell(id, ospec.type, ospec.col, ospec.row, ospec.colspan || dc, ospec.rowspan || dr));
      }
      await app.createObject({
        qInfo: { qType: 'sheet' },
        qMetaDef: { title: sheet.title, description: sheet.description || '' },
        rank: si + 1, thumbnail: { qStaticContentUrlDef: {} },
        columns: T.GRID_COLS, rows: T.GRID_ROWS,
        cells,
        qChildListDef: { qData: { title: '/qMetaDef/title' } }
      });
      log('Лист «' + sheet.title + '»: объектов ' + cells.length);
    }

    await app.doSave();
    log('Готово. Приложение «' + spec.appName + '» (ID ' + created.qAppId + ') в Hub → Work.');
    return { appId: created.qAppId, appName: spec.appName, objects: createdObjects, sheets: spec.sheets.length };
  });
}

module.exports = { build };
