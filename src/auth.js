// Sessões por pessoa: cookie HttpOnly, expiração absoluta e por inatividade,
// derrubada imediata quando o acesso muda, e telas de login e de conta.
import crypto from 'node:crypto';
import { cfg } from './config.js';
import { getDoc } from './store.js';
import { authenticate, findUser, findLogin, changePassword, setTotp, totpSecretOf, createUserWithPassword, hasUsers } from './users.js';
import { findByToken, markUsed } from './invites.js';
import { audit } from './store.js';
import { newSecret, verify as verifyTotp, otpauthUri } from './totp.js';
import { loginExtras, accountExtras } from './passkey-ui.js';

const sessions = new Map(); // sid -> { userId, epoch, created, lastSeen, setup, pending2fa }
const ipFails = new Map();

export const sec = () => ({ sessionHours: 12, idleMinutes: 30, require2fa: true, passwordMin: 12, ...(getDoc().security || {}) });
const readSid = (req) => (/(?:^|;\s*)bancada=([a-f0-9]{64})/.exec(req.headers.cookie || '') || [])[1];
const cookie = (sid, maxAge) => `bancada=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${cfg.secureCookie ? '; Secure' : ''}`;

// Atrás de um proxy local (Tailscale Serve, nginx), vale o host que o navegador usou
const fromLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
// method: no upgrade do WebSocket, quem chama informa o método a considerar.
// (Não copie o req com spread: headers é getter do IncomingMessage e some na cópia.)
export function sameOrigin(req, method = req.method) {
  const headers = req?.headers || {};
  const origin = headers.origin;
  if (!origin) return method === 'GET';
  let host;
  try { host = new URL(origin).host; } catch { return false; }
  if (host === headers.host) return true;
  return fromLoopback(req) && !!headers['x-forwarded-host'] && host === String(headers['x-forwarded-host']).split(',')[0].trim();
}

export function newSession(res, user, extra = {}) {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { userId: user.id, epoch: user.sessionEpoch || 1, created: Date.now(), lastSeen: Date.now(), ...extra });
  res.setHeader('Set-Cookie', cookie(sid, sec().sessionHours * 3600));
  return sid;
}

// Devolve a pessoa logada (ou null). Sessões em configuração só acessam /account.
export function sessionOf(req) {
  const sid = readSid(req);
  const s = sid && sessions.get(sid);
  if (!s) return null;
  const u = findUser(s.userId);
  const { sessionHours, idleMinutes } = sec();
  const now = Date.now();
  if (!u || !u.active || s.epoch !== (u.sessionEpoch || 1) || now - s.created > sessionHours * 3600000 || now - s.lastSeen > idleMinutes * 60000) {
    sessions.delete(sid);
    return null;
  }
  s.lastSeen = now;
  return { sid, session: s, user: u };
}

