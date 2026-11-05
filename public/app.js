// Dashgen UI — логика конвейера: профиль → приватность → spec → макет → сборка → публикация.
// Долгие операции читают SSE-поток сервера: лог появляется построчно, есть таймер прогресса.
'use strict';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = () => { if (window.lucide) window.lucide.createIcons({ attrs: { width: 16, height: 16 } }); };

const state = {
  config: null, spec: null, specName: null, specHash: null,
  approvals: [], streams: [], specChecked: false, built: false, published: false, verifyOk: false
};

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// Долгая операция с живым логом: сервер отвечает SSE {log|done|error}
async function apiStream(path, bodyObj, logEl) {
  const res = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bodyObj)
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok && !ct.includes('event-stream')) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || res.statusText);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', done = null, error = null;
  while (true) {
    const { value, done: fin } = await reader.read();
    if (fin) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
      if (!chunk.startsWith('data:')) continue;
      let ev; try { ev = JSON.parse(chunk.slice(5)); } catch (_) { continue; }
      if (ev.type === 'log') { logEl.textContent += (logEl.textContent ? '\n' : '') + ev.text; logEl.scrollTop = logEl.scrollHeight; }
      else if (ev.type === 'done') done = ev;
      else if (ev.type === 'error') error = new Error(ev.message);
    }
  }
  if (error) throw error;
  if (!done) throw new Error('Операция прервана без результата');
  return done;
}

// Прогресс: спиннер + фаза + секундомер (видно, что идёт работа, а не зависло)
let progressTimer = null;
function progressStart(logEl, phaseText) {
  progressStop();
  const bar = document.createElement('div');
  bar.className = 'dg-progress';
  bar.innerHTML = '<span class="dg-spin" aria-hidden="true"></span><span class="dg-phase">' + esc(phaseText) + '</span><span class="dg-secs">0 с</span>';
  logEl.classList.remove('dg-hidden', 'is-err');
  logEl.textContent = '';
  logEl.parentNode.insertBefore(bar, logEl);
  const t0 = Date.now();
  const secs = bar.querySelector('.dg-secs');
  progressTimer = { bar, interval: setInterval(() => { secs.textContent = Math.round((Date.now() - t0) / 1000) + ' с'; }, 500) };
}
function progressPhase(text) {
  if (progressTimer) progressTimer.bar.querySelector('.dg-phase').textContent = text;
}
function progressStop(ok) {
  if (!progressTimer) return;
  clearInterval(progressTimer.interval);
  progressTimer.bar.remove();
  progressTimer = null;
}

// ── навигация и статусы ──
const navBtns = document.querySelectorAll('.dg-navbtn');
navBtns.forEach(btn => btn.addEventListener('click', () => {
  navBtns.forEach(b => b.classList.toggle('is-on', b === btn));
  document.querySelectorAll('.dg-panel').forEach(p => { p.hidden = p.id !== 'dg-p-' + btn.dataset.step; });
}));

function pipeDone(names) {
  document.querySelectorAll('.dg-pipestep').forEach(el => el.classList.toggle('is-done', names.includes(el.dataset.pipe)));
}

function setStatus(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text || '';
}

// ── маршруты этапов: подсветка выполненных пунктов ──
function refreshGuides() {
  const marks = {
    'dg-guide-source': [!!state.safeProfile],
    'dg-guide-spec': [!!state.spec, !!state.specChecked],
    'dg-guide-layout': [!!state.spec, !!state.built],
    'dg-guide-build': [!!state.built, !!(state.built && state.verifyOk)],
    'dg-guide-publish': [!!state.built, currentSpecApproved(), !!state.published]
  };
  Object.entries(marks).forEach(([id, flags]) => {
    const el = document.getElementById(id);
    if (!el) return;
    [...el.children].forEach((li, i) => li.classList.toggle('is-done', !!flags[i]));
  });
}

// ── конфиг и подключения ──
async function loadConfig() {
  try {
    const cfg = await api('/api/config');
    state.config = cfg;
    $('#dg-srv-chip').innerHTML = '<i data-lucide="server" aria-hidden="true"></i> ' + esc(cfg.host);
    $('#dg-cfg-chip').textContent = 'config загружен';
    $('#dg-cfg-chip').className = 'dg-chipstat is-ok';
    $('#dg-user-chip').textContent = cfg.userDirectory + '\\' + cfg.userId;
    $('#dg-conn-host').textContent = cfg.host;
    $('#dg-conn-ports').textContent = 'Engine ' + cfg.portEngine + ' · QRS ' + cfg.portQrs + ' · сертификаты ' + cfg.certDir;
    $('#dg-conn-table').innerHTML = [
      ['Host', cfg.host], ['Engine API', 'порт ' + cfg.portEngine + ' · enigma.js · схема 12.612.0'],
      ['QRS API', 'порт ' + cfg.portQrs + ' · публикация, стримы'], ['Сертификаты', cfg.certDir],
      ['Учётная запись', cfg.userDirectory + '\\' + cfg.userId],
      ['ИИ-провайдер', cfg.ai ? cfg.ai.model + ' · ' + cfg.ai.baseUrl : 'не задан (блок ai в config.json)']
    ].map(r => '<tr><td style="color:var(--dg-mut);width:40%;">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>').join('');
    setStatus('dg-st-conn', '✓');
  } catch (e) {
    $('#dg-cfg-chip').textContent = 'config.json не найден';
    $('#dg-cfg-chip').className = 'dg-chipstat is-bad';
  }
  icons();
}

