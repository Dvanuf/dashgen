// Локальный сервер интерфейса Dashgen: статика из public/ + JSON API над движком src/.
// Слушает только 127.0.0.1 — наружу не доступен. Зависимостей нет: встроенный http.
// Долгие операции (ИИ, сборка) отдают лог потоком событий SSE — интерфейс видит прогресс.
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

// Поток событий SSE: emit({type:'log', text}) → интерфейс показывает строку сразу
function sseStart(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  return obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
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

// Хеш версии spec: для файла — по байтам файла; для spec из памяти — по его JSON.
// По хешу сверяется утверждение перед публикацией.
function specHash(fp) {
  return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
}
function specObjHash(specObj) {
  return crypto.createHash('sha256').update(JSON.stringify(specObj)).digest('hex');
}

function appendLog(file, entry) {
  fs.appendFileSync(path.join(LOGS, file), JSON.stringify(entry) + '\n');
}

function readLogLines(file) {
  const fp = path.join(LOGS, file);
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
}

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

// ── API (JSON, короткие операции) ──
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

  'GET /api/state': () => [200, { profile: lastProfile }],

  // ── ключ ИИ-провайдера: статус и установка из интерфейса ──
  // Ключ пишется в ~/.dashgen/zai_api_key (chmod 600), в git/логи/ответы не попадает.
  'GET /api/key-status': () => {
    const keyFile = path.join(require('os').homedir(), '.dashgen', 'zai_api_key');
    if (process.env.ZAI_API_KEY) return [200, { present: true, source: 'env' }];
    return [200, { present: fs.existsSync(keyFile), source: 'file' }];
  },

  'POST /api/set-api-key': async req => {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const key = String(body.key || '').trim();
    if (!key) return [400, { error: 'Пустой ключ' }];
    if (key.length < 10) return [400, { error: 'Ключ подозрительно короткий — проверьте, что вставлен целиком' }];
    const fp = path.join(require('os').homedir(), '.dashgen', 'zai_api_key');
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, key + '\n', { mode: 0o600 });
    fs.chmodSync(fp, 0o600);
    return [200, { present: true, source: 'file', file: fp }];
  },

  // ── платформа/модель ИИ ──
  'GET /api/ai-presets': () => {
    const presets = [
      { id: 'zai-open', label: 'Z.ai Open Platform', baseUrl: 'https://api.z.ai/api/paas/v4' },
      { id: 'zai-coding', label: 'Z.ai Coding Plan', baseUrl: 'https://api.z.ai/api/coding/paas/v4' },
      { id: 'bigmodel', label: 'BigModel (Китай)', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }
    ];
    return [200, { presets, current: CFG && CFG.ai ? { baseUrl: CFG.ai.baseUrl, model: CFG.ai.model } : null }];
  },

  'POST /api/set-ai-endpoint': async req => {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!CFG) return [500, { error: 'config.json не найден' }];
    const baseUrl = String(body.baseUrl || '').trim().replace(/\/$/, '');
    const model = String(body.model || '').trim();
    if (baseUrl && !/^https:\/\//.test(baseUrl)) return [400, { error: 'baseUrl должен начинаться с https://' }];
    if (!CFG.ai) CFG.ai = {};
    if (baseUrl) CFG.ai.baseUrl = baseUrl;
    if (model) CFG.ai.model = model;
    const cfgPath = path.join(ROOT, 'config.json');
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    raw.ai = raw.ai || {};
    if (baseUrl) raw.ai.baseUrl = CFG.ai.baseUrl;
    if (model) raw.ai.model = CFG.ai.model;
    fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
    return [200, { ai: { baseUrl: CFG.ai.baseUrl, model: CFG.ai.model } }];
  },

  // ── публикация (QRS 4242) ──

  'GET /api/streams': async () => {
    if (!CFG) return [500, { error: 'config.json не найден' }];
    try { return [200, { streams: await qrs.listStreams(CFG) }]; }
    catch (e) { return [502, { error: 'QRS недоступен: ' + e.message }]; }
  },

  'GET /api/approvals': () => [200, { approvals: readLogLines('approvals.jsonl').slice(-20).reverse() }],

  // Зафиксировать утверждение: {specName | spec, approvedBy} → запись в журнале с хешем версии.
  // Работает и для spec-файла, и для сгенерированного/изменённого ИИ spec из памяти.
  'POST /api/approve': async req => {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!body.approvedBy || !String(body.approvedBy).trim()) return [400, { error: 'Укажите, кто утвердил' }];
    let specObj, hash, specName;
    if (body.specName) {
      const { fp, name } = specPathByName(body.specName);
      specObj = JSON.parse(fs.readFileSync(fp, 'utf8'));
      hash = specHash(fp);
      specName = name;
    } else if (body.spec && typeof body.spec === 'object') {
      specObj = body.spec;
      hash = specObjHash(specObj);
      specName = null;
    } else {
      return [400, { error: 'Нужен specName или spec' }];
    }
    const v = validateSpec(specObj);
    if (!v.ok) return [400, { error: 'spec не прошёл валидацию — утверждать нельзя', validation: v.errors }];
    const entry = {
      at: new Date().toISOString(),
      approvedBy: String(body.approvedBy).trim(),
      specName: specName || '(в памяти, не сохранён)',
      appName: specObj.appName,
      hash
    };
    appendLog('approvals.jsonl', entry);
    return [200, { entry }];
  },

  // Публикация: {specName | spec, streamId} — только при утверждённой версии spec.
  'POST /api/publish': async req => {
    if (!CFG) return [500, { error: 'config.json не найден' }];
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!body.streamId) return [400, { error: 'Укажите streamId' }];
    let specObj, hash, specName;
    if (body.specName) {
      const { fp, name } = specPathByName(body.specName);
      specObj = JSON.parse(fs.readFileSync(fp, 'utf8'));
      hash = specHash(fp);
      specName = name;
    } else if (body.spec && typeof body.spec === 'object') {
      specObj = body.spec;
      hash = specObjHash(specObj);
      specName = '(в памяти, не сохранён)';
    } else {
      return [400, { error: 'Нужен specName или spec' }];
    }
    const approval = readLogLines('approvals.jsonl').find(a => a.hash === hash);
    if (!approval) {
      return [403, { error: 'Утверждение для этой версии spec не найдено — сначала зафиксируйте утверждение (кто и когда)' }];
    }
    try {
      const app = await qrs.findAppByName(CFG, specObj.appName);
      if (!app) return [404, { error: 'Приложение «' + specObj.appName + '» не найдено — сначала соберите его (шаг «Сборка»)' }];
      if (app.published) {
        return [409, { error: 'Приложение уже опубликовано в стрим «' + (app.stream ? app.stream.name : '?') + '». Замена опубликованных версий — следующий шаг этапа 9.' }];
      }
      const published = await qrs.publishApp(CFG, app.id, body.streamId);
      appendLog('publish.jsonl', {
        at: new Date().toISOString(), specName, hash, appName: specObj.appName,
        appId: published.id, stream: published.stream, approvedBy: approval.approvedBy
      });
      return [200, { published }];
    } catch (e) {
      return [502, { error: 'QRS: ' + e.message }];
    }
  }
};

