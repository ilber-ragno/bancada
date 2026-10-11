import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { cfg, assertConfig } from './config.js';
import { addClient, broadcast, configureBus, dropUser } from './bus.js';
import { fullState, stripDoc, setDoc, getDoc, findNode, findProject, audit, server as srv } from './store.js';
import { login, logout, sessionOf, sameOrigin, loginPage, accountPage, accountPassword, accountTotp, invitePage, acceptInvite, setupPage, setupSubmit, _sessions } from './auth.js';
import { createInvite, listInvites, revokeInvite } from './invites.js';
import { listDir, readFile } from './files.js';
import { sendMessage, runTerminal, stop, runPlaybook } from './sessions.js';
import { decide } from './approvals.js';
import { commit, discard, openPR, refreshDiff } from './git.js';
import { refreshUsage, startUsageLoop } from './usage.js';
import { listSessions, resume } from './history.js';
import { startScheduler, runSchedule, strictOff, hold, flushHeld } from './scheduler.js';
import { emit, initPush, pushPublicKey, addSubscription, readInbox, markRead } from './inbox.js';
import { can } from './permissions.js';
import { filterFor, mergeFrom, makeView, canNode } from './acl.js';
import { allUsers, findUser, publicUser, createUser, updateUser, resetPassword, revokeSessions, hasUsers } from './users.js';
import { setSecret, checkVault } from './vault.js';
import { exec, shq, writeRemote } from './ssh.js';

const problems = assertConfig();
if (problems.length) {
  console.error('Configuração incompleta:\n- ' + problems.join('\n- ') + '\nVeja o arquivo .env.example.');
  process.exit(1);
}
checkVault();
initPush();

// Quem pode receber cada evento em tempo real
configureBus({
  findUser,
  validate: (sid, userId) => { const s = _sessions.get(sid); const u = findUser(userId); return !!(s && u && u.active && s.epoch === (u.sessionEpoch || 1)); },
  filter: (user, ev) => {
    if (!can(user, 'view')) return false;
    const doc = getDoc();
    if (ev.type === 'event') return ev.event.nodeId ? makeView(doc, user).visible(findNode(ev.event.nodeId)) : can(user, 'audit');
    if (ev.nodeId) return makeView(doc, user).visible(findNode(ev.nodeId));
    if (ev.type === 'schedules' || ev.type === 'runs') return user.projects === '*';
    return true;
  },
});

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com', "img-src 'self' data:", "connect-src 'self' ws: wss:", "worker-src 'self'", `frame-src ${process.env.PORTAL_FRAME_SRC || 'https: http://localhost:* http://127.0.0.1:*'}`, "frame-ancestors 'none'", "form-action 'self'", "base-uri 'none'",
  ].join('; '));
  if (cfg.secureCookie) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

const form = express.urlencoded({ extended: false, limit: '4kb' });
app.get('/setup', (req, res) => setupPage(req, res));
app.post('/setup', form, setupSubmit);
app.get('/login', (req, res) => (!hasUsers() ? res.redirect('/setup') : sessionOf(req) ? res.redirect('/') : res.send(loginPage())));
app.post('/login', form, login);
app.post('/logout', logout);
app.get('/account', (req, res) => accountPage(req, res));
app.post('/account/password', form, accountPassword);
app.post('/account/totp', form, accountTotp);
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/invite/:token', (req, res) => invitePage(req, res));
app.post('/invite/:token', form, acceptInvite);
app.get('/sw.js', (req, res) => res.type('application/javascript').send(fs.readFileSync(path.join(cfg.root, 'web', 'sw.js'), 'utf8')));

// Daqui para baixo, só com sessão completa (senha trocada e 2FA, se exigido)
app.use((req, res, next) => {
  const x = sessionOf(req);
  if (!x) return req.path.startsWith('/api') ? res.status(401).json({ error: 'Não autenticado' }) : res.redirect(hasUsers() ? '/login' : '/setup');
  if (x.session.setup) return req.path.startsWith('/api') ? res.status(403).json({ error: 'Conclua a configuração da conta' }) : res.redirect('/account');
  req.user = x.user; req.sid = x.sid;
  next();
});

const indexHtml = () => fs.readFileSync(path.join(cfg.root, 'web', 'index.html'), 'utf8').replace('<!--BANCADA_CONFIG-->', '<script>window.BANCADA_LIVE=true</script>');
app.get('/', (req, res) => res.type('html').send(indexHtml()));

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && !sameOrigin(req)) return res.status(403).json({ error: 'Origem não permitida' });
  next();
}, express.json({ limit: '5mb' }));

