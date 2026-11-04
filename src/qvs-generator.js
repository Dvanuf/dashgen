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
  const s = String(v).replace(/"/g, '""');
  return '"' + s + '"';
}

function inlineLoad(source) {
  const rowsText = source.rows.map(r => r.map(qLiteral).join(', ')).join('\n');
  return source.table + ':\nLOAD * INLINE [\n' + source.fields.join(', ') + '\n' + rowsText + '\n];';
}

function excelLoad(source) {
  const fields = source.fields && source.fields.length ? source.fields.join(', ') : '*';
  const sheet = /[\s']/.test(source.sheet) ? "'" + source.sheet.replace(/'/g, "''") + "'" : source.sheet;
  return source.table + ':\nLOAD ' + fields + '\nFROM [' + source.path + ']\n(ooxml, embedded labels, table is ' + sheet + ');';
}

function qvdLoad(source) {
  const fields = source.fields && source.fields.length ? source.fields.join(', ') : '*';
  return source.table + ':\nLOAD ' + fields + '\nFROM [' + source.path + ']\n(qvd);';
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
