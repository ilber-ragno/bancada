// Fila de aprovações: pedidos vindos da tela (mensagens arriscadas) e do hook remoto do Claude Code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { server, saveServer, addMessage, setStatus, getStatus, audit, findNode, getDoc, findProject, allNodes } from './store.js';
import { broadcast } from './bus.js';
import { exec, shq, writeRemote } from './ssh.js';
import { checkRisky, isReadOnlyCmd } from './policy.js';
import { emit } from './inbox.js';

const waiting = new Map();

export function ask({ nodeId, cmd, reason, source = 'bancada', by = null, byName = null }) {
  const a = { id: 'a' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), nodeId, cmd: String(cmd).slice(0, 4000), reason, ts: Date.now(), status: 'pending', source, by, byName };
  server().approvals.unshift(a);
  server().approvals.length = Math.min(server().approvals.length, 300);
  saveServer();
  broadcast({ type: 'approval', nodeId, approval: a });
  addMessage(nodeId, { role: 'approval', id: a.id });
  const previous = getStatus(nodeId);
  setStatus(nodeId, 'waiting');
  const n = findNode(nodeId);
  audit({ actor: n?.label || 'agente', action: 'Pediu aprovação', detail: a.cmd, nodeId });
  emit('approval', `${n?.label || 'Agente'} pede aprovação`, `${a.cmd}\n${reason}`, { nodeId });
  return new Promise((resolve) => waiting.set(a.id, { resolve, previous }));
}

export function decide(id, decision, actor = 'sistema') {
  const a = server().approvals.find((x) => x.id === id);
  if (!a) throw new Error('Aprovação não encontrada');
  if (a.status !== 'pending') throw new Error('Esta aprovação já foi respondida');
  a.status = decision === 'allow' ? 'allowed' : 'denied';
  a.decided = Date.now();
  a.decidedBy = actor;
  saveServer();
  broadcast({ type: 'approval', nodeId: a.nodeId, approval: a });
  audit({ actor, action: a.status === 'allowed' ? 'Permitiu' : 'Negou', detail: a.cmd, nodeId: a.nodeId });
  const w = waiting.get(id);
  waiting.delete(id);
  setStatus(a.nodeId, w?.previous === 'running' ? 'running' : 'idle');
  w?.resolve(a.status === 'allowed');
  return a;
}

// ---------- Hook remoto do Claude Code ----------
const hookScript = fs.readFileSync(path.join(cfg.root, 'remote', 'bancada-hook.sh'), 'utf8');
const installed = new Set();

export async function ensureHook(target) {
  if (installed.has(target)) return;
  await writeRemote(target, '~/.bancada/hooks/pretooluse.sh', hookScript, '700');
  await exec(target, 'mkdir -p ~/.bancada/approvals && chmod 700 ~/.bancada', { timeoutMs: 15000 });
  installed.add(target);
}

export const hookSettings = () => JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash ~/.bancada/hooks/pretooluse.sh' }] }] },
});

const watchers = new Map();

export function watchHost(target, isActive) {
  if (watchers.has(target)) return;
  const seen = new Set();
  const iv = setInterval(async () => {
    if (!isActive(target)) { clearInterval(iv); watchers.delete(target); return; }
    try { await poll(target, seen); } catch (e) { console.error('[approvals]', target, e.message); }
  }, 2000);
  watchers.set(target, iv);
}

async function poll(target, seen) {
  const r = await exec(target, 'for f in ~/.bancada/approvals/*.req; do [ -e "$f" ] || continue; printf "@@@%s\\n" "$f"; head -c 20000 "$f"; printf "\\n"; done', { timeoutMs: 15000 });
  const blocks = r.stdout.split('@@@').map((b) => b.trim()).filter(Boolean);
  for (const b of blocks) {
    const nl = b.indexOf('\n');
    const file = (nl < 0 ? b : b.slice(0, nl)).trim();
    if (!/^[\w./~-]+\.req$/.test(file) || seen.has(file)) continue;
    seen.add(file);
    let data = {};
    try { data = JSON.parse(b.slice(nl + 1)); } catch {}
    handleRequest(target, file, data).catch((e) => console.error('[approvals]', e.message));
  }
}

async function handleRequest(target, file, data) {
  const cmd = data?.tool_input?.command || '';
  const sessionId = data?.session_id;
  const nodeId = Object.entries(server().sessions).find(([, s]) => s.id === sessionId)?.[0]
    || allNodes().find((n) => server().nodeData[n.id]?.worktree && data.cwd?.startsWith(server().nodeData[n.id].worktree))?.id;
  const n = nodeId && findNode(nodeId);
  const p = n && findProject(n.projectId);
  const settings = getDoc().settings || {};
  const risky = checkRisky(cmd, settings.risky);
  const prodWrite = p?.env === 'prod' && settings.prodReadOnly !== false && !isReadOnlyCmd(cmd);
  const resFile = file.replace(/\.req$/, '.res');
  let allow = true;
  if (!n) allow = false;
  else if (risky || prodWrite) {
    const runner = server().runners?.[n.id];
    allow = await ask({ nodeId: n.id, cmd, reason: risky ? `Comando marcado como arriscado ("${risky}").` : 'Escrita em servidor de produção.', source: 'hook', by: runner?.id || null, byName: runner?.name || null });
  } else {
    audit({ actor: n.label, action: 'Comando permitido pela regra', detail: cmd, nodeId: n.id });
  }
  await exec(target, `printf %s ${allow ? 'allow' : 'deny'} > ${shq(resFile).replace(/^'~/, "~'")}`, { timeoutMs: 15000 });
}
