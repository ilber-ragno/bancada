// Worktree por janela, leitura de diff, commit, descarte e PR.
import path from 'node:path';
import { exec, shq } from './ssh.js';
import { server, saveServer, audit, addMessage } from './store.js';
import { broadcast } from './bus.js';

const slug = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'sessao';

export function validateProject(p) {
  if (!p) throw new Error('Projeto não encontrado');
  if (!/^\/[\w./ @+-]*$/.test(p.path) || p.path.includes('..')) throw new Error('Pasta do projeto inválida: use um caminho absoluto, sem "..".');
  return p;
}
export function validateBranch(b) {
  if (!/^[\w][\w./-]{0,120}$/.test(b || '') || b.includes('..')) throw new Error('Nome de branch inválido: ' + b);
  return b;
}
function validateFiles(files, allowed) {
  if (!Array.isArray(files) || !files.length) throw new Error('Nenhum arquivo selecionado');
  for (const f of files) {
    if (typeof f !== 'string' || f.startsWith('/') || f.includes('..') || !allowed.has(f)) throw new Error('Arquivo fora do diff atual: ' + f);
  }
  return files;
}

const data = (nodeId) => (server().nodeData[nodeId] ||= {});
const hostOf = (node, project) => data(node.id).target || project.server;

export async function ensureWorktree(node, project) {
  validateProject(project);
  validateBranch(node.branch);
  const d = data(node.id);
  if (!d.worktree) d.worktree = path.posix.join(path.posix.dirname(project.path), `wt-${slug(node.label)}-${node.id.slice(-5)}`);
  const wt = d.worktree;
  const cmd = `if [ -d ${shq(wt)} ]; then echo existe; else git -C ${shq(project.path)} worktree add -B ${shq(node.branch)} ${shq(wt)}; fi`;
  const r = await exec(project.server, cmd, { timeoutMs: 60000 });
  if (r.code !== 0) throw new Error('Não consegui criar o worktree: ' + r.stderr.slice(-400));
  d.target = project.server;
  saveServer();
  return wt;
}

function splitDiff(text) {
  const files = [];
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const m = /^a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (!m) continue;
    const body = chunk.slice(chunk.indexOf('@@') >= 0 ? chunk.indexOf('@@') : chunk.length);
    let add = 0, del = 0;
    for (const l of body.split('\n')) { if (l.startsWith('+') && !l.startsWith('+++')) add++; else if (l.startsWith('-') && !l.startsWith('---')) del++; }
    files.push({ path: m[2], add, del, sel: true, hunk: body.slice(0, 20000) || '(arquivo binário ou sem alterações de texto)' });
  }
  return files;
}

export async function refreshDiff(node, project) {
  const wt = data(node.id).worktree;
  if (!wt) return { files: [] };
  const r = await exec(hostOf(node, project), `cd ${shq(wt)} && git add -N . && git diff --no-color --no-ext-diff`, { timeoutMs: 60000 });
  const diff = { files: splitDiff(r.stdout) };
  data(node.id).diff = diff;
  saveServer();
  broadcast({ type: 'diff', nodeId: node.id, diff, commits: data(node.id).commits || [], pr: data(node.id).pr || null });
  return diff;
}

export async function commit(node, project, files, message, actor) {
  const d = data(node.id);
  validateFiles(files, new Set((d.diff?.files || []).map((f) => f.path)));
  const msg = String(message || '').slice(0, 300) || `Alterações de ${node.label} via Bancada`;
  const list = files.map(shq).join(' ');
  const r = await exec(hostOf(node, project), `cd ${shq(d.worktree)} && git add -- ${list} && git commit -m ${shq(msg)} && git rev-parse --short HEAD`, { timeoutMs: 60000 });
  if (r.code !== 0) throw new Error('Commit falhou: ' + (r.stderr || r.stdout).slice(-500));
  const hash = r.stdout.trim().split('\n').pop();
  d.commits = [...(d.commits || []), { hash, msg, files, ts: Date.now() }];
  addMessage(node.id, { role: 'tool', text: `$ git commit -m "${msg}"\n[${node.branch} ${hash}] ${files.length} arquivo(s)` });
  audit({ actor, action: 'Commitou', detail: `${msg} (${files.length} arquivo(s))`, nodeId: node.id });
  await refreshDiff(node, project);
  return hash;
}

export async function discard(node, project, files, actor) {
  const d = data(node.id);
  validateFiles(files, new Set((d.diff?.files || []).map((f) => f.path)));
  const script = files.map((f) => `git restore --staged -- ${shq(f)} 2>/dev/null; git restore -- ${shq(f)} 2>/dev/null || rm -f -- ${shq(f)}`).join('; ');
  await exec(hostOf(node, project), `cd ${shq(d.worktree)} && ${script}`, { timeoutMs: 60000 });
  addMessage(node.id, { role: 'tool', text: '$ git restore -- ' + files.join(' ') });
  audit({ actor, action: 'Descartou alterações', detail: files.join(', '), nodeId: node.id });
  return refreshDiff(node, project);
}

export async function openPR(node, project, actor) {
  const d = data(node.id);
  if (!d.commits?.length) throw new Error('Faça pelo menos um commit antes de abrir o PR');
  const r = await exec(hostOf(node, project), `cd ${shq(d.worktree)} && git push -u origin ${shq(node.branch)} && gh pr create --fill --head ${shq(node.branch)}`, { timeoutMs: 120000 });
  if (r.code !== 0) throw new Error('Não consegui abrir o PR (precisa do gh autenticado no servidor): ' + (r.stderr || r.stdout).slice(-500));
  const url = (r.stdout.match(/https:\/\/\S+\/pull\/\d+/) || [''])[0];
  d.pr = { url, num: Number((url.match(/\/pull\/(\d+)/) || [])[1]) || null, ts: Date.now() };
  saveServer();
  addMessage(node.id, { role: 'tool', text: `$ gh pr create --fill --head ${node.branch}\n${url}` });
  audit({ actor, action: 'Abriu PR', detail: url, nodeId: node.id });
  broadcast({ type: 'diff', nodeId: node.id, diff: d.diff || { files: [] }, commits: d.commits, pr: d.pr });
  return d.pr;
}

export const worktreeOf = (nodeId) => server().nodeData[nodeId]?.worktree;
export const targetOf = (nodeId) => server().nodeData[nodeId]?.target;
