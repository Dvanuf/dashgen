// Сборка приложения Qlik из spec.json: приложение → загрузка → мастер-элементы → объекты → листы.
// Два режима:
//   create (по умолчанию) — новое приложение, старое с тем же именем удаляется;
//   attach — подключение к существующему дашборду БЕЗ удаления: обновляются только
//            листы/объекты из спеки (reconcile), остальные листы и ручные правки живут.
const { withSession, deleteAppsByName } = require('../engine');
const { generateScript } = require('../qvs-generator');
const qrs = require('../qrs');
const objects = require('./objects');
const archetypes = require('./archetypes');
const brand = require('./brand');
const T = require('./templates');

const VIZ_TYPES = ['barchart', 'linechart', 'combochart', 'piechart', 'kpi', 'table', 'pivot-table',
  'gauge', 'text', 'filterpane', 'listbox', 'scatterplot', 'treemap', 'map', 'container',
  'sl-logo', 'sl-info', 'sl-theme-light'];

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
    const clean = String(text || '').replace(/'[^']*'|"[^']*"/g, "''");
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

// Перезагрузка: doReload, а при отказе (стандартный режим движка) — одноразовая QRS-задача.
// Скрипт должен быть уже установлен. Возвращает свежий хэндл приложения.
async function reloadApp(app, global, appId, cfg, spec, log) {
  let reloaded = false;
  if ((cfg.reload || 'auto') !== 'qrs') reloaded = await app.doReload(0, false, false);
  if (reloaded) { log('Данные загружены'); return app; }
  log('doReload недоступен (стандартный режим движка) — перезагрузка через QRS-задачу…');
  await app.doSave(); // задача читает скрипт из сохранённого приложения
  const taskId = await qrs.createReloadTask(cfg, appId, 'Dashgen reload — ' + spec.appName);
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
  return global.openDoc(appId); // свежий хэндл после внешней перезагрузки
}

// attach: id или имя приложения → id (имя ищется через QRS)
async function resolveTarget(cfg, target) {
  if (!target) throw new Error('attach: укажите приложение — --app <id|имя>');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)) return target;
  const found = await qrs.findAppByName(cfg, target);
  if (!found) throw new Error('приложение с именем «' + target + '» не найдено (QRS)');
  return found.id;
}

// attach: синхронизация листов по спеке — листы с целевыми названиями удаляются
// (создадутся заново), остальные листы и ручные правки не трогаются; сироты чистятся.
// ВАЖНО: Dashgen создаёт объекты КОРНЕВЫМИ (не детьми листа) — клиент рендерит их по
// cells[].name, а getChildInfos листа пуст. «Прикреплённые» = имена из cells всех листов.
async function reconcileSheets(app, spec, log) {
  const titles = new Set(spec.sheets.map(s => s.title));
  const existing = await app.getObjects({ qTypes: ['sheet'], qData: { title: '/qMetaDef/title' } });
  let removed = 0;
  for (const s of existing) {
    const o = await app.getObject(s.qInfo.qId);
    const p = await o.getProperties();
    const title = (p.qMetaDef && p.qMetaDef.title) || p.title || '';
    if (titles.has(title)) { await app.destroyObject(s.qInfo.qId); removed++; }
  }
  if (removed) log('Reconcile: удалено листов с целевыми названиями: ' + removed);

  const attached = new Set();
  for (const s of await app.getObjects({ qTypes: ['sheet'], qData: {} })) {
    const sh = await app.getObject(s.qInfo.qId);
    const lo = await sh.getLayout();
    (lo.cells || []).forEach(c => attached.add(c.name));
  }
  const all = await app.getObjects({ qTypes: VIZ_TYPES, qData: {} });
  let orphans = 0;
  for (const o of all) {
    if (attached.has(o.qInfo.qId)) continue;
    try { await app.destroyObject(o.qInfo.qId); orphans++; } catch (_) { /* не критично */ }
  }
  if (orphans) log('Reconcile: удалено осиротевших объектов прошлых сборок: ' + orphans);
}

// build(spec, cfg, log, opts) → { appId, appName, objects: [{id, type, title}], sheets: n }
// opts: { mode: 'create'|'attach', target: <id|имя> (attach), noReload: true }
// log — куда пишется журнал сборки (консоль CLI или интерфейс)
async function build(spec, cfg, log = console.log, opts = {}) {
  const mode = opts.mode === 'attach' ? 'attach' : 'create';
  // Бренд-пак: расширения оформления загружаются через QRS идемпотентно (до сборки)
  const isSunlight = !!(spec.design && spec.design.brand === 'sunlight');
  if (isSunlight) await brand.ensureExtensions(cfg, log);
  // Базовый макет: spec.design.layout + design.fill → готовые sheets с позициями слотов
  if (spec.design && spec.design.layout) spec = archetypes.applyLayout(spec, log);
  if (!Array.isArray(spec.sheets) || !spec.sheets.length) throw new Error('в spec нет листов (sheets или design.layout)');
  return withSession(cfg, async global => {
    let appId, app;
    if (mode === 'attach') {
      appId = await resolveTarget(cfg, opts.target);
      app = await global.openDoc(appId);
      log('Подключено к существующему приложению: ' + appId);
      await reconcileSheets(app, spec, log);
    } else {
      const removed = await deleteAppsByName(global, spec.appName);
      if (removed.length) log('Удалено старых приложений с тем же именем: ' + removed.length);
      const created = await global.createApp(spec.appName);
      appId = created.qAppId;
      app = await global.openDoc(appId);
      log('Приложение создано: ' + appId);
    }

    if (!opts.noReload) {
      await app.setScript(generateScript(spec));
      app = await reloadApp(app, global, appId, cfg, spec, log);
    } else {
      log('Перезагрузка пропущена (no-reload): правим оформление на текущих данных');
    }

    const { dimMap, meaMap } = await objects.resolveMasters(app, spec, log);

    // Инжектор light-темы бренда: корневой объект, ячейка в правом нижнем углу последнего листа
    let injectorId = null;
    if (isSunlight) {
      const inj = await app.createObject(brand.themeInjectorProps());
      injectorId = inj.id;
    }

    const createdObjects = [];
    for (let si = 0; si < spec.sheets.length; si++) {
      const sheet = spec.sheets[si];
      const cells = [];
      for (const ospec of sheet.objects) {
        const { id } = await objects.createObjectBySpec(app, ospec, dimMap, meaMap, isSunlight);
        createdObjects.push({ id, type: ospec.type, title: ospec.title || '' });
        const [dc, dr] = T.DEFAULT_SIZE[ospec.type] || [4, 3];
        cells.push(T.cell(id, ospec.type, ospec.col, ospec.row, ospec.colspan || dc, ospec.rowspan || dr));
      }
      if (isSunlight && injectorId && si === spec.sheets.length - 1) {
        cells.push(T.cell(injectorId, 'sl-theme-light', T.GRID_COLS - 1, T.GRID_ROWS - 1, 1, 1));
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
    const name = mode === 'attach' ? (opts.target || spec.appName) : spec.appName;
    log('Готово. Приложение «' + name + '» (ID ' + appId + ') в Hub → Work.');
    return { appId, appName: name, objects: createdObjects, sheets: spec.sheets.length, mode, appliedSpec: spec };
  });
}

module.exports = { build, reconcileSheets };
