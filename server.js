// Локальный сервер интерфейса Dashgen: статика из public/ + JSON API над движком src/.
// Слушает только 127.0.0.1 — наружу не доступен. Зависимостей нет: встроенный http.
const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');

const PORT = 4748;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const EXAMPLES = path.join(ROOT, 'examples');
const TMP = path.join(ROOT, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

const { loadConfig } = require('./src/config');
const { profileSource } = require('./src/sources');
const { loadSpec, validateSpec } = require('./src/spec-validator');
const privacy = require('./src/privacy');

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

// ── API ──
const api = {
  'GET /api/config': () => {
    if (!CFG) return [500, { error: 'config.json не найден — скопируйте config.example.json и заполните' }];
    return [200, {
      host: CFG.host, portEngine: CFG.port, portQrs: 4242,
      userDirectory: CFG.userDirectory, userId: CFG.userId,
      certDir: CFG.certDir, rejectUnauthorized: CFG.rejectUnauthorized,
      privacy: CFG.privacy
    }];
  },

  'GET /api/specs': () => {
    const files = fs.readdirSync(EXAMPLES).filter(f => f.endsWith('.json')).map(f => {
      const spec = JSON.parse(fs.readFileSync(path.join(EXAMPLES, f), 'utf8'));
      return { name: f, appName: spec.appName, description: spec.description || '' };
    });
    return [200, { specs: files }];
  },

  'GET /api/spec': (req, res, url) => {
    const name = safeName(url.searchParams.get('name'));
    if (!name.endsWith('.json')) return [400, { error: 'Ожидается имя .json' }];
    const fp = path.join(EXAMPLES, name);
    if (!fp.startsWith(EXAMPLES) || !fs.existsSync(fp)) return [404, { error: 'spec не найден: ' + name }];
    return [200, { name, spec: JSON.parse(fs.readFileSync(fp, 'utf8')) }];
  },

  'POST /api/check': async req => {
    const body = await readBody(req);
    const result = validateSpec(JSON.parse(body.toString('utf8')));
    return [200, result];
  },

  'POST /api/test-connection': async () => {
    if (!CFG) return [500, { error: 'config.json не найден' }];
    const [engine, qrs] = await Promise.all([tcpCheck(CFG.host, CFG.port), tcpCheck(CFG.host, 4242)]);
    return [200, { host: CFG.host, engine, qrs }];
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
  }
};

function profileFile(fp, url) {
  const type = fp.toLowerCase().endsWith('.qvd') ? 'qvd' : 'excel';
  const sheet = url.searchParams.get('sheet') || undefined;
  try {
    const sourceProfile = profileSource(type, fp, { sheet });
    const safeProfile = privacy.makeSafeProfile(sourceProfile, CFG ? CFG.privacy : {});
    return [200, { sourceProfile, safeProfile }];
  } catch (e) {
    return [400, { error: e.message }];
  }
}

// Сборка: {specName} или {spec}
const apiBuild = {
  'POST /api/build': async req => {
    if (!CFG) return [500, { error: 'config.json не найден' }];
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    let spec;
    if (body.specName) {
      const name = safeName(body.specName);
      const fp = path.join(EXAMPLES, name);
      if (!fp.startsWith(EXAMPLES) || !fs.existsSync(fp)) return [404, { error: 'spec не найден: ' + name }];
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
