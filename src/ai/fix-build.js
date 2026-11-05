// Самоисправление сборки (этап 7 документации): spec не загрузился →
// диагноз причины уходит модели → она возвращает исправленный spec →
// валидатор решает → пересборка. Лимит попыток, затем отчёт человеку.
const { chat, extractJson } = require('./provider');
const { validateSpec } = require('../spec-validator');

const SYSTEM = [
  'Тебе дают spec.json дашборда Qlik Sense, сборка которого упала при загрузке данных, и диагноз причины.',
  'Верни ТОЛЬКО исправленный spec.json (те же поля version=1, appName, description, source, measures, dimensions, sheets), без пояснений.',
  'Правила:',
  '- Читай диагноз: чаще всего формулы мер или поля измерений ссылаются на колонки, которых нет в source.fields.',
  '- Формулы мер должны использовать ТОЛЬКО колонки из source.fields (или функции Qlik: Sum, Count, Avg, Min, Max, If…).',
  '- Поля измерений тоже только из source.fields.',
  '- Если по диагнозу источник повреждён (полей нет вовсе) — исправь source так, чтобы таблица создавалась, сохраняя смысл отчёта.',
  '- Не меняй раскладку (col/row/colspan/rowspan) и состав листов, если диагноз этого не требует.',
  '- Сетка 24×12: col+colspan ≤ 24, row+rowspan ≤ 12, объекты не перекрываются.'
].join('\n');

// fixBuild({spec, diagnosis, aiCfg, log}) → {spec, attempts}
async function fixBuild({ spec, diagnosis, aiCfg, log = () => {} }) {
  const maxAttempts = 3;
  let prompt = [
    'Диагноз сбоя загрузки:',
    diagnosis,
    '',
    'spec.json, который не загрузился:',
    JSON.stringify(spec, null, 2)
  ].join('\n');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log('Самоисправление, попытка ' + attempt + ' из ' + maxAttempts + ': запрос к модели…');
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
      log('Попытка ' + attempt + ': исправленный spec прошёл валидацию');
      return { spec: candidate, attempts: attempt };
    }
    log('Попытка ' + attempt + ': ошибок валидации — ' + v.errors.length + ' (' + v.errors.slice(0, 3).join('; ') + (v.errors.length > 3 ? ' …' : '') + ')');
    prompt = [
      'Твой spec.json не прошёл валидацию. Исправь и верни ТОЛЬКО spec.json.',
      'Ошибки валидатора:',
      ...v.errors.map(e => '- ' + e),
      '',
      'Твой предыдущий ответ:',
      JSON.stringify(candidate, null, 2)
    ].join('\n');
  }
  throw new Error('Модель не исправила spec за ' + maxAttempts + ' попытки — правьте вручную');
}

module.exports = { fixBuild, SYSTEM };
