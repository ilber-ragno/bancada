// Envio de mensagens aos agentes, terminal, orquestrador e playbooks.
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from './config.js';
import { exec, shq, lineSplitter, writeRemote } from './ssh.js';
import { getDoc, saveDoc, server, saveServer, findNode, findProject, linkedNodes, addMessage, setStatus, getStatus, audit } from './store.js';
import { broadcast } from './bus.js';
import { mask, checkRisky, isReadOnlyCmd } from './policy.js';
import { buildCommand, parserFor } from './agents.js';
import { contextFor } from './context.js';
import { ask, ensureHook, hookSettings, watchHost } from './approvals.js';
import { ensureWorktree, refreshDiff, worktreeOf, targetOf } from './git.js';
import { canUseAccount } from './permissions.js';
import { findUser } from './users.js';
import { parseTarget } from './ssh.js';
import { emit } from './inbox.js';
import { getSecret } from './vault.js';

const running = new Map(); // nodeId -> AbortController
const chains = new Map();
const NAME = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', shell: 'Terminal' };

// Decide com qual conta (usuário do servidor) o agente roda, respeitando o compartilhamento
export function runTarget(node, project, user) {
  const acc = node.accountId && (getDoc().accounts || []).find((a) => a.id === node.accountId);
  if (!acc) return project.server;
  const requester = (user?.id && findUser(user.id)) || findUser(node.owner);
  if (!canUseAccount(acc, requester)) throw new Error(`A conta "${acc.name}" não está compartilhada com ${requester?.name || 'quem pediu'}.`);
  if (acc.engine !== node.agent) throw new Error(`A conta "${acc.name}" é de outro motor.`);
  parseTarget(acc.target);
  return acc.target;
}

const activeOnHost = (target) => [...running.keys()].some((id) => findProject(findNode(id)?.projectId)?.server === target);

export function sendMessage(nodeId, text, opts = {}) {
  const prev = chains.get(nodeId) || Promise.resolve();
  const p = prev.catch(() => {}).then(() => runOne(nodeId, text, opts));
  chains.set(nodeId, p);
  return p;
}

export function stop(nodeId, user) {
  const ac = running.get(nodeId);
  if (!ac) return false;
  ac.abort();
  audit({ actor: user?.name, action: 'Parou o agente', nodeId });
  return true;
}

function skillsPrompt(ids = []) {
  const lib = getDoc().skills || [];
  return ids.map((id) => {
    const s = lib.find((x) => x.id === id);
    if (s?.content) return `## ${s.name}\n${s.content}`;
    if (!/^[a-z0-9-]+$/.test(id)) return '';
    try { return fs.readFileSync(path.join(cfg.skillsDir, id + '.md'), 'utf8').trim(); } catch { return ''; }
  }).filter(Boolean).join('\n\n');
}

const splitArgs = (s) => (String(s || '').match(/"[^"]*"|'[^']*'|\S+/g) || []).map((a) => a.replace(/^["']|["']$/g, ''));

// Monta o arquivo de MCP com os segredos do cofre só durante a execução (permissão 600) e devolve como apagar.
async function mcpFile(node, project) {
  const lib = getDoc().mcps || [];
  const chosen = (node.mcps || []).map((id) => lib.find((m) => m.id === id)).filter(Boolean);
  if (!chosen.length || node.agent !== 'claude') return { file: null, cleanup: async () => {} };
  const servers = {};
  for (const m of chosen) {
    const env = {};
    for (const e of m.env || []) { const v = getSecret('mcp:' + m.id, e.key); if (v) env[e.key] = v; }
    servers[m.id] = { command: m.command, args: splitArgs(m.args), env };
  }
  const home = (await exec(project.server, 'printf %s "$HOME"', { timeoutMs: 15000 })).stdout.trim();
  if (!home.startsWith('/')) throw new Error('Não consegui descobrir a pasta home no servidor');
  const file = `${home}/.bancada/mcp-${node.id}-${Date.now()}.json`;
  await writeRemote(project.server, shq(file), JSON.stringify({ mcpServers: servers }));
  return { file, cleanup: () => exec(project.server, `rm -f ${shq(file)}`, { timeoutMs: 15000 }).catch(() => {}) };
}

function modeFor(node, project) {
  const s = getDoc().settings || {};
  if (project.env === 'prod') return s.prodReadOnly === false ? 'normal' : 'readOnly';
  return node.danger ? 'danger' : 'normal';
}

