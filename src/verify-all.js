// ЦИКЛ ПРОВЕРКИ собранного приложения (порт verify-all солнлайт-проекта):
//  1. дубли листов (qId и названия), children ↔ cells по именам
//  2. гиперкубы: qError, пустая модель, «данные по требованию» стековых barchart
//  3. сироты (объекты, не упомянутые ни в одном cells — Dashgen-объекты корневые)
//  4. листбоксы у filterpane
//  5. условия приёмки по каждому объекту спеки: тип, минимум строк, KPI-значение > 0
//  6. базовые условия макета: порядок зон фильтры→KPI→графики→детализация, без пересечений
// Запуск: verifyAll(cfg, appId, spec) → { ok, problems: [], lines: [] } — код 2 при проблемах.
const { withSession, openAppById } = require('./engine');
const layouts = require('./builder/layouts');

const VIZ_TYPES = ['barchart', 'linechart', 'combochart', 'piechart', 'kpi', 'table', 'pivot-table',
  'gauge', 'text', 'filterpane', 'listbox', 'scatterplot', 'treemap', 'map', 'container',
  'sl-logo', 'sl-info', 'sl-theme-light'];

// verifyAll(cfg, appId, appliedSpec) → { ok, problems, lines }
// appliedSpec — спека после applyLayout (builder.build возвращает её в appliedSpec):
// только в ней sheets[] соответствуют фактически созданным объектам.
async function verifyAll(cfg, appId, spec) {
  const lines = [];
  const problems = [];
  const ok = m => lines.push('  ✔ ' + m);
  const bad = m => { lines.push('  ✖ ' + m); problems.push(m); };
  const warn = m => lines.push('  … ' + m);

  // ---- статика спеки: макет ----
  if (spec.design && spec.design.layout) {
    const layout = layouts.getLayout(spec.design.layout);
    if (!layout) bad(`design.layout «${spec.design.layout}»: макет не найден`);
    else {
      const archetypes = require('./builder/archetypes');
      const mIds = new Set((spec.measures || []).map(m => m.id));
      const dIds = new Set((spec.dimensions || []).map(d => d.id));
      const errs = archetypes.validateFill(layout, spec.design.fill, mIds, dIds);
      if (errs.length) errs.forEach(e => bad(e));
      else ok(`макет «${layout.id}»: слоты заполнены, ссылки сходятся`);
    }
  }
  // пересечения объектов во всех sheets спеки
  for (const sh of spec.sheets || []) {
    const overlaps = layouts.findOverlaps(sh.objects || []);
    if (overlaps.length) bad(`лист «${sh.title}»: пересечение объектов — ` + overlaps.join(', '));
  }

  await withSession(cfg, async global => {
    const app = await openAppById(global, appId);

    // ---- 1. листы ----
    const sheets = await app.getObjects({ qTypes: ['sheet'], qData: { title: '/qMetaDef/title' } });
    lines.push('== Листов: ' + sheets.length);
    const byId = new Map(), byTitle = new Map();
    const attached = new Set();
    for (const s of sheets) {
      const so = await app.getObject(s.qInfo.qId);
      const p = await so.getProperties();
      const lo = await so.getLayout();
      const title = (p.qMetaDef && p.qMetaDef.title) || '';
      if (byId.has(s.qInfo.qId)) bad(`дубль qId листа: ${s.qInfo.qId}`);
      if (byTitle.has(title)) bad(`дубль названия листа: «${title}»`);
      byId.set(s.qInfo.qId, title);
      byTitle.set(title, s.qInfo.qId);
      const cells = lo.cells || [];
      if (!cells.length) bad(`лист «${title}»: 0 объектов в cells`);
      // Dashgen-объекты корневые: children листа отсутствуют — проверяем доступность каждого cell
      for (const c of cells) {
        attached.add(c.name);
        try {
          const o = await app.getObject(c.name);
          const co = await o.getProperties();
          if ((co.qInfo && co.qInfo.qType) !== c.type) bad(`лист «${title}»: cells ${c.name} — тип ${co.qInfo && co.qInfo.qType} ≠ ${c.type}`);
        } catch (e) {
          bad(`лист «${title}»: объект cells «${c.name}» не читается — ${e.message}`);
        }
      }
      ok(`лист «${title}»: ${cells.length} объектов в cells`);
    }

    // ---- 2/5. объекты: гиперкубы и условия приёмки ----
    const ospecByTitle = new Map();
    for (const sh of spec.sheets || []) {
      for (const o of sh.objects || []) ospecByTitle.set(o.title, o);
    }
    let checked = 0;
    for (const s of sheets) {
      const so = await app.getObject(s.qInfo.qId);
      const lo = await so.getLayout();
      for (const cell of lo.cells || []) {
        const o = await app.getObject(cell.name);
        const p = await o.getProperties();
        const lo2 = await o.getLayout();
        const t = p.qInfo && p.qInfo.qType;
        if (lo2.qError) { bad(`${t} «${cell.name}»: qError`); continue; }
        const hc = lo2.qHyperCube;
        if (hc) {
          // стековый бар: клиент запрашивает данные сам — пустая начальная страница не ошибка
          const lazy = t === 'barchart' && (hc.qDataPages || []).length === 0 && (hc.qSize && hc.qSize.qcy || 0) > 0;
          if (!hc.qSize || hc.qSize.qcy === 0) {
            if (t !== 'listbox' && t !== 'filterpane') bad(`${t} «${cell.name}»: гиперкуб пуст (0 строк в модели)`);
          } else {
            const rows = hc.qDataPages && hc.qDataPages[0] && hc.qDataPages[0].qMatrix
              ? hc.qDataPages[0].qMatrix.filter(r => r.some(c => c.qText || c.qNum !== null)).length : 0;
            if (rows === 0 && !lazy) bad(`${t} «${cell.name}»: нет данных в странице`);
          }
        }
        // условие приёмки из спеки: по заголовку (в appliedSpec заголовки = созданным)
        const ospec = ospecByTitle.get(p.title || '');
        if (ospec) {
          checked++;
          const errs = [];
          if (ospec.type !== t) errs.push(`тип ${t} ≠ ${ospec.type}`);
          const osMeas = ospec.measures || (ospec.measure ? [ospec.measure] : []);
          const defMeas = (p.qHyperCubeDef && p.qHyperCubeDef.qMeasures) || [];
          if (osMeas.length && !defMeas.length) errs.push('мер нет в определении объекта');
          if (['kpi', 'gauge'].includes(ospec.type)) {
            const v = hc && hc.qDataPages && hc.qDataPages[0] && hc.qDataPages[0].qMatrix &&
              hc.qDataPages[0].qMatrix[0] && hc.qDataPages[0].qMatrix[0][0] && hc.qDataPages[0].qMatrix[0][0].qNum;
            if (typeof v !== 'number' || !isFinite(v) || v <= 0) errs.push('значение KPI/датчика пусто или ≤ 0');
          }
          if (errs.length) bad(`${t} «${p.title}»: ${errs.join('; ')}`);
          else ok(`${t} «${p.title}»: условия приёмки выполнены`);
        } else {
          warn(`нет условия приёмки: ${t} «${p.title || cell.name}»`);
        }
      }
    }
    if (!checked) warn('в спеке нет объектов с условиями приёмки (сравнение по заголовкам)');

    // ---- 3. сироты: объекты вне любых cells ----
    const all = await app.getObjects({ qTypes: VIZ_TYPES, qData: {} });
    const orphans = all.filter(o => !attached.has(o.qInfo.qId));
    if (orphans.length) orphans.forEach(o => bad(`сирота: ${o.qInfo.qType} ${o.qInfo.qId}`));
    else ok('сирот нет');

    // ---- 4. filterpane: листбоксы ----
    const fps = all.filter(o => o.qInfo.qType === 'filterpane');
    for (const f of fps) {
      const o = await app.getObject(f.qInfo.qId);
      const infos = await o.getChildInfos();
      if (!infos.length) bad(`фильтр ${f.qInfo.qId}: нет списка`);
      else ok(`фильтр ${f.qInfo.qId}: список есть`);
    }
  });

  return { ok: problems.length === 0, problems, lines };
}

// printVerifyAll(report, log) — человекочитаемый вывод
function printVerifyAll(report, log = console.log) {
  for (const l of report.lines) log(l);
  log(report.ok ? '\n✔ ЦИКЛ ПРОВЕРКИ: чисто' : `\n✖ ЦИКЛ ПРОВЕРКИ: проблем — ${report.problems.length}`);
}

module.exports = { verifyAll, printVerifyAll };
