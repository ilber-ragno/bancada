// Descobre sessões antigas dos CLIs no servidor para retomar na Bancada.
import { exec, shq } from './ssh.js';
import { findNode, findProject, server, saveServer, audit } from './store.js';
import { worktreeOf } from './git.js';

const firstText = (msg) => {
  const c = msg?.message?.content ?? msg?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => x.text || '').join(' ');
  return '';
};

export async function listSessions(nodeId) {
  const node = findNode(nodeId);
  const project = node && findProject(node.projectId);
  if (!project) throw new Error('Janela sem projeto');
  const dirs = [project.path, worktreeOf(nodeId)].filter(Boolean);
  const items = [];
  // Claude Code guarda em ~/.claude/projects/<pasta com / trocado por ->/<id>.jsonl
  for (const dir of dirs) {
    const enc = dir.replace(/[^a-zA-Z0-9]/g, '-');
    const r = await exec(project.server, `d=~/.claude/projects/${shq(enc)}; ls -t "$d"/*.jsonl 2>/dev/null | head -20 | while read f; do printf '@@@%s\\t%s\\n' "$f" "$(stat -c %Y "$f")"; grep -m1 '"type":"user"' "$f" | head -c 4000; printf '\\n'; done`, { timeoutMs: 20000 });
    for (const b of r.stdout.split('@@@').slice(1)) {
      const [head, ...rest] = b.split('\n');
      const [file, mtime] = head.split('\t');
      let title = '';
      try { title = firstText(JSON.parse(rest.join('\n').trim())); } catch {}
      items.push({ agent: 'claude', id: file.split('/').pop().replace(/\.jsonl$/, ''), title: title.slice(0, 140) || '(sem título)', ts: Number(mtime) * 1000 });
    }
  }
  // Codex guarda em ~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl, com a pasta de trabalho na primeira linha
  const rc = await exec(project.server, `ls -t ~/.codex/sessions/*/*/*/*.jsonl 2>/dev/null | head -60 | while read f; do printf '@@@%s\\t%s\\n' "$f" "$(stat -c %Y "$f")"; head -n 1 "$f" | head -c 4000; printf '\\n'; done`, { timeoutMs: 20000 });
  for (const b of rc.stdout.split('@@@').slice(1)) {
    const [head, ...rest] = b.split('\n');
    const [, mtime] = head.split('\t');
    try {
      const meta = JSON.parse(rest.join('\n').trim());
      const p = meta.payload || meta;
      if (!dirs.some((d) => String(p.cwd || '').startsWith(d))) continue;
      items.push({ agent: 'codex', id: p.id || p.session_id, title: (p.instructions || 'Sessão do Codex').slice(0, 140), ts: Number(mtime) * 1000 });
    } catch {}
  }
  return items.filter((i) => i.id).sort((a, b) => b.ts - a.ts);
}

export function resume(nodeId, agent, sessionId, actor) {
  if (!['claude', 'codex'].includes(agent) || !/^[\w-]{6,80}$/.test(sessionId || '')) throw new Error('Sessão inválida');
  server().sessions[nodeId] = { id: sessionId, agent };
  saveServer();
  audit({ actor, action: 'Retomou sessão', detail: `${agent} ${sessionId}`, nodeId });
}
