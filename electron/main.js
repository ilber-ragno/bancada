// App da Bancada para macOS: sobe o servidor localmente e abre a tela numa janela.
// Os dados ficam em ~/Library/Application Support/Bancada/dados e a chave do cofre fica
// protegida pelo Keychain do macOS (safeStorage).
import { app, BrowserWindow, shell, safeStorage, dialog, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import crypto from 'node:crypto';

if (!app.requestSingleInstanceLock()) app.quit();

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  s.on('error', reject);
});

function vaultKey(dir) {
  const file = path.join(dir, 'cofre.key');
  const secure = safeStorage.isEncryptionAvailable();
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file);
    return secure ? safeStorage.decryptString(raw) : raw.toString('utf8');
  }
  const key = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secure ? safeStorage.encryptString(key) : key, { mode: 0o600 });
  return key;
}

async function waitUp(port) {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('o servidor interno não respondeu');
}

let win = null;
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(async () => {
  const dataDir = path.join(app.getPath('userData'), 'dados');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const port = await freePort();
  Object.assign(process.env, { HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir, BANCADA_SECRET_KEY: vaultKey(dataDir) });
  if (!process.env.SSH_AUTH_SOCK && !process.env.SSH_KEY_PATH) {
    for (const k of ['id_ed25519', 'id_ecdsa', 'id_rsa']) {
      const p = path.join(os.homedir(), '.ssh', k);
      if (fs.existsSync(p)) { process.env.SSH_KEY_PATH = p; break; }
    }
  }
  try {
    await import('../src/server.js');
    await waitUp(port);
  } catch (e) {
    dialog.showErrorBox('Bancada', 'Não consegui iniciar a Bancada: ' + e.message);
    app.quit();
    return;
  }
  const base = `http://127.0.0.1:${port}`;
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 600, title: 'Bancada', backgroundColor: '#FAFAFA', show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  // Links externos abrem no navegador do Mac; a janela só navega dentro da própria Bancada
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(base)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); } });
  win.once('ready-to-show', () => win.show());
  win.loadURL(base + '/');
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' }, { role: 'editMenu' },
    { label: 'Exibir', submenu: [{ role: 'reload', label: 'Recarregar' }, { role: 'togglefullscreen', label: 'Tela cheia' }, { type: 'separator' }, { role: 'zoomIn', label: 'Aumentar' }, { role: 'zoomOut', label: 'Diminuir' }, { role: 'resetZoom', label: 'Tamanho real' }] },
    { role: 'windowMenu' },
  ]));
});

app.on('window-all-closed', () => app.quit());
