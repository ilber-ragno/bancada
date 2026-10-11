// Conexões SSH com pool, verificação de chave do host (TOFU) e execução remota.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Client } from 'ssh2';
import { cfg } from './config.js';
import { server, saveServer } from './store.js';

export const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

export function parseTarget(value) {
  const m = /^([a-z_][a-z0-9_.-]{0,31})@([a-zA-Z0-9.-]{1,253})(?::(\d{1,5}))?$/.exec(String(value || '').trim());
  if (!m) throw new Error('Servidor inválido. Use usuário@host ou usuário@host:porta.');
  return { username: m[1], host: m[2], port: Number(m[3] || 22), key: `${m[1]}@${m[2]}:${m[3] || 22}` };
}

const pool = new Map();

function connect(t) {
  if (pool.has(t.key)) return pool.get(t.key);
  const p = new Promise((resolve, reject) => {
    const c = new Client();
    const hostId = `${t.host}:${t.port}`;
    const opts = {
      host: t.host, port: t.port, username: t.username,
      readyTimeout: 15000, keepaliveInterval: 15000,
      hostVerifier: (key) => {
        const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64');
        const known = server().hostKeys[hostId];
        if (!known) { server().hostKeys[hostId] = fp; saveServer(); return true; }
        if (known !== fp) console.error(`[ssh] Chave do host ${hostId} mudou (${known} -> ${fp}). Conexão recusada.`);
        return known === fp;
      },
    };
    if (cfg.sshAgent) opts.agent = cfg.sshAgent;
    if (cfg.sshKeyPath) opts.privateKey = fs.readFileSync(cfg.sshKeyPath);
    if (cfg.sshKeyPassphrase) opts.passphrase = cfg.sshKeyPassphrase;
    c.on('ready', () => resolve(c))
      .on('error', (e) => { pool.delete(t.key); reject(e); })
      .on('close', () => pool.delete(t.key));
    c.connect(opts);
  });
  pool.set(t.key, p);
  p.catch(() => pool.delete(t.key));
  return p;
}

const MAX_BUFFER = 2 * 1024 * 1024;

export async function exec(target, cmd, { onStdout, onStderr, timeoutMs = 0, signal, stdin } = {}) {
  const t = typeof target === 'string' ? parseTarget(target) : target;
  const conn = await connect(t);
  return new Promise((resolve, reject) => {
    conn.exec(`bash -lc ${shq(cmd)}`, (err, stream) => {
      if (err) return reject(err);
      let out = '', errOut = '', timer;
      const stop = () => { try { stream.signal('TERM'); } catch {} stream.close(); };
      if (timeoutMs) timer = setTimeout(() => { stop(); reject(new Error('Tempo esgotado')); }, timeoutMs);
      if (signal) signal.addEventListener('abort', stop, { once: true });
      stream.on('data', (d) => { const s = d.toString(); if (out.length < MAX_BUFFER) out += s; onStdout?.(s); });
      stream.stderr.on('data', (d) => { const s = d.toString(); if (errOut.length < MAX_BUFFER) errOut += s; onStderr?.(s); });
      stream.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: errOut }); });
      if (stdin != null) stream.end(stdin); else stream.end();
    });
  });
}

// Junta pedaços de saída e entrega linha a linha.
export function lineSplitter(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  };
}

// Grava um arquivo no servidor remoto sem passar o conteúdo pela linha de comando.
export function writeRemote(target, remotePath, content, mode = '600') {
  return exec(target, `umask 077; mkdir -p "$(dirname ${remotePath})" && cat > ${remotePath} && chmod ${mode} ${remotePath}`, { stdin: content, timeoutMs: 20000 });
}
