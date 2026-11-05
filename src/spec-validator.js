// Валидация spec.json по JSON-схеме (spec/schema.v1.json) + проверка ссылок на id мер и измерений.
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const schemaPath = path.join(__dirname, '..', 'spec', 'schema.v1.json');

// validateSpec(spec) → { ok: true } | { ok: false, errors: [строки] }
function validateSpec(spec) {
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const errors = [];
  if (!validate(spec)) {
    for (const e of validate.errors) {
      const where = e.instancePath || '(корень)';
      errors.push(where + ' ' + e.message);
    }
  }
  // Проверка ссылок: каждый id в объектах должен существовать в measures/dimensions
  if (spec && typeof spec === 'object') {
    const meaIds = new Set((spec.measures || []).map(m => m.id));
    const dimIds = new Set((spec.dimensions || []).map(d => d.id));
    (spec.sheets || []).forEach(sheet => (sheet.objects || []).forEach((o, i) => {
      const at = `sheet «${sheet.title}» объект #${i}`;
      if (o.type === 'kpi' && o.measure && !meaIds.has(o.measure)) errors.push(at + ': неизвестная мера «' + o.measure + '»');
      if (['linechart', 'barchart'].includes(o.type) && o.dimension && !dimIds.has(o.dimension)) {
        errors.push(at + ': неизвестное измерение «' + o.dimension + '»');
      }
      if (['linechart', 'barchart', 'table'].includes(o.type)) {
        for (const mid of o.measures || []) if (!meaIds.has(mid)) errors.push(at + ': неизвестная мера «' + mid + '»');
      }
      if (o.type === 'table') for (const did of o.dimensions || []) if (!dimIds.has(did)) errors.push(at + ': неизвестное измерение «' + did + '»');
    }));

    // Сетка 24×12: выход за границы и перекрытия объектов
    const SIZE = { kpi: [5, 3], linechart: [10, 4], barchart: [10, 4], table: [20, 5], listbox: [4, 4] };
    (spec.sheets || []).forEach(sheet => {
      const rects = [];
      (sheet.objects || []).forEach((o, i) => {
        const [dc, dr] = SIZE[o.type] || [4, 3];
        const x0 = o.col, y0 = o.row;
        const w = o.colspan || dc, h = o.rowspan || dr;
        const at = `sheet «${sheet.title}» объект #${i} (${o.type})`;
        if (x0 < 0 || y0 < 0 || x0 + w > 24 || y0 + h > 12) {
          errors.push(at + `: выходит за сетку 24×12 (col ${x0}, row ${y0}, размер ${w}×${h})`);
        }
        rects.push({ x0, y0, x1: x0 + w, y1: y0 + h, at });
      });
      for (let a = 0; a < rects.length; a++) {
        for (let b = a + 1; b < rects.length; b++) {
          const A = rects[a], B = rects[b];
          if (A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1) {
            errors.push(A.at + ' перекрывается с ' + B.at);
          }
        }
      }
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

// loadSpec(path) → spec (с проверкой схемы)
function loadSpec(specPath) {
  const spec = JSON.parse(fs.readFileSync(path.resolve(specPath), 'utf8'));
  const result = validateSpec(spec);
  if (!result.ok) {
    const err = new Error('spec.json не прошёл валидацию:\n- ' + result.errors.join('\n- '));
    err.validation = result.errors;
    throw err;
  }
  return spec;
}

module.exports = { validateSpec, loadSpec };