$('#dg-btn-test-conn').addEventListener('click', async () => {
  const note = $('#dg-conn-test-note');
  note.textContent = 'Проверка Engine 4747 и QRS 4242…';
  try {
    const r = await api('/api/test-connection', { method: 'POST' });
    note.textContent = 'Engine: ' + (r.engine ? 'succeeded ✓' : 'недоступен ✗') + ' · QRS: ' + (r.qrs ? 'отвечает ✓' : 'недоступен ✗');
  } catch (e) { note.textContent = 'Ошибка: ' + e.message; }
});

// ── источник ──
document.querySelectorAll('.dg-chip[data-src]').forEach(chip => chip.addEventListener('click', () => {
  document.querySelectorAll('.dg-chip[data-src]').forEach(c => c.classList.toggle('is-on', c === chip));
  $('#dg-src-share').classList.toggle('dg-hidden', chip.dataset.src !== 'share');
  $('#dg-src-path').classList.toggle('dg-hidden', chip.dataset.src !== 'path');
  $('#dg-src-upload').classList.toggle('dg-hidden', chip.dataset.src !== 'upload');
}));

function renderProfile(data) {
  state.sourceProfile = data.sourceProfile;
  state.safeProfile = data.safeProfile;
  const sp = data.sourceProfile;
  const banned = new Set((data.safeProfile.excludedColumns || []).map(x => x.table + '::' + x.column));
  let html = '';
  for (const t of sp.tables) {
    html += '<div class="dg-card"><p class="dg-cardtitle"><i data-lucide="table" aria-hidden="true"></i>' + esc(t.name) +
      ' <span class="dg-note" style="font-weight:400;">· ' + t.rowCount + ' строк · ' + sp.sourceType + '</span></p>' +
      '<table class="dg-table"><thead><tr><th>Колонка</th><th>Тип</th><th class="num">Уник.</th><th class="num">Проп.</th><th>Профиль для ИИ</th></tr></thead><tbody>';
    for (const c of t.columns) {
      const isBanned = banned.has(t.name + '::' + c.name);
      html += '<tr' + (isBanned ? ' class="is-block"' : '') + '><td>' + esc(c.name) + '</td><td>' + esc(c.type) +
        '</td><td class="num">' + (c.distinct ?? '—') + '</td><td class="num">' + (c.nulls ?? '—') + '</td><td>' +
        (isBanned ? '🔒 запрещённая колонка' : 'в профиле') + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '<div class="dg-rowbtn"><span class="dg-badge dg-badge--ok"><i data-lucide="check" aria-hidden="true"></i>профиль построен локально</span>' +
    '<span class="dg-note">В ИИ уйдёт только схема — см. шаг «Приватность».</span></div>';
  $('#dg-profile-out').innerHTML = html;
  renderPrivacy(data.safeProfile);
  setStatus('dg-st-source', '✓'); setStatus('dg-st-privacy', '✓');
  pipeDone(['source', 'profile', 'privacy']);
  refreshGuides();
  icons();
}

function renderPrivacy(safe) {
  $('#dg-privacy-out').innerHTML = '<pre class="dg-code">' + esc(JSON.stringify(safe, null, 2)) + '</pre>';
  $('#dg-privacy-actions').style.display = 'flex';
  const excl = (safe.excludedColumns || []);
  $('#dg-priv-excluded').innerHTML = excl.length
    ? '<p class="dg-note" style="margin:8px 0 4px;">Исключено из профиля:</p><div class="dg-chips">' +
      excl.map(x => '<span class="dg-chip">🔒 ' + esc(x.column) + '</span>').join('') + '</div>'
    : '';
}

$('#dg-btn-profile-path').addEventListener('click', async () => {
  const p = $('#dg-src-path-in').value.trim();
  if (!p) return;
  const body = { path: p };
  const sheet = $('#dg-src-sheet-in').value.trim();
  if (sheet) body.sheet = sheet;
  $('#dg-profile-out').innerHTML = '<div class="card dg-note">Профилирую…</div>';
  try { renderProfile(await api('/api/profile-path', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })); }
  catch (e) { $('#dg-profile-out').innerHTML = '<div class="dg-card dg-note">Ошибка: ' + esc(e.message) + '</div>'; }
});

$('#dg-btn-profile-upload').addEventListener('click', async () => {
  const f = $('#dg-src-file').files[0];
  if (!f) return;
  $('#dg-profile-out').innerHTML = '<div class="dg-card dg-note">Загружаю и профилирую…</div>';
  try { renderProfile(await api('/api/profile?name=' + encodeURIComponent(f.name), { method: 'POST', body: f })); }
  catch (e) { $('#dg-profile-out').innerHTML = '<div class="dg-card dg-note">Ошибка: ' + esc(e.message) + '</div>'; }
});

// ── спецификация ──
async function loadSpecList() {
  const { specs } = await api('/api/specs');
  $('#dg-spec-select').innerHTML = specs.map(s =>
    '<option value="' + esc(s.name) + '">' + esc(s.appName) + ' · ' + esc(s.hash) + '</option>').join('');
  if (specs.length) await loadSpec(specs[0].name);
}

async function loadSpec(name) {
  const data = await api('/api/spec?name=' + encodeURIComponent(name));
  state.spec = data.spec;
  state.specName = data.name;
  state.specHash = data.hash;
  state.specChecked = false;
  state.built = false;
  state.published = false;
  $('#dg-spec-view').textContent = JSON.stringify(data.spec, null, 2);
  $('#dg-top-spec').textContent = data.spec.appName;
  $('#dg-build-spec-name').textContent = data.spec.appName;
  $('#dg-spec-hash').textContent = data.hash.slice(0, 8);
  $('#dg-publish-hash').textContent = data.hash.slice(0, 8);
  $('#dg-spec-check-out').innerHTML = '';
  $('#dg-spec-badge').classList.add('dg-hidden');
  setStatus('dg-st-spec', '');
  renderLayout(data.spec);
  refreshGuides();
  icons();
}

$('#dg-btn-spec-load').addEventListener('click', () => loadSpec($('#dg-spec-select').value));
$('#dg-spec-select').addEventListener('change', () => loadSpec($('#dg-spec-select').value));

$('#dg-btn-spec-check').addEventListener('click', async () => {
  if (!state.spec) return;
  try {
    const r = await api('/api/check', { method: 'POST', body: JSON.stringify(state.spec), headers: { 'Content-Type': 'application/json' } });
    if (r.ok) {
      state.specChecked = true;
      $('#dg-spec-check-out').innerHTML = '<div class="dg-rowbtn" style="margin-top:10px;"><span class="dg-badge dg-badge--ok"><i data-lucide="check" aria-hidden="true"></i>схема v1, ссылки и сетка — корректны</span></div>';
      $('#dg-spec-badge').classList.remove('dg-hidden');
      setStatus('dg-st-spec', '✓');
    } else {
      state.specChecked = false;
      $('#dg-spec-check-out').innerHTML = '<pre class="dg-code is-err">' + esc(r.errors.join('\n')) + '</pre>';
    }
  } catch (e) { $('#dg-spec-check-out').innerHTML = '<pre class="dg-code is-err">' + esc(e.message) + '</pre>'; }
  refreshGuides();
  icons();
});

// ── проект ИИ: ключ провайдера ──
async function loadKeyStatus() {
  try {
    const st = await api('/api/key-status');
    $('#dg-key-row').classList.toggle('dg-hidden', st.present);
    $('#dg-key-badge').classList.toggle('dg-hidden', !st.present);
    $('#dg-btn-rekey').classList.toggle('dg-hidden', !st.present);
  } catch (e) { /* поле остаётся видимым */ }
}

$('#dg-btn-rekey').addEventListener('click', () => {
  $('#dg-key-row').classList.remove('dg-hidden');
  $('#dg-key-input').focus();
});

$('#dg-btn-save-key').addEventListener('click', async () => {
  const key = $('#dg-key-input').value.trim();
  if (!key) return;
  try {
    await api('/api/set-api-key', { method: 'POST', body: JSON.stringify({ key }), headers: { 'Content-Type': 'application/json' } });
    $('#dg-key-input').value = '';
    await loadKeyStatus();
    const logEl = $('#dg-ai-log');
    logEl.classList.remove('dg-hidden', 'is-err');
    logEl.textContent = 'Ключ сохранён в ~/.dashgen/zai_api_key (chmod 600). Можно генерировать.';
  } catch (e) {
    const logEl = $('#dg-ai-log');
    logEl.classList.remove('dg-hidden');
    logEl.classList.add('is-err');
    logEl.textContent = 'Ошибка сохранения ключа: ' + e.message;
  }
});

// ── проект ИИ: платформа и модель ──
async function loadAiPresets() {
  const r = await api('/api/ai-presets');
  const sel = $('#dg-ai-endpoint');
  sel.innerHTML = r.presets.map(p => '<option value="' + esc(p.baseUrl) + '">' + esc(p.label) + '</option>').join('');
  const cur = r.current && r.current.baseUrl;
  if (cur && !r.presets.some(p => p.baseUrl === cur)) {
    sel.insertAdjacentHTML('beforeend', '<option value="' + esc(cur) + '">Свой URL</option>');
  }
  if (cur) sel.value = cur;
  if (r.current && r.current.model) $('#dg-ai-model-in').value = r.current.model;
}

async function saveAiEndpoint() {
  try {
    await api('/api/set-ai-endpoint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: $('#dg-ai-endpoint').value, model: $('#dg-ai-model-in').value.trim() })
    });
    $('#dg-endpoint-saved').textContent = 'сохранено ✓';
    setTimeout(() => { $('#dg-endpoint-saved').textContent = ''; }, 2500);
  } catch (e) {
    $('#dg-endpoint-saved').textContent = 'ошибка: ' + e.message;
  }
}