const deny = (res, msg = 'Seu acesso não permite isso.') => res.status(403).json({ error: msg });
const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => res.status(e.status || 400).json({ error: e.message }));
const forbidden = (msg) => Object.assign(new Error(msg || 'Seu acesso não permite isso.'), { status: 403 });
const need = (perm) => (req, res, next) => (can(req.user, perm) ? next() : deny(res));
function nodeFor(req, perm) {
  const n = findNode(req.params.id);
  if (!n) throw new Error('Janela não encontrada');
  if (!canNode(getDoc(), req.user, perm, n)) throw forbidden();
  return n;
}
const projectOf = (n) => { const p = findProject(n.projectId); if (!p) throw new Error('Projeto não encontrado'); return p; };
const background = (p, nodeId) => p.catch((e) => broadcast({ type: 'toast', nodeId, text: e.message }));
const actor = (req) => ({ id: req.user.id, name: req.user.name });

// ---------- Estado ----------
app.get('/api/state', (req, res) => {
  const s = filterFor(fullState(), req.user);
  s.inbox = { [req.user.id]: readInbox(req.user.id) };
  s.invites = listInvites().filter((i) => i.createdBy === req.user.id || can(req.user, 'users'));
  res.json(s);
});
app.put('/api/state', wrap((req, res) => {
  const merged = mergeFrom(getDoc(), stripDoc(req.body), req.user);
  setDoc(merged);
  res.json({ ok: true });
}));

// ---------- Janelas ----------
app.post('/api/nodes/:id/message', wrap((req, res) => {
  const n = nodeFor(req, 'message');
  const text = String(req.body?.text || '').slice(0, 50000);
  if (!text.trim()) throw new Error('Mensagem vazia');
  if (n.type === 'agent' && n.agent === 'shell') throw new Error('Esta janela é um terminal: use o modo terminal.');
  if (n.type === 'agent' && !req.body?.force && strictOff(n.id)) { hold(n.id, text, actor(req)); return res.json({ held: true }); }
  background(sendMessage(n.id, text, { user: actor(req) }), n.id);
  res.json({ ok: true });
}));
app.post('/api/nodes/:id/held/flush', wrap((req, res) => res.json({ sent: flushHeld(nodeFor(req, 'message').id, actor(req)) })));
app.post('/api/nodes/:id/exec', wrap((req, res) => {
  const n = nodeFor(req, 'terminal');
  background(runTerminal(n.id, String(req.body?.cmd || ''), actor(req)), n.id);
  res.json({ ok: true });
}));
app.post('/api/nodes/:id/stop', wrap((req, res) => res.json({ ok: stop(nodeFor(req, 'message').id, req.user) })));
app.post('/api/nodes/:id/diff', wrap(async (req, res) => { const n = nodeFor(req, 'view'); res.json(await refreshDiff(n, projectOf(n))); }));
app.post('/api/nodes/:id/commit', wrap(async (req, res) => { const n = nodeFor(req, 'commit'); res.json({ hash: await commit(n, projectOf(n), req.body?.files, req.body?.message, req.user.name) }); }));
app.post('/api/nodes/:id/discard', wrap(async (req, res) => { const n = nodeFor(req, 'commit'); res.json(await discard(n, projectOf(n), req.body?.files, req.user.name)); }));
app.post('/api/nodes/:id/pr', wrap(async (req, res) => { const n = nodeFor(req, 'pr'); res.json(await openPR(n, projectOf(n), req.user.name)); }));
app.get('/api/nodes/:id/sessions', wrap(async (req, res) => res.json(await listSessions(nodeFor(req, 'message').id))));
app.post('/api/nodes/:id/resume', wrap((req, res) => { resume(nodeFor(req, 'message').id, req.body?.agent, req.body?.sessionId, req.user.name); res.json({ ok: true }); }));

// ---------- Aprovações (com quatro olhos em produção) ----------
app.post('/api/approvals/:id', wrap((req, res) => {
  const a = (srv().approvals || []).find((x) => x.id === req.params.id);
  if (!a) throw new Error('Aprovação não encontrada');
  const n = findNode(a.nodeId);
  if (!n || !canNode(getDoc(), req.user, 'approve', n)) throw forbidden('Você não pode aprovar ações deste projeto.');
  const p = n.projectId && findProject(n.projectId);
  if ((getDoc().security || {}).fourEyesProd !== false && p?.env === 'prod' && a.by && a.by === req.user.id) throw forbidden('Produção exige outra pessoa para aprovar (quatro olhos).');
  res.json(decide(a.id, req.body?.decision === 'allow' ? 'allow' : 'deny', req.user.name));
}));

