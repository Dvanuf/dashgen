// Архетипы: превращение «макет + наполнение слотов» в spec.sheets.
// spec.design.layout выбирает макет, spec.design.fill — что в какой слот ставится.
// Позиции диктует макет, наполнение — ИИ или пользователь.
const layouts = require('./layouts');

// Требования ролей слотов: какие поля наполнения обязательны
const ROLE_RULES = {
  filter:      { needs: ['field'] },
  kpi:         { needs: ['measure'] },
  gauge:       { needs: ['measure'] },
  trend:       { needs: ['dimension', 'measures'] },
  structure:   { needs: ['dimension', 'measures'] },
  breakdown:   { needs: ['dimension', 'measures'] },
  top:         { needs: ['dimension', 'measures'] },
  detailTable: { needs: ['dimensions', 'measures'] }
};

// validateFill(layout, fill, measureIds, dimensionIds) → [строки ошибок]
// measureIds/dimensionIds — Set идентификаторов из spec.measures/dimensions
function validateFill(layout, fill, measureIds, dimensionIds) {
  const errors = [];
  const f = fill || {};
  for (const slot of layout.slots) {
    const asg = f[slot.id];
    if (!asg || typeof asg !== 'object') {
      errors.push(`макет «${layout.id}»: слот «${slot.id}» (${slot.roleTitle || slot.role}) не заполнен — добавьте design.fill["${slot.id}"]`);
      continue;
    }
    for (const key of ROLE_RULES[slot.role].needs) {
      if (!asg[key]) errors.push(`макет «${layout.id}»: в слоте «${slot.id}» не задано «${key}»`);
    }
    if (asg.measure && measureIds && !measureIds.has(asg.measure)) errors.push(`слот «${slot.id}»: мера «${asg.measure}» не объявлена в spec.measures`);
    if (asg.dimension && dimensionIds && !dimensionIds.has(asg.dimension)) errors.push(`слот «${slot.id}»: измерение «${asg.dimension}» не объявлено в spec.dimensions`);
    for (const key of ['measures', 'dimensions']) {
      for (const id of asg[key] || []) {
        const have = key === 'measures' ? measureIds : dimensionIds;
        if (have && !have.has(id)) errors.push(`слот «${slot.id}»: «${id}» не объявлено в spec.${key}`);
      }
    }
  }
  for (const key of Object.keys(f)) {
    if (!layout.slots.find(s => s.id === key)) errors.push(`design.fill["${key}"]: в макете «${layout.id}» нет такого слота`);
  }
  return errors;
}

// Автозаголовок объекта, если наполнение не задало свой
function autoTitle(slot, asg, spec) {
  if (asg.title) return asg.title;
  const mTitle = id => (spec.measures || []).find(m => m.id === id);
  const dTitle = id => (spec.dimensions || []).find(d => d.id === id);
  switch (slot.role) {
    case 'filter': return asg.field || slot.id;
    case 'kpi':
    case 'gauge': return (mTitle(asg.measure) || {}).title || slot.id;
    case 'trend':
    case 'structure':
    case 'breakdown':
    case 'top': {
      const dim = (dTitle(asg.dimension) || {}).title || '';
      const meas = (asg.measures || []).map(id => (mTitle(id) || {}).title).filter(Boolean).join(', ');
      return [dim, meas].filter(Boolean).join(' — ') || slot.id;
    }
    case 'detailTable': {
      const dims = (asg.dimensions || []).map(id => (dTitle(id) || {}).title).filter(Boolean).join(', ');
      return 'Детализация' + (dims ? ': ' + dims : '');
    }
    default: return slot.id;
  }
}

// ospec для слота по наполнению
function slotToObject(slot, asg, spec) {
  const o = {
    type: slot.type,
    title: autoTitle(slot, asg, spec),
    col: slot.col, row: slot.row, colspan: slot.colspan, rowspan: slot.rowspan
  };
  if (slot.role === 'filter') o.field = asg.field;
  if (slot.role === 'kpi' || slot.role === 'gauge') o.measure = asg.measure;
  if (['trend', 'structure', 'breakdown', 'top'].includes(slot.role)) {
    o.dimension = asg.dimension;
    o.measures = asg.measures;
  }
  if (slot.role === 'detailTable') {
    o.dimensions = asg.dimensions;
    o.measures = asg.measures;
  }
  return o;
}

// applyLayout(spec, log) → spec с гарантированным sheets[] (лист из макета).
// Объекты с fixed:true из прежних sheets сохраняются и добавляются к сгенерированным —
// фиксация правок не теряется при перегенерации.
function applyLayout(spec, log = () => {}) {
  const layout = layouts.getLayout(spec.design.layout);
  if (!layout) throw new Error('макет не найден: ' + spec.design.layout);
  const fill = (spec.design && spec.design.fill) || {};

  const fixed = [];
  for (const sh of spec.sheets || []) {
    for (const o of sh.objects || []) if (o.fixed) fixed.push({ ...o, fixed: true });
  }
  if (fixed.length) log('Сохранено зафиксированных объектов: ' + fixed.length);

  const objects = layout.slots.map(slot => slotToObject(slot, fill[slot.id] || {}, spec));
  objects.push(...fixed);
  const overlaps = layouts.findOverlaps(objects);
  if (overlaps.length) throw new Error('зафиксированные объекты пересекаются со слотами макета: ' + overlaps.join(', '));

  return {
    ...spec,
    sheets: [{
      title: (spec.design && spec.design.sheetTitle) || layout.title,
      description: layout.description,
      objects
    }]
  };
}

module.exports = { applyLayout, validateFill, autoTitle };