async function runOne(nodeId, rawText, { from, user } = {}) {
  const node = findNode(nodeId);
  if (!node) throw new Error('Janela não encontrada');
  if (node.type === 'orch') return runOrch(node, rawText, user);
  if (node.type !== 'agent') throw new Error('Esta janela não recebe mensagens');
  if (node.agent === 'shell') throw new Error('Esta janela é um terminal; use o modo terminal.');
  const baseProject = findProject(node.projectId);
  if (!baseProject) throw new Error('Projeto da janela não encontrado');
  const project = { ...baseProject, server: runTarget(node, baseProject, user) };
  const settings = getDoc().settings || {};
  const text = settings.mask === false ? rawText : mask(rawText).text;
  const actor = user?.name || from || 'agendamento';

  addMessage(nodeId, from ? { role: 'peer', from, text } : { role: 'user', text, by: user?.name });
  audit({ actor, action: from ? 'Recebeu tarefa' : 'Enviou mensagem', detail: text.slice(0, 200), nodeId });

  const risky = checkRisky(text, settings.risky);
  if (risky) {
    const ok = await ask({ nodeId, cmd: text, reason: `A mensagem pede uma ação marcada como arriscada ("${risky}").`, by: user?.id, byName: user?.name });
    if (!ok) { addMessage(nodeId, { role: 'note', text: 'Negado. A mensagem não foi enviada ao agente.' }); return ''; }
  }

  const ac = new AbortController();
  running.set(nodeId, ac);
  (server().runners ||= {})[nodeId] = user ? { id: user.id, name: user.name } : null;
  setStatus(nodeId, 'running');
  let final = '';
  let mcp = { cleanup: async () => {} };
  try {
    const wt = await ensureWorktree(node, project);
    const mode = modeFor(node, project);
    if (mode === 'readOnly') addMessage(nodeId, { role: 'note', text: 'Produção em somente leitura: o agente vai analisar sem alterar arquivos.' });
    let settingsJson = null;
    if (node.agent === 'claude' && mode === 'normal') {
      await ensureHook(project.server);
      settingsJson = hookSettings();
      watchHost(project.server, activeOnHost);
    }
    const ctx = contextFor(node);
    const prompt = (ctx ? `Contexto preparado pela Bancada (leia antes de agir):\n${ctx}\n\n---\n\n` : '') + text;
    const session = server().sessions[nodeId];
    mcp = await mcpFile(node, project);
    const cmd = `cd ${shq(wt)} && ` + buildCommand(node.agent, {
      session: session?.agent === node.agent ? session.id : null,
      mode,
      systemPrompt: skillsPrompt(node.skills),
      mcpFile: mcp.file,
      settingsJson,
    });
    const parse = parserFor(node.agent);
    let chunks = [];
    const onLine = (line) => {
      for (const ev of parse(line)) {
        if (ev.kind === 'chunk') { chunks.push(ev.text); continue; }
        if (ev.kind === 'session') { server().sessions[nodeId] = { id: ev.id, agent: node.agent }; saveServer(); }
        else if (ev.kind === 'text') { final = ev.text; addMessage(nodeId, { role: 'agent', text: ev.text }); }
        else if (ev.kind === 'tool') addMessage(nodeId, { role: 'tool', text: ev.text });
        else if ((ev.kind === 'result' && ev.error) || ev.kind === 'error') addMessage(nodeId, { role: 'warn', text: ev.text || 'O agente terminou com erro.' });
      }
    };
    const res = await exec(project.server, cmd, { onStdout: lineSplitter(onLine), signal: ac.signal, stdin: prompt });
    if (chunks.length) { final = chunks.join('\n').slice(-20000); addMessage(nodeId, { role: 'agent', text: final }); }
    if (ac.signal.aborted) addMessage(nodeId, { role: 'note', text: 'Agente interrompido.' });
    else if (res.code !== 0 && !final) addMessage(nodeId, { role: 'warn', text: `O agente saiu com código ${res.code}. ${res.stderr.slice(-800)}` });
    await refreshDiff(node, project).catch((e) => addMessage(nodeId, { role: 'note', text: 'Não consegui ler o diff: ' + e.message }));
    audit({ actor: node.label, action: 'Concluiu', detail: final.slice(0, 200), nodeId });
    emit('done', `${node.label} terminou`, final.slice(0, 600) || 'Atividade concluída.', { nodeId });
    return final;
  } catch (e) {
    addMessage(nodeId, { role: 'warn', text: 'Erro: ' + e.message });
    emit('error', `${node.label}: erro`, e.message, { nodeId });
    throw e;
  } finally {
    await mcp.cleanup();
    running.delete(nodeId);
    setStatus(nodeId, 'idle');
  }
}

