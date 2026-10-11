// Persistência simples em arquivos:
//  data/state.json        documento de layout e configurações vindo da tela
//  data/server.json       dados que só o servidor controla (sessões, aprovações, consumo, chaves de host)
//  data/messages/<id>.jsonl  conversa de cada janela (só acréscimo)
//  data/audit.jsonl       auditoria (só acréscimo)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { broadcast } from './bus.js';

const msgDir = path.join(cfg.dataDir, 'messages');
fs.mkdirSync(msgDir, { recursive: true, mode: 0o700 });

const statePath = path.join(cfg.dataDir, 'state.json');
const serverPath = path.join(cfg.dataDir, 'server.json');
const auditPath = path.join(cfg.dataDir, 'audit.jsonl');

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

let doc = readJson(statePath, {});
const srv = Object.assign(
  { sessions: {}, nodeData: {}, approvals: [], usage: {}, hostKeys: {}, runs: [] },
  readJson(serverPath, {}),
);
const status = new Map();

export const getDoc = () => doc;
export const server = () => srv;
export function saveServer() { writeAtomic(serverPath, JSON.stringify(srv)); }

const SERVER_FIELDS = ['approvals', 'usage', 'events', 'runs', 'users', 'me', 'inbox', 'invites'];
const NODE_RUNTIME = ['messages', 'term', 'diff', 'status', 'queue', 'commits', 'pr'];

export function stripDoc(next) {
  if (!next || typeof next !== 'object' || !Array.isArray(next.nodes)) throw new Error('Documento inválido');
  const clean = { ...next };
  for (const k of SERVER_FIELDS) delete clean[k];
  const strip = (n) => { const c = { ...n }; for (const k of NODE_RUNTIME) delete c[k]; delete c.held; return c; };
  clean.nodes = next.nodes.map(strip);
  clean.archive = (next.archive || []).map(strip);
  if (clean.wsData) clean.wsData = Object.fromEntries(Object.entries(clean.wsData).map(([k, w]) => [k, { ...w, nodes: (w.nodes || []).map(strip) }]));
  return clean;
}

export function setDoc(next) {
  if (!next || typeof next !== 'object' || !Array.isArray(next.nodes)) throw new Error('Documento inválido');
  const clean = { ...next };
  for (const k of SERVER_FIELDS) delete clean[k];
  const strip = (n) => { const c = { ...n }; for (const k of NODE_RUNTIME) delete c[k]; return c; };
  clean.nodes = next.nodes.map(strip);
  clean.archive = (next.archive || []).map(strip);
  if (clean.wsData) for (const w of Object.values(clean.wsData)) if (Array.isArray(w.nodes)) w.nodes = w.nodes.map(strip);
  doc = clean;
  writeAtomic(statePath, JSON.stringify(doc));
}

export function saveDoc() { writeAtomic(statePath, JSON.stringify(doc)); }

export function allNodes() {
  const extra = Object.values(doc.wsData || {}).flatMap((w) => w.nodes || []);
  return [...(doc.nodes || []), ...extra];
}
export const findNode = (id) => allNodes().find((n) => n.id === id) || (doc.archive || []).find((n) => n.id === id);
export const findProject = (id) => (doc.projects || []).find((p) => p.id === id);
export function linkedNodes(id) {
  return (doc.links || [])
    .filter((l) => l.a === id || l.b === id)
    .map((l) => findNode(l.a === id ? l.b : l.a))
    .filter(Boolean);
}

const safeId = (id) => { if (!/^[\w-]{1,64}$/.test(id)) throw new Error('Id inválido'); return id; };
const fileFor = (id, where) => path.join(msgDir, safeId(id) + (where === 'term' ? '.term' : '') + '.jsonl');

export function addMessage(nodeId, message, where) {
  const m = { ...message, ts: Date.now() };
  fs.appendFileSync(fileFor(nodeId, where), JSON.stringify(m) + '\n', { mode: 0o600 });
  broadcast({ type: 'message', nodeId, message: m, where: where === 'term' ? 'term' : undefined });
  return m;
}

export function readMessages(nodeId, where, limit = 300) {
  try {
    const lines = fs.readFileSync(fileFor(nodeId, where), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l));
  } catch { return []; }
}

export function lastAgentText(nodeId) {
  const msgs = readMessages(nodeId, undefined, 80);
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === 'agent') return msgs[i].text;
  return '';
}

export function setStatus(nodeId, value) {
  status.set(nodeId, value);
  broadcast({ type: 'status', nodeId, status: value });
}
export const getStatus = (nodeId) => status.get(nodeId) || 'idle';

export function audit({ actor, action, detail = '', nodeId = null }) {
  actor = actor || 'sistema';
  const n = nodeId && findNode(nodeId);
  const p = n && n.projectId && findProject(n.projectId);
  const event = {
    id: 'e' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    ts: Date.now(), actor, action, detail: String(detail).slice(0, 500), nodeId,
    where: p ? `${p.server.split('@').pop()}:${p.path}` : n ? n.label : 'Bancada',
    env: p ? p.env : null,
  };
  fs.appendFileSync(auditPath, JSON.stringify(event) + '\n', { mode: 0o600 });
  broadcast({ type: 'event', event });
  return event;
}

export function readAudit(limit = 300) {
  try {
    const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
  } catch { return []; }
}

export function fullState() {
  const withRuntime = (n) => {
    const data = srv.nodeData[n.id] || {};
    return {
      ...n,
      messages: readMessages(n.id),
      term: readMessages(n.id, 'term', 200),
      diff: data.diff || { files: [] },
      commits: data.commits || [],
      pr: data.pr || null,
      status: getStatus(n.id),
      queue: [],
      held: ((srv.held || {})[n.id] || []).map((x) => x.text),
    };
  };
  return {
    ...doc,
    nodes: (doc.nodes || []).map(withRuntime),
    archive: (doc.archive || []).map(withRuntime),
    approvals: srv.approvals,
    usage: srv.usage,
    runs: srv.runs,
    events: readAudit(),
  };
}
