// Monta os comandos dos CLIs e traduz a saída JSON de cada um em eventos simples.
// Os formatos de saída mudam entre versões: confira com `claude --help` e `codex exec --help`
// e ajuste config/agents.json se precisar.
import { cfg } from './config.js';
import { shq } from './ssh.js';

const fill = (parts, vars) => parts.map((p) => p.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''));

export function buildCommand(agent, { prompt, session, mode, systemPrompt, mcpFile, settingsJson }) {
  const a = cfg.agents[agent];
  if (!a) throw new Error('Agente desconhecido: ' + agent);
  const args = [...a.base];
  if (mode === 'readOnly' && !a.readOnly) throw new Error(`O ${agent} não tem modo somente leitura configurado; bloqueado em produção.`);
  if (mode === 'danger') args.push(...a.danger);
  else if (mode === 'readOnly') args.push(...a.readOnly);
  else args.push(...(a.normal || []));
  if (systemPrompt && a.systemPrompt) args.push(...fill(a.systemPrompt, { text: systemPrompt }));
  if (mcpFile && a.mcpConfig) args.push(...fill(a.mcpConfig, { file: mcpFile }));
  if (settingsJson && a.settings) args.push(...fill(a.settings, { json: settingsJson }));
  if (session && a.resume) args.push(...fill(a.resume, { session }));
  // O prompt vai pela entrada padrão (stdin) para não esbarrar no limite de tamanho de argumento.
  if (agent === 'codex') args.push('-');
  return [a.bin, ...args.map(shq)].join(' ');
}

function toolLine(name, input = {}) {
  if (name === 'Bash') return '$ ' + (input.command || '');
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return `${name}: ${input.file_path || ''}`;
  if (name === 'Read') return 'Leu ' + (input.file_path || '');
  return `${name} ${JSON.stringify(input).slice(0, 300)}`;
}

export function parseClaude(line) {
  let e;
  try { e = JSON.parse(line); } catch { return []; }
  const out = [];
  if (e.type === 'system' && e.subtype === 'init' && e.session_id) out.push({ kind: 'session', id: e.session_id });
  if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
    for (const c of e.message.content) {
      if (c.type === 'text' && c.text?.trim()) out.push({ kind: 'text', text: c.text });
      if (c.type === 'tool_use') out.push({ kind: 'tool', text: toolLine(c.name, c.input) });
    }
  }
  if (e.type === 'result') {
    if (e.session_id) out.push({ kind: 'session', id: e.session_id });
    out.push({ kind: 'result', error: !!e.is_error, text: e.is_error ? String(e.result || e.subtype || 'erro') : '' });
  }
  return out;
}

export function parseCodex(line) {
  let e;
  try { e = JSON.parse(line); } catch { return []; }
  const out = [];
  const id = e.thread_id || e.session_id || e.msg?.session_id;
  if (id && /thread\.started|session/.test(e.type || e.msg?.type || '')) out.push({ kind: 'session', id });
  if (e.type === 'item.completed' && e.item) {
    const it = e.item, t = it.type || it.item_type;
    if (t === 'agent_message' || t === 'assistant_message') out.push({ kind: 'text', text: it.text || '' });
    else if (t === 'command_execution') out.push({ kind: 'tool', text: '$ ' + (it.command || '') + (it.aggregated_output ? '\n' + String(it.aggregated_output).slice(-1500) : '') });
    else if (t === 'file_change') out.push({ kind: 'tool', text: 'Alterou: ' + (it.changes || []).map((c) => c.path).join(', ') });
  }
  if (e.type === 'turn.failed' || e.type === 'error') out.push({ kind: 'error', text: e.error?.message || e.message || 'erro do Codex' });
  return out;
}

// Gemini CLI: saída em texto simples; as linhas são juntadas numa resposta ao final
export const parseText = (line) => [{ kind: 'chunk', text: line }];

export const parserFor = (agent) => (agent === 'codex' ? parseCodex : agent === 'gemini' ? parseText : parseClaude);