export const currentUser = (req) => { const x = sessionOf(req); return x && !x.session.setup && !x.session.pending2fa ? x.user : null; };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, body) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#FAFAFA;font:15px/1.5 system-ui,sans-serif;color:#171717;padding:16px;box-sizing:border-box}
.card{background:#fff;border:1px solid #E5E5E5;border-radius:20px;padding:28px;width:min(400px,100%);display:flex;flex-direction:column;gap:14px;box-sizing:border-box}
h1{margin:0;font-size:19px}label{display:flex;flex-direction:column;gap:6px;font-size:14px;font-weight:500}
input{padding:10px 12px;border:1px solid #E5E5E5;border-radius:12px;font:inherit}button{padding:10px;border:0;border-radius:12px;background:#171717;color:#fff;font:inherit;font-weight:500;cursor:pointer}
.err{margin:0;color:#DC2626;font-size:14px}.ok{margin:0;color:#15803D;font-size:14px}p{margin:0;color:#525252;font-size:14px}code{font:13px ui-monospace,monospace;background:#F5F5F5;padding:8px 10px;border-radius:10px;word-break:break-all;display:block}
.sec{border-top:1px solid #F0F0F0;padding-top:14px;display:flex;flex-direction:column;gap:12px}a{color:#171717}</style></head><body><div class="card">${body}</div></body></html>`;

export function loginPage(error = '', login = '', needCode = false) {
  return page('Entrar na Bancada', `<h1>Bancada</h1><form method="post" action="/login" style="display:flex;flex-direction:column;gap:14px">
<label>Login<input name="login" autocomplete="username" required value="${esc(login)}" ${needCode ? '' : 'autofocus'}></label>
<label>Senha<input type="password" name="password" autocomplete="current-password" required></label>
${needCode ? '<label>Código do autenticador<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" autofocus required></label>' : ''}
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}<button type="submit">Entrar</button></form>${needCode ? '' : loginExtras()}`);
}

export function login(req, res) {
  if (!sameOrigin(req) && req.headers.origin) return res.status(403).send(loginPage('Origem não permitida.'));
  const ip = req.socket.remoteAddress || '?';
  const f = ipFails.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 15 * 60000) { f.n = 0; f.t = Date.now(); }
  if (f.n >= 20) return res.status(429).send(loginPage('Muitas tentativas deste endereço. Aguarde 15 minutos.'));
  const { login: lg = '', password = '', code = '' } = req.body || {};
  const r = authenticate(lg, password, code, sec().require2fa);
  if (r.error || r.needCode) {
    if (r.error) { f.n++; ipFails.set(ip, f); }
    return res.status(r.error ? 401 : 200).send(loginPage(r.error || '', lg, !!r.needCode));
  }
  newSession(res, r.user, r.setupRequired ? { setup: true } : {});
  res.redirect(r.setupRequired ? '/account' : '/');
}

export function logout(req, res) {
  const sid = readSid(req);
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', cookie('', 0));
  res.redirect('/login');
}

// Página da conta: troca de senha e autenticador. Também é o passo obrigatório do primeiro acesso.
export function accountPage(req, res, msg = '', isError = false) {
  const x = sessionOf(req);
  if (!x) return res.redirect('/login');
  const u = x.user, s = x.session;
  if (!s.totpDraft && !u.totp) s.totpDraft = newSecret();
  const needPw = u.mustChange, need2fa = sec().require2fa && !u.totp;
  const draft = s.totpDraft;
  res.send(page('Minha conta', `<h1>${esc(u.name)}</h1>
${s.setup ? `<p>Antes de continuar: ${[needPw ? 'troque a senha temporária' : '', need2fa ? 'configure o autenticador' : ''].filter(Boolean).join(' e ')}.</p>` : ''}
${msg ? `<p class="${isError ? 'err' : 'ok'}" role="alert">${esc(msg)}</p>` : ''}
<form class="sec" method="post" action="/account/password"><b>Senha</b>
<label>Senha atual<input type="password" name="current" autocomplete="current-password" required></label>
<label>Nova senha (mínimo ${Math.max(12, sec().passwordMin)} caracteres)<input type="password" name="next" autocomplete="new-password" required minlength="12"></label>
<button type="submit">Trocar senha</button></form>
<form class="sec" method="post" action="/account/totp"><b>Autenticador ${u.totp ? '(ativo)' : ''}</b>
${u.totp && !draft ? '<p>Para trocar de aparelho, gere uma nova chave.</p><input type="hidden" name="action" value="new"><button type="submit">Gerar nova chave</button>' : `
<p>No Google Authenticator, Microsoft Authenticator ou similar, adicione a chave abaixo (ou abra o link no celular) e digite o código de 6 dígitos.</p>
<code>${esc(draft.match(/.{1,4}/g).join(' '))}</code><a href="${esc(otpauthUri(draft, u.login))}">Abrir no aplicativo autenticador</a>
<input type="hidden" name="action" value="confirm"><label>Código<input name="code" inputmode="numeric" autocomplete="one-time-code" required></label><button type="submit">Ativar autenticador</button>`}</form>
${s.setup ? '' : accountExtras(u)}
${s.setup ? '' : '<p><a href="/wizard">Novo projeto (assistente)</a> · <a href="/?assistente=0">Voltar para a Bancada</a></p>'}
<form method="post" action="/logout"><button type="submit" style="background:#fff;color:#171717;border:1px solid #E5E5E5">Sair</button></form>`));
}

function finishSetupIfDone(s, u) {
  if (s.setup && !u.mustChange && !(sec().require2fa && !u.totp)) s.setup = false;
}

export function accountPassword(req, res) {
  if (!sameOrigin(req) && req.headers.origin) return res.status(403).end();
  const x = sessionOf(req); if (!x) return res.redirect('/login');
  try {
    changePassword(x.user, req.body?.current || '', req.body?.next || '', sec().passwordMin);
    // trocar a senha derruba as outras sessões; esta continua com a nova época
    x.session.epoch = x.user.sessionEpoch;
    finishSetupIfDone(x.session, x.user);
    accountPage(req, res, 'Senha trocada.');
  } catch (e) { accountPage(req, res, e.message, true); }
}

export function accountTotp(req, res) {
  if (!sameOrigin(req) && req.headers.origin) return res.status(403).end();
  const x = sessionOf(req); if (!x) return res.redirect('/login');
  const s = x.session;
  if (req.body?.action === 'new') { s.totpDraft = newSecret(); return accountPage(req, res, 'Nova chave gerada. A anterior continua valendo até você confirmar a nova.'); }
  if (!s.totpDraft || !verifyTotp(s.totpDraft, req.body?.code)) return accountPage(req, res, 'Código incorreto. Confira a hora do celular e tente de novo.', true);
  setTotp(x.user, s.totpDraft);
  s.totpDraft = null; s.epoch = x.user.sessionEpoch;
  finishSetupIfDone(s, x.user);
  accountPage(req, res, 'Autenticador ativado.');
}

// Convite: a pessoa escolhe nome, login e senha; depois configura o autenticador em /account
export function invitePage(req, res, error = '', values = {}) {
  const inv = findByToken(req.params.token);
  if (!inv) return res.status(404).send(page('Convite inválido', '<h1>Convite inválido</h1><p>Este link expirou, já foi usado ou foi revogado. Peça um novo a quem convidou você.</p>'));
  res.send(page('Convite para a Bancada', `<h1>Criar seu acesso</h1><p>Convite de ${esc(inv.createdByName)}.</p>
<form method="post" style="display:flex;flex-direction:column;gap:14px">
<label>Nome completo<input name="name" required maxlength="80" value="${esc(values.name)}"></label>
<label>Login (letras minúsculas, números, ponto ou hífen)<input name="login" required pattern="[a-z0-9._\\-]{3,32}" autocapitalize="off" value="${esc(values.login)}"></label>
<label>Senha (mínimo ${Math.max(12, sec().passwordMin)} caracteres)<input type="password" name="password" required minlength="12" autocomplete="new-password"></label>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}<button type="submit">Criar acesso</button></form>`));
}

export function acceptInvite(req, res) {
  if (!sameOrigin(req) && req.headers.origin) return res.status(403).end();
  const ip = req.socket.remoteAddress || '?';
  const f = ipFails.get(ip) || { n: 0, t: Date.now() };
  if (f.n >= 20 && Date.now() - f.t < 15 * 60000) return res.status(429).send(page('Aguarde', '<p>Muitas tentativas. Aguarde 15 minutos.</p>'));
  const inv = findByToken(req.params.token);
  if (!inv) { f.n++; ipFails.set(ip, f); return invitePage(req, res); }
  const { name = '', login: lg = '', password = '' } = req.body || {};
  try {
    if (findLogin(lg)) throw new Error('Esse login já existe. Escolha outro.');
    const u = createUserWithPassword({ login: lg, name, role: inv.role, projects: inv.projects }, password, sec().passwordMin);
    markUsed(inv, u.id);
    audit({ actor: u.name, action: 'Aceitou convite', detail: `${inv.label} (${inv.role}), convidado por ${inv.createdByName}` });
    newSession(res, u, sec().require2fa ? { setup: true } : {});
    res.redirect(sec().require2fa ? '/account' : '/');
  } catch (e) { invitePage(req, res, e.message, { name, login: lg }); }
}

// Primeiro acesso: sem nenhuma conta, quem está na própria máquina cria o administrador.
// Pedido vindo por proxy (outro aparelho) não conta como local, mesmo chegando por 127.0.0.1
const isLocal = (req) => fromLoopback(req) && !req.headers['x-forwarded-for'] && !req.headers['x-forwarded-host'];
export function setupPage(req, res, error = '', values = {}) {
  if (hasUsers()) return res.redirect('/login');
  if (!isLocal(req)) return res.status(403).send(page('Bancada', '<h1>Configuração inicial</h1><p>Por segurança, o primeiro administrador só pode ser criado na própria máquina onde a Bancada roda.</p>'));
  res.send(page('Bem-vindo à Bancada', `<h1>Bem-vindo à Bancada</h1><p>Crie a conta de administrador. É por ela que você vai cadastrar e convidar as outras pessoas.</p>
<form method="post" action="/setup" style="display:flex;flex-direction:column;gap:14px">
<label>Nome completo<input name="name" required maxlength="80" value="${esc(values.name)}" autofocus></label>
<label>Login<input name="login" required pattern="[a-z0-9._\\-]{3,32}" autocapitalize="off" value="${esc(values.login)}"></label>
<label>Senha (mínimo 12 caracteres)<input type="password" name="password" required minlength="12" autocomplete="new-password"></label>
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}<button type="submit">Criar administrador</button></form>`));
}
export function setupSubmit(req, res) {
  if (hasUsers()) return res.redirect('/login');
  if (!isLocal(req) || (!sameOrigin(req) && req.headers.origin)) return res.status(403).end();
  const { name = '', login: lg = '', password = '' } = req.body || {};
  try {
    const u = createUserWithPassword({ login: lg, name, role: 'admin', projects: '*' }, password, 12);
    audit({ actor: u.name, action: 'Criou o primeiro administrador', detail: u.login });
    newSession(res, u, { setup: true });
    res.redirect('/account');
  } catch (e) { setupPage(req, res, e.message, { name, login: lg }); }
}
