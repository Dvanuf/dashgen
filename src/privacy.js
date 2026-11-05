// Граница безопасности: в ИИ уходит ТОЛЬКО вывод этого модуля, а не данные из excel-reader.
// Значения, свободный текст и метаданные файла не передаются никогда.
const fs = require('fs');
const path = require('path');

function bannedDetector(options) {
  const exact = new Set((options.bannedColumns || []).map(s => s.toLowerCase()));
  const patterns = (options.bannedPatterns || []).map(p => {
    try { return new RegExp(p, 'i'); } catch (_) { return null; }
  }).filter(Boolean);
  return name => exact.has(String(name).toLowerCase()) || patterns.some(re => re.test(String(name)));
}

// makeSafeProfile(SourceProfile, options) → безопасный профиль для ИИ (режим schema)
function makeSafeProfile(sourceProfile, options = {}) {
  const banned = bannedDetector(options);
  const excluded = [];
  const tables = sourceProfile.tables.map(t => {
    const columns = [];
    for (const c of t.columns) {
      if (banned(c.name)) { excluded.push({ table: t.name, column: c.name }); continue; }
      columns.push({ name: c.name, type: c.type, distinct: c.distinct, nulls: c.nulls });
    }
    return { name: t.name, rowCount: t.rowCount, columns };
  });
  return {
    mode: 'schema',
    generatedAt: new Date().toISOString(),
    source: { type: sourceProfile.sourceType, file: sourceProfile.file },
    tables,
    excludedColumns: excluded
  };
}

// Журнал отправок: время, содержимое, адресат — хранится только локально (logs/ вне git)
function journal(safeProfile, destination, logsDir) {
  const dir = logsDir || process.env.DASHGEN_DATA_DIR || path.join(__dirname, '..', 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    destination,
    bytes: JSON.stringify(safeProfile).length,
    tables: safeProfile.tables.map(t => t.name)
  }) + '\n';
  fs.appendFileSync(path.join(dir, 'privacy-send.jsonl'), line);
}

module.exports = { makeSafeProfile, journal, bannedDetector };