$('#dg-ai-endpoint').addEventListener('change', saveAiEndpoint);
$('#dg-ai-model-in').addEventListener('change', saveAiEndpoint);

// ── проект ИИ: генерация spec (SSE, живой прогресс) ──
$('#dg-btn-ai-gen').addEventListener('click', async () => {
  const btn = $('#dg-btn-ai-gen'), logEl = $('#dg-ai-log');
  const desc = $('#dg-ai-desc').value.trim();
  if (!desc) { logEl.classList.remove('dg-hidden'); logEl.classList.add('is-err'); logEl.textContent = 'Опишите отчёт — что показывать.'; return; }
  if (!state.safeProfile) { logEl.classList.remove('dg-hidden'); logEl.classList.add('is-err'); logEl.textContent = 'Сначала профилируйте источник на шаге «Источник».'; return; }
  btn.disabled = true;
  progressStart(logEl, 'Готовлю профиль и отправляю модели…');
  try {
    const r = await apiStream('/api/generate-spec', { profile: state.safeProfile, description: desc }, text => {
      progressPhase('Модель работает…');
      logEl.textContent += (logEl.textContent ? '\n' : '') + text;
    });
    progressStop(true);
    state.spec = r.spec;
    state.specName = null;
    state.specHash = null;
    state.specChecked = true;
    state.built = false;
    state.published = false;
    $('#dg-spec-view').textContent = JSON.stringify(r.spec, null, 2);
    $('#dg-top-spec').textContent = r.spec.appName;
    $('#dg-build-spec-name').textContent = r.spec.appName + ' (сгенерирован ИИ, не сохранён)';
    $('#dg-spec-hash').textContent = '—'; $('#dg-publish-hash').textContent = '—';
    setStatus('dg-st-spec', '✓');
    $('#dg-spec-check-out').innerHTML = '<span class="dg-note">Сгенерирован за ' + r.attempts + ' попыт. Перейдите на «Макет» или собирайте черновик.</span>';
    renderLayout(r.spec);
    pipeDone(['source', 'profile', 'privacy', 'spec']);
  } catch (e) {
    progressStop(false);
    logEl.classList.add('is-err');
    let msg = 'ОШИБКА: ' + e.message;
    if (/HTTP 401/.test(e.message)) msg += '\nПодсказка: ключ отклонён — проверьте платформу и нажмите «Заменить ключ».';
    logEl.textContent += '\n' + msg;
  } finally { btn.disabled = false; refreshGuides(); updateApprovalBadge(); icons(); }
});

