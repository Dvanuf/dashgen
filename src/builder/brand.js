// Бренд-пак SUNLIGHT: палитра, расширения оформления, инжектор темы.
// spec.design.brand === 'sunlight' включает: загрузку расширений через QRS (идемпотентно),
// фирменные цвета объектов (первичный красный #C8102E) и инжектор light-темы на лист.
const fs = require('fs');
const path = require('path');
const qrs = require('../qrs');

const BRAND_DIR = path.join(__dirname, '..', '..', 'brand', 'sunlight');

// Палитра бренда (брендбук SUNLIGHT; см. sunlight-qlik-theme theme.json)
const PALETTE = {
  red: '#C8102E',       // первичный — бары, линии, KPI
  champagne: '#D8C6A5', // вторичный — прошлый год, вторая серия
  graphite: '#343434',  // текст, нейтральные ряды
  good: '#1B8A00',      // позитивные отклонения
  bad: '#C8102E',
  bg: '#F2EEE6'         // фон light-темы (инжектор CSS)
};

const EXTENSIONS = ['sl-theme-light', 'sl-logo', 'sl-info'];

// Идемпотентная загрузка расширений бренда через QRS
async function ensureExtensions(cfg, log = () => {}) {
  const have = new Set(await qrs.listExtensions(cfg));
  for (const name of EXTENSIONS) {
    if (have.has(name)) { log('Бренд: расширение уже установлено — ' + name); continue; }
    const dir = path.join(BRAND_DIR, 'extensions', name);
    const qext = fs.readFileSync(path.join(dir, name + '.qext'), 'utf8');
    const zip = fs.readFileSync(path.join(dir, name + '.zip'));
    await qrs.uploadExtension(cfg, name, qext, zip);
    log('Бренд: расширение загружено — ' + name);
  }
}

// Фирменный цвет объекта: переопределение color поверх шаблона.
// auto:false обязателен — при auto:true клиент игнорирует paletteColor.
function brandColor(kind) {
  const c = kind === 'secondary' ? PALETTE.champagne : PALETTE.red;
  return {
    auto: false, mode: 'primary',
    formatting: { numFormatFromTemplate: true },
    useBaseColors: 'off',
    paletteColor: { index: -1, color: c, alpha: 1 },
    useDimColVal: true, useMeasureGradient: true, persistent: true,
    expressionIsColor: true, expressionLabel: '',
    measureScheme: 'sg', reverseScheme: false, dimensionScheme: '12',
    autoMinMax: true, measureMin: 0, measureMax: 10
  };
}

// Свойства инжектора темы: 1×1 в правом нижнем углу листа (24×12)
function themeInjectorProps() {
  return {
    qInfo: { qType: 'sl-theme-light' },
    visualization: 'sl-theme-light',
    showTitles: false,
    title: ''
  };
}

module.exports = { PALETTE, EXTENSIONS, ensureExtensions, brandColor, themeInjectorProps };
