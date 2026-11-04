// Адаптер Excel: чтение листов и построение SourceProfile — локально, полный проход.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

function inferType(values) {
  const vals = values.filter(v => v !== null && v !== undefined && v !== '');
  if (!vals.length) return 'empty';
  if (vals.every(v => typeof v === 'number')) return 'number';
  if (vals.every(v => v instanceof Date)) return 'date';
  return 'text';
}

function profile(filePath, options = {}) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error('Файл не найден: ' + resolved);
  const wb = XLSX.readFile(resolved, { cellDates: true });

  let sheetNames = wb.SheetNames;
  if (options.sheet) {
    if (!wb.SheetNames.includes(options.sheet)) {
      throw new Error('Лист «' + options.sheet + '» не найден. Доступны: ' + wb.SheetNames.join(', '));
    }
    sheetNames = [options.sheet];
  }

  const tables = sheetNames.map(name => {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    const header = (rows[0] || []).map(String);
    const body = rows.slice(1).filter(r => r.some(v => v !== null && v !== undefined && v !== ''));
    const columns = header.map((h, i) => {
      const colVals = body.map(r => r[i]);
      const nonEmpty = colVals.filter(v => v !== null && v !== undefined && v !== '');
      return {
        name: h,
        type: inferType(colVals),
        distinct: new Set(nonEmpty).size,
        nulls: colVals.length - nonEmpty.length
      };
    });
    return { name, rowCount: body.length, columns };
  });

  return {
    sourceType: 'excel',
    file: path.basename(resolved),
    tables,
    keyCandidates: [],
    joinCandidates: []
  };
}

module.exports = { profile };
