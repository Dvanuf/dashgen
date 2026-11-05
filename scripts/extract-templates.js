#!/usr/bin/env node
// Снятие эталонных шаблонов свойств всех стандартных визуализаций Qlik Sense.
// Создаёт временное приложение с inline-данными, строит по одному объекту каждого типа,
// снимает getProperties() и сохраняет в templates/<тип>.json. Неподнявшиеся типы — в отчёт.
// Повторный прогон после обновления клиента Qlik обновляет всю библиотеку (риск раздела 11).
const path = require('path');
const fs = require('fs');
const { loadConfig } = require('../src/config');
const { withSession } = require('../src/engine');
const { generateScript } = require('../src/qvs-generator');

const OUT_DIR = path.join(__dirname, '..', 'templates');
fs.mkdirSync(OUT_DIR, { recursive: true });

const APP = 'TMP_TemplateHarvest';
const SPEC = {
  version: 1,
  appName: APP,
  source: {
    type: 'inline', table: 'Harvest',
    fields: ['Region', 'Product', 'Month', 'Amount', 'Qty', 'Plan'],
    rows: [
      ['Центр', 'Ноутбуки', 1, 120000, 2, 110000], ['Центр', 'Мониторы', 1, 68000, 4, 70000],
      ['Север', 'Ноутбуки', 2, 210000, 3, 200000], ['Север', 'Принтеры', 2, 45000, 5, 50000],
      ['Юг', 'Мониторы', 3, 96000, 6, 90000], ['Юг', 'Ноутбуки', 3, 178000, 2, 180000],
      ['Урал', 'Принтеры', 4, 54000, 6, 60000], ['Урал', 'Ноутбуки', 4, 232000, 4, 220000]
    ]
  },
  measures: [], dimensions: [], sheets: []
};

const meas = (id, label, formula) => ({ qLibraryId: id, qDef: {} });
const dim = field => ({ qDef: { qFieldDefs: [field], qFieldLabels: [field] } });

// Минимальные определения на каждый тип; у измерений/мер подставляем library-ссылки после их создания
const TYPES = [
  { type: 'barchart', build: (d, m) => ({ qHyperCubeDef: { qDimensions: [d('Region')], qMeasures: [m('Amount'), m('Qty')], qInitialDataFetch: [{ qWidth: 3, qHeight: 50 }] } }) },
  { type: 'linechart', build: (d, m) => ({ qHyperCubeDef: { qDimensions: [d('Month')], qMeasures: [m('Amount')], qInitialDataFetch: [{ qWidth: 2, qHeight: 100 }] } }) },
  { type: 'piechart', build: (d, m) => ({ qHyperCubeDef: { qDimensions: [d('Region')], qMeasures: [m('Amount')], qInitialDataFetch: [{ qWidth: 2, qHeight: 50 }] } }) },
  { type: 'scatterplot', build: (d, m) => ({ qHyperCubeDef: { qDimensions: [d('Product')], qMeasures: [m('Qty'), m('Amount'), m('Plan')], qInitialDataFetch: [{ qWidth: 4, qHeight: 3333 }] } }) },
  { type: 'combochart', build: (d, m) => ({ qHyperCubeDef: { qDimensions: [d('Month')], qMeasures: [m('Amount'), m('Qty')], qInitialDataFetch: [{ qWidth: 3, qHeight: 100 }] } }) },
  { type: 'table', build: (d, m) => ({ qHyperCubeDef: { qDimensions: [d('Region'), d('Product')], qMeasures: [m('Amount'), m('Qty')], qInitialDataFetch: [{ qWidth: 4, qHeight: 100 }] } }) },
  { type: 'pivot-table', build: (d, m) => ({ qHyperCubeDef: { qDimensions: [d('Region')], qMeasures: [m('Amount')], qInitialDataFetch: [{ qWidth: 2, qHeight: 50 }] } }) },
  { type: 'treemap', build: (d, m) => ({ qHyperCubeDef: { qDimensions: [d('Region')], qMeasures: [m('Amount')], qInitialDataFetch: [{ qWidth: 2, qHeight: 50 }] } }) },
  { type: 'gauge', build: (d, m) => ({ qHyperCubeDef: { qMeasures: [m('Amount')], qInitialDataFetch: [{ qWidth: 1, qHeight: 1 }] } }) },
  { type: 'kpi', build: (d, m) => ({ qHyperCubeDef: { qMeasures: [m('Amount')], qInitialDataFetch: [{ qWidth: 1, qHeight: 1 }] } }) },
  { type: 'listbox', build: () => ({ qListObjectDef: { qDef: { qFieldDefs: ['Region'], qSortCriterias: [{ qSortByAscii: 1 }] }, qInitialDataFetch: [{ qWidth: 1, qHeight: 100 }] } }) },
  { type: 'filterpane', build: () => ({ qChildListDef: { qData: { info: '/qListObjectDef' } } }) },
  { type: 'textimage', build: () => ({ markdown: '# Harvest' }) },
  { type: 'boxplot', build: (d, m) => ({ qHyperCubeDef: { qDimensions: [d('Region')], qMeasures: [{ qDef: { qLabel: 'Box' }, qBoxPlotDef: { qMeasures: [m('Amount')], qFrequencyMode: 'P' } }], qInitialDataFetch: [{ qWidth: 2, qHeight: 50 }] } }) },
  { type: 'distributionplot', build: (d, m) => ({ qHyperCubeDef: { qDimensions: [d('Region')], qMeasures: [m('Amount')], qInitialDataFetch: [{ qWidth: 2, qHeight: 50 }] } }) },
  { type: 'waterfallchart', build: (d, m) => ({ qHyperCubeDef: { qDimensions: [d('Region')], qMeasures: [m('Amount'), m('Qty'), m('Plan')], qInitialDataFetch: [{ qWidth: 4, qHeight: 50 }] } }) },
  { type: 'mekko-chart', build: (d, m) => ({ qHyperCubeDef: { qDimensions: [d('Region'), d('Product')], qMeasures: [m('Amount')], qInitialDataFetch: [{ qWidth: 3, qHeight: 50 }] } }) },
  { type: 'funnel-chart', build: (d, m) => ({ qHyperCubeDef: { qDimensions: [d('Region')], qMeasures: [m('Amount')], qInitialDataFetch: [{ qWidth: 2, qHeight: 50 }] } }) }
];

