// Cofre de segredos: AES-256-GCM com a chave BANCADA_SECRET_KEY do .env.
// Os valores nunca voltam para a tela; só o servidor lê, na hora de usar.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';

const file = path.join(cfg.dataDir, 'secrets.json');
let data = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } })();

function key() {
  const raw = process.env.BANCADA_SECRET_KEY || '';
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error('BANCADA_SECRET_KEY precisa ter 32 bytes (64 caracteres hex). Gere com: openssl rand -hex 32');
  return buf;
}

export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

export function decrypt(box) {
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(box.iv, 'base64'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]).toString('utf8');
}

function persist() {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const valid = (s) => /^[\w:.-]{1,80}$/.test(s);

export function setSecret(scope, name, value) {
  if (!valid(scope) || !valid(name)) throw new Error('Nome de segredo inválido');
  if (typeof value !== 'string' || !value || value.length > 8000) throw new Error('Valor de segredo inválido');
  (data[scope] ||= {})[name] = encrypt(value);
  persist();
}
export function getSecret(scope, name) {
  const box = data[scope]?.[name];
  return box ? decrypt(box) : null;
}
export const hasSecret = (scope, name) => !!data[scope]?.[name];
export function deleteScope(scope) { delete data[scope]; persist(); }
export function checkVault() { key(); }
