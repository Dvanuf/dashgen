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

function excelLoad(source) {
  const fields = normalizeFields(source.fields);
  const fieldsText = fields.length ? fields.join(', ') : '*';
  const sheet = /[\s']/.test(source.sheet) ? "'" + source.sheet.replace(/'/g, "''") + "'" : source.sheet;
  return tableNameLiteral(source.table) + ':\nLOAD ' + fieldsText + '\nFROM [' + source.path + ']\n(ooxml, embedded labels, table is ' + sheet + ');';
}

function qvdLoad(source) {
  const fields = normalizeFields(source.fields);
  const fieldsText = fields.length ? fields.join(', ') : '*';
  return tableNameLiteral(source.table) + ':\nLOAD ' + fieldsText + '\nFROM [' + source.path + ']\n(qvd);';
}

// generateScript(spec) → текст скрипта загрузки для app.setScript()
function generateScript(spec) {
  const src = spec.source;
  const tableName = src.table || 'Data';
  const normalized = { ...src, table: tableName };
  let load;
  if (src.type === 'inline') load = inlineLoad(normalized);
  else if (src.type === 'excel') load = excelLoad(normalized);
  else if (src.type === 'qvd') load = qvdLoad(normalized);
  else throw new Error('Неизвестный тип источника: ' + src.type);
  return setBlock() + '\n\n' + load + '\n';
}

module.exports = { generateScript };
