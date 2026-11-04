const enigma = require('enigma.js');
const WebSocket = require('ws');
const fs = require('fs');
const schema = require('enigma.js/schemas/12.612.0.json');

const src = fs.readFileSync(__dirname + '/build_test_dashboard.js', 'utf8');
const CONFIG = eval('(' + src.match(/const CONFIG = (\{[\s\S]*?\});/)[1] + ')');
const LOAD_SCRIPT = src.match(/const LOAD_SCRIPT = `([\s\S]*?)`;/)[1];

const VER = '1.39.8';
const BASE = {
  script: '', filter: null, refLine: { refLines: [], dimRefLines: [] }, plugins: [],
  subtitle: '', footnote: '', disableNavMenu: false, showDetails: true,
  showDetailsExpression: false, showDisclaimer: true, components: [], version: VER
};
const CHART = {
  ...BASE,
  gridLine: { auto: true, spacing: 2 },
  dataPoint: { showLabels: false, showSegmentLabels: false, showTotalLabels: true },
  color: {
    auto: true, mode: 'primary', formatting: { numFormatFromTemplate: true }, useBaseColors: 'off',
    paletteColor: { index: 6 }, useDimColVal: true, useMeasureGradient: true, persistent: false,
    expressionIsColor: true, expressionLabel: '', measureScheme: 'sg', reverseScheme: false,
    dimensionScheme: '12', autoMinMax: true, measureMin: 0, measureMax: 10
  },
  legend: { show: true, dock: 'auto', showTitle: true },
  dimensionAxis: { continuousAuto: true, show: 'all', label: 'auto', dock: 'near', axisDisplayMode: 'auto', maxVisibleItems: 10 },
  preferContinuousAxis: true,
  measureAxis: { show: 'all', dock: 'near', spacing: 1, autoMinMax: true, minMax: 'min', min: 0, max: 10 },
  tooltip: { auto: true, hideBasic: false, chart: { style: { size: 'medium' } }, data: {} },
  scrollbar: 'miniChart', scrollStartPos: 0, showMiniChartForContinuousAxis: true
};
const BAR_DEFAULTS = { ...CHART, barGrouping: { grouping: 'grouped' }, orientation: 'vertical' };
const LINE_DEFAULTS = { ...CHART, lineType: 'line', nullMode: 'gap' };
const TABLE_DEFAULTS = {
  ...BASE,
  totals: { show: true, position: 'noTotals', label: 'Totals' },
  multiline: { wrapTextInCells: true },
  scrolling: { horizontal: true, keepFirstColumnInView: false, keepFirstColumnInViewTouch: false }
};
const withDefaults = (base, props) => ({ ...JSON.parse(JSON.stringify(base)), ...props });

const numFmt = { qType: 'F', qnDec: 0, qUseThou: 1, qFmt: '# ##0', qDec: ',', qThou: ' ' };
const GRID_COLS = 24, GRID_ROWS = 12;
const cell = (name, type, col, row, colspan, rowspan) => ({
  name, type, col, row, colspan, rowspan,
  bounds: { x: col / GRID_COLS * 100, y: row / GRID_ROWS * 100, width: colspan / GRID_COLS * 100, height: rowspan / GRID_ROWS * 100 }
});

const session = enigma.create({
  schema,
  url: `wss://${CONFIG.host}:${CONFIG.port}/app/engineData`,
  createSocket: url => new WebSocket(url, {
    ca: [fs.readFileSync(`${CONFIG.certDir}/root.pem`)],
    cert: fs.readFileSync(`${CONFIG.certDir}/client.pem`),
    key: fs.readFileSync(`${CONFIG.certDir}/client_key.pem`),
    headers: { 'X-Qlik-User': `UserDirectory=${CONFIG.userDirectory}; UserId=${CONFIG.userId}` },
    rejectUnauthorized: CONFIG.rejectUnauthorized
  })
});

