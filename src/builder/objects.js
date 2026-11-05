// Создание объектов Qlik по элементам spec: мастер-элементы и визуализации.
// Свойства отображения берутся из шаблонов: базовые 5 типов — из templates.js (проверены),
// новые типы (piechart, scatterplot, treemap…) — из снятых слепков клиента templates/*.json.
const fs = require('fs');
const path = require('path');
const T = require('./templates');

const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'templates');

// Шаблон клиента для типа: templates/<тип>.json (снят extract-templates.js) или null
function loadTemplate(type) {
  const fp = path.join(TEMPLATE_DIR, type + '.json');
  if (!fs.existsSync(fp)) return null;
  try {
    const t = JSON.parse(fs.readFileSync(fp, 'utf8'));
    delete t.qInfo; // id и тип задаёт сборщик
    return t;
  } catch (_) { return null; }
}

// HyperCube из spec для шаблонных типов (dims/меры — library-ссылки)
function buildHypercube(ospec, dimMap, meaMap) {
  const dims = (ospec.dimensions || (ospec.dimension ? [ospec.dimension] : []))
    .map(did => ({ qLibraryId: dimMap[did], qDef: {} }));
  const meas = (ospec.measures || []).map(mid => meaMap[mid])
    .filter(Boolean).map(id => ({ qLibraryId: id, qDef: {} }));
  const total = dims.length + meas.length;
  return {
    qDimensions: dims,
    qMeasures: meas,
    qInterColumnSortOrder: Array.from({ length: total }, (_, i) => i),
    qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: Math.max(total, 1), qHeight: ospec.type === 'scatterplot' ? 3333 : 100 }]
  };
}

// Создание по снятому шаблону: свойства клиента (цвета, оси, легенда) — из слепка,
// данные и заголовок — из spec. Если шаблона нет — ошибка с подсказкой.
async function createFromTemplate(app, ospec, dimMap, meaMap) {
  const template = loadTemplate(ospec.type);
  if (!template) {
    throw new Error(`для типа «${ospec.type}» нет снятого шаблона templates/${ospec.type}.json — прогоните scripts/extract-templates.js`);
  }
  return app.createObject({
    ...template,
    qInfo: { qType: ospec.type },
    visualization: ospec.type,
    showTitles: true,
    title: ospec.title || '',
    qHyperCubeDef: buildHypercube(ospec, dimMap, meaMap)
  });
}

function ref(map, id, kind) {
  if (!map[id]) throw new Error('spec ссылается на несуществующий ' + kind + ': ' + id);
  return map[id];
}

const mea = id => ({ qLibraryId: id, qDef: {} });
const dim = (field, label) => ({ qDef: { qFieldDefs: [field], qFieldLabels: [label] } });

// ── Мастер-элементы ──
async function createMasterDimension(app, d) {
  const obj = await app.createDimension({
    qInfo: { qType: 'dimension' },
    qDim: { qGrouping: 'N', qFieldDefs: [d.field], qFieldLabels: [d.title], title: d.title },
    qMetaDef: { title: d.title }
  });
  return obj.id;
}

async function createMasterMeasure(app, m) {
  const numFormat = m.format ? { ...T.numFmt, qFmt: m.format } : T.numFmt;
  const obj = await app.createMeasure({
    qInfo: { qType: 'measure' },
    qMeasure: { qLabel: m.title, qDef: m.formula, qNumFormat: numFormat },
    qMetaDef: { title: m.title }
  });
  return obj.id;
}

// ── Визуализации ──
async function createKpi(app, ospec, meaMap) {
  const id = ref(meaMap, ospec.measure, 'меру');
  return app.createObject({
    qInfo: { qType: 'kpi' }, visualization: 'kpi', showTitles: false, title: ospec.title || '',
    qHyperCubeDef: {
      qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 1, qHeight: 1 }],
      qMeasures: [mea(id)]
    }
  });
}

