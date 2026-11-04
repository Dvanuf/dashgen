// Шаблоны свойств объектов — перенесены из проверенного прототипа (build_dashboard_v2.js).
// Клиент Qlik требует ~60 служебных свойств (цвета, оси, легенда, версия) — без них
// объекты «незавершённые». VER должен совпадать с версией клиента Qlik на сервере.
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

// Формат чисел мастер-меры (русская локаль сервера)
const numFmt = { qType: 'F', qnDec: 0, qUseThou: 1, qFmt: '# ##0', qDec: ',', qThou: ' ' };

// Сетка листа 24 на 12; ячейки задаются в долях сетки
const GRID_COLS = 24, GRID_ROWS = 12;
const cell = (name, type, col, row, colspan, rowspan) => ({
  name, type, col, row, colspan, rowspan,
  bounds: {
    x: col / GRID_COLS * 100, y: row / GRID_ROWS * 100,
    width: colspan / GRID_COLS * 100, height: rowspan / GRID_ROWS * 100
  }
});

// Размеры по умолчанию, если в spec не заданы colspan/rowspan
const DEFAULT_SIZE = { kpi: [5, 3], linechart: [10, 4], barchart: [10, 4], table: [20, 5], listbox: [4, 4] };

module.exports = {
  VER, BASE, CHART, BAR_DEFAULTS, LINE_DEFAULTS, TABLE_DEFAULTS,
  withDefaults, numFmt, GRID_COLS, GRID_ROWS, cell, DEFAULT_SIZE
};