// ── макет ──
function renderLayout(spec) {
  const size = { kpi: [5, 3], linechart: [10, 4], barchart: [10, 4], table: [20, 5], listbox: [4, 4] };
  const cells = [];
  for (const sheet of spec.sheets || []) {
    for (const o of sheet.objects || []) {
      const [dc, dr] = size[o.type] || [4, 3];
      const cs = o.colspan || dc, rs = o.rowspan || dr;
      const kind = o.type === 'kpi' ? 'kpi' : (o.type === 'linechart' || o.type === 'barchart') ? 'chart' : '';
      cells.push('<div class="gcell ' + kind + '" style="left:' + (o.col / 24 * 100) + '%;top:' + (o.row / 12 * 100) +
        '%;width:' + (cs / 24 * 100) + '%;height:' + (rs / 12 * 100) + '%;">' +
        '<div class="k">' + esc(o.type) + '</div><div class="t">' + esc(o.title || o.field || o.measure || '') + '</div>' +
        (kind === 'chart' ? '<div class="ph"></div>' : '') + '</div>');
    }
  }
  $('#dg-layout-out').innerHTML = '<div class="dg-grid">' + cells.join('') + '</div>' +
    '<p class="dg-note" style="margin:8px 0 0;">Лист «' + esc((spec.sheets[0] || {}).title || '') + '»</p>';
}