async function createLine(app, ospec, dimMap, meaMap) {
  const dimId = ref(dimMap, ospec.dimension, 'измерение');
  return app.createObject(T.withDefaults(T.LINE_DEFAULTS, {
    qInfo: { qType: 'linechart' }, visualization: 'linechart', showTitles: true, title: ospec.title || '',
    qHyperCubeDef: {
      qDimensions: [{ qLibraryId: dimId, qDef: { qSortCriterias: [{ qSortByNumeric: 1 }] } }],
      qMeasures: ospec.measures.map(mid => mea(ref(meaMap, mid, 'меру'))),
      qInterColumnSortOrder: [0, ...ospec.measures.map((_, i) => i + 1)],
      qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 1 + ospec.measures.length, qHeight: 100 }]
    }
  }));
}

async function createBar(app, ospec, dimMap, meaMap) {
  const dimId = ref(dimMap, ospec.dimension, 'измерение');
  return app.createObject(T.withDefaults(T.BAR_DEFAULTS, {
    qInfo: { qType: 'barchart' }, visualization: 'barchart', showTitles: true, title: ospec.title || '',
    qHyperCubeDef: {
      qDimensions: [{ qLibraryId: dimId, qDef: {} }],
      qMeasures: ospec.measures.map(mid => mea(ref(meaMap, mid, 'меру'))),
      qInterColumnSortOrder: [1, 0],
      qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 1 + ospec.measures.length, qHeight: 50 }]
    }
  }));
}

async function createTable(app, ospec, dimMap, meaMap) {
  const dims = ospec.dimensions.map(did => {
    const d = dimMap[did];
    if (!d) throw new Error('spec ссылается на несуществующее измерение: ' + did);
    return { qLibraryId: d, qDef: {} };
  });
  const meas = ospec.measures.map(mid => mea(ref(meaMap, mid, 'меру')));
  const total = dims.length + meas.length;
  return app.createObject(T.withDefaults(T.TABLE_DEFAULTS, {
    qInfo: { qType: 'table' }, visualization: 'table', showTitles: true, title: ospec.title || '',
    qHyperCubeDef: {
      qDimensions: dims, qMeasures: meas,
      qInterColumnSortOrder: Array.from({ length: total }, (_, i) => i),
      columnOrder: Array.from({ length: total }, (_, i) => i),
      columnWidths: Array.from({ length: total }, () => -1),
      qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: total, qHeight: 100 }]
    }
  }));
}

async function createListbox(app, ospec) {
  return app.createObject({
    qInfo: { qType: 'listbox' }, visualization: 'listbox', showTitles: true, title: ospec.title || ospec.field,
    qListObjectDef: {
      qDef: { qFieldDefs: [ospec.field], qSortCriterias: [{ qSortByAscii: 1 }] },
      qShowAlternatives: true, frequencyMode: 'N',
      qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 1, qHeight: 100 }]
    }
  });
}

// createObjectBySpec(app, ospec, dimMap, meaMap) → { id }
async function createObjectBySpec(app, ospec, dimMap, meaMap) {
  let obj;
  switch (ospec.type) {
    case 'kpi': obj = await createKpi(app, ospec, meaMap); break;
    case 'linechart': obj = await createLine(app, ospec, dimMap, meaMap); break;
    case 'barchart': obj = await createBar(app, ospec, dimMap, meaMap); break;
    case 'table': obj = await createTable(app, ospec, dimMap, meaMap); break;
    case 'listbox': obj = await createListbox(app, ospec); break;
    // Типы из снятых шаблонов клиента (templates/<тип>.json):
    case 'piechart':
    case 'scatterplot':
    case 'combochart':
    case 'treemap':
    case 'gauge':
    case 'pivot-table':
      obj = await createFromTemplate(app, ospec, dimMap, meaMap); break;
    default: throw new Error('Неизвестный тип объекта: ' + ospec.type + ' (в spec v1 разрешены: kpi, linechart, barchart, table, listbox, piechart, scatterplot, combochart, treemap, gauge, pivot-table)');
  }
  return { id: obj.id };
}

module.exports = { createMasterDimension, createMasterMeasure, createObjectBySpec };
