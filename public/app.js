// Dashgen UI — логика конвейера: профиль → приватность → spec → макет → сборка → публикация.
'use strict';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = () => { if (window.lucide) window.lucide.createIcons({ attrs: { width: 16, height: 16 } }); };

const state = { config: null, spec: null, specName: null, specHash: null, approvals: [], streams: [] };

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
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
    $('#dg-ai-model').textContent = cfg.ai && cfg.ai.model ? cfg.ai.model : 'не задан';
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
  $('#dg-src-path').classList.toggle('dg-hidden', chip.dataset.src !== 'path');
  $('#dg-src-upload').classList.toggle('dg-hidden', chip.dataset.src !== 'upload');
}));

function renderProfile(data) {
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
  $('#dg-profile-out').innerHTML = '<div class="dg-card dg-note">Профилирую…</div>';
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
  $('#dg-spec-view').textContent = JSON.stringify(data.spec, null, 2);
  $('#dg-top-spec').textContent = data.spec.appName;
  $('#dg-build-spec-name').textContent = data.spec.appName;
  $('#dg-spec-hash').textContent = data.hash.slice(0, 8);
  $('#dg-publish-hash').textContent = data.hash.slice(0, 8);
  $('#dg-spec-check-out').innerHTML = '';
  $('#dg-spec-badge').classList.add('dg-hidden');
  setStatus('dg-st-spec', '');
  renderLayout(data.spec);
  icons();
}

$('#dg-btn-spec-load').addEventListener('click', () => loadSpec($('#dg-spec-select').value));

// ── проект ИИ: генерация spec ──
$('#dg-btn-ai-gen').addEventListener('click', async () => {
  const btn = $('#dg-btn-ai-gen'), logEl = $('#dg-ai-log');
  const desc = $('#dg-ai-desc').value.trim();
  if (!desc) { logEl.classList.remove('dg-hidden'); logEl.classList.add('is-err'); logEl.textContent = 'Опишите отчёт — что показывать.'; return; }
  if (!state.safeProfile) { logEl.classList.remove('dg-hidden'); logEl.classList.add('is-err'); logEl.textContent = 'Сначала профилируйте источник на шаге «Источник».'; return; }
  btn.disabled = true;
  logEl.classList.remove('dg-hidden', 'is-err');
  logEl.textContent = 'Отправляю безопасный профиль в модель (только schema, без значений)…';
  try {
    const r = await api('/api/generate-spec', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: state.safeProfile, description: desc })
    });
    logEl.textContent = r.log.join('\n');
    // сгенерированный spec показываем и делаем текущим: можно проверить, собрать, утвердить
    state.spec = r.spec;
    state.specName = null;
    $('#dg-spec-view').textContent = JSON.stringify(r.spec, null, 2);
    $('#dg-top-spec').textContent = r.spec.appName;
    $('#dg-build-spec-name').textContent = r.spec.appName + ' (сгенерирован ИИ, не сохранён)';
    setStatus('dg-st-spec', '✓');
    $('#dg-spec-check-out').innerHTML = '<span class="dg-note">Сгенерирован за ' + r.attempts + ' попыт. Нажмите «Проверить схему» или соберите черновик. Чтобы сохранить: добавьте файл в examples/.</span>';
    pipeDone(['source', 'profile', 'privacy', 'spec']);
  } catch (e) {
    logEl.classList.add('is-err');
    logEl.textContent += '\nОШИБКА: ' + e.message + (e.log ? '\n' + e.log.join('\n') : '');
  } finally { btn.disabled = false; }
});
$('#dg-spec-select').addEventListener('change', () => loadSpec($('#dg-spec-select').value));

