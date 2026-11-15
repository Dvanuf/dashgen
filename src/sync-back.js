// «Зафиксировать с приложения»: правки, сделанные вручную в Qlik-клиенте,
// перечитываются в spec.json и помечаются fixed — перегенерация ИИ и
// пересборка их не теряют. После фиксации spec.sheets — источник истины,
// поэтому design.layout из спеки убирается (позиции теперь явные).
const { withSession, openAppById } = require('./engine');
const { normalizeSpecSources } = require('./spec-validator');
const { listMasterRefs } = require('./builder/objects');

const VIZ_TYPES = ['barchart', 'linechart', 'combochart', 'piechart', 'kpi', 'table', 'pivot-table',
  'gauge', 'listbox', 'scatterplot', 'treemap'];

const slug = s => String(s || 'obj')
  .toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'obj';

// Список мастер-элементов приложения: [{qId, title, field, formula, format}]
// (перечисление через session-объекты DimensionList/MeasureList; свойства — по qId)
async function listMasters(app, kind) {
  const refs = await listMasterRefs(app, kind);
  const out = [];
  for (const r of refs) {
    const m = { qId: r.qId, title: r.title };
    try {
      const o = await app.getObject(r.qId);
      const p = await o.getProperties();
      if (p.qDim && Array.isArray(p.qDim.qFieldDefs) && p.qDim.qFieldDefs.length) m.field = p.qDim.qFieldDefs[0];
      if (p.qMeasure && p.qMeasure.qDef) { m.formula = p.qMeasure.qDef; m.format = p.qMeasure.qNumFormat && p.qMeasure.qNumFormat.qFmt; }
    } catch (_) { /* заголовка достаточно */ }
    out.push(m);
  }
  return out;
}

// resolveRef(libId, masters, specList, used) → id в спеке:
// мастер-элемент по qLibraryId → берём его название и ищем/добавляем в spec.
function resolveRef(libId, masters, specList, used) {
  const m = masters.find(x => x.qId === libId);
  if (!m) return null;
  const title = m.title;
  let item = specList.find(x => x.title === title);
  if (!item) {
    let id = slug(title);
    while (used.has(id)) id = id + '_' + (used.size + 1);
    used.add(id);
    item = { id, title };
    if (m.field) item.field = m.field;
    if (m.formula) item.formula = m.formula;
    if (m.format) item.format = m.format;
    specList.push(item);
  }
  return item.id;
}

// syncBack(cfg, appId, spec, log) → { spec, stats }
async function syncBack(cfg, appId, specIn, log = () => {}) {
  let spec = JSON.parse(JSON.stringify(specIn));
  spec = normalizeSpecSources(spec);
  if (!Array.isArray(spec.measures)) spec.measures = [];
  if (!Array.isArray(spec.dimensions)) spec.dimensions = [];

  return withSession(cfg, async global => {
    const app = await openAppById(global, appId);
    // мастер-элементы приложения: qLibraryId объектов → id/названия спеки
    const dimMasters = await listMasters(app, 'DimensionList');
    const meaMasters = await listMasters(app, 'MeasureList');
    const usedDim = new Set(spec.dimensions.map(d => d.id));
    const usedMea = new Set(spec.measures.map(m => m.id));

    const sheets = await app.getObjects({ qTypes: ['sheet'], qData: { title: '/qMetaDef/title' } });
    const outSheets = [];
    const stats = { sheets: 0, objects: 0, skipped: 0 };

    for (const s of sheets) {
      const sheetObj = await app.getObject(s.qInfo.qId);
      const sProp = await sheetObj.getProperties();
      const sheetTitle = (sProp.qMetaDef && sProp.qMetaDef.title) || '';
      const lo = await sheetObj.getLayout();
      // Dashgen-объекты корневые — на листе их находим по cells[].name
      const objects = [];
      for (const cell of lo.cells || []) {
        const o = await app.getObject(cell.name);
        const p = await o.getProperties();
        const type = p.qInfo && p.qInfo.qType;
        if (!VIZ_TYPES.includes(type)) continue; // служебные (инжекторы тем) не переносим
        const ospec = {
          type,
          title: (p.qMetaDef && p.qMetaDef.title) || p.title || '',
          col: cell.col ?? 0, row: cell.row ?? 0,
          colspan: cell.colspan ?? 6, rowspan: cell.rowspan ?? 3,
          fixed: true
        };
        let ok = true;
        const hc = p.qHyperCubeDef;
        if (['kpi', 'gauge'].includes(type)) {
          const lib = hc && hc.qMeasures && hc.qMeasures[0] && hc.qMeasures[0].qLibraryId;
          const id = lib ? resolveRef(lib, meaMasters, spec.measures, usedMea) : null;
          if (!id) ok = false; else ospec.measure = id;
        } else if (type === 'listbox') {
          const fd = p.qListObjectDef && p.qListObjectDef.qDef && p.qListObjectDef.qDef.qFieldDefs;
          if (!fd || !fd.length) ok = false; else ospec.field = fd[0];
        } else if (['barchart', 'linechart', 'combochart', 'piechart', 'scatterplot', 'treemap'].includes(type)) {
          const dimLib = hc && hc.qDimensions && hc.qDimensions[0] && hc.qDimensions[0].qLibraryId;
          const did = dimLib ? resolveRef(dimLib, dimMasters, spec.dimensions, usedDim) : null;
          const mid = ((hc && hc.qMeasures) || [])
            .map(x => x.qLibraryId ? resolveRef(x.qLibraryId, meaMasters, spec.measures, usedMea) : null)
            .filter(Boolean);
          if (!did || !mid.length) ok = false; else { ospec.dimension = did; ospec.measures = mid; }
        } else if (['table', 'pivot-table'].includes(type)) {
          const dims = ((hc && hc.qDimensions) || [])
            .map(x => x.qLibraryId ? resolveRef(x.qLibraryId, dimMasters, spec.dimensions, usedDim) : null)
            .filter(Boolean);
          const meas = ((hc && hc.qMeasures) || [])
            .map(x => x.qLibraryId ? resolveRef(x.qLibraryId, meaMasters, spec.measures, usedMea) : null)
            .filter(Boolean);
          if (!dims.length || !meas.length) ok = false; else { ospec.dimensions = dims; ospec.measures = meas; }
        }
        if (!ok) { log('  пропущен (нет ссылок на мастер-элементы): ' + type + ' «' + ospec.title + '»'); stats.skipped++; continue; }
        objects.push(ospec);
        stats.objects++;
      }
      if (objects.length) {
        outSheets.push({ title: sheetTitle || ('Лист ' + (outSheets.length + 1)), objects });
        stats.sheets++;
      }
    }

    if (!outSheets.length) throw new Error('в приложении не найдено листов с переносимыми объектами');
    spec.sheets = outSheets;
    if (spec.design) delete spec.design.layout; // позиции теперь явные: макет больше не управляет листами
    log('Зафиксировано: листов ' + stats.sheets + ', объектов ' + stats.objects +
      (stats.skipped ? ', пропущено ' + stats.skipped : '') + ' — все с fixed:true');
    return { spec, stats };
  });
}

module.exports = { syncBack };
