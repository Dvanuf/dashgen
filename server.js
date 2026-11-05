// Локальный сервер интерфейса Dashgen: статика из public/ + JSON API над движком src/.
// Слушает только 127.0.0.1 — наружу не доступен. Зависимостей нет: встроенный http.
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const PORT = 4748;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const EXAMPLES = path.join(ROOT, 'examples');
const TMP = path.join(ROOT, 'tmp');
const LOGS = path.join(ROOT, 'logs');
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

const { loadConfig } = require('./src/config');
const { profileSource } = require('./src/sources');
const { loadSpec, validateSpec } = require('./src/spec-validator');
const privacy = require('./src/privacy');
const qrs = require('./src/qrs');

let CFG = null;
try { CFG = loadConfig(); } catch (e) { console.warn('Конфиг не загружен: ' + e.message); }

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}

function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('Слишком большое тело запроса')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// TCP-проверка порта (то, что раньше делалось командой nc)
function tcpCheck(host, port, timeoutMs = 4000) {
  return new Promise(resolve => {
    const s = net.createConnection({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

function safeName(name) {
  const base = path.basename(String(name || 'file'));
  return base.replace(/[^a-zA-Z0-9._\u0400-\u04FF-]/g, '_');
}

function specPathByName(specName) {
  const name = safeName(specName);
  if (!name.endsWith('.json')) throw new Error('Ожидается имя .json');
  const fp = path.join(EXAMPLES, name);
  if (!fp.startsWith(EXAMPLES)) throw new Error('Некорректный путь spec');
  if (!fs.existsSync(fp)) throw new Error('spec не найден: ' + name);
  return { fp, name };
}

// SHA-256 содержимого spec-файла — версия, по которой сверяется утверждение
function specHash(fp) {
  return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
}

function appendLog(file, entry) {
  fs.appendFileSync(path.join(LOGS, file), JSON.stringify(entry) + '\n');
}

function readLogLines(file) {
  const fp = path.join(LOGS, file);
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

// ── API ──
const api = {
  'GET /api/config': () => {
    if (!CFG) return [500, { error: 'config.json не найден — скопируйте config.example.json и заполните' }];
    return [200, {
      host: CFG.host, portEngine: CFG.port, portQrs: 4242,
      userDirectory: CFG.userDirectory, userId: CFG.userId,
      certDir: CFG.certDir, rejectUnauthorized: CFG.rejectUnauthorized,
      ai: CFG.ai ? { baseUrl: CFG.ai.baseUrl, model: CFG.ai.model } : null,
      privacy: CFG.privacy
    }];
  },

  'GET /api/specs': () => {
    const files = fs.readdirSync(EXAMPLES).filter(f => f.endsWith('.json')).map(f => {
      const spec = JSON.parse(fs.readFileSync(path.join(EXAMPLES, f), 'utf8'));
      return { name: f, appName: spec.appName, description: spec.description || '', hash: specHash(path.join(EXAMPLES, f)).slice(0, 8) };
    });
    return [200, { specs: files }];
  },

  'GET /api/spec': (req, res, url) => {
    const { fp, name } = specPathByName(url.searchParams.get('name'));
    return [200, { name, spec: JSON.parse(fs.readFileSync(fp, 'utf8')), hash: specHash(fp) }];
  },

  'POST /api/check': async req => {
    const body = await readBody(req);
    const result = validateSpec(JSON.parse(body.toString('utf8')));
    return [200, result];
  },

  // Генерация spec ИИ-моделью: {profile (safeProfile!), description}
  // Граница: принимается только безопасный профиль; если не передан —
  // используется последний профилированный на сервере (тоже safeProfile).
  'POST /api/generate-spec': async req => {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const profile = (body.profile && body.profile.tables) ? body.profile : (lastProfile && lastProfile.safeProfile);
    if (!profile) return [400, { error: 'Нужен безопасный профиль (сначала профилируйте источник)' }];
    if (!body.description || !String(body.description).trim()) return [400, { error: 'Опишите отчёт словами — что показывать' }];
    if (profile.mode !== 'schema') return [400, { error: 'Ожидается профиль режима schema (вывод privacy), а не SourceProfile' }];
    const aiCfg = (CFG && CFG.ai) || null;
    if (!aiCfg) return [500, { error: 'В config.json нет блока ai (provider/baseUrl/model)' }];
    const logLines = [];
    const { generateSpec } = require('./src/ai/generate-spec');
    try {
      const r = await generateSpec({ safeProfile: profile, description: String(body.description), aiCfg, log: l => logLines.push(l) });
      privacy.journal(profile, aiCfg.baseUrl + ' (' + aiCfg.model + ')');
      logLines.push('Отправка профиля записана в журнал (logs/privacy-send.jsonl)');
      return [200, { spec: r.spec, attempts: r.attempts, log: logLines }];
    } catch (e) {
      logLines.push('ОШИБКА: ' + e.message);
      return [502, { error: e.message, log: logLines }];
    }
  },

  'POST /api/test-connection': async () => {
    if (!CFG) return [500, { error: 'config.json не найден' }];
    const [engine, qrsOk] = await Promise.all([tcpCheck(CFG.host, CFG.port), tcpCheck(CFG.host, 4242)]);
    return [200, { host: CFG.host, engine, qrs: qrsOk }];
  },

  // Загрузка файла из браузера: тело — бинарник файла, ?name=имя.xlsx
  'POST /api/profile': async (req, res, url) => {
    const name = safeName(url.searchParams.get('name'));
    const body = await readBody(req);
    const fp = path.join(TMP, name);
    fs.writeFileSync(fp, body);
    return profileFile(fp, url);
  },

  // Профиль файла, который уже лежит на этом компьютере: {path, sheet}
  'POST /api/profile-path': async req => {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!body.path) return [400, { error: 'Укажите path' }];
    return profileFile(body.path, new URL('http://x/?' + (body.sheet ? 'sheet=' + encodeURIComponent(body.sheet) : '')));
  },

  // ── Публикация (QRS 4242) ──

  'GET /api/streams': async () => {
    if (!CFG) return [500, { error: 'config.json не найден' }];
    try { return [200, { streams: await qrs.listStreams(CFG) }]; }
    catch (e) { return [502, { error: 'QRS недоступен: ' + e.message }]; }
  },

  'GET /api/approvals': () => [200, { approvals: readLogLines('approvals.jsonl').slice(-20).reverse() }],

  // Зафиксировать утверждение: {specName, approvedBy} → запись в журнал с хешем spec
  'POST /api/approve': async req => {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!body.approvedBy || !String(body.approvedBy).trim()) return [400, { error: 'Укажите, кто утвердил' }];
    const { fp, name } = specPathByName(body.specName);
    const spec = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const entry = {
      at: new Date().toISOString(),
      approvedBy: String(body.approvedBy).trim(),
      specName: name,
      appName: spec.appName,
      hash: specHash(fp)
    };
    appendLog('approvals.jsonl', entry);
    return [200, { entry }];
  },

  // Публикация: {specName, streamId} — только при утверждённой версии spec
  'POST /api/publish': async req => {
    if (!CFG) return [500, { error: 'config.json не найден' }];
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!body.streamId) return [400, { error: 'Укажите streamId' }];
    const { fp, name } = specPathByName(body.specName);
    const hash = specHash(fp);
    const approval = readLogLines('approvals.jsonl').find(a => a.hash === hash);
    if (!approval) {
      return [403, { error: 'Утверждение для этой версии spec не найдено — сначала зафиксируйте утверждение (кто и когда)' }];
    }
    const spec = JSON.parse(fs.readFileSync(fp, 'utf8'));
    try {
      const app = await qrs.findAppByName(CFG, spec.appName);
      if (!app) return [404, { error: 'Приложение «' + spec.appName + '» не найдено — сначала соберите его (шаг «Сборка»)' }];
      if (app.published) {
        return [409, { error: 'Приложение уже опубликовано в стрим «' + (app.stream ? app.stream.name : '?') + '». Замена опубликованных версий — следующий шаг этапа 9.' }];
      }
      const published = await qrs.publishApp(CFG, app.id, body.streamId);
      appendLog('publish.jsonl', {
        at: new Date().toISOString(), specName: name, hash, appName: spec.appName,
        appId: published.id, stream: published.stream, approvedBy: approval.approvedBy
      });
      return [200, { published }];
    } catch (e) {
      return [502, { error: 'QRS: ' + e.message }];
    }
  }
};

// Последний профилированный источник: переживает перезагрузку страницы (F5)
let lastProfile = null;

function profileFile(fp, url) {
  const type = fp.toLowerCase().endsWith('.qvd') ? 'qvd' : 'excel';
  const sheet = url.searchParams.get('sheet') || undefined;
  try {
    const sourceProfile = profileSource(type, fp, { sheet });
    const safeProfile = privacy.makeSafeProfile(sourceProfile, CFG ? CFG.privacy : {});
    lastProfile = { sourceProfile, safeProfile, file: path.basename(fp), at: new Date().toISOString() };
    return [200, { sourceProfile, safeProfile, file: lastProfile.file, at: lastProfile.at }];
  } catch (e) {
    return [400, { error: e.message }];
  }
}

// Текущее состояние конвейера для восстановления UI после F5
api['GET /api/state'] = () => [200, { profile: lastProfile }];

// Сборка: {specName} или {spec}
const apiBuild = {
  'POST /api/build': async req => {
    if (!CFG) return [500, { error: 'config.json не найден' }];
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    let spec;
    if (body.specName) {
      let fp;
      try { ({ fp } = specPathByName(body.specName)); } catch (e) { return [404, { error: e.message }]; }
      spec = loadSpec(fp);
    } else if (body.spec) {
      const v = validateSpec(body.spec);
      if (!v.ok) return [400, { error: 'spec не прошёл валидацию', validation: v.errors }];
      spec = body.spec;
    } else {
      return [400, { error: 'Укажите specName или spec' }];
    }

    const logLines = [];
    const log = line => { logLines.push(String(line)); };
    const builder = require('./src/builder');
    const { verify, printReport } = require('./src/verify');
    try {
      const buildResult = await builder.build(spec, CFG, log);
      const verifyReport = await verify(CFG, buildResult.appId, spec, buildResult);
      printReport(verifyReport, log);
      return [200, { log: logLines, build: buildResult, verify: verifyReport }];
    } catch (e) {
      logLines.push('ОШИБКА: ' + (e && e.message ? e.message : e));
      return [500, { log: logLines, error: e && e.message ? e.message : String(e) }];
    }
  }
};

// ── Статика ──
function serveStatic(res, urlPath) {
  let fp = path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath);
  if (!fp.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  const key = req.method + ' ' + url.pathname;
  try {
    if (api[key]) return json(res, ...(await api[key](req, res, url)));
    if (apiBuild[key]) return json(res, ...(await apiBuild[key](req, res, url)));
    if (req.method === 'GET') return serveStatic(res, url.pathname);
    return json(res, 404, { error: 'Неизвестный маршрут: ' + key });
  } catch (e) {
    console.error('API error:', e);
    return json(res, 500, { error: e && e.message ? e.message : String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Dashgen UI: http://127.0.0.1:' + PORT + '  (только localhost)');
});