(async () => {
  const cfg = loadConfig();
  await withSession(cfg, async global => {
    for (const d of await global.getDocList().then(l => l.filter(x => x.qDocName === APP))) {
      await global.deleteApp(d.qDocId).catch(() => {});
    }
    const created = await global.createApp(APP);
    const app = await global.openDoc(created.qAppId);
    console.log('Временное приложение:', created.qAppId);

    await app.setScript(generateScript(SPEC));
    if (!(await app.doReload(0, false, false))) throw new Error('Загрузка harvest-данных не прошла');
    console.log('Данные загружены (8 строк, 6 полей)');

    const dimId = (await app.createDimension({
      qInfo: { qType: 'dimension' },
      qDim: { qGrouping: 'N', qFieldDefs: ['Region'], qFieldLabels: ['Region'], title: 'Region' },
      qMetaDef: { title: 'Region' }
    })).id;
    const measIdAmount = (await app.createMeasure({
      qInfo: { qType: 'measure' },
      qMeasure: { qLabel: 'Amount', qDef: 'Sum(Amount)', qNumFormat: { qType: 'F', qnDec: 0, qDec: ',', qThou: ' ', qFmt: '# ##0' } },
      qMetaDef: { title: 'Amount' }
    })).id;
    const measIdQty = (await app.createMeasure({
      qInfo: { qType: 'measure' },
      qMeasure: { qLabel: 'Qty', qDef: 'Sum(Qty)', qNumFormat: { qType: 'F', qnDec: 0, qDec: ',', qThou: ' ', qFmt: '# ##0' } },
      qMetaDef: { title: 'Qty' }
    })).id;
    const measIdPlan = (await app.createMeasure({
      qInfo: { qType: 'measure' },
      qMeasure: { qLabel: 'Plan', qDef: 'Sum(Plan)', qNumFormat: { qType: 'F', qnDec: 0, qDec: ',', qThou: ' ', qFmt: '# ##0' } },
      qMetaDef: { title: 'Plan' }
    })).id;

    const D = field => ({ qLibraryId: dimId, qDef: {} });
    const MEAS_IDS = { Amount: measIdAmount, Qty: measIdQty, Plan: measIdPlan };
    const M = name => ({ qLibraryId: MEAS_IDS[name], qDef: {} });

    const report = { ok: [], fail: [] };
    for (const t of TYPES) {
      try {
        const props = t.build(D, M);
        // унификация вызова build: (D, M-словарь)
        const full = {
          qInfo: { qType: t.type },
          visualization: t.type,
          showTitles: true,
          title: 'Harvest ' + t.type,
          ...props
        };
        const obj = await app.createObject(full);
        const properties = await obj.getProperties();
        delete properties.qInfo.qId; // id пересоздаётся при сборке
        fs.writeFileSync(path.join(OUT_DIR, t.type + '.json'), JSON.stringify(properties, null, 1));
        report.ok.push(t.type);
        console.log('  ✓', t.type);
      } catch (e) {
        report.fail.push({ type: t.type, error: String(e && e.message ? e.message : e).slice(0, 160) });
        console.log('  ✗', t.type, '—', String(e && e.message ? e.message : e).slice(0, 100));
      }
    }

    await app.doSave();
    fs.writeFileSync(path.join(OUT_DIR, 'harvest-report.json'), JSON.stringify(report, null, 2));
    await global.deleteApp(created.qAppId).catch(e => console.warn('Удалить приложение не удалось:', e.message));
    console.log('Готово. Шаблонов снято:', report.ok.length, '| не удалось:', report.fail.length, '→ templates/');
  });
})().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
