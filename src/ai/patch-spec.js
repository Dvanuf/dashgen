// Правка spec.json словами: модель получает текущий spec + инструкцию,
// возвращает исправленный spec. Валидатор (включая коллизии сетки) решает,
// применять патч или вернуть ошибку модели (контур самоисправления, до 3 попыток).
const { chat, extractJson } = require('./provider');
const { validateSpec } = require('../spec-validator');

const SYSTEM = [
  'Ты редактируешь spec.json дашборда Qlik Sense. Тебе дают текущий spec и инструкцию пользователя.',
  'Верни ТОЛЬКО полный исправленный spec.json (те же поля version=1, appName, description, source, measures, dimensions, sheets), без пояснений.',
  'Правила:',
  '- Меняй только то, о чём просит инструкция; остальное сохраняй без изменений.',
  '- Сетка листа 24 колонок × 12 строк, отсчёт с 0. Все объекты должны целиком помещаться: col+colspan ≤ 24, row+rowspan ≤ 12.',
  '- Объекты не должны перекрываться по площади.',
  '- Не выдумывай мер, измерений и полей: каждый объект ссылается только на существующие id.',
  '- Сохрани все типы объектов (kpi, linechart, barchart, table, listbox) осмысленно: kpi — компактные сверху, графики в середине, таблицы снизу, фильтры listbox — слева.'
].join('\n');

// patchSpec({spec, instruction, aiCfg, log}) → {spec, attempts}
async function patchSpec({ spec, instruction, aiCfg, log = () => {} }) {
  const maxAttempts = 3;
  let current = spec;
  let prompt = [
    'Инструкция пользователя по изменению дашборда:',
    instruction,
    '',
    'Текущий spec.json:',
    JSON.stringify(spec, null, 2)
  ].join('\n');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log('Попытка ' + attempt + ' из ' + maxAttempts + ': запрос к модели…');
    const text = await chat(aiCfg, SYSTEM, prompt);
    let candidate;
    try {
      candidate = extractJson(text);
    } catch (e) {
      log('Попытка ' + attempt + ': ответ не JSON — ' + e.message);
      prompt = 'Предыдущий ответ не был JSON. Верни ТОЛЬКО исправленный spec.json.\n\n' + prompt;
      continue;
    }
    const v = validateSpec(candidate);
    if (v.ok) {
      log('Попытка ' + attempt + ': патч прошёл схему, ссылки и сетку');
      return { spec: candidate, attempts: attempt };
    }
    log('Попытка ' + attempt + ': ошибок валидации — ' + v.errors.length + ' (' + v.errors[0] + (v.errors.length > 1 ? ' …' : '') + ')');
    prompt = [
      'Твой spec.json не прошёл валидацию. Исправь и верни ТОЛЬКО spec.json.',
      'Ошибки валидатора:',
      ...v.errors.map(e => '- ' + e),
      '',
      'Твой предыдущий ответ:',
      JSON.stringify(candidate, null, 2)
    ].join('\n');
    current = candidate;
  }
  throw new Error('Модель не выдала валидный патч за ' + maxAttempts + ' попытки');
}

module.exports = { patchSpec, SYSTEM };
