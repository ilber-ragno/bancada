// Agendador (roda no servidor, mesmo com a tela fechada), turnos das equipes e mensagens guardadas fora do turno.
import { getDoc, saveDoc, findNode, addMessage, audit, server, saveServer } from './store.js';
import { broadcast } from './bus.js';
import { sendMessage, runPlaybook } from './sessions.js';
import { emit } from './inbox.js';

const toMin = (t) => { const [a, b] = String(t || '0:0').split(':').map(Number); return a * 60 + b; };

export function inShift(team, d = new Date()) {
  const sh = team.shift;
  if (!sh || !sh.days?.includes(d.getDay())) return false;
  const m = d.getHours() * 60 + d.getMinutes(), s0 = toMin(sh.start), s1 = toMin(sh.end);
  return s1 > s0 ? m >= s0 && m < s1 : m >= s0 || m < s1;
}

const teamsOf = (nodeId) => (getDoc().teams || []).filter((t) => t.members?.includes(nodeId) || t.lead === nodeId);
export const strictOff = (nodeId) => teamsOf(nodeId).find((t) => t.strict && !inShift(t)) || null;

export function nextRun(sc, from = Date.now()) {
  const w = sc.when || {};
  const [hh, mm] = String(w.at || '09:00').split(':').map(Number);
  if (w.kind === 'once') { if (!w.date) return null; const d = new Date(`${w.date}T${w.at || '09:00'}`); return d > from && !sc.lastRun ? d : null; }
  if (w.kind === 'interval') { const base = sc.lastRun || from; return new Date(Math.max(base + Math.max(1, Number(w.every) || 1) * 3600000, from + 60000)); }
  for (let i = 0; i < 9; i++) {
    const d = new Date(from); d.setDate(d.getDate() + i); d.setHours(hh, mm, 0, 0);
    if (d <= from) continue;
    if (w.kind === 'daily' || (w.days || []).includes(d.getDay())) return d;
  }
  return null;
}

export function hold(nodeId, text, source) {
  const held = (server().held ||= {});
  (held[nodeId] ||= []).push({ text, source, ts: Date.now() });
  saveServer();
  const t = strictOff(nodeId);
  addMessage(nodeId, { role: 'note', text: `Fora do turno${t ? ` da equipe "${t.name}"` : ''}. A mensagem fica guardada e sai quando o turno começar.` });
  broadcast({ type: 'held', nodeId, held: held[nodeId].map((x) => x.text) });
}

export function flushHeld(nodeId, user) {
  const held = server().held || {};
  const list = held[nodeId] || [];
  delete held[nodeId];
  saveServer();
  broadcast({ type: 'held', nodeId, held: [] });
  for (const x of list) sendMessage(nodeId, x.text, { user: user || x.source }).catch(() => {});
  if (list.length) audit({ actor: user?.name || 'turno', action: 'Enviou mensagens guardadas', detail: `${list.length} mensagem(ns)`, nodeId });
  return list.length;
}

function record(sc, status, detail) {
  sc.history = [{ ts: Date.now(), status, detail }, ...(sc.history || [])].slice(0, 30);
  saveDoc();
  broadcast({ type: 'schedules', schedules: getDoc().schedules });
}

export async function runSchedule(sc, user, manual = false) {
  sc.lastRun = Date.now();
  const doc = getDoc();
  const team = sc.target?.type === 'team' ? (doc.teams || []).find((t) => t.id === sc.target.id) : null;
  const targets = (team ? team.members : [sc.target?.id]).map(findNode).filter((n) => n && n.type !== 'note');
  if (!targets.length) { record(sc, 'failed', 'destino não está aberto'); emit('error', `Agendamento "${sc.name}"`, 'O destino não está aberto.'); return; }
  const text = sc.action?.type === 'playbook' ? null : (sc.action?.text || '').trim();
  if (sc.action?.type !== 'playbook' && !text) { record(sc, 'failed', 'sem texto'); return; }
  if (!manual && team?.strict && !inShift(team)) {
    if (text) targets.forEach((n) => hold(n.id, text, null));
    record(sc, 'skipped', 'fora do turno, guardada');
    return;
  }
  audit({ actor: user?.name || 'agendador', action: 'Rodou agendamento', detail: sc.name + (manual ? ' (manual)' : ''), nodeId: targets[0].id });
  try {
    if (sc.action?.type === 'playbook') {
      const pb = (doc.playbooks || []).find((p) => p.id === sc.action.playbookId);
      if (!pb) throw new Error('playbook não encontrado');
      await Promise.all(targets.map((n) => runPlaybook(pb, user, n.id)));
    } else {
      await Promise.all(targets.map((n) => sendMessage(n.id, text, { user })));
    }
    record(sc, 'ok', `${targets.length} agente(s)`);
    emit('schedule', `Agendamento "${sc.name}"`, `Executado em ${targets.map((n) => n.label).join(', ')}.`, { nodeId: targets[0].id });
  } catch (e) {
    record(sc, 'failed', e.message);
    emit('error', `Agendamento "${sc.name}"`, e.message, { nodeId: targets[0].id });
  }
}

export function startScheduler() {
  setInterval(() => {
    const now = Date.now();
    for (const sc of getDoc().schedules || []) {
      if (!sc.enabled) continue;
      const due = nextRun(sc, now - 60000);
      if (due && due <= now && (!sc.lastRun || now - sc.lastRun > 90000)) runSchedule(sc, null).catch((e) => console.error('[agendador]', e.message));
    }
    for (const nodeId of Object.keys(server().held || {})) if (!strictOff(nodeId)) flushHeld(nodeId, null);
  }, 30000);
}