(async () => {
  const global = await session.open();
  const docs = await global.getDocList();
  for (const d of docs.filter(d => d.qDocName === CONFIG.appName)) {
    try { await global.deleteApp(d.qDocId); console.log('Удалено старое приложение', d.qDocId); }
    catch (e) { console.warn('Не удалось удалить:', e.message); }
  }
  const created = await global.createApp(CONFIG.appName);
  const app = await global.openDoc(created.qAppId);
  console.log('Приложение создано:', created.qAppId);

  await app.setScript(LOAD_SCRIPT);
  if (!(await app.doReload(0, false, false))) throw new Error('Загрузка данных не прошла');
  console.log('Данные загружены');

  const mkDim = async (field, title) => app.createDimension({
    qInfo: { qType: 'dimension' },
    qDim: { qGrouping: 'N', qFieldDefs: [field], qFieldLabels: [title], title },
    qMetaDef: { title }
  });
  await mkDim('Region', 'Регион'); await mkDim('Product', 'Товар'); await mkDim('Month', 'Месяц');

  const mkMeasure = async (def, title) => (await app.createMeasure({
    qInfo: { qType: 'measure' },
    qMeasure: { qLabel: title, qDef: def, qNumFormat: numFmt },
    qMetaDef: { title }
  })).id;
  const mRevenue = await mkMeasure('Sum(Amount)', 'Выручка');
  const mOrders = await mkMeasure('Count(DISTINCT OrderID)', 'Заказы');
  const mAvg = await mkMeasure('Sum(Amount) / Count(DISTINCT OrderID)', 'Средний чек');
  const mQty = await mkMeasure('Sum(Qty)', 'Количество, шт.');

  const mea = id => ({ qLibraryId: id, qDef: {} });
  const dim = (field, label) => ({ qDef: { qFieldDefs: [field], qFieldLabels: [label] } });

  const kpi = async (measureId, title) => (await app.createObject({
    qInfo: { qType: 'kpi' }, visualization: 'kpi', showTitles: false, title,
    qHyperCubeDef: { qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 1, qHeight: 1 }], qMeasures: [mea(measureId)] }
  })).id;
  const kpi1 = await kpi(mRevenue, 'Выручка');
  const kpi2 = await kpi(mOrders, 'Заказы');
  const kpi3 = await kpi(mAvg, 'Средний чек');
  const kpi4 = await kpi(mQty, 'Количество, шт.');

  const line = (await app.createObject(withDefaults(LINE_DEFAULTS, {
    qInfo: { qType: 'linechart' }, visualization: 'linechart', showTitles: true, title: 'Выручка по месяцам',
    qHyperCubeDef: {
      qDimensions: [{ qDef: { qFieldDefs: ['Month'], qFieldLabels: ['Месяц'], qSortCriterias: [{ qSortByNumeric: 1 }] } }],
      qMeasures: [mea(mRevenue)], qInterColumnSortOrder: [0, 1],
      qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 2, qHeight: 100 }]
    }
  }))).id;

  const bar = (await app.createObject(withDefaults(BAR_DEFAULTS, {
    qInfo: { qType: 'barchart' }, visualization: 'barchart', showTitles: true, title: 'Выручка по регионам',
    qHyperCubeDef: {
      qDimensions: [dim('Region', 'Регион')], qMeasures: [mea(mRevenue)], qInterColumnSortOrder: [1, 0],
      qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 2, qHeight: 50 }]
    }
  }))).id;

  const table = (await app.createObject(withDefaults(TABLE_DEFAULTS, {
    qInfo: { qType: 'table' }, visualization: 'table', showTitles: true, title: 'Детализация: товар и регион',
    qHyperCubeDef: {
      qDimensions: [dim('Product', 'Товар'), dim('Region', 'Регион')],
      qMeasures: [mea(mRevenue), mea(mOrders), mea(mAvg)],
      qInterColumnSortOrder: [0, 1, 2, 3, 4],
      columnOrder: [0, 1, 2, 3, 4], columnWidths: [-1, -1, -1, -1, -1],
      qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 5, qHeight: 100 }]
    }
  }))).id;

  const lbox = async (field, title) => (await app.createObject({
    qInfo: { qType: 'listbox' }, visualization: 'listbox', showTitles: true, title,
    qListObjectDef: {
      qDef: { qFieldDefs: [field], qSortCriterias: [{ qSortByAscii: 1 }] },
      qShowAlternatives: true, frequencyMode: 'N',
      qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 1, qHeight: 100 }]
    }
  })).id;
  const lb1 = await lbox('Region', 'Регион');
  const lb2 = await lbox('Product', 'Товар');
  const lb3 = await lbox('Year', 'Год');

  await app.createObject({
    qInfo: { qType: 'sheet' },
    qMetaDef: { title: 'Обзор', description: 'Тестовый дашборд (inline-данные)' },
    rank: 1, thumbnail: { qStaticContentUrlDef: {} }, columns: GRID_COLS, rows: GRID_ROWS,
    cells: [
      cell(lb1, 'listbox', 0, 0, 4, 4), cell(lb2, 'listbox', 0, 4, 4, 4), cell(lb3, 'listbox', 0, 8, 4, 4),
      cell(kpi1, 'kpi', 4, 0, 5, 3), cell(kpi2, 'kpi', 9, 0, 5, 3),
      cell(kpi3, 'kpi', 14, 0, 5, 3), cell(kpi4, 'kpi', 19, 0, 5, 3),
      cell(line, 'linechart', 4, 3, 10, 4), cell(bar, 'barchart', 14, 3, 10, 4),
      cell(table, 'table', 4, 7, 20, 5)
    ],
    qChildListDef: { qData: { title: '/qMetaDef/title' } }
  });

  await app.doSave();
  console.log('Готово. Приложение «' + CONFIG.appName + '» (ID ' + created.qAppId + ') в Hub → Work.');
  await session.close();
})().catch(async e => {
  console.error('Ошибка:', e && e.message ? e.message : e);
  try { await session.close(); } catch (_) {}
  process.exit(1);
});