async function runOrch(orch, text, user) {
  const workers = linkedNodes(orch.id).filter((n) => n.type === 'agent');
  addMessage(orch.id, { role: 'user', text, by: user?.name });
  if (!workers.length) { addMessage(orch.id, { role: 'note', text: 'Nenhum projeto ligado a este orquestrador.' }); return ''; }
  setStatus(orch.id, 'running');
  addMessage(orch.id, { role: 'tool', text: 'Enviado para ' + workers.map((w) => w.label).join(', ') });
  audit({ actor: user?.name || 'agendamento', action: 'Enviou tarefa', detail: text.slice(0, 200), nodeId: orch.id });
  const results = await Promise.allSettled(workers.map((w) => sendMessage(w.id, `[Tarefa do ${orch.label}]\n${text}`, { from: orch.label, user })));
  let ok = 0;
  results.forEach((r, i) => {
    const w = workers[i];
    if (r.status === 'fulfilled') { ok++; addMessage(orch.id, { role: 'peer', from: `${w.label} (${NAME[w.agent] || w.agent})`, text: String(r.value || 'Concluído sem resposta em texto.').slice(0, 2000) }); }
    else addMessage(orch.id, { role: 'peer', from: w.label, text: 'Falhou: ' + r.reason?.message });
  });
  const summary = `Resumo: ${ok} de ${workers.length} projetos concluíram.`;
  addMessage(orch.id, { role: 'agent', text: summary });
  setStatus(orch.id, 'idle');
  audit({ actor: orch.label, action: 'Concluiu tarefa', detail: summary, nodeId: orch.id });
  emit('done', orch.label, summary, { nodeId: orch.id });
  return summary;
}

export async function runTerminal(nodeId, rawCmd, user) {
  const node = findNode(nodeId);
  const project = node && findProject(node.projectId);
  if (!project) throw new Error('Janela sem projeto');
  const settings = getDoc().settings || {};
  const cmd = String(rawCmd).slice(0, 4000);
  addMessage(nodeId, { role: 'cmd', text: '$ ' + cmd, by: user?.name }, 'term');
  if (project.env === 'prod' && settings.prodReadOnly !== false && !isReadOnlyCmd(cmd)) {
    addMessage(nodeId, { role: 'out', text: 'Bloqueado: produção está em somente leitura.' }, 'term');
    audit({ actor: user?.name, action: 'Bloqueou comando', detail: cmd, nodeId });
    return;
  }
  const risky = checkRisky(cmd, settings.risky);
  if (risky && !(await ask({ nodeId, cmd, reason: `Comando marcado como arriscado ("${risky}").`, by: user?.id, byName: user?.name }))) {
    addMessage(nodeId, { role: 'out', text: 'Negado.' }, 'term');
    return;
  }
  const wt = worktreeOf(nodeId) || await ensureWorktree(node, { ...project, server: runTarget(node, project, user) });
  audit({ actor: user?.name, action: 'Rodou comando', detail: cmd, nodeId });
  const r = await exec(targetOf(nodeId) || project.server, `cd ${shq(wt)} && ${cmd}`, { timeoutMs: 120000 }).catch((e) => ({ stdout: '', stderr: e.message, code: -1 }));
  addMessage(nodeId, { role: 'out', text: ((r.stdout + r.stderr).slice(-20000) || '(sem saída)') + (r.code ? `\n[código ${r.code}]` : '') }, 'term');
}

// ---------- Playbooks ----------
export const parseSteps = (t) => String(t || '').split('\n').map((l) => l.match(/^\s*[-*]\s*\[( |x|X)\]\s+(.+)/)).filter(Boolean).map((m) => ({ text: m[2].trim(), done: m[1] !== ' ' }));

function resetSessions(node) {
  const ids = node.type === 'orch' ? linkedNodes(node.id).filter((n) => n.type === 'agent').map((n) => n.id) : [node.id];
  for (const id of ids) delete server().sessions[id];
  saveServer();
}

export async function runPlaybook(pb, user, targetId) {
  const target = findNode(targetId || pb.target);
  if (!target) throw new Error('A janela de destino do playbook não está aberta');
  const steps = parseSteps(pb.steps).filter((s) => !s.done);
  if (!steps.length) throw new Error('O playbook não tem passos pendentes no formato "- [ ] passo"');
  const run = { id: 'r' + Date.now().toString(36), pbId: pb.id, ts: Date.now(), status: 'running', target: target.id, steps: steps.map((s) => ({ text: s.text, status: 'pending' })) };
  const srv = server();
  srv.runs = [run, ...(srv.runs || [])].slice(0, 50);
  const push = () => { saveServer(); broadcast({ type: 'runs', runs: srv.runs }); };
  push();
  audit({ actor: user?.name || 'agendamento', action: 'Rodou playbook', detail: pb.name, nodeId: target.id });
  for (const step of run.steps) {
    step.status = 'running'; push();
    try {
      resetSessions(target);
      addMessage(target.id, { role: 'note', text: `Playbook "${pb.name}": passo em sessão limpa.` });
      await sendMessage(target.id, step.text, { user });
      step.status = 'done'; step.ts = Date.now();
    } catch (e) {
      step.status = 'failed'; step.error = e.message; push(); break;
    }
    push();
  }
  run.status = run.steps.every((s) => s.status === 'done') ? 'done' : 'failed';
  pb.lastRun = Date.now();
  saveDoc();
  push();
  emit(run.status === 'done' ? 'done' : 'error', `Playbook "${pb.name}"`, `${run.steps.filter((s) => s.status === 'done').length} de ${run.steps.length} passos concluídos.`, { nodeId: target.id });
  return run;
}

export const isRunning = (nodeId) => running.has(nodeId) || getStatus(nodeId) === 'running';
export { NAME };