// ---------- Consumo, agendador e playbooks ----------
app.get('/api/usage', (req, res) => res.json(srv().usage || {}));
app.post('/api/usage/refresh', wrap(async (req, res) => res.json(await refreshUsage())));
app.post('/api/schedules/:id/run', need('schedule'), wrap((req, res) => {
  const sc = (getDoc().schedules || []).find((s) => s.id === req.params.id);
  if (!sc) throw new Error('Agendamento não encontrado');
  const ids = sc.target?.type === 'team' ? ((getDoc().teams || []).find((t) => t.id === sc.target.id)?.members || []) : [sc.target?.id];
  if (!ids.every((id) => canNode(getDoc(), req.user, 'message', findNode(id)))) throw forbidden();
  background(runSchedule(sc, actor(req), true));
  res.json({ ok: true });
}));
app.post('/api/playbooks/:id/run', need('schedule'), wrap((req, res) => {
  const pb = (getDoc().playbooks || []).find((p) => p.id === req.params.id);
  if (!pb) throw new Error('Playbook não encontrado. Aguarde um instante para a tela salvar e tente de novo.');
  const target = findNode(req.body?.target || pb.target);
  if (!target || !canNode(getDoc(), req.user, 'message', target)) throw forbidden();
  background(runPlaybook(pb, actor(req), target.id), target.id);
  res.json({ ok: true });
}));

// ---------- Skills e segredos de MCP ----------
const slug = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'skill';
app.post('/api/skills/:id/install', need('skills'), wrap(async (req, res) => {
  const k = (getDoc().skills || []).find((s) => s.id === req.params.id);
  if (!k) throw new Error('Skill não encontrada');
  const servers = new Set((getDoc().nodes || []).filter((n) => n.type === 'agent' && (n.skills || []).includes(k.id) && can(req.user, 'skills', n.projectId)).map((n) => findProject(n.projectId)?.server).filter(Boolean));
  const body = `---\nname: ${slug(k.name)}\ndescription: ${String(k.desc || k.name).replace(/\n/g, ' ').slice(0, 200)}\n---\n\n${k.content || ''}\n`;
  for (const s of servers) await writeRemote(s, `~/.claude/skills/${slug(k.name)}/SKILL.md`, body, '644');
  audit({ actor: req.user.name, action: 'Instalou skill', detail: `${k.name} em ${servers.size} servidor(es)` });
  res.json({ servers: servers.size });
}));
app.post('/api/secrets', need('mcp'), wrap((req, res) => {
  const { scope, key, value } = req.body || {};
  const m = /^mcp:([\w-]{1,64})$/.exec(scope || '');
  const mcp = m && (getDoc().mcps || []).find((x) => x.id === m[1]);
  if (!mcp || !(mcp.env || []).some((e) => e.key === key)) throw new Error('Declare a variável no MCP e salve antes de guardar o segredo');
  setSecret(scope, key, value);
  audit({ actor: req.user.name, action: 'Guardou segredo', detail: `${mcp.name} / ${key}` });
  res.json({ ok: true });
}));

// ---------- Pessoas e acessos ----------
const onlyAdminCanGrant = (req, body) => {
  if (req.user.role === 'admin') return;
  if (body.role === 'admin' || (body.extra || []).some((p) => ['users', 'rules', 'mcp', 'integrations'].includes(p))) throw forbidden('Só administradores concedem acesso administrativo.');
};
app.get('/api/users', need('users'), (req, res) => res.json(allUsers().map(publicUser)));
app.post('/api/users', need('users'), wrap((req, res) => {
  onlyAdminCanGrant(req, req.body || {});
  const r = createUser(req.body || {});
  audit({ actor: req.user.name, action: 'Criou acesso', detail: `${r.user.name} (${r.user.login}, ${r.user.role})` });
  res.json({ user: publicUser(r.user), tempPassword: r.tempPassword });
}));
app.put('/api/users/:id', need('users'), wrap((req, res) => {
  onlyAdminCanGrant(req, req.body || {});
  const before = JSON.stringify(publicUser(findUser(req.params.id)));
  const u = updateUser(req.params.id, req.body || {}, req.user);
  if (JSON.stringify(publicUser(u)) !== before) { audit({ actor: req.user.name, action: 'Alterou acesso', detail: `${u.name}: ${u.role}, projetos ${u.projects === '*' ? 'todos' : u.projects.length}, ${u.active ? 'ativo' : 'desativado'}` }); dropUser(u.id); }
  res.json(publicUser(u));
}));
app.post('/api/users/:id/reset', need('users'), wrap((req, res) => {
  const u = findUser(req.params.id);
  if (!u) throw new Error('Pessoa não encontrada');
  if (u.role === 'admin' && req.user.role !== 'admin') throw forbidden();
  const temp = resetPassword(u.id);
  dropUser(u.id);
  audit({ actor: req.user.name, action: 'Redefiniu senha', detail: u.name });
  res.json({ tempPassword: temp });
}));
app.post('/api/users/:id/revoke', need('users'), wrap((req, res) => {
  revokeSessions(req.params.id); dropUser(req.params.id);
  audit({ actor: req.user.name, action: 'Encerrou sessões', detail: findUser(req.params.id)?.name || req.params.id });
  res.json({ ok: true });
}));

