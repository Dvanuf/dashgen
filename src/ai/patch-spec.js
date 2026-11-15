// Правка spec.json словами: модель получает текущий spec + инструкцию,
// возвращает исправленный spec. Валидатор (включая коллизии сетки) решает,
// применять патч или вернуть ошибку модели (контур самоисправления, до 3 попыток).
const { chat, extractJson } = require('./provider');
const { validateSpec, normalizeSpecTypes } = require('../spec-validator');

const SYSTEM = [
  'Ты редактируешь spec.json дашборда Qlik Sense. Тебе дают текущий spec и инструкцию пользователя.',
  'Верни ТОЛЬКО полный исправленный spec.json (те же поля version=1, appName, description, source, measures, dimensions, sheets), без пояснений.',
  'Правила:',
  '- Меняй только то, о чём просит инструкция; остальное сохраняй без изменений.',
  '- Сетка листа 24 колонок × 12 строк, отсчёт с 0. Все объекты должны целиком помещаться: col+colspan ≤ 24, row+rowspan ≤ 12.',
  '- Объекты не должны перекрываться по площади.',
  '- Типы объектов: barchart, linechart, piechart (доли ≤6), scatterplot (пузырьковая: dimension + 2 меры X/Y + 3-я = размер, не более 3), combochart (две шкалы), treemap (иерархия долей), gauge (одна мера, без dimension), table, kpi, listbox.',
  '- Просьба «пузырьковая/бабл» = scatterplot. Меняй типы осмысленно, но не добавляй типы вне этого списка.',
  '- Точный пример scatterplot (НИКАКИХ других полей в объекте): {"type":"scatterplot","title":"Связь показателей","dimension":"<id измерения>","measures":["<id мерыX>","<id мерыY>","<id мерыРазмер>"],"col":14,"row":3,"colspan":10,"rowspan":5} — если размер не нужен, мер ровно 2.',
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
      candidate = normalizeSpecTypes(extractJson(text));
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
    const typesSeen = (candidate.sheets || []).map(s2 => (s2.objects || []).map(o => o.type).join(',')).join(' | ');
    log('Попытка ' + attempt + ': ошибок валидации — ' + v.errors.length + ' (' + v.errors.slice(0, 3).join('; ') + (v.errors.length > 3 ? ' …' : '') + '); типы: [' + typesSeen + ']');
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

// ── Диалог: правка созданного отчёта беседой с моделью ──
// Модель видит историю разговора и текущий spec (обычно — зафиксированный с
// приложения через syncBack), возвращает короткий ответ пользователю и полный spec.
const SYSTEM_DIALOG = [
  'Ты правишь дашборд Qlik Sense в режиме диалога: пользователь пишет пожелания, ты кратко отвечаешь по-русски и обновляешь spec.',
  'Верни ТОЛЬКО JSON вида: {"comment": "<1–2 предложения: что изменил или почему не вышло>", "spec": {полный обновлённый spec.json}}.',
  'Правила правки:',
  '- Меняй только то, о чём просят; остальное сохраняй без изменений.',
  '- Сетка листа 24 колонок × 12 строк, отсчёт с 0: col+colspan ≤ 24, row+rowspan ≤ 12, без перекрытий.',
  '- Типы объектов: barchart, linechart, piechart (доли ≤6), scatterplot (пузырьковая), combochart, treemap, gauge (одна мера), table, kpi, listbox.',
  '- Каждый объект ссылается только на существующие id мер/измерений. Поля — только из модели данных.',
  '- Объекты с fixed:true — зафиксированы человеком: меняй их только по прямой просьбе.'
].join('\n');

// patchDialog({spec, history, instruction, aiCfg, log}) → {spec, reply, attempts}
// history — прошлые ходы диалога: [{user: '…', assistant: '…'}]
async function patchDialog({ spec, history = [], instruction, aiCfg, log = () => {} }) {
  const maxAttempts = 3;
  const hist = history.slice(-6).map(h => `Пользователь: ${h.user}\nТы: ${h.assistant}`).join('\n\n');
  let prompt = [
    hist ? 'История разговора:\n' + hist : '',
    'Новое сообщение пользователя:',
    instruction,
    '',
    'Текущий spec.json:',
    JSON.stringify(spec, null, 2)
  ].filter(Boolean).join('\n\n');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log('Попытка ' + attempt + ' из ' + maxAttempts + ': запрос к модели…');
    const text = await chat(aiCfg, SYSTEM_DIALOG, prompt);
    let parsed;
    try {
      parsed = extractJson(text);
    } catch (e) {
      log('Попытка ' + attempt + ': ответ не JSON — ' + e.message);
      prompt = 'Предыдущий ответ не был JSON нужного вида. Верни ТОЛЬКО {"comment":"…","spec":{…}}.\n\n' + prompt;
      continue;
    }
    const reply = String(parsed.comment || 'Готово.');
    let candidate;
    try {
      if (!parsed.spec || typeof parsed.spec !== 'object') throw new Error('в ответе нет spec');
      candidate = normalizeSpecTypes(parsed.spec);
    } catch (e) {
      log('Попытка ' + attempt + ': ' + e.message);
      prompt = 'В ответе нет корректного spec.json. Верни ТОЛЬКО {"comment":"…","spec":{полный spec}}.\n\n' + prompt;
      continue;
    }
    const v = validateSpec(candidate);
    if (v.ok) {
      log('Попытка ' + attempt + ': патч прошёл схему, ссылки и сетку');
      return { spec: candidate, reply, attempts: attempt };
    }
    log('Попытка ' + attempt + ': ошибок валидации — ' + v.errors.slice(0, 3).join('; '));
    prompt = [
      'Твой spec не прошёл валидацию. Верни ТОЛЬКО {"comment":"…","spec":{…}}.',
      'Ошибки валидатора:',
      ...v.errors.map(e => '- ' + e),
      '',
      'Твой предыдущий ответ:',
      JSON.stringify(parsed, null, 2)
    ].join('\n');
  }
  throw new Error('Модель не выдала валидный патч за ' + maxAttempts + ' попытки');
}

module.exports = { patchSpec, patchDialog, SYSTEM, SYSTEM_DIALOG };
