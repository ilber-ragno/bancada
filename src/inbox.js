// Notificações: caixa de entrada por pessoa, push no aparelho (Web Push), Telegram e webhook.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';
import { cfg } from './config.js';
import { getDoc, findNode } from './store.js';
import { allUsers } from './users.js';
import { can, canSeeProject } from './permissions.js';
import { sendTo } from './bus.js';
import { encrypt, decrypt } from './vault.js';

const dir = path.join(cfg.dataDir, 'inbox');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const pushFile = path.join(cfg.dataDir, 'push.json');
const vapidFile = path.join(cfg.dataDir, 'vapid.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v), { mode: 0o600 }); fs.renameSync(f + '.tmp', f); };

let subs = readJson(pushFile, {});
let vapid = null;
export function initPush() {
  let v = readJson(vapidFile, null);
  if (!v) { const k = webpush.generateVAPIDKeys(); v = { publicKey: k.publicKey, privateKey: encrypt(k.privateKey) }; writeJson(vapidFile, v); }
  vapid = { publicKey: v.publicKey, privateKey: decrypt(v.privateKey) };
  webpush.setVapidDetails(process.env.PUSH_SUBJECT || 'mailto:admin@localhost', vapid.publicKey, vapid.privateKey);
}
export const pushPublicKey = () => vapid?.publicKey;

export function addSubscription(userId, sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Inscrição de push inválida');
  const list = (subs[userId] ||= []).filter((s) => s.endpoint !== sub.endpoint);
  list.push({ endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } });
  subs[userId] = list.slice(-5);
  writeJson(pushFile, subs);
}

async function push(userId, title, body) {
  const list = subs[userId] || [];
  for (const s of list) {
    try { await webpush.sendNotification(s, JSON.stringify({ title, body: String(body).slice(0, 200) }), { TTL: 3600 }); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) { subs[userId] = subs[userId].filter((x) => x.endpoint !== s.endpoint); writeJson(pushFile, subs); } }
  }
}

const inboxFile = (userId) => path.join(dir, userId.replace(/[^\w-]/g, '') + '.json');
export const readInbox = (userId) => readJson(inboxFile(userId), []);
export function markRead(userId, ids) {
  const list = readInbox(userId);
  for (const it of list) if (!ids || ids.includes(it.id)) it.read = true;
  writeJson(inboxFile(userId), list);
}

const DEFAULTS = { done: { app: true }, approval: { app: true, push: true, telegram: true }, error: { app: true, push: true }, schedule: { app: true }, usage: { app: true } };
const prefsOf = (userId) => (getDoc().prefs || {})[userId] || { events: DEFAULTS };

async function telegram(chat, text) {
  if (!cfg.telegramToken || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
    });
  } catch (e) { console.error('[telegram]', e.message); }
}

// kind: done | approval | error | schedule | usage
export async function emit(kind, title, text, { nodeId = null } = {}) {
  const n = nodeId && findNode(nodeId);
  if (n && kind === 'done' && n.notify === false) return 0;
  let sent = 0;
  for (const u of allUsers()) {
    if (!u.active || !can(u, 'view')) continue;
    if (n?.projectId && !canSeeProject(u, n.projectId)) continue;
    if (kind === 'approval' && !can(u, 'approve', n?.projectId)) continue;
    const pr = prefsOf(u.id);
    const ch = (pr.events || DEFAULTS)[kind] || {};
    const item = { id: 'i' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'), ts: Date.now(), kind, title, text: String(text || '').slice(0, 300), nodeId, read: false };
    if (ch.app) {
      const list = [item, ...readInbox(u.id)].slice(0, 200);
      writeJson(inboxFile(u.id), list);
      sendTo(u.id, { type: 'inbox', item, push: false });
      sent++;
    }
    if (ch.push) { push(u.id, title, text); sent++; }
    if (ch.telegram && pr.telegramChat) { telegram(pr.telegramChat, `${title}\n${text}`); sent++; }
  }
  // Canal geral do time (opcional) e webhook
  const tg = getDoc().integrations?.telegram;
  const team = cfg.telegramChat || (tg?.connected ? tg.chatId : '');
  if (team && (!tg?.events || tg.events[kind] !== false) && !(n && n.projectId && (getDoc().projects || []).find((p) => p.id === n.projectId)?.env === 'prod' && kind === 'done')) {
    telegram(team, `${title}\n${text}`); sent++;
  }
  if (cfg.webhookUrl) {
    fetch(cfg.webhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, title, text, node: n ? { id: n.id, label: n.label } : null, ts: Date.now() }) }).catch(() => {});
    sent++;
  }
  return sent;
}