// ── правка макета словами (SSE, живой прогресс) ──
$('#dg-btn-patch').addEventListener('click', async () => {
  const btn = $('#dg-btn-patch'), logEl = $('#dg-patch-log');
  const instruction = $('#dg-patch-in').value.trim();
  if (!instruction) return;
  if (!state.spec) { logEl.classList.remove('dg-hidden'); logEl.classList.add('is-err'); logEl.textContent = 'Сначала откройте или сгенерируйте spec на шаге «Спецификация».'; return; }
  btn.disabled = true;
  progressStart(logEl, 'Отправляю spec и правку в модель…');
  try {
    const r = await apiStream('/api/patch-spec', { spec: state.spec, instruction }, text => {
      progressPhase('Модель формирует правку…');
      logEl.textContent += (logEl.textContent ? '\n' : '') + text;
    });
    progressStop(true);
    state.spec = r.spec;
    state.specName = null;
    state.specHash = null;
    state.specChecked = true;
    state.built = false;
    state.published = false;
    $('#dg-spec-view').textContent = JSON.stringify(r.spec, null, 2);
    $('#dg-top-spec').textContent = r.spec.appName + ' (изменён)';
    $('#dg-build-spec-name').textContent = r.spec.appName + ' (изменён, не сохранён)';
    $('#dg-spec-hash').textContent = '—'; $('#dg-publish-hash').textContent = '—';
    renderLayout(r.spec);
    logEl.textContent += '\nМакет обновлён. Пересоберите черновик на вкладке «Сборка и проверка».';
    setStatus('dg-st-spec', '✓');
  } catch (e) {
    progressStop(false);
    logEl.classList.add('is-err');
    logEl.textContent += '\nОШИБКА: ' + e.message;
  } finally { btn.disabled = false; refreshGuides(); updateApprovalBadge(); icons(); }
});

// ── сборка (SSE, живой прогресс и самоисправление) ──
$('#dg-btn-build').addEventListener('click', async () => {
  if (!state.spec) return;
  const btn = $('#dg-btn-build'), timer = $('#dg-build-timer');
  btn.disabled = true;
  const logEl = $('#dg-build-log');
  const t0 = Date.now();
  progressStart(logEl, 'Подключаюсь к Qlik и собираю приложение…');
  const tick = setInterval(() => { timer.textContent = 'идёт сборка… ' + Math.round((Date.now() - t0) / 1000) + ' с'; }, 500);
  const payload = state.specName ? { specName: state.specName } : { spec: state.spec };
  try {
    const r = await apiStream('/api/build', payload, text => {
      if (/Самоисправление/.test(text)) progressPhase('Сборка упала — модель исправляет spec…');
      else if (/Модель исправила/.test(text)) progressPhase('Пересобираю с исправлениями…');
      else if (/Загрузка|данные/i.test(text)) progressPhase('Загружаю данные в Qlik…');
      else progressPhase('Сборка в Qlik…');
      logEl.textContent += (logEl.textContent ? '\n' : '') + text;
      logEl.scrollTop = logEl.scrollHeight;
    });
    clearInterval(tick);
    progressStop(true);
    timer.textContent = 'готово за ' + Math.round((Date.now() - t0) / 1000) + ' с';
    logEl.classList.add('is-ok');
    if (r.healed && r.healed.spec) {
      state.spec = r.healed.spec;
      state.specName = null;
      state.specHash = null;
      state.specChecked = true;
      $('#dg-spec-view').textContent = JSON.stringify(r.healed.spec, null, 2);
      $('#dg-build-spec-name').textContent = r.healed.spec.appName + ' (исправлен ИИ, циклов: ' + r.healed.cycles + ')';
    }
    state.built = true;
    state.published = false;
    renderVerify(r.verify);
    setStatus('dg-st-build', '✓');
    pipeDone(['source', 'profile', 'privacy', 'spec', 'build']);
  } catch (e) {
    clearInterval(tick);
    progressStop(false);
    timer.textContent = '';
    state.built = false;
    logEl.textContent += '\nОШИБКА: ' + e.message;
    logEl.classList.add('is-err');
  } finally { btn.disabled = false; refreshGuides(); icons(); }
});

function renderVerify(v) {
  if (!v) return;
  state.verifyOk = !v.objectErrors.length && v.rowsMatch !== false;
  const rows = [];
  for (const h of v.hyperCubes) rows.push('<li><span class="ic"><i data-lucide="check" aria-hidden="true"></i></span><span>' +
    esc(h.type) + ' «' + esc(h.title) + '»: <b>' + h.rows + '×' + h.cols + '</b></span></li>');
  if (v.objectErrors.length) for (const e of v.objectErrors) rows.push('<li><span class="ic" style="background:color-mix(in srgb,var(--dg-bad) 15%,transparent);color:var(--dg-bad);"><i data-lucide="x" aria-hidden="true"></i></span><span>' + esc(e.type) + ' «' + esc(e.title) + '»: ' + esc(e.error) + '</span></li>');
  if (v.expectedRows !== undefined) rows.push('<li><span class="ic"><i data-lucide="check" aria-hidden="true"></i></span><span>Сверка строк: <b>' + v.modelRows + ' / ' + v.expectedRows + '</b> — ' + (v.rowsMatch ? 'совпадает' : 'РАСХОЖДЕНИЕ') + '</span></li>');
  $('#dg-verify-out').innerHTML = '<div class="dg-card"><p class="dg-cardtitle"><i data-lucide="list-checks" aria-hidden="true"></i>Проверка перед публикацией ' +
    '<span class="dg-badge ' + (v.objectErrors.length ? 'dg-badge--warn' : 'dg-badge--ok') + '" style="margin-left:auto;">' +
    (v.objectErrors.length ? 'ошибок: ' + v.objectErrors.length : 'расхождений нет') + '</span></p><ul class="dg-checks">' + rows.join('') + '</ul>' +
    '<div class="dg-rowbtn"><a class="dg-btn" href="https://' + esc(state.config ? state.config.host : '') + '/hub" target="_blank" rel="noopener"><i data-lucide="external-link" aria-hidden="true"></i>Открыть в Hub</a></div></div>';
  icons();
}