$('#dg-btn-spec-check').addEventListener('click', async () => {
  if (!state.spec) return;
  try {
    const r = await api('/api/check', { method: 'POST', body: JSON.stringify(state.spec), headers: { 'Content-Type': 'application/json' } });
    if (r.ok) {
      $('#dg-spec-check-out').innerHTML = '<div class="dg-rowbtn" style="margin-top:10px;"><span class="dg-badge dg-badge--ok"><i data-lucide="check" aria-hidden="true"></i>схема v1 пройдена, ссылки корректны</span></div>';
      $('#dg-spec-badge').classList.remove('dg-hidden');
      setStatus('dg-st-spec', '✓');
    } else {
      $('#dg-spec-check-out').innerHTML = '<pre class="dg-code is-err">' + esc(r.errors.join('\n')) + '</pre>';
    }
  } catch (e) { $('#dg-spec-check-out').innerHTML = '<pre class="dg-code is-err">' + esc(e.message) + '</pre>'; }
  icons();
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

// ── сборка ──
$('#dg-btn-build').addEventListener('click', async () => {
  if (!state.spec) return;
  const btn = $('#dg-btn-build'), timer = $('#dg-build-timer');
  btn.disabled = true;
  const t0 = Date.now();
  const tick = setInterval(() => { timer.textContent = 'идёт сборка… ' + Math.round((Date.now() - t0) / 1000) + ' с'; }, 500);
  $('#dg-build-log').classList.remove('dg-hidden', 'is-err');
  $('#dg-build-log').textContent = 'Подключение к Qlik и сборка…';
  try {
    const r = await api('/api/build', {
      method: 'POST', body: JSON.stringify({ specName: state.specName }),
      headers: { 'Content-Type': 'application/json' }
    });
    clearInterval(tick);
    timer.textContent = 'готово за ' + Math.round((Date.now() - t0) / 1000) + ' с';
    $('#dg-build-log').textContent = r.log.join('\n');
    $('#dg-build-log').classList.add('is-ok');
    renderVerify(r.verify);
    setStatus('dg-st-build', '✓');
    pipeDone(['source', 'profile', 'privacy', 'spec', 'build']);
  } catch (e) {
    clearInterval(tick);
    timer.textContent = '';
    $('#dg-build-log').textContent += '\nОШИБКА: ' + e.message;
    $('#dg-build-log').classList.add('is-err');
  } finally { btn.disabled = false; }
});

function renderVerify(v) {
  if (!v) return;
  const okRows = [];
  for (const h of v.hyperCubes) okRows.push('<li><span class="ic"><i data-lucide="check" aria-hidden="true"></i></span><span>' +
    esc(h.type) + ' «' + esc(h.title) + '»: <b>' + h.rows + '×' + h.cols + '</b></span></li>');
  if (v.objectErrors.length) for (const e of v.objectErrors) okRows.push('<li><span class="ic" style="background:color-mix(in srgb,var(--dg-bad) 15%,transparent);color:var(--dg-bad);"><i data-lucide="x" aria-hidden="true"></i></span><span>' + esc(e.type) + ' «' + esc(e.title) + '»: ' + esc(e.error) + '</span></li>');
  if (v.expectedRows !== undefined) okRows.push('<li><span class="ic"><i data-lucide="check" aria-hidden="true"></i></span><span>Сверка строк: <b>' + v.modelRows + ' / ' + v.expectedRows + '</b> — ' + (v.rowsMatch ? 'совпадает' : 'РАСХОЖДЕНИЕ') + '</span></li>');
  $('#dg-verify-out').innerHTML = '<div class="dg-card"><p class="dg-cardtitle"><i data-lucide="list-checks" aria-hidden="true"></i>Проверка перед публикацией ' +
    '<span class="dg-badge ' + (v.objectErrors.length ? 'dg-badge--warn' : 'dg-badge--ok') + '" style="margin-left:auto;">' +
    (v.objectErrors.length ? 'ошибок: ' + v.objectErrors.length : 'расхождений нет') + '</span></p><ul class="dg-checks">' + okRows.join('') + '</ul>' +
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
  if (!state.specHash) { badge.textContent = 'spec не выбран'; return; }
  if (currentSpecApproved()) {
    badge.textContent = 'утверждено';
    badge.className = 'dg-badge dg-badge--ok';
    btn.disabled = false;
    setStatus('dg-st-publish', '');
  } else {
    badge.textContent = 'ожидает утверждения';
    badge.className = 'dg-badge dg-badge--warn';
    btn.disabled = true;
    setStatus('dg-st-publish', '🔒');
  }
}

$('#dg-btn-approve').addEventListener('click', async () => {
  const by = $('#dg-approve-by').value.trim();
  if (!by || !state.specName) return;
  try {
    await api('/api/approve', { method: 'POST', body: JSON.stringify({ specName: state.specName, approvedBy: by }), headers: { 'Content-Type': 'application/json' } });
    $('#dg-approve-by').value = '';
    await loadApprovals();
  } catch (e) { $('#dg-publish-result').textContent = 'Ошибка: ' + e.message; }
});

$('#dg-btn-streams').addEventListener('click', loadStreams);

$('#dg-btn-publish').addEventListener('click', async () => {
  if (!state.specName || !$('#dg-stream-select').value) return;
  const btn = $('#dg-btn-publish');
  btn.disabled = true;
  $('#dg-publish-result').textContent = 'Публикую через QRS…';
  try {
    const r = await api('/api/publish', {
      method: 'POST', body: JSON.stringify({ specName: state.specName, streamId: $('#dg-stream-select').value }),
      headers: { 'Content-Type': 'application/json' }
    });
    const st = r.published.stream || {};
    $('#dg-publish-result').innerHTML = '<span class="dg-badge dg-badge--ok"><i data-lucide="check" aria-hidden="true"></i>опубликовано в стрим «' + esc(st.name || '') + '»</span>';
    pipeDone(['source', 'profile', 'privacy', 'spec', 'build', 'publish']);
    setStatus('dg-st-publish', '✓');
  } catch (e) {
    $('#dg-publish-result').textContent = 'Ошибка: ' + e.message;
  } finally { btn.disabled = false; updateApprovalBadge(); icons(); }
});

// ── старт ──
(async () => {
  await loadConfig();
  await loadSpecList().catch(e => console.warn(e));
  await loadApprovals().catch(e => console.warn(e));
  await loadStreams().catch(e => console.warn(e));
  icons();
})();
