// Dashgen Desktop (Electron): запускает локальный сервер server.js и открывает окно приложения.
// Сервер слушает только 127.0.0.1 — наружу не доступен.
// Фоновый режим: закрытие окна сворачивает Dashgen (сервер продолжает работать);
// клик по иконке в Dock возвращает окно. Полное завершение: ⌘Q или ПКМ по иконке Dock.
// ⌘R / F5 — перезагрузка интерфейса (сервер не трогается).
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');

const PORT = 4749;
const ROOT = path.join(__dirname, '..');

let win = null;
let quitting = false;

function serverReady(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tryOnce = () => {
      const s = net.createConnection({ host: '127.0.0.1', port: PORT });
      s.on('connect', () => { s.destroy(); resolve(); });
      s.on('error', () => {
        s.destroy();
        if (Date.now() - t0 > timeoutMs) return reject(new Error('Сервер не поднялся за ' + timeoutMs + ' мс'));
        setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

function startServer() {
  // Если порт уже занят (сервер запущен вручную) — используем его, второй не поднимаем.
  // Иначе сервер работает В ПРОЦЕССЕ Electron (в собранном .app spawn внешнего node невозможен).
  return new Promise(resolve => {
    const probe = net.createConnection({ host: '127.0.0.1', port: PORT });
    probe.on('connect', () => { probe.destroy(); resolve(false); });
    probe.on('error', () => {
      probe.destroy();
      const userData = app.getPath('userData'); // ~/Library/Application Support/Dashgen
      process.env.DASHGEN_DATA_DIR = userData;
      process.env.DASHGEN_CONFIG_DIR = userData;
      if (!fs.existsSync(path.join(userData, 'config.json'))) {
        const devConfig = path.join(ROOT, 'config.json');
        if (fs.existsSync(devConfig)) fs.copyFileSync(devConfig, path.join(userData, 'config.json'));
      }
      require(path.join(ROOT, 'server.js'));
      resolve(true);
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 620,
    title: 'Dashgen',
    backgroundColor: '#171e29',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // ⌘R / F5 — перезагрузка интерфейса (сервер не трогается)
  win.webContents.on('before-input-event', (e, input) => {
    const key = (input.key || '').toLowerCase();
    if (input.type !== 'keyDown') return;
    if ((input.control || input.meta) && key === 'r') { win.webContents.reload(); e.preventDefault(); }
    if (key === 'f5') { win.webContents.reload(); e.preventDefault(); }
  });

  // Внешние ссылки (Hub, документация) — в системном браузере
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('http://127.0.0.1:' + PORT)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  // Фоновый режим: крестик скрывает окно, сервер продолжает работать
  win.on('close', e => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });

  win.loadURL('http://127.0.0.1:' + PORT + '/');
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  const started = await startServer();
  if (started) await serverReady();
  createWindow();
  app.on('activate', () => {
    if (win && !win.isDestroyed()) { win.show(); return; }
    createWindow();
  });
});

// Полное завершение: ⌘Q или ПКМ по иконке Dock → Завершить
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (quitting) app.quit(); });
