// Contas: senha com scrypt, troca obrigatória da senha temporária, autenticador e bloqueio por tentativas.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { ROLES, PERMS } from './permissions.js';
import { encrypt, decrypt } from './vault.js';
import { verify as verifyTotp } from './totp.js';

const file = path.join(cfg.dataDir, 'users.json');
fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
let users = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } })();

function persist() {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function checkHash(pw, stored) {
  const [alg, s, h] = String(stored || '').split('$');
  if (alg !== 'scrypt') { crypto.scryptSync('x', 'y', 64, SCRYPT); return false; }
  const got = crypto.scryptSync(String(pw), Buffer.from(s, 'base64'), 64, SCRYPT);
  return crypto.timingSafeEqual(got, Buffer.from(h, 'base64'));
}

export function passwordProblem(pw, minLen = 12) {
  const len = Math.max(12, minLen);
  if (typeof pw !== 'string' || pw.length < len) return `A senha precisa ter pelo menos ${len} caracteres.`;
  if (pw.length > 200) return 'Senha longa demais.';
  if (/^(.)\1+$/.test(pw) || /^(?:0123456789|123456789|senha|password)/i.test(pw)) return 'Senha fraca demais.';
  return null;
}

export const tempPassword = () => crypto.randomBytes(12).toString('base64url');

// O que pode sair do servidor sobre uma pessoa
export const publicUser = (u) => u && ({
  id: u.id, name: u.name, login: u.login, role: u.role, projects: u.projects, active: u.active,
  extra: u.extra || [], deny: u.deny || [], color: u.color, twofa: !!u.totp, mustChange: !!u.mustChange,
});

export const allUsers = () => users;
export const findUser = (id) => users.find((u) => u.id === id);
export const findLogin = (login) => users.find((u) => u.login === String(login || '').toLowerCase());

function clean(input, current = {}) {
  const out = {};
  if (input.name !== undefined) out.name = String(input.name).trim().slice(0, 80) || current.name || 'Sem nome';
  if (input.role !== undefined) { if (!ROLES[input.role]) throw new Error('Papel inválido'); out.role = input.role; }
  if (input.projects !== undefined) {
    if (input.projects === '*') out.projects = '*';
    else if (Array.isArray(input.projects) && input.projects.every((p) => /^[\w-]{1,64}$/.test(p))) out.projects = [...new Set(input.projects)];
    else throw new Error('Lista de projetos inválida');
  }
  for (const k of ['extra', 'deny']) if (input[k] !== undefined) {
    if (!Array.isArray(input[k]) || !input[k].every((p) => PERMS.includes(p))) throw new Error('Permissão inválida');
    out[k] = [...new Set(input[k])];
  }
  if (input.active !== undefined) out.active = !!input.active;
  if (input.color !== undefined && /^#[0-9a-f]{6}$/i.test(input.color)) out.color = input.color;
  return out;
}

const activeAdmins = () => users.filter((u) => u.active && u.role === 'admin' && !(u.deny || []).includes('users'));

export function createUser(input) {
  const login = String(input.login || '').toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(login)) throw new Error('Login inválido: 3 a 32 caracteres, letras minúsculas, números, ponto, hífen ou _');
  if (findLogin(login)) throw new Error('Já existe alguém com esse login');
  const temp = tempPassword();
  const u = {
    id: 'u' + crypto.randomBytes(6).toString('hex'), login, name: 'Sem nome', role: 'leitura', projects: [], extra: [], deny: [], active: true, color: '#737373',
    ...clean(input), pw: hashPassword(temp), mustChange: true, totp: null, createdAt: Date.now(), failed: 0, lockedUntil: 0, sessionEpoch: 1,
  };
  users.push(u); persist();
  return { user: u, tempPassword: temp };
}

export function createUserWithPassword(input, password, minLen) {
  const problem = passwordProblem(password, minLen);
  if (problem) throw new Error(problem);
  const { user } = createUser(input);
  user.pw = hashPassword(password); user.mustChange = false;
  persist();
  return user;
}

export function updateUser(id, input, actor) {
  const u = findUser(id);
  if (!u) throw new Error('Pessoa não encontrada');
  const next = { ...u, ...clean(input, u) };
  if (actor && actor.id === id && (next.role !== u.role || next.active === false || (next.deny || []).includes('users'))) throw new Error('Você não pode reduzir o próprio acesso');
  const wasAdmin = u.active && u.role === 'admin';
  const stillAdmin = next.active && next.role === 'admin' && !(next.deny || []).includes('users');
  if (wasAdmin && !stillAdmin && activeAdmins().length <= 1) throw new Error('Precisa existir pelo menos um administrador ativo');
  const changedAccess = ['role', 'projects', 'extra', 'deny', 'active'].some((k) => JSON.stringify(next[k]) !== JSON.stringify(u[k]));
  Object.assign(u, next);
  if (changedAccess) u.sessionEpoch = (u.sessionEpoch || 1) + 1; // derruba sessões antigas
  persist();
  return u;
}

export function resetPassword(id) {
  const u = findUser(id);
  if (!u) throw new Error('Pessoa não encontrada');
  const temp = tempPassword();
  Object.assign(u, { pw: hashPassword(temp), mustChange: true, failed: 0, lockedUntil: 0, sessionEpoch: (u.sessionEpoch || 1) + 1 });
  persist();
  return temp;
}

export function revokeSessions(id) {
  const u = findUser(id);
  if (u) { u.sessionEpoch = (u.sessionEpoch || 1) + 1; persist(); }
}

export function changePassword(u, current, next, minLen) {
  if (!checkHash(current, u.pw)) throw new Error('Senha atual incorreta');
  const problem = passwordProblem(next, minLen);
  if (problem) throw new Error(problem);
  if (checkHash(next, u.pw)) throw new Error('A nova senha precisa ser diferente da atual');
  u.pw = hashPassword(next); u.mustChange = false; u.sessionEpoch = (u.sessionEpoch || 1) + 1;
  persist();
}

export function setTotp(u, secret) { u.totp = secret ? encrypt(secret) : null; u.sessionEpoch = (u.sessionEpoch || 1) + 1; persist(); }
export const totpSecretOf = (u) => (u.totp ? decrypt(u.totp) : null);

// Login com proteção contra força bruta (bloqueio de 15 min após 5 erros seguidos)
export function authenticate(login, password, code, require2fa) {
  const u = findLogin(login);
  if (!u) { checkHash(password, 'scrypt$AAAA$AAAA'); return { error: 'Login ou senha incorretos.' }; }
  if (!u.active) return { error: 'Conta desativada. Fale com um administrador.' };
  if (u.lockedUntil > Date.now()) return { error: 'Conta bloqueada por tentativas erradas. Tente de novo em alguns minutos.' };
  if (!checkHash(password, u.pw)) {
    u.failed = (u.failed || 0) + 1;
    if (u.failed >= 5) { u.lockedUntil = Date.now() + 15 * 60000; u.failed = 0; }
    persist();
    return { error: 'Login ou senha incorretos.' };
  }
  if (u.totp) {
    if (!code) return { needCode: true };
    if (!verifyTotp(totpSecretOf(u), code)) {
      u.failed = (u.failed || 0) + 1;
      if (u.failed >= 5) { u.lockedUntil = Date.now() + 15 * 60000; u.failed = 0; }
      persist();
      return { error: 'Código do autenticador incorreto.', needCode: true };
    }
  }
  u.failed = 0; u.lastLogin = Date.now(); persist();
  return { user: u, setupRequired: u.mustChange || (require2fa && !u.totp) };
}

export const hasUsers = () => users.length > 0;

// Usado pelas passkeys e pelo assistente de projetos
export const saveUsers = () => persist();

// Dar acesso a um projeto novo não derruba as sessões da pessoa (só ampliar acesso)
export function grantProject(userId, projectId) {
  const u = findUser(userId);
  if (!u || u.projects === '*') return;
  if (!Array.isArray(u.projects)) u.projects = [];
  if (!u.projects.includes(projectId)) { u.projects.push(projectId); persist(); }
}
