// Подключение к Qlik Engine API (порт 4747) через enigma.js.
// Аутентификация: клиентские сертификаты из QMC + заголовок X-Qlik-User.
const enigma = require('enigma.js');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');

const SCHEMA = require('enigma.js/schemas/12.612.0.json');

function openSession(cfg) {
  return enigma.create({
    schema: SCHEMA,
    url: `wss://${cfg.host}:${cfg.port}/app/engineData`,
    createSocket: url => new WebSocket(url, {
      ca: [fs.readFileSync(path.join(cfg.certDir, 'root.pem'))],
      cert: fs.readFileSync(path.join(cfg.certDir, 'client.pem')),
      key: fs.readFileSync(path.join(cfg.certDir, 'client_key.pem')),
      headers: { 'X-Qlik-User': `UserDirectory=${cfg.userDirectory}; UserId=${cfg.userId}` },
      rejectUnauthorized: !!cfg.rejectUnauthorized
    })
  });
}

// withSession(cfg, async global => { ... }) — сессия закрывается в любом случае
async function withSession(cfg, fn) {
  const session = openSession(cfg);
  try {
    const global = await session.open();
    try {
      return await fn(global);
    } finally {
      try { await session.close(); } catch (_) { /* сессия уже закрыта */ }
    }
  } catch (e) {
    try { await session.close(); } catch (_) { /* игнорируем */ }
    throw e;
  }
}

async function openAppById(global, appId) {
  return global.openDoc(appId);
}

// Удаление приложений с заданным именем (политика замены при пересборке)
async function deleteAppsByName(global, appName) {
  const docs = await global.getDocList();
  const removed = [];
  for (const d of docs.filter(d => d.qDocName === appName)) {
    try {
      await global.deleteApp(d.qDocId);
      removed.push(d.qDocId);
    } catch (e) {
      console.warn('Не удалось удалить старое приложение ' + d.qDocId + ':', e.message);
    }
  }
  return removed;
}

module.exports = { openSession, withSession, openAppById, deleteAppsByName };
