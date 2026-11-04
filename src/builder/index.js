// Сборка приложения Qlik из spec.json: приложение → загрузка → мастер-элементы → объекты → листы.
const { withSession, deleteAppsByName } = require('../engine');
const { generateScript } = require('../qvs-generator');
const objects = require('./objects');
const T = require('./templates');

// build(spec, cfg, log) → { appId, appName, objects: [{id, type, title}], sheets: n }
// log — куда пишется журнал сборки (консоль CLI или интерфейс)
async function build(spec, cfg, log = console.log) {
  return withSession(cfg, async global => {
    const removed = await deleteAppsByName(global, spec.appName);
    if (removed.length) log('Удалено старых приложений с тем же именем: ' + removed.length);

    const created = await global.createApp(spec.appName);
    const app = await global.openDoc(created.qAppId);
    log('Приложение создано: ' + created.qAppId);

    await app.setScript(generateScript(spec));
    if (!(await app.doReload(0, false, false))) {
      throw new Error('Загрузка данных не прошла — проверьте скрипт и источник');
    }
    log('Данные загружены');

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
