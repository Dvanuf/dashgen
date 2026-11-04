// Dashgen UI — логика: подключение к локальному API движка.
'use strict';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { spec: null, specName: null, sourceProfile: null, safeProfile: null, config: null };

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ── навигация ──
document.querySelectorAll('.navbtn').forEach(btn => btn.addEventListener('click', () => {
  document.querySelectorAll('.navbtn').forEach(b => b.classList.toggle('is-on', b === btn));
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== 'p-' + btn.dataset.step; });
}));

function pipeDone(names) {
  document.querySelectorAll('.pstep').forEach(el => el.classList.toggle('done', names.includes(el.dataset.pipe)));
}

// ── подключения / конфиг ──
async function loadConfig() {
  try {
    const cfg = await api('/api/config');
    state.config = cfg;
    $('#host-chip').textContent = 'сервер: ' + cfg.host;
    $('#user-chip').textContent = cfg.userDirectory + '\\' + cfg.userId;
    $('#cfg-status').textContent = 'config загружен';
    $('#cfg-status').className = 'chipstat ok';
    renderConn(cfg);
  } catch (e) {
    $('#cfg-status').textContent = 'config.json не найден';
    $('#cfg-status').className = 'chipstat bad';
    $('#conn-out').innerHTML = '<div class="card note">' + esc(e.message) + '</div>';
  }
}

function renderConn(cfg) {
  $('#conn-out').innerHTML = '<div class="card"><table class="t"><tbody>' +
    row('Host', cfg.host) + row('Engine API', 'порт ' + cfg.portEngine) +
    row('QRS API', 'порт ' + cfg.portQrs) + row('Сертификаты', cfg.certDir) +
    row('Учётная запись', cfg.userDirectory + '\\' + cfg.userId) +
    row('rejectUnauthorized', String(cfg.rejectUnauthorized)) +
    '</tbody></table></div>';
  function row(k, v) { return '<tr><td>' + esc(k) + '</td><td>' + esc(v) + '</td></tr>'; }
}

$('#btn-test-conn').addEventListener('click', async () => {
  const note = $('#conn-test-note');
  note.textContent = 'Проверка Engine 4747 и QRS 4242…';
  try {
    const r = await api('/api/test-connection', { method: 'POST' });
    note.textContent = 'Engine: ' + (r.engine ? 'succeeded ✓' : 'недоступен ✗') + ' · QRS: ' + (r.qrs ? 'отвечает ✓' : 'недоступен ✗');
  } catch (e) { note.textContent = 'Ошибка: ' + e.message; }
});

// ── источник: путь или загрузка ──
document.querySelectorAll('.chip[data-src]').forEach(chip => chip.addEventListener('click', () => {
  document.querySelectorAll('.chip[data-src]').forEach(c => c.classList.toggle('is-on', c === chip));
  $('#src-path-box').classList.toggle('hidden', chip.dataset.src !== 'path');
  $('#src-upload-box').classList.toggle('hidden', chip.dataset.src !== 'upload');
}));

function renderProfile(data) {
  state.sourceProfile = data.sourceProfile;
  state.safeProfile = data.safeProfile;
  const sp = data.sourceProfile;
  let html = '';
  for (const t of sp.tables) {
    html += '<div class="card"><b>' + esc(t.name) + '</b> <span class="note">· ' + t.rowCount + ' строк</span><table class="t"><thead><tr>' +
      '<th>Колонка</th><th>Тип</th><th class="num">Уник.</th><th class="num">Проп.</th><th>Профиль для ИИ</th></tr></thead><tbody>';
    const banned = new Set((data.safeProfile.excludedColumns || []).map(x => x.table + '::' + x.column));
    for (const c of t.columns) {
      const isBanned = banned.has(t.name + '::' + c.name);
      html += '<tr' + (isBanned ? ' class="banned"' : '') + '><td>' + esc(c.name) + '</td><td>' + esc(c.type) +
        '</td><td class="num">' + (c.distinct ?? '—') + '</td><td class="num">' + (c.nulls ?? '—') + '</td><td>' +
        (isBanned ? '🔒 запрещённая колонка' : 'в профиле') + '</td></tr>';
    }
    html += '</tbody></table></div>';
  }
  html += '<div class="row"><span class="badge badge-ok">профиль построен локально</span>' +
    '<span class="note">Значения не покидают эту машину. В ИИ уйдёт только схема.</span></div>';
  $('#profile-out').innerHTML = html;
  renderPrivacy(data.safeProfile);
  pipeDone(['source', 'profile']);
}

function renderPrivacy(safe) {
  $('#privacy-out').innerHTML =
    '<div class="card"><b>Режим schema (dry run)</b> — именно это уйдёт модели:<pre class="code">' +
    esc(JSON.stringify(safe, null, 2)) + '</pre></div>';
  $('#privacy-actions').style.display = 'flex';
}

$('#btn-profile-path').addEventListener('click', async () => {
  const p = $('#src-path').value.trim();
  if (!p) return;
  const body = { path: p };
  const sheet = $('#src-sheet').value.trim();
  if (sheet) body.sheet = sheet;
  $('#profile-out').innerHTML = '<div class="card note">Профилирую…</div>';
  try { renderProfile(await api('/api/profile-path', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })); }
  catch (e) { $('#profile-out').innerHTML = '<div class="card note">Ошибка: ' + esc(e.message) + '</div>'; }
});

