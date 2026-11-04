// Слой источников: единый интерфейс adapter.profile(...) → SourceProfile.
// Конвейер не знает типа источника; новый тип добавляется своим файлом здесь.
const path = require('path');
const excel = require(path.join(__dirname, 'excel'));
const qvd = require(path.join(__dirname, 'qvd'));

const ADAPTERS = { excel, qvd };

// profileSource('excel', '/path/file.xlsx', { sheet: 'Лист1' }) → SourceProfile
function profileSource(type, filePath, options) {
  const adapter = ADAPTERS[type];
  if (!adapter) {
    throw new Error('Неизвестный тип источника: ' + type + ' (доступны: ' + Object.keys(ADAPTERS).join(', ') + ')');
  }
  return adapter.profile(filePath, options);
}

module.exports = { ADAPTERS, profileSource };
