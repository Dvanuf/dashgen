// Генерация spec.json по безопасному профилю и описанию отчёта.
// Граница приватности: сюда технически может попасть ТОЛЬКО вывод модуля privacy
// (safeProfile без значений) и текст описания. Данные источника сюда не проходят.
// Контур самоисправления (раздел 9 документации): ошибки валидации возвращаются
// модели на исправление; лимит 3 попытки, затем отчёт человеку.
const { chat, extractJson } = require('./provider');
const { validateSpec, normalizeSpecTypes } = require('../spec-validator');

// Схема v1 прикладывается к запросу: модель видит точные допустимые поля
// (лишние свойства в sheets/objects — главная причина бракованных попыток).
const SCHEMA = require('../../spec/schema.v1.json');

// Системный промпт зависит от режима: синтетика inline или реальный Excel с шары.
const buildSystem = (excelLib, isMulti) => [
  'Ты проектируешь дашборды Qlik Sense. Тебе дают безопасный профиль данных (имена колонок, типы, кардинальность — БЕЗ значений) и описание отчёта.',
  'Верни ТОЛЬКО spec.json по JSON-схеме Dashgen v1 (схема приложена ниже), без пояснений.',
  'Жёсткие требования к структуре (additionalProperties: false — ЛИШНИЕ ПОЛЯ ЗАПРЕЩЕНЫ):',
  '- sheets[i]: только title, description, objects. НЕ добавляй kpis, charts, layout и прочее.',
  '- sheets[i].objects[j]: только type, title, measure, dimension, dimensions, measures, field, col, row, colspan, rowspan.',
  '- object.type — одно из: kpi, linechart, barchart, table, listbox.',
  '- Обязательные пары: kpi → measure; linechart/barchart → dimension + measures; table → dimensions + measures; listbox → field.',
  'Схема v1:',
  JSON.stringify(SCHEMA, null, 1),
  isMulti
    ? 'Правило источника (МУЛЬТИ): "sources" массив (каждый: id/type/path/sheet, не-главным задай prefix). Одиночный source и inline ЗАПРЕЩЕНЫ. Связи — "joins" с how:"rename".'
    : excelLib
    ? 'Правило источника (РЕАЛЬНЫЙ EXCEL): source строго {"type":"excel","path":"' + excelLib + '","sheet":"<точное имя листа из профиля>"}. НЕ используй inline и синтетику: данные загрузит Qlik из файла. fields не указывай (LOAD * всех колонок).'
    : [
        'Правила источника (СИНТЕТИЧЕСКИЙ РЕЖИМ, lib:// недоступен):',
        '- inline → {type:"inline", table, fields, rows} — строки по полям, значения правдоподобные синтетические, не более 15 строк.',
        '- excel/qvd профиль: ВСЕГДА используй type:"inline" с синтетическими строками; НЕ используй lib:// пути. В description добавь пометку «синтетические данные».'
      ],
  '- measures: id латиницей, title по-русски, formula — выражение Qlik (Sum(...), Count(DISTINCT ...), деление для средних). Учитывай типы колонок из профиля: меры — по числовым, измерения — по текстовым и датам.',
  '- dimensions: id латиницей, title по-русски, field — точное имя колонки из профиля.',
  '- ДИЗАЙН МАКЕТА — архетип «Обзор», проектируй как дизайнер отчётов, ориентируясь на профиль (типы колонок и distinct = кардинальность):',
  '- Слоты архетипа «Обзор»: 3-4 kpi — главные суммы (row 0, rowspan 3, col 4..19); динамика по колонке-дате — linechart/combochart (row 3, col 4..12); категорийная диаграмма справа (row 3, col 14..22); table — детализация (row 7, colspan 16-20, rowspan 5); listbox-фильтры слева (col 0, w 2, rowspan 3-4) по 2-3 ключевым текстовым полям.',
  '- Выбор типа по кардинальности из профиля: колонка-дата → linechart (динамика); текст с distinct ≤6 → piechart (доли); текст с distinct 7-40 → barchart (топ сравнения) или treemap (много); две числовые меры разных смыслов → combochart; числовые пары для связи → scatterplot (2-3 меры).',
  '- Пример кардинальности: «Показатель» с distinct 33 → treemap/barchart, «Отв» с distinct 4 → piechart, «Период» с distinct 738 (дата) → linechart по месяцам.',
  '- Не ставь piechart по полю с высокой кардинальностью — модель значений не читается. KPI — только по самым важным числовым колонкам (обычно суммы или количества).',
  '- Каждый объект ссылается ТОЛЬКО на существующие id мер/измерений.',
  '- Не выдумывай поля, которых нет в профиле. Формулы используй только по существующим колонкам.'
].filter(Boolean).join('\n');

const SYSTEM = buildSystem(null); // режим по умолчанию (синтетика)

