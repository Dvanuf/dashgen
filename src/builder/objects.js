// Создание объектов Qlik по элементам spec: мастер-элементы и визуализации.
// Свойства отображения берутся из шаблонов (templates.js), данные — из spec.
const T = require('./templates');

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
    default: throw new Error('Неизвестный тип объекта: ' + ospec.type);
  }
  return { id: obj.id };
}

module.exports = { createMasterDimension, createMasterMeasure, createObjectBySpec };
