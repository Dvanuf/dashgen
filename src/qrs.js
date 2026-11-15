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

// Список приложений (для выбора цели attach): [{id, name, published, stream, modifiedDate}]
async function listApps(cfg) {
  const apps = await request(cfg, 'GET', '/qrs/app/full');
  return (apps || []).map(a => ({
    id: a.id, name: a.name, published: !!a.published,
    stream: a.stream ? { id: a.stream.id, name: a.stream.name } : null,
    modifiedDate: a.modifiedDate
  }));
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

// ---- Перезагрузка данных через одноразовую QRS-задачу ----
// На ряде серверов (стандартный режим движка) doReload по прямой сессии 4747
// мгновенно возвращает false — рабочая перезагрузка только задачей.
// ВАЖНО: скрипт приложения должен быть сохранён (doSave) ДО запуска задачи —
// задача читает скрипт из сохранённого приложения.

// Создание одноразовой задачи перезагрузки приложения → id задачи
async function createReloadTask(cfg, appId, taskName) {
  const task = await request(cfg, 'POST', '/qrs/reloadtask', {
    name: taskName,
    taskType: 0,
    app: { id: appId },
    taskSessionTimeout: 1440,
    maxRetries: 0
  });
  return task.id;
}

// Запуск задачи: /qrs/reloadtask/{id}/start на части серверов даёт 404 —
// работает общий эндпоинт /qrs/task/{id}/start (204)
async function startTask(cfg, taskId) {
  return request(cfg, 'POST', `/qrs/task/${taskId}/start`);
}

// Опрос результатов выполнения до терминального статуса.
// Статусы: 7 = FinishedSuccess, 6 = Aborted, 8 = FinishedFail.
// → { ok, status, duration, messages, timedOut }
async function waitForTask(cfg, taskId, opts = {}) {
  const pollMs = opts.pollMs || 2000;
  const timeoutMs = (opts.timeoutMin || 30) * 60 * 1000;
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const results = await request(cfg, 'GET', '/qrs/executionresult/full');
    const rows = (results || []).filter(r => r.taskID === taskId);
    last = rows[rows.length - 1] || null;
    const st = last ? last.status : null;
    if (st === 7 || st === 6 || st === 8) break;
    await new Promise(r => setTimeout(r, pollMs));
  }
  const status = last ? last.status : null;
  const messages = [];
  if (last && Array.isArray(last.details)) {
    for (const d of last.details) if (d && d.message) messages.push(String(d.message));
  }
  return {
    ok: status === 7,
    status,
    duration: last ? last.duration : null,
    messages,
    timedOut: status === null || (status !== 7 && status !== 6 && status !== 8)
  };
}

// Удаление одноразовой задачи (после выполнения; ошибка не критична)
async function deleteReloadTask(cfg, taskId) {
  try { await request(cfg, 'DELETE', `/qrs/reloadtask/${taskId}`); return true; }
  catch (_) { return false; }
}

// Список имён установленных расширений (для идемпотентной загрузки)
async function listExtensions(cfg) {
  const exts = await request(cfg, 'GET', '/qrs/extension/full');
  return (exts || []).map(e => e.name);
}

// Загрузка расширения: multipart qextFile + file(zip) — HTTP 201.
// request() шлёт JSON, поэтому multipart собирается вручную (граница + две части).
function uploadExtension(cfg, extName, qextJson, zipBuffer) {
  const boundary = '----dashgen-ext-' + Date.now();
  const pre = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="qextFile"; filename="${extName}.qext"\r\n` +
    `Content-Type: application/json\r\n\r\n`);
  const mid = Buffer.from(
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${extName}.zip"\r\n` +
    `Content-Type: application/zip\r\n\r\n`);
  const end = Buffer.from(`\r\n--${boundary}--\r\n`);
  const payload = Buffer.concat([pre, Buffer.from(String(qextJson), 'utf8'), mid, Buffer.from(zipBuffer), end]);
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: cfg.host,
      port: cfg.qrsPort || 4242,
      path: '/qrs/extension/upload?xrfkey=' + XRF,
      method: 'POST',
      headers: {
        'X-Qlik-User': `UserDirectory=${cfg.userDirectory}; UserId=${cfg.userId}`,
        'X-Qlik-Xrfkey': XRF,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': payload.length
      },
      ca: [fs.readFileSync(path.join(cfg.certDir, 'root.pem'))],
      cert: fs.readFileSync(path.join(cfg.certDir, 'client.pem')),
      key: fs.readFileSync(path.join(cfg.certDir, 'client_key.pem')),
      rejectUnauthorized: !!cfg.rejectUnauthorized,
      timeout: 60000
    }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) reject(new Error('QRS uploadExtension → HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
        else resolve(data ? JSON.parse(data) : null);
      });
    });
    req.on('timeout', () => req.destroy(new Error('QRS: таймаут загрузки расширения')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { request, listStreams, listApps, findAppByName, publishApp, createReloadTask, startTask, waitForTask, deleteReloadTask, listExtensions, uploadExtension };
