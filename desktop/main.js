// Dashgen Desktop (Electron): запускает локальный сервер server.js и открывает окно приложения.
// Сервер слушает только 127.0.0.1 — наружу не доступен; при закрытии окна сервер останавливается.
const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const PORT = 4748;
const ROOT = path.join(__dirname, '..');

let serverProc = null;
let win = null;

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
  // Если порт уже занят (например, сервер запущен вручную) — используем его и не плодим второй
  return new Promise(resolve => {
    const probe = net.createConnection({ host: '127.0.0.1', port: PORT });
    probe.on('connect', () => { probe.destroy(); resolve(false); });
    probe.on('error', () => {
      probe.destroy();
      serverProc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      serverProc.stdout.on('data', d => process.stdout.write('[server] ' + d));
      serverProc.stderr.on('data', d => process.stderr.write('[server] ' + d));
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
  // Внешние ссылки (Hub, документация) — в системном браузере, не внутри приложения
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('http://127.0.0.1:' + PORT)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });
  win.loadURL('http://127.0.0.1:' + PORT + '/');
  win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
  const started = await startServer();
  if (started) await serverReady();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (serverProc) { try { serverProc.kill(); } catch (_) {} }
  app.quit();
});
