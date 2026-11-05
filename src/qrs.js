// Клиент QRS API (порт 4242): публикация приложений в стрим.
// Те же сертификаты, что и для Engine, плюс заголовок X-Qlik-Xrfkey (требование QRS).
const fs = require('fs');
const path = require('path');
const https = require('https');

const XRF = 'abcdefg123456789'; // 16 символов, произвольные

// request(cfg, 'GET', '/qrs/about') → распарсенный JSON или null
// Важно: QRS на Windows (HTTP.sys) требует Content-Length даже для запросов без тела —
// иначе HTTP 411; публикация приложения — метод PUT (POST даёт 404 No matching endpoint).
function request(cfg, method, apiPath, body) {
  const sep = apiPath.includes('?') ? '&' : '?';
  const fullPath = apiPath + sep + 'xrfkey=' + XRF;
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers = {
    'X-Qlik-User': `UserDirectory=${cfg.userDirectory}; UserId=${cfg.userId}`,
    'X-Qlik-Xrfkey': XRF,
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  };
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: cfg.host,
      port: cfg.qrsPort || 4242,
      path: fullPath,
      method,
      headers,
      ca: [fs.readFileSync(path.join(cfg.certDir, 'root.pem'))],
      cert: fs.readFileSync(path.join(cfg.certDir, 'client.pem')),
      key: fs.readFileSync(path.join(cfg.certDir, 'client_key.pem')),
      rejectUnauthorized: !!cfg.rejectUnauthorized,
      timeout: 20000
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error('QRS ' + method + ' ' + apiPath + ' → HTTP ' + res.statusCode + ': ' + data.slice(0, 300)));
        } else {
          resolve(data ? JSON.parse(data) : null);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('QRS: таймаут запроса')));
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// Список стримов: [{id, name}]
async function listStreams(cfg) {
  const streams = await request(cfg, 'GET', '/qrs/stream/full');
  return streams.map(s => ({ id: s.id, name: s.name }));
}

// Приложение по имени: {id, name, published, stream} | null
async function findAppByName(cfg, appName) {
  const filter = encodeURIComponent(`name eq '${appName.replace(/'/g, "''")}'`);
  const apps = await request(cfg, 'GET', '/qrs/app/full?filter=' + filter);
  if (!apps.length) return null;
  const a = apps[0];
  return { id: a.id, name: a.name, published: !!a.published, stream: a.stream ? { id: a.stream.id, name: a.stream.name } : null, modifiedDate: a.modifiedDate };
}

// Публикация приложения в стрим → {id, name, published, stream}
// Метод PUT: POST /publish на QRS возвращает 404 «No matching endpoint found»
async function publishApp(cfg, appId, streamId) {
  const app = await request(cfg, 'PUT', `/qrs/app/${appId}/publish?stream=${streamId}`);
  return { id: app.id, name: app.name, published: !!app.published, stream: app.stream ? { id: app.stream.id, name: app.stream.name } : null };
}

module.exports = { request, listStreams, findAppByName, publishApp };
