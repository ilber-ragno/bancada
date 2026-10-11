// Lê o consumo dos planos abrindo o CLI num tmux temporário e capturando /usage (Claude) e /status (Codex).
// É uma leitura de tela: se o formato mudar, o valor volta como indisponível em vez de inventado.
import { cfg } from './config.js';
import { exec, shq } from './ssh.js';
import { server, saveServer, getDoc } from './store.js';
import { broadcast } from './bus.js';
import { emit } from './inbox.js';

export function parseUsage(text, agent) {
  const lines = String(text).split('\n');
  const pick = (re) => {
    const i = lines.findIndex((l) => re.test(l));
    if (i < 0) return null;
    for (let j = i; j < Math.min(lines.length, i + 4); j++) {
      const m = lines[j].match(/(\d{1,3}(?:[.,]\d)?)\s*%\s*(used|usado|left|restante)?/i);
      if (m) {
        let pct = Math.round(parseFloat(m[1].replace(',', '.')));
        if (/left|restante/i.test(m[2] || '')) pct = 100 - pct;
        const ctx = lines.slice(i, j + 3).join(' ');
        const reset = (ctx.match(/resets?\s*(?:at|em|às)?\s*([^·|)\n]{3,40})/i) || [])[1];
        return { pct: Math.max(0, Math.min(100, pct)), reset: reset ? reset.trim() : null };
      }
    }
    return null;
  };
  const session = pick(agent === 'claude' ? /current session|sessão atual/i : /5h|5-hour|5 h/i);
  const week = pick(/current week|weekly|semana|week/i);
  return {
    session: session?.pct ?? null, sessionResetText: session?.reset ?? null,
    week: week?.pct ?? null, weekResetText: week?.reset ?? null,
  };
}

async function readOne(target, agent) {
  const name = 'bancada-usage-' + agent;
  const bin = cfg.agents[agent].bin;
  const slash = agent === 'claude' ? '/usage' : '/status';
  const script = [
    `tmux kill-session -t ${name} 2>/dev/null`,
    `tmux new-session -d -s ${name} -x 220 -y 60 ${shq(bin)}`,
    'sleep 6',
    `tmux send-keys -t ${name} ${shq(slash)} Enter`,
    'sleep 5',
    `tmux capture-pane -p -t ${name} -S -120`,
    `tmux kill-session -t ${name} 2>/dev/null; true`,
  ].join('; ');
  const r = await exec(target, script, { timeoutMs: 45000 });
  return parseUsage(r.stdout, agent);
}

export async function refreshUsage() {
  const target = cfg.usageHost || (getDoc().projects || [])[0]?.server;
  if (!target) return server().usage;
  const prev = server().usage || {};
  const next = {};
  for (const agent of ['claude', 'codex']) {
    try {
      next[agent] = { ...(prev[agent] || {}), ...(await readOne(target, agent)), checked: Date.now(), source: target.split('@').pop(), error: null };
    } catch (e) {
      next[agent] = { ...(prev[agent] || {}), error: e.message, checked: Date.now(), source: target.split('@').pop() };
    }
  }
  for (const a of ['claude', 'codex']) {
    const before = prev[a]?.session ?? 0, now = next[a]?.session;
    if (now != null && before < 80 && now >= 80) emit('usage', `Consumo do ${a === 'claude' ? 'Claude Code' : 'Codex'}`, `A janela de 5 h chegou a ${now}%.`);
  }
  server().usage = next;
  saveServer();
  broadcast({ type: 'usage', usage: next });
  return next;
}

export function startUsageLoop() {
  const tick = () => refreshUsage().catch((e) => console.error('[usage]', e.message));
  setTimeout(tick, 5000);
  setInterval(tick, cfg.usageIntervalMin * 60000);
}
