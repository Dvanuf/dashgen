// Генерация spec.json по безопасному профилю и описанию отчёта.
// Граница приватности: сюда технически может попасть ТОЛЬКО вывод модуля privacy
// (safeProfile без значений) и текст описания. Данные источника сюда не проходят.
// Контур самоисправления (раздел 9 документации): ошибки валидации возвращаются
// модели на исправление; лимит 3 попытки, затем отчёт человеку.
const { chat, extractJson } = require('./provider');
const { validateSpec } = require('../spec-validator');

const SYSTEM = [
  'Ты проектируешь дашборды Qlik Sense. Тебе дают безопасный профиль данных (имена колонок, типы, кардинальность — БЕЗ значений) и описание отчёта.',
  'Верни ТОЛЬКО spec.json по JSON-схеме Dashgen v1, без пояснений.',
  'Схема spec v1 (обязательные поля):',
  '{ "version": 1, "appName": "...", "description": "...",',
  '  "source": {тип из профиля}, "measures": [...], "dimensions": [...], "sheets": [...] }',
  'Правила:',
  '- source: inline → {type:"inline", table, fields, rows: []} (rows верни пустым — данные заполнит сборщик); excel → {type:"excel", path:"lib://SRC/<файл>", sheet}; qvd → {type:"qvd", path:"lib://QVD/<файл>"}.',
  '- measures: id латиницей, title по-русски, formula — выражение Qlik (Sum(...), Count(DISTINCT ...), деление для средних). Учитывай типы колонок из профиля: меры — по числовым, измерения — по текстовым и датам.',
  '- dimensions: id латиницей, title по-русски, field — точное имя колонки из профиля.',
  '- sheets: 1 лист «Обзор»; objects: 3-4 kpi сверху (col 4..19, row 0, rowspan 3), linechart/barchart (row 3), table (row 7, rowspan 5); listbox слева (col 0). Сетка 24×12: col 0-23, row 0-11.',
  '- Каждый объект ссылается ТОЛЬКО на существующие id мер/измерений.',
  '- Не выдумывай поля, которых нет в профиле. Формулы используй только по существующим колонкам.'
].join('\n');

// buildPrompt(safeProfile, description) — пользовательский запрос
function buildPrompt(safeProfile, description) {
  return [
    'Описание отчёта от пользователя:',
    description,
    '',
    'Безопасный профиль данных (значений нет):',
    JSON.stringify(safeProfile, null, 2)
  ].join('\n');
}

// repairPrompt(spec, errors) — запрос исправления
function repairPrompt(spec, errors) {
  return [
    'Твой spec.json не прошёл валидацию. Исправь и верни ТОЛЬКО исправленный spec.json.',
    'Ошибки валидатора:',
    ...errors.map(e => '- ' + e),
    '',
    'Текущий spec.json:',
    JSON.stringify(spec, null, 2)
  ].join('\n');
}

// generateSpec({safeProfile, description, aiCfg, log}) → {spec, attempts}
async function generateSpec({ safeProfile, description, aiCfg, log = () => {} }) {
  const maxAttempts = 3;
  let spec = null;
  let prompt = buildPrompt(safeProfile, description);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log('Попытка ' + attempt + ' из ' + maxAttempts + ': запрос к модели…');
    const text = await chat(aiCfg, SYSTEM, prompt);
    try {
      spec = extractJson(text);
    } catch (e) {
      log('Попытка ' + attempt + ': не удалось извлечь JSON — ' + e.message);
      prompt = repairPrompt({}, ['Ответ не является валидным JSON: ' + e.message]);
      continue;
    }
    const v = validateSpec(spec);
    if (v.ok) {
      log('Попытка ' + attempt + ': spec прошёл схему v1 и проверку ссылок');
      return { spec, attempts: attempt };
    }
    log('Попытка ' + attempt + ': ошибок валидации — ' + v.errors.length + ' (' + v.errors[0] + (v.errors.length > 1 ? ' …' : '') + ')');
    prompt = repairPrompt(spec, v.errors);
  }
  throw new Error('Модель не выдала валидный spec за ' + maxAttempts + ' попытки — правьте spec.json вручную или уточните описание');
}

module.exports = { generateSpec, SYSTEM, buildPrompt };