// ── публикация ──
async function loadStreams() {
  const sel = $('#dg-stream-select');
  try {
    const r = await api('/api/streams');
    state.streams = r.streams;
    sel.innerHTML = r.streams.map(s => '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>').join('');
  } catch (e) {
    sel.innerHTML = '<option value="">— нет доступа к QRS —</option>';
    $('#dg-publish-result').textContent = e.message;
  }
}

async function loadApprovals() {
  const r = await api('/api/approvals');
  state.approvals = r.approvals;
  const rows = r.approvals.map(a =>
    '<tr><td>' + esc(a.specName) + '</td><td>' + esc(a.approvedBy) + '</td><td>' + esc((a.at || '').slice(0, 16).replace('T', ' ')) + '</td><td class="dg-mono">' + esc((a.hash || '').slice(0, 8)) + '</td></tr>').join('');
  $('#dg-approvals-out').innerHTML = rows
    ? '<table class="dg-table"><thead><tr><th>Spec</th><th>Утвердил</th><th>Когда</th><th>Хеш</th></tr></thead><tbody>' + rows + '</tbody></table>'
    : '<p class="dg-note">Утверждений пока нет.</p>';
  updateApprovalBadge();
}

function currentSpecApproved() {
  return state.specHash && state.approvals.some(a => a.hash === state.specHash);
}

function updateApprovalBadge() {
  const badge = $('#dg-approval-badge'), btn = $('#dg-btn-publish');
  if (currentSpecApproved()) {
    badge.textContent = 'утверждено';
    badge.className = 'dg-badge dg-badge--ok';
    btn.disabled = false;
    setStatus('dg-st-publish', '');
  } else {
    badge.textContent = state.spec ? 'требуется утверждение' : 'spec не выбран';
    badge.className = 'dg-badge dg-badge--warn';
    btn.disabled = true;
    setStatus('dg-st-publish', '🔒');
  }
}

