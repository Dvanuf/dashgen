// Генератор скрипта загрузки по spec: inline | excel | qvd.
// Даты и форматы задаются явно (SET-блок), чтобы серийные номера Excel не ломали модель.
function setBlock() {
  return [
    "SET ThousandSep=' ';",
    "SET DecimalSep=',';",
    "SET DateFormat='DD.MM.YYYY';",
    "SET TimestampFormat='DD.MM.YYYY hh:mm:ss';",
    "SET MonthNames='янв;фев;мар;апр;май;июн;июл;авг;сен;окт;ноя;дек';",
    "SET DayNames='пн;вт;ср;чт;пт;сб;вс';"
  ].join('\n');
}

function qLiteral(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return String(v); // inline-данные v1: целые числа; дробные — через excel/qvd
  const s = String(v).replace(/"/g, '""').replace(/[\r\n]+/g, ' '); // перенос строки ломает строку inline
  return '"' + s + '"';
}

// Имя таблицы с пробелами/спецсимволами берём в двойные кавычки («Сводно UPD» → "Сводно UPD")
function tableNameLiteral(name) {
  const t = String(name || 'Data');
  return /^[A-Za-zА-Яа-яЁё0-9_]+$/.test(t) ? t : '"' + t.replace(/"/g, '""') + '"';
}

// fields может прийти строкой «A, B, C» (так отвечала модель) — нормализуем в массив
function normalizeFields(fields) {
  if (Array.isArray(fields)) return fields;
  if (typeof fields === 'string') return fields.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function inlineLoad(source) {
  const fields = normalizeFields(source.fields);
  const rowsText = (source.rows || []).map(r => r.map(qLiteral).join(', ')).join('\n');
  return tableNameLiteral(source.table) + ':\nLOAD * INLINE [\n' + fields.join(', ') + '\n' + rowsText + '\n];';
}

// Кавычение имени поля Qlik (пробелы/спецсимволы → [имя])
function qFieldName(f) {
  return /^[A-Za-zА-Яа-яЁё0-9_]+$/.test(f) ? f : '[' + f + ']';
}

// Правила полей источника из joins:
//   правая сторона связи (how=rename) → поле переименовывается в левое имя;
//   левая сторона → поле исключается из префикса (имя должно совпасть с правым после его rename).
// Возвращает { renames: {rawField: newName}, keepRaw: Set(rawField) }
function fieldRulesFor(spec, srcId) {
  const renames = {}, keepRaw = new Set();
  for (const j of Array.isArray(spec.joins) ? spec.joins : []) {
    if (j.how === 'key') continue;
    const ls = String(j.left || '').split('.')[0], lf = String(j.left || '').split('.')[1];
    const rs = String(j.right || '').split('.')[0], rf = String(j.right || '').split('.')[1];
    if (!lf || !rf) continue;
    if (j.how === 'concat') continue;
    if (rs === srcId) renames[rf] = lf;
    if (ls === srcId) keepRaw.add(lf);
    if (rf === lf) { keepRaw.add(lf); } // одинаковые имена: защитить поле от префикса на обеих сторонах
  }
  return { renames, keepRaw };
}

// Список полей с учётом renames и префикса источника.
// Порядок: join-rename сильнее префикса; поле левой стороны связи не получает префикс.
function loadFields(source, rules) {
  const fields = normalizeFields(source.fields);
  const prefix = source.prefix || '';
  if (!fields.length) return { text: '*', needsFields: !!(Object.keys(rules.renames).length || prefix) };
  return {
    text: fields.map(f => {
      if (rules.renames[f] && rules.renames[f] !== f) return qFieldName(f) + ' as ' + qFieldName(rules.renames[f]);
      if (rules.keepRaw.has(f)) return qFieldName(f);
      const target = prefix ? prefix + f : f;
      return target === f ? qFieldName(f) : qFieldName(f) + ' as ' + qFieldName(target);
    }).join(', '),
    needsFields: false
  };
}

function excelLoad(source, rules) {
  const { text, needsFields } = loadFields(source, rules);
  if (needsFields) throw new Error('источник ' + (source.id || source.table) + ': renames/prefix требуют явного списка fields');
  const sheet = /[\s']/.test(source.sheet) ? "'" + source.sheet.replace(/'/g, "''") + "'" : source.sheet;
  return tableNameLiteral(source.table || source.id) + ':\nLOAD ' + text + '\nFROM [' + source.path + ']\n(ooxml, embedded labels, table is ' + sheet + ');';
}

function qvdLoad(source, rules) {
  const { text, needsFields } = loadFields(source, rules);
  if (needsFields) throw new Error('источник ' + (source.id || source.table) + ': renames/prefix требуют явного списка fields');
  return tableNameLiteral(source.table || source.id) + ':\nLOAD ' + text + '\nFROM [' + source.path + ']\n(qvd);';
}

function inlineLoad(source, renames) {
  const fields = normalizeFields(source.fields);
  const targets = fields.map(f => renames[f] || f);
  const rowsText = (source.rows || []).map(r => r.map(qLiteral).join(', ')).join('\n');
  return tableNameLiteral(source.table || source.id) + ':\nLOAD ' + fields.map((f, i) => (targets[i] !== f ? f + ' as ' + targets[i] : f)).join(', ') + '\nINLINE [\n' + fields.join(', ') + '\n' + rowsText + '\n];';
}

// generateScript(spec) → текст скрипта загрузки для app.setScript()
// generateScript(spec): один источник (source) или несколько (sources + joins)
function generateScript(spec) {
  const specNorm = require('./spec-validator').normalizeSpecSources({ ...spec });
  const sources = Array.isArray(specNorm.sources) ? specNorm.sources : [];
  if (!sources.length) throw new Error('В spec нет источников');
  // Автоподмена направления связи: rename должен лечь на источник с явным fields
  // (LOAD * переименовать нельзя). У левой стороны приоритет — её имя сохраняется.
  const byId = {};
  for (const src of sources) byId[src.id || src.table] = src;
  const joinsNorm = (Array.isArray(specNorm.joins) ? specNorm.joins : []).map(j => {
    if (j.how !== 'rename') return j;
    const rightSrc = byId[String(j.right).split('.')[0]];
    const leftSrc = byId[String(j.left).split('.')[0]];
    const rightHasFields = rightSrc && normalizeFields(rightSrc.fields).length;
    const leftHasFields = leftSrc && normalizeFields(leftSrc.fields).length;
    // rename исполняется в LOAD правого источника; если у правого нет fields (LOAD *),
    // а у левого есть — меняем стороны местами (левое имя сохраняется за правым полем).
    if (!rightHasFields && leftHasFields) {
      return { left: j.right, right: j.left, how: 'rename' };
    }
    return j;
  });
  specNorm.joins = joinsNorm;

  const parts = [setBlock()];
  for (const src of sources) {
    const srcId = src.id || src.table;
    const rules = fieldRulesFor(specNorm, srcId);
    let load;
    if (src.type === 'inline') load = inlineLoad({ ...src, table: src.table || srcId }, rules.renames);
    else if (src.type === 'excel') load = excelLoad({ ...src, table: src.table || srcId }, rules);
    else if (src.type === 'qvd') load = qvdLoad({ ...src, table: src.table || srcId }, rules);
    else throw new Error('Неизвестный тип источника: ' + src.type);
    // concat: правый источник склеивается к указанному левому
    const concatTo = (Array.isArray(specNorm.joins) ? specNorm.joins : []).find(j => j.how === 'concat' && String(j.right || '').split('.')[0] === srcId);
    const prefix = concatTo ? 'Concatenate (' + tableNameLiteral(String(concatTo.left).split('.')[0]) + ') ' : '';
    parts.push(prefix + load);
  }
  return parts.join('\n\n') + '\n';
}

module.exports = { generateScript };
