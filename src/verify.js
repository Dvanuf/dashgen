// Проверка собранного приложения: ошибки объектов, число строк модели против ожидаемого.
const { withSession, openAppById } = require('./engine');

// verify(cfg, appId, spec, buildResult) → отчёт { objectsChecked, objectErrors: [], modelRows }
async function verify(cfg, appId, spec, buildResult) {
  return withSession(cfg, async global => {
    const app = await openAppById(global, appId);
    const report = { objectsChecked: 0, objectErrors: [], hyperCubes: [] };

    for (const o of buildResult.objects) {
      try {
        const obj = await app.getObject(o.id);
        const layout = await obj.getLayout();
        report.objectsChecked += 1;
        if (layout.qHyperCube && layout.qHyperCube.qSize) {
          report.hyperCubes.push({ type: o.type, title: o.title, rows: layout.qHyperCube.qSize.qcy, cols: layout.qHyperCube.qSize.qcx });
        }
      } catch (e) {
        report.objectErrors.push({ id: o.id, type: o.type, title: o.title, error: e.message });
      }
    }

    // Сверка числа строк для inline-источника: Count(первое поле) против числа строк в spec
    if (spec.source.type === 'inline') {
      const field = spec.source.fields[0];
      try {
        const res = await app.evaluate(`Count([${field}])`);
        const n = Number(res);
        report.modelRows = Number.isFinite(n) ? n : null;
        report.expectedRows = spec.source.rows.length;
        report.rowsMatch = Number.isFinite(n) && n === spec.source.rows.length;
      } catch (e) {
        report.modelRows = null;
        report.rowsError = e.message;
      }
    }

    return report;
  });
}

// printReport(report) — человекочитаемый вывод в консоль
function printReport(report) {
  console.log('--- Проверка (verify) ---');
  console.log('Объектов проверено:', report.objectsChecked);
  for (const h of report.hyperCubes) {
    console.log(`  ${h.type} «${h.title}»: ${h.rows} строк x ${h.cols} колонок`);
  }
  if (report.objectErrors.length) {
    console.log('ОШИБКИ ОБЪЕКТОВ:', report.objectErrors.length);
    for (const e of report.objectErrors) console.log('  -', e.type, '«' + e.title + '»:', e.error);
  } else {
    console.log('Ошибок объектов нет');
  }
  if (report.expectedRows !== undefined) {
    console.log(`Строк в модели: ${report.modelRows} (ожидалось ${report.expectedRows}) — ` + (report.rowsMatch ? 'совпадает' : 'РАСХОЖДЕНИЕ'));
  }
}

module.exports = { verify, printReport };