// ── Долгие операции: SSE-поток с живым логом ──

// Генерация spec ИИ: {profile?, description} → SSE {log}… {done: {spec, attempts}}
async function streamGenerate(req, res, url) {
  const emit = sseStart(res);
  try {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    const profile = (body.profile && body.profile.tables) ? body.profile : (lastProfile && lastProfile.safeProfile);
    if (!profile) { emit({ type: 'error', message: 'Нужен безопасный профиль (сначала профилируйте источник)' }); return res.end(); }
    if (!body.description || !String(body.description).trim()) { emit({ type: 'error', message: 'Опишите отчёт словами — что показывать' }); return res.end(); }
    if (profile.mode !== 'schema') { emit({ type: 'error', message: 'Ожидается профиль режима schema (вывод privacy), а не SourceProfile' }); return res.end(); }
    const aiCfg = (CFG && CFG.ai) || null;
    if (!aiCfg) { emit({ type: 'error', message: 'В config.json нет блока ai (provider/baseUrl/model)' }); return res.end(); }
    const { generateSpec } = require('./src/ai/generate-spec');
    const r = await generateSpec({
      safeProfile: profile,
      description: String(body.description),
      aiCfg,
      excelLib: body.excelLib ? String(body.excelLib) : null,
      log: l => emit({ type: 'log', text: String(l) })
    });
    privacy.journal(profile, aiCfg.baseUrl + ' (' + aiCfg.model + ')');
    emit({ type: 'log', text: 'Отправка профиля записана в журнал (logs/privacy-send.jsonl)' });
    emit({ type: 'done', spec: r.spec, attempts: r.attempts });
  } catch (e) {
    emit({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
  res.end();
}

// Правка spec словами: {spec, instruction} → SSE {log}… {done: {spec, attempts}}
async function streamPatch(req, res, url) {
  const emit = sseStart(res);
  try {
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    if (!body.spec || typeof body.spec !== 'object') { emit({ type: 'error', message: 'Нужен текущий spec (откройте или сгенерируйте его на шаге «Спецификация»)' }); return res.end(); }
    if (!body.instruction || !String(body.instruction).trim()) { emit({ type: 'error', message: 'Опишите желаемое изменение словами' }); return res.end(); }
    const aiCfg = (CFG && CFG.ai) || null;
    if (!aiCfg) { emit({ type: 'error', message: 'В config.json нет блока ai' }); return res.end(); }
    const { patchSpec } = require('./src/ai/patch-spec');
    const r = await patchSpec({ spec: body.spec, instruction: String(body.instruction), aiCfg, log: l => emit({ type: 'log', text: String(l) }) });
    emit({ type: 'done', spec: r.spec, attempts: r.attempts });
  } catch (e) {
    emit({ type: 'error', message: e && e.message ? e.message : String(e) });
  }
  res.end();
}

// Сборка + verify + самоисправление: {specName | spec} → SSE {log}… {done: {...}}
async function streamBuild(req, res, url) {
  const emit = sseStart(res);
  const logLines = [];
  const log = line => { logLines.push(String(line)); emit({ type: 'log', text: String(line) }); };
  try {
    if (!CFG) { emit({ type: 'error', message: 'config.json не найден' }); return res.end(); }
    const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
    let spec;
    if (body.specName) {
      try {
        const { fp } = specPathByName(body.specName);
        spec = loadSpec(fp);
      } catch (e) { emit({ type: 'error', message: e.message }); return res.end(); }
    } else if (body.spec && typeof body.spec === 'object') {
      const v = validateSpec(body.spec);
      if (!v.ok) { emit({ type: 'error', message: 'spec не прошёл валидацию', validation: v.errors }); return res.end(); }
      spec = body.spec;
    } else {
      emit({ type: 'error', message: 'Укажите specName или spec' }); return res.end();
    }

    const builder = require('./src/builder');
    const { verify, printReport } = require('./src/verify');
    try {
      const buildResult = await builder.build(spec, CFG, log);
      const verifyReport = await verify(CFG, buildResult.appId, spec, buildResult);
      printReport(verifyReport, log);
      emit({ type: 'done', build: buildResult, verify: verifyReport });
      return res.end();
    } catch (e) {
      let diagnosis = e && e.qlikReloadFailure ? e.diagnosis : null;
      log('СБОЙ СБОРКИ: ' + (e && e.message ? e.message : e));
      // Этап 7, самоисправление: сбой загрузки уходит модели, она правит spec, пересборка.
      const aiCfg = CFG.ai;
      if (diagnosis && aiCfg) {
        let working = spec;
        for (let i = 1; i <= 3; i++) {
          log('Самоисправление, цикл ' + i + ' из 3: отправляю диагноз в модель…');
          try {
            const { fixBuild } = require('./src/ai/fix-build');
            const fixed = await fixBuild({ spec: working, diagnosis, aiCfg, log });
            working = fixed.spec;
            log('Модель исправила spec за ' + fixed.attempts + ' попыт(и) — пересобираю…');
            const buildResult = await builder.build(working, CFG, log);
            const verifyReport = await verify(CFG, buildResult.appId, working, buildResult);
            printReport(verifyReport, l => log(String(l)));
            log('ИТОГ: сборка после самоисправления прошла успешно');
            emit({ type: 'done', build: buildResult, verify: verifyReport, healed: { spec: working, cycles: i } });
            return res.end();
          } catch (healErr) {
            if (!healErr || !healErr.qlikReloadFailure) {
              log('Самоисправление не удалось: ' + (healErr && healErr.message));
              break;
            }
            diagnosis = healErr.diagnosis;
          }
        }
        log('ИТОГ: самоисправление не сработало за 3 цикла — исправьте spec вручную');
        emit({ type: 'error', message: diagnosis });
        return res.end();
      }
      emit({ type: 'error', message: e && e.message ? e.message : String(e) });
      return res.end();
    }
  } catch (e) {
    emit({ type: 'error', message: e && e.message ? e.message : String(e) });
    res.end();
  }
}

const STREAM_ROUTES = { '/api/generate-spec': streamGenerate, '/api/patch-spec': streamPatch, '/api/build': streamBuild };

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
    if (req.method === 'POST' && STREAM_ROUTES[url.pathname]) return await STREAM_ROUTES[url.pathname](req, res, url);
    if (api[key]) return json(res, ...(await api[key](req, res, url)));
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