// ---------- Convites ----------
app.post('/api/invites', need('invite'), wrap((req, res) => {
  const { invite, token } = createInvite(req.user, req.body || {}, (getDoc().projects || []).map((p) => p.id));
  audit({ actor: req.user.name, action: 'Criou convite', detail: `${invite.label} (${invite.role})` });
  const proto = cfg.secureCookie ? 'https' : req.protocol;
  res.json({ id: invite.id, url: `${proto}://${req.headers.host}/invite/${token}`, expires: invite.expires });
}));
app.post('/api/invites/:id/revoke', wrap((req, res) => { const i = revokeInvite(req.params.id, req.user); audit({ actor: req.user.name, action: 'Revogou convite', detail: i.label }); res.json(i); }));

// ---------- Árvore de arquivos (só leitura) ----------
const projectFor = (req) => { const p = findProject(req.params.id); if (!p) throw new Error('Projeto não encontrado'); if (!can(req.user, 'view', p.id)) throw forbidden(); return p; };
app.get('/api/projects/:id/files', wrap(async (req, res) => res.json({ entries: await listDir(projectFor(req), req.query.dir) })));
app.get('/api/projects/:id/file', wrap(async (req, res) => {
  const p = projectFor(req);
  const text = await readFile(p, req.query.path);
  audit({ actor: req.user.name, action: 'Leu arquivo', detail: `${p.name}: ${String(req.query.path).slice(0, 200)}` });
  res.json({ text });
}));

// ---------- Notificações ----------
app.get('/api/inbox', (req, res) => res.json(readInbox(req.user.id)));
app.post('/api/inbox/read', wrap((req, res) => { markRead(req.user.id, Array.isArray(req.body?.ids) ? req.body.ids : null); res.json({ ok: true }); }));
app.get('/api/push/key', (req, res) => res.json({ key: pushPublicKey() }));
app.post('/api/push/subscribe', wrap((req, res) => { addSubscription(req.user.id, req.body); res.json({ ok: true }); }));
app.post('/api/notify/test', need('integrations'), wrap(async (req, res) => {
  const sent = await emit('done', 'Teste da Bancada', 'Os avisos estão funcionando.');
  audit({ actor: req.user.name, action: 'Testou avisos', detail: sent ? 'enviado' : 'nenhum canal' });
  res.json({ sent });
}));

app.use((req, res) => res.status(404).json({ error: 'Não encontrado' }));
// Erros inesperados: nunca devolve stack trace
app.use((err, req, res, next) => { console.error('[erro]', err.message); res.status(err.status || 500).json({ error: err.expose ? err.message : 'Erro interno' }); });

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
httpServer.on('upgrade', (req, socket, head) => {
  const originOk = !req.headers.origin || (() => { try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; } })();
  const x = req.url === '/ws' && originOk ? sessionOf(req) : null;
  if (!x || x.session.setup) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => addClient(ws, x.user.id, x.sid));
});

httpServer.listen(cfg.port, cfg.host, () => {
  console.log(`Bancada rodando em http://${cfg.host}:${cfg.port}`);
  if (!hasUsers()) console.log(`Nenhuma conta ainda. Abra http://${cfg.host}:${cfg.port}/setup nesta máquina para criar o administrador.`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(cfg.host)) console.warn('Atenção: o painel está exposto além da máquina local. Use VPN ou HTTPS com COOKIE_SECURE=1.');
  startScheduler();
  startUsageLoop();
});
