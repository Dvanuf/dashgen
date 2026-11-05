// Загрузка и проверка конфигурации окружения Qlik.
// Пути строятся через path.join и os.homedir — работает на macOS и Windows одинаково.
// Реальный config.json не коммитится (см. .gitignore); в репозитории лежит config.example.json.
const fs = require('fs');
const path = require('path');
const os = require('os');

const REQUIRED = ['host', 'port', 'certDir', 'userDirectory', 'userId'];

// ~/... разворачивается в домашний каталог на любой платформе
function expandPath(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function loadConfig(configPath) {
  // В собранном .app конфиг ищем в userData (DASHGEN_CONFIG_DIR); в dev — в корне проекта
  const defaultDir = process.env.DASHGEN_CONFIG_DIR || path.join(__dirname, '..');
  const resolved = path.resolve(configPath || path.join(defaultDir, 'config.json'));
  if (!fs.existsSync(resolved)) {
    throw new Error('Конфиг не найден: ' + resolved + ' — создайте его из config.example.json');
  }
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const cfg = { ...raw, certDir: expandPath(raw.certDir) };
  const missing = REQUIRED.filter(k => cfg[k] === undefined);
  if (missing.length) throw new Error('В конфиге не хватает ключей: ' + missing.join(', '));

  for (const f of ['root.pem', 'client.pem', 'client_key.pem']) {
    const fp = path.join(cfg.certDir, f);
    if (!fs.existsSync(fp)) throw new Error('Не найден сертификат: ' + fp);
  }

  cfg.privacy = cfg.privacy || {};
  cfg.privacy.bannedColumns = cfg.privacy.bannedColumns || [];
  cfg.privacy.bannedPatterns = cfg.privacy.bannedPatterns || ['инн', 'телефон', 'фио', 'паспорт', 'e-?mail'];
  return cfg;
}

module.exports = { loadConfig, expandPath };
