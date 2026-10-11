// Convites: link de uso único, com validade, papel e projetos definidos por quem convida.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { RANK, canSeeProject, can } from './permissions.js';

const file = path.join(cfg.dataDir, 'invites.json');
let invites = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } })();
const persist = () => { fs.writeFileSync(file + '.tmp', JSON.stringify(invites), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); };
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export const publicInvite = (i) => ({ id: i.id, label: i.label, role: i.role, projects: i.projects, createdBy: i.createdBy, createdByName: i.createdByName, ts: i.ts, expires: i.expires, status: i.status === 'pendente' && i.expires < Date.now() ? 'expirado' : i.status, link: '' });
export const listInvites = () => invites.map(publicInvite);

export function createInvite(creator, { label, role, projects, days }, existingProjects) {
  if (!can(creator, 'invite')) throw new Error('Seu acesso não permite convidar');
  if (!(role in RANK)) throw new Error('Papel inválido');
  if (RANK[role] > RANK[creator.role] || (role === 'admin' && creator.role !== 'admin')) throw new Error('Você só pode convidar com papel igual ou menor que o seu');
  const list = role === 'admin' ? '*' : (Array.isArray(projects) ? [...new Set(projects)] : []);
  if (list !== '*') {
    if (!list.length) throw new Error('Escolha pelo menos um projeto');
    for (const p of list) if (!existingProjects.includes(p) || !canSeeProject(creator, p)) throw new Error('Você só pode liberar projetos que acessa');
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const inv = {
    id: 'inv' + crypto.randomBytes(6).toString('hex'), tokenHash: hash(token), label: String(label || 'Convite').slice(0, 80), role, projects: list,
    createdBy: creator.id, createdByName: creator.name, ts: Date.now(), expires: Date.now() + Math.min(7, Math.max(1, Number(days) || 3)) * 86400000, status: 'pendente',
  };
  invites.push(inv); persist();
  return { invite: inv, token };
}

export function findByToken(token) {
  if (!/^[\w-]{40,60}$/.test(token || '')) return null;
  const h = hash(token);
  const i = invites.find((x) => crypto.timingSafeEqual(Buffer.from(x.tokenHash), Buffer.from(h)));
  return i && i.status === 'pendente' && i.expires > Date.now() ? i : null;
}

export function markUsed(inv, userId) { inv.status = 'aceito'; inv.usedBy = userId; inv.usedAt = Date.now(); persist(); }

export function revokeInvite(id, user) {
  const i = invites.find((x) => x.id === id);
  if (!i) throw new Error('Convite não encontrado');
  if (i.createdBy !== user.id && !can(user, 'users')) throw new Error('Só quem criou ou um administrador revoga');
  i.status = 'revogado'; persist();
  return publicInvite(i);
}