$('#dg-btn-approve').addEventListener('click', async () => {
  const by = $('#dg-approve-by').value.trim();
  if (!by) { $('#dg-publish-result').textContent = 'Впишите, кто утвердил.'; return; }
  if (!state.spec) { $('#dg-publish-result').textContent = 'Сначала откройте или сгенерируйте spec.'; return; }
  try {
    // работает и для spec-файла, и для сгенерированного/изменённого ИИ (spec в памяти)
    const body = state.specName
      ? { specName: state.specName, approvedBy: by }
      : { spec: state.spec, approvedBy: by };
    const r = await api('/api/approve', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    state.specHash = r.entry.hash;
    $('#dg-approve-by').value = '';
    $('#dg-publish-hash').textContent = r.entry.hash.slice(0, 8);
    await loadApprovals();
    refreshGuides();
  } catch (e) { $('#dg-publish-result').textContent = 'Ошибка: ' + e.message; }
});

$('#dg-btn-streams').addEventListener('click', loadStreams);

$('#dg-btn-publish').addEventListener('click', async () => {
  if (!state.spec || !$('#dg-stream-select').value) return;
  const btn = $('#dg-btn-publish');
  btn.disabled = true;
  $('#dg-publish-result').textContent = 'Публикую через QRS…';
  try {
    const body = state.specName
      ? { specName: state.specName, streamId: $('#dg-stream-select').value }
      : { spec: state.spec, streamId: $('#dg-stream-select').value };
    const r = await api('/api/publish', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
    const st = r.published.stream || {};
    state.published = true;
    $('#dg-publish-result').innerHTML = '<span class="dg-badge dg-badge--ok"><i data-lucide="check" aria-hidden="true"></i>опубликовано в стрим «' + esc(st.name || '') + '»</span>';
    pipeDone(['source', 'profile', 'privacy', 'spec', 'build', 'publish']);
    setStatus('dg-st-publish', '✓');
  } catch (e) {
    $('#dg-publish-result').textContent = 'Ошибка: ' + e.message;
  } finally { btn.disabled = false; refreshGuides(); updateApprovalBadge(); icons(); }
});

// ── браузер сетевой папки Qlik ──
const share = { rel: '', selected: null, status: null };

async function shareLoad() {
  const st = await api('/api/share-status');
  share.status = st;
  const badge = $('#dg-share-status');
  if (st.mounted && st.exists) {
    badge.textContent = 'шара подключена';
    badge.className = 'dg-badge dg-badge--ok';
    $('#dg-btn-share-mount').classList.add('dg-hidden');
    await shareList('');
  } else if (st.mounted && !st.exists) {
    badge.textContent = 'папка ' + st.userDir + ' на шаре не найдена';
    badge.className = 'dg-badge dg-badge--warn';
    $('#dg-share-list').innerHTML = '<p class="dg-note">Создайте папку <span class="dg-mono">' + esc(st.userDir) + '</span> на шаре или проверьте имя.</p>';
  } else {
    badge.textContent = 'шара не подключена';
    badge.className = 'dg-badge dg-badge--warn';
    $('#dg-btn-share-mount').classList.remove('dg-hidden');
    $('#dg-share-list').innerHTML = '<p class="dg-note">Подключите шару — Finder запросит доменные креды.</p>';
  }
}

$('#dg-btn-share-mount').addEventListener('click', async () => {
  const badge = $('#dg-share-status');
  badge.textContent = 'подключаю…';
  try { await api('/api/share-mount', { method: 'POST' }); }
  catch (e) { badge.textContent = 'ошибка подключения'; return; }
  await shareLoad();
});

async function shareList(sub) {
  const r = await api('/api/share-files?sub=' + encodeURIComponent(sub));
  share.rel = r.sub || '';
  share.selected = null;
  $('#dg-share-actions').style.display = 'none';
  $('#dg-share-selected').textContent = 'Выберите файл кликом — путь lib:// построится сам, inline не будет.';
  const crumbs = [[r.sub ? 'корень' : '', '']];
  const parts = (r.sub || '').split('/').filter(Boolean);
  let acc = '';
  parts.forEach(p => { acc += (acc ? '/' : '') + p; crumbs.push([p, acc]); });
  $('#dg-share-crumbs').innerHTML = crumbs.map((c, i) =>
    (i ? ' / ' : '') + '<a data-sub="' + esc(c[1]) + '">' + esc(c[0] || 'корень') + '</a>').join('');
  $('#dg-share-crumbs').querySelectorAll('a').forEach(a => a.addEventListener('click', () => shareList(a.dataset.sub)));

  const list = $('#dg-share-list');
  let html = '';
  if (r.sub) html += '<button class="dg-share-item" type="button" data-up="1"><i data-lucide="arrow-left" aria-hidden="true"></i>… назад</button>';
  for (const f of r.folders || []) {
    html += '<button class="dg-share-item" type="button" data-folder="' + esc(f) + '"><i data-lucide="folder" aria-hidden="true"></i>' + esc(f) + '</button>';
  }
  for (const f of r.files || []) {
    html += '<button class="dg-share-item" type="button" data-file="' + esc(f.name) + '"><i data-lucide="file-spreadsheet" aria-hidden="true"></i>' + esc(f.name) +
      '<span class="meta">' + Math.round(f.size / 1024) + ' КБ · ' + new Date(f.mtime).toLocaleDateString('ru') + '</span></button>';
  }
  if (!r.folders?.length && !r.files?.length) html += '<p class="dg-note" style="padding:8px;">Папка пуста — скопируйте сюда .xlsx через Finder.</p>';
  list.innerHTML = '<div class="dg-share-list">' + html + '</div>';
  icons();

  list.querySelectorAll('[data-up]').forEach(b => b.addEventListener('click', () => {
    const parts = (share.rel || '').split('/').filter(Boolean); parts.pop();
    shareList(parts.join('/'));
  }));
  list.querySelectorAll('[data-folder]').forEach(b => b.addEventListener('click', () => {
    shareList((share.rel ? share.rel + '/' : '') + b.dataset.folder);
  }));
  list.querySelectorAll('[data-file]').forEach(b => b.addEventListener('click', () => {
    list.querySelectorAll('.dg-share-item').forEach(x => x.classList.remove('is-on'));
    b.classList.add('is-on');
    selectShareFile(b.dataset.file);
  }));
}

async function selectShareFile(name) {
  share.selected = name;
  const rel = (share.rel ? share.rel + '/' : '') + name;
  const localPath = (share.status ? share.status.root : '/Volumes/Users/anufriev_d_v') + '/' + rel;
  $('#dg-share-actions').style.display = 'flex';
  $('#dg-share-selected').innerHTML = 'Выбран: <b>' + esc(name) + '</b> → <span class="dg-mono">lib://Рабочие_папки_разработчиков/anufriev_d_v/' + esc(rel) + '</span>';
  shareHistoryAdd(name, rel);
  $('#dg-profile-out').innerHTML = '<div class="dg-card dg-note">Профилирую выбранный файл…</div>';
  try {
    const data = await api('/api/profile-path', { method: 'POST', body: JSON.stringify({ path: localPath }), headers: { 'Content-Type': 'application/json' } });
    renderProfile(data);
  } catch (e) {
    $('#dg-profile-out').innerHTML = '<div class="dg-card dg-note">Ошибка: ' + esc(e.message) + '</div>';
  }
}

// история выбранных файлов (вариант 3): localStorage
function shareHistoryAdd(name, rel) {
  try {
    const h = JSON.parse(localStorage.getItem('dg_share_history') || '[]').filter(x => x.rel !== rel);
    h.unshift({ name, rel, at: Date.now() });
    localStorage.setItem('dg_share_history', JSON.stringify(h.slice(0, 5)));
  } catch (_) {}
  shareHistoryRender();
}

function shareHistoryRender() {
  let h = [];
  try { h = JSON.parse(localStorage.getItem('dg_share_history') || '[]'); } catch (_) {}
  const sel = $('#dg-share-history');
  if (!h.length) { sel.classList.add('dg-hidden'); return; }
  sel.classList.remove('dg-hidden');
  sel.innerHTML = '<option value="">Недавние…</option>' + h.map(x => '<option value="' + esc(x.rel) + '">' + esc(x.name) + '</option>').join('');
  sel.onchange = async () => {
    if (!sel.value) return;
    const parts = sel.value.split('/'); parts.pop();
    await shareList(parts.join('/'));
    const item = $('#dg-share-list [data-file="' + CSS.escape(parts.length ? '' : '') + '"]') || null;
    // выбор файла из истории: открываем папку и выбираем по имени
    const name = h.find(x => x.rel === sel.value).name;
    const btn = [...document.querySelectorAll('#dg-share-list [data-file]')].find(b => b.dataset.file === name);
    if (btn) btn.click();
  };
}

$('#dg-btn-profile-share').addEventListener('click', () => {
  if (!share.selected) return;
  // повторное профилирование (например, файл обновился на шаре)
  selectShareFile(share.selected);
});

$('#dg-btn-gen-share').addEventListener('click', async () => {
  const btn = $('#dg-btn-gen-share'), logEl = $('#dg-ai-log');
  if (!share.selected) { logEl.classList.remove('dg-hidden'); logEl.classList.add('is-err'); logEl.textContent = 'Выберите файл в списке выше.'; return; }
  if (!state.safeProfile) { logEl.classList.remove('dg-hidden'); logEl.classList.add('is-err'); logEl.textContent = 'Сначала профилируйте выбранный файл.'; return; }
  const rel = (share.rel ? share.rel + '/' : '') + share.selected;
  const excelLib = 'lib://Рабочие_папки_разработчиков/anufriev_d_v/' + rel;
  navBtns.forEach(b => b.classList.toggle('is-on', b.dataset.step === 'spec'));
  document.querySelectorAll('.dg-panel').forEach(p => { p.hidden = p.id !== 'dg-p-spec'; });
  btn.disabled = true;
  progressStart(logEl, 'Генерирую spec с excel-источником: ' + excelLib);
  try {
    const r = await apiStream('/api/generate-spec', {
      profile: state.safeProfile,
      description: $('#dg-ai-desc').value.trim() || 'Дашборд по профилю файла: KPI, динамика, детализация.',
      excelLib
    }, text => {
      progressPhase('Модель формирует spec (реальные данные)…');
      logEl.textContent += (logEl.textContent ? '\n' : '') + text;
    });
    progressStop(true);
    state.spec = r.spec;
    state.specName = null;
    state.specHash = null;
    state.specChecked = true;
    state.built = false;
    state.published = false;
    $('#dg-spec-view').textContent = JSON.stringify(r.spec, null, 2);
    $('#dg-top-spec').textContent = r.spec.appName;
    $('#dg-build-spec-name').textContent = r.spec.appName + ' (excel: ' + share.selected + ')';
    setStatus('dg-st-spec', '✓');
    renderLayout(r.spec);
  } catch (e) {
    progressStop(false);
    logEl.classList.add('is-err');
    logEl.textContent += '\nОШИБКА: ' + e.message;
  } finally { btn.disabled = false; refreshGuides(); updateApprovalBadge(); icons(); }
});

// ── старт ──
(async () => {
  await loadConfig();
  await loadSpecList().catch(e => console.warn(e));
  await loadApprovals().catch(e => console.warn(e));
  await loadStreams().catch(e => console.warn(e));
  await loadKeyStatus().catch(e => console.warn(e));
  await loadAiPresets().catch(e => console.warn(e));
  await shareLoad().catch(e => console.warn(e));
  try {
    const st = await api('/api/state');
    if (st.profile && st.profile.safeProfile) {
      renderProfile(st.profile);
      const note = document.createElement('div');
      note.className = 'dg-note';
      note.style.marginTop = '6px';
      note.textContent = 'Восстановлен последний профиль: ' + st.profile.file + ' (от ' + (st.profile.at || '').slice(0, 16).replace('T', ' ') + ')';
      $('#dg-profile-out').appendChild(note);
    }
  } catch (e) { console.warn(e); }
  refreshGuides();
  icons();
})();