// buildPrompt(safeProfile, description, excelLib, multi) — пользовательский запрос.
// excelLib — путь lib:// к реальному файлу на шаре: тогда источник excel, не inline.
// multi — несколько источников: [{id, excelLib, safeProfile, main}]
function buildPrompt(safeProfile, description, excelLib, multi) {
  const base = [
    'Описание отчёта от пользователя:',
    description,
    ''
  ];
  if (multi && multi.length) {
    multi.forEach((m, i) => {
      base.push('=== Источник ' + (i + 1) + (m.main ? ' (ГЛАВНЫЙ: KPI и основная динамика — из него)' : '') + ' id: "' + m.id + '" ===');
      base.push(JSON.stringify(m.safeProfile, null, 1));
      base.push('Путь: ' + m.excelLib);
      base.push('');
    });
    base.push('РЕЖИМ: НЕСКОЛЬКО РЕАЛЬНЫХ EXCEL-ИСТОЧНИКОВ. Правила:');
    base.push('- Верни "sources": массив, каждый элемент: {"id":"<как выше>","type":"excel","path":"<путь источника>","sheet":"<лист из его профиля>"}. НЕ используй одиночный source и inline.');
    base.push('- Главный источник (первый) — БЕЗ prefix. Каждому следующему задай "prefix": "<id>_" (например "src2_").');
    base.push('- Поля не-главных источников в формулах мер и field измерений указывай С префиксом (например "src2_Сумма").');
    base.push('- Связи: "joins":[{"left":"<idГлавного>.<Поле>","right":"<idДругой>.<Поле>","how":"rename"}] — поле right переименуется в имя left, таблицы свяжутся. Связывай по совпадающим по смыслу колонкам (даты, коды, названия) — они есть в обоих профилях.');
    base.push('- Поля, по которым связываешь, НЕ включай в префиксные переименования: указывай их сырыми именами в joins.');
    return base.join('\n');
  }
  base.push('Безопасный профиль данных (значений нет):');
  base.push(JSON.stringify(safeProfile, null, 2));
  if (excelLib) base.push('\nРежим данных: РЕАЛЬНЫЙ EXCEL на шаре Qlik. source обязателен вида: {"type":"excel","path":"' + excelLib + '","sheet":"<имя листа профиля>"} — НЕ inline, синтетику не придумывай.');
  return base.join('\n');
}

// repairPrompt(spec, errors) — запрос исправления: со схемой и всеми ошибками
function repairPrompt(spec, errors) {
  return [
    'Твой spec.json не прошёл валидацию. Исправь и верни ТОЛЬКО исправленный spec.json.',
    'Важно: лишние поля запрещены схемой (additionalProperties: false).',
    'Ошибки валидатора (все):',
    ...errors.map(e => '- ' + e),
    '',
    'JSON-схема, которой должен соответствовать результат:',
    JSON.stringify(SCHEMA, null, 1),
    '',
    'Текущий spec.json:',
    JSON.stringify(spec, null, 2)
  ].join('\n');
}

// generateSpec({safeProfile, description, aiCfg, excelLib, log}) → {spec, attempts}
async function generateSpec({ safeProfile, description, aiCfg, excelLib, multi, log = () => {} }) {
  const maxAttempts = 3;
  let spec = null;
  let prompt = buildPrompt(safeProfile, description, excelLib, multi);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log('Попытка ' + attempt + ' из ' + maxAttempts + ': запрос к модели…');
    const text = await chat(aiCfg, buildSystem(excelLib, !!multi), prompt);
    try {
      spec = normalizeSpecTypes(extractJson(text));
    } catch (e) {
      log('Попытка ' + attempt + ': не удалось извлечь JSON — ' + e.message);
      prompt = repairPrompt({}, ['Ответ не является валидным JSON: ' + e.message]);
      continue;
    }
    const v = validateSpec(spec);
    if (v.ok) {
      // Режим реального Excel обязателен: если модель всё же вернула inline — бракуем с объяснением
      if (excelLib && (!spec.source || spec.source.type !== 'excel')) {
        log('Попытка ' + attempt + ': нужен source.type="excel" (реальные данные), модель вернула ' + (spec.source ? spec.source.type : 'без source') + ' — возвращаю на исправление');
        prompt = repairPrompt(spec, ['режим реального Excel: source должен быть {"type":"excel","path":"' + excelLib + '","sheet":"<лист>"}, inline и синтетика запрещены']);
        continue;
      }
      log('Попытка ' + attempt + ': spec прошёл схему v1 и проверку ссылок');
      return { spec, attempts: attempt };
    }
    log('Попытка ' + attempt + ': ошибок валидации — ' + v.errors.length + ' (' + v.errors.slice(0, 3).join('; ') + (v.errors.length > 3 ? ' …' : '') + ')');
    prompt = repairPrompt(spec, v.errors);
  }
  throw new Error('Модель не выдала валидный spec за ' + maxAttempts + ' попытки — правьте spec.json вручную или уточните описание');
}

module.exports = { generateSpec, SYSTEM, buildPrompt };
