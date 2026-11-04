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
