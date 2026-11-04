// Адаптер QVD: заголовок — XML-секция в конце файла — парсится локально.
// Значения не читаются: для режима privacy schema этого достаточно, их читает только движок Qlik.
const fs = require('fs');
const path = require('path');

// Коды NumberFormat.Type в заголовке QVD
const TYPE_MAP = { 4: 'text', 5: 'text', 6: 'number', 7: 'number', 8: 'integer', 12: 'date' };

function profile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error('Файл не найден: ' + resolved);

  const stat = fs.statSync(resolved);
  const tailSize = Math.min(stat.size, 2 * 1024 * 1024); // заголовок обычно меньше 2 МБ
  const fd = fs.openSync(resolved, 'r');
  try {
    const buf = Buffer.alloc(tailSize);
    fs.readSync(fd, buf, 0, tailSize, stat.size - tailSize);
    const tail = buf.toString('utf8');

    const start = tail.lastIndexOf('<QvdTableHeader>');
    const endMarker = '</QvdTableHeader>';
    const end = tail.lastIndexOf(endMarker);
    if (start === -1 || end === -1 || end < start) {
      throw new Error('Не найден заголовок QVD (файл повреждён или это не QVD): ' + resolved);
    }
    const xml = tail.slice(start, end + endMarker.length);

    const rowCount = Number((xml.match(/<RowCount>(\d+)<\/RowCount>/) || [])[1] || 0);
    const columns = [];
    const re = /<QvdFieldHeader>([\s\S]*?)<\/QvdFieldHeader>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const block = m[1];
      const name = ((block.match(/<FieldName>([\s\S]*?)<\/FieldName>/) || [])[1] || '').trim();
      const typeCode = Number((block.match(/<Type>(\d+)<\/Type>/) || [])[1] || 0);
      columns.push({ name, type: TYPE_MAP[typeCode] || 'text', typeCode, distinct: null, nulls: null });
    }

    return {
      sourceType: 'qvd',
      file: path.basename(resolved),
      tables: [{ name: path.basename(resolved, path.extname(resolved)), rowCount, columns }],
      keyCandidates: [],
      joinCandidates: []
    };
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { profile };