$('#btn-profile-upload').addEventListener('click', async () => {
  const f = $('#src-file').files[0];
  if (!f) return;
  $('#profile-out').innerHTML = '<div class="card note">Загружаю и профилирую…</div>';
  try {
    const data = await api('/api/profile?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
    renderProfile(data);
  } catch (e) { $('#profile-out').innerHTML = '<div class="card note">Ошибка: ' + esc(e.message) + '</div>'; }
});

// ── спецификация ──
async function loadSpecList() {
  const { specs } = await api('/api/specs');
  $('#spec-select').innerHTML = specs.map(s => '<option value="' + esc(s.name) + '">' + esc(s.appName) + '</option>').join('');
  if (specs.length) await loadSpec(specs[0].name);
}

async function loadSpec(name) {
  const data = await api('/api/spec?name=' + encodeURIComponent(name));
  state.spec = data.spec;
  state.specName = data.name;
  $('#spec-view').textContent = JSON.stringify(data.spec, null, 2);
  $('#build-spec-name').textContent = data.spec.appName;
  renderLayout(data.spec);
  $('#spec-check-out').innerHTML = '';
}

$('#btn-spec-load').addEventListener('click', () => loadSpec($('#spec-select').value));
$('#spec-select').addEventListener('change', () => loadSpec($('#spec-select').value));

$('#btn-spec-check').addEventListener('click', async () => {
  if (!state.spec) return;
  try {
    const r = await api('/api/check', { method: 'POST', body: JSON.stringify(state.spec), headers: { 'Content-Type': 'application/json' } });
    $('#spec-check-out').innerHTML = r.ok
      ? '<span class="badge badge-ok">схема v1 пройдена, ссылки корректны</span>'
      : '<pre class="code err">' + esc(r.errors.join('\n')) + '</pre>';
  } catch (e) { $('#spec-check-out').innerHTML = '<pre class="code err">' + esc(e.message) + '</pre>'; }
});

// ── макет: сетка 24x12 как в Qlik ──
function renderLayout(spec) {
  const cells = [];
  const defaultSize = { kpi: [5, 3], linechart: [10, 4], barchart: [10, 4], table: [20, 5], listbox: [4, 4] };
  for (const sheet of spec.sheets || []) {
    for (const o of sheet.objects || []) {
      const [dc, dr] = defaultSize[o.type] || [4, 3];
      const cs = o.colspan || dc, rs = o.rowspan || dr;
      const kind = o.type === 'kpi' ? 'kpi' : (o.type === 'linechart' || o.type === 'barchart') ? 'chart' : '';
      cells.push('<div class="gcell ' + kind + '" style="left:' + (o.col / 24 * 100) + '%;top:' + (o.row / 12 * 100) +
        '%;width:' + (cs / 24 * 100) + '%;height:' + (rs / 12 * 100) + '%;">' +
        '<div class="k">' + esc(o.type) + '</div><div class="t">' + esc(o.title || o.field || o.measure || '') + '</div>' +
        (kind === 'chart' ? '<div class="placeholder"></div>' : '') + '</div>');
    }
  }
  $('#layout-out').innerHTML = '<div class="grid">' + cells.join('') + '</div>' +
    '<p class="note" style="margin-top:8px;">Лист «' + esc((spec.sheets[0] || {}).title || '') + '» · предпросмотр раскладки; точный вид — после сборки в Qlik.</p>';
}

// ── сборка ──
$('#btn-build').addEventListener('click', async () => {
  if (!state.spec) return;
  const btn = $('#btn-build'), timer = $('#build-timer');
  btn.disabled = true;
  const t0 = Date.now();
  const tick = setInterval(() => { timer.textContent = 'идёт сборка… ' + Math.round((Date.now() - t0) / 1000) + ' с'; }, 500);
  $('#build-log').classList.remove('hidden');
  $('#build-log').textContent = 'Подключение к Qlik и сборка…';
  $('#verify-out').innerHTML = '';
  try {
    const r = await api('/api/build', {
      method: 'POST', body: JSON.stringify({ specName: state.specName }),
      headers: { 'Content-Type': 'application/json' }
    });
    clearInterval(tick);
    timer.textContent = 'готово за ' + Math.round((Date.now() - t0) / 1000) + ' с';
    $('#build-log').textContent = r.log.join('\n');
    renderVerify(r.verify);
    pipeDone(['source', 'profile', 'spec', 'build']);
  } catch (e) {
    clearInterval(tick);
    timer.textContent = '';
    $('#build-log').textContent += '\nОШИБКА: ' + e.message;
    $('#build-log').classList.add('err');
  } finally { btn.disabled = false; }
});

function renderVerify(v) {
  if (!v) return;
  let html = '<div class="card"><b>Verify</b> <span class="badge ' + (v.objectErrors.length ? 'badge-warn' : 'badge-ok') + '">' +
    (v.objectErrors.length ? 'ошибок: ' + v.objectErrors.length : 'ошибок нет') + '</span><table class="t"><tbody>';
  for (const h of v.hyperCubes) html += '<tr><td>' + esc(h.type) + '</td><td>' + esc(h.title) + '</td><td class="num">' + h.rows + '×' + h.cols + '</td></tr>';
  if (v.expectedRows !== undefined) html += '<tr><td>Строк в модели</td><td>' + v.modelRows + ' из ' + v.expectedRows + '</td><td>' + (v.rowsMatch ? '✓ совпадает' : '✗ РАСХОЖДЕНИЕ') + '</td></tr>';
  html += '</tbody></table></div>';
  $('#verify-out').innerHTML = html;
}

// ── старт ──
loadConfig().then(loadSpecList).catch(e => console.warn(e));
