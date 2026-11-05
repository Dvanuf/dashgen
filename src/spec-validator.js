// Валидация spec.json по JSON-схеме (spec/schema.v1.json) + проверка ссылок на id мер и измерений.
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');

const schemaPath = path.join(__dirname, '..', 'spec', 'schema.v1.json');

// Синонимы типов от модели («scatter», «bubble», «столбчатая»…) → канонические имена.
// ИИ выбирает смысл — код чинит имя (принцип «ИИ решает, код исполняет»).
const TYPE_ALIASES = {
  'scatter': 'scatterplot', 'bubble': 'scatterplot', 'bubblechart': 'scatterplot', 'scatter-chart': 'scatterplot',
  'пузырьковая': 'scatterplot', 'пузырьковаядиаграмма': 'scatterplot',
  'pie': 'piechart', 'круговая': 'piechart', 'donut': 'piechart', 'донат': 'piechart',
  'bar': 'barchart', 'столбчатая': 'barchart', 'гистограмма': 'barchart', 'barchart-vertical': 'barchart',
  'line': 'linechart', 'линейный': 'linechart', 'линия': 'linechart',
  'combo': 'combochart', 'комбинированный': 'combochart',
  'tree': 'treemap', 'картадерева': 'treemap',
  'gaugechart': 'gauge', 'спидометр': 'gauge',
  'pivot': 'pivot-table', 'своднаятаблица': 'pivot-table'
};

// Нормализация типов объектов в spec: модель иногда называет типы по-своему
function normalizeSpecTypes(spec) {
  if (!spec || !Array.isArray(spec.sheets)) return spec;
  for (const sheet of spec.sheets) {
    if (!Array.isArray(sheet.objects)) continue;
    for (const o of sheet.objects) {
      if (o && typeof o.type === 'string') {
        const key = o.type.toLowerCase().replace(/[\s\-_]/g, '');
        if (TYPE_ALIASES[key]) o.type = TYPE_ALIASES[key];
      }
    }
  }
  return spec;
}

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
  // Формулы против полей источника (для inline поля известны точно).
  // Литералы '…'/"…" вырезаем (значения set-анализа не поля), [Поле] считаем полем.
  const QLIK_WORDS = new Set(['sum', 'count', 'distinct', 'avg', 'min', 'max', 'only', 'if', 'aggr', 'num', 'date', 'month', 'year', 'quarter', 'week', 'day', 'floor', 'ceil', 'round', 'upper', 'lower', 'left', 'right', 'len', 'trim', 'and', 'or', 'not', 'total', 'above', 'stdev', 'frac', 'rank']);
  const stripLiterals = s => String(s || '').replace(/'[^']*'|"[^"]*"/g, "''");
  if (spec && typeof spec === 'object' && spec.source && spec.source.type === 'inline') {
    if (!Array.isArray(spec.source.fields)) {
      // модель иногда возвращает fields строкой «A, B» — валидатор не должен падать, а объяснить модели
      errors.push('source.fields должен быть массивом строк (например ["Отв", "Период"]), а не ' + typeof spec.source.fields);
    }
    const fields = new Set(Array.isArray(spec.source.fields) ? spec.source.fields.map(f => String(f).toLowerCase()) : []);
    const checkFormula = (title, id, formula) => {
      const clean = stripLiterals(formula);
      const bracket = new Set((clean.match(/\[([^\]]+)\]/g) || []).map(b => b.slice(1, -1).toLowerCase()));
      const ids = clean.match(/[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]*/g) || [];
      for (const raw of ids) {
        const lid = raw.toLowerCase();
        if (!fields.has(lid) && !bracket.has(lid) && !QLIK_WORDS.has(lid)) {
          errors.push(`мера «${title}» (${id}): формула «${formula}» использует «${raw}», а такого поля нет в source.fields`);
        }
      }
    };
    (spec.measures || []).forEach(m => checkFormula(m.title, m.id, m.formula));
    (spec.dimensions || []).forEach(d => {
      if (String(d.field).toLowerCase() && !fields.has(String(d.field).toLowerCase())) {
        errors.push(`измерение «${d.title}» (${d.id}): поле «${d.field}» отсутствует в source.fields`);
      }
    });
  }

  // Проверка ссылок: каждый id в объектах должен существовать в measures/dimensions
  if (spec && typeof spec === 'object') {
    const meaIds = new Set((Array.isArray(spec.measures) ? spec.measures : []).map(m => m.id));
    const dimIds = new Set((Array.isArray(spec.dimensions) ? spec.dimensions : []).map(d => d.id));
    (spec.sheets || []).forEach(sheet => (sheet.objects || []).forEach((o, i) => {
      const at = `sheet «${sheet.title}» объект #${i}`;
      if (o.type === 'kpi' && o.measure && !meaIds.has(o.measure)) errors.push(at + ': неизвестная мера «' + o.measure + '»');
      if (['linechart', 'barchart', 'piechart', 'scatterplot', 'combochart', 'treemap'].includes(o.type) && o.dimension && !dimIds.has(o.dimension)) {
        errors.push(at + ': неизвестное измерение «' + o.dimension + '»');
      }
      if (o.type === 'scatterplot') {
        const n = (o.measures || []).length;
        if (n < 2 || n > 3) {
          errors.push(at + ': пузырьковой (scatterplot) нужно 2 меры (X и Y) или 3 (X, Y, размер пузырька), сейчас — ' + n + '. Пример: {"type":"scatterplot","dimension":"<id>","measures":["<мераX>","<мераY>","<мераРазмер>"],"col":14,"row":3,"colspan":10,"rowspan":5}');
        }
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

module.exports = { validateSpec, loadSpec, normalizeSpecTypes };
