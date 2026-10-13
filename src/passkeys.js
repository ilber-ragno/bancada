// Entrar sem senha: passkeys (WebAuthn) com Touch ID, Face ID ou o iPhone/iPad.
// A passkey vale como os dois fatores (o aparelho exige a digital ou o rosto),
// então quem entra por ela não precisa do código do autenticador.
//
// No app do Mac (Electron) o Chromium não oferece o Touch ID para WebAuthn sem
// assinatura da Apple; lá o login usa o Touch ID nativo (ver appTouchId abaixo).
import crypto from 'node:crypto';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { allUsers, findUser, findLogin, saveUsers } from './users.js';
import { audit } from './store.js';

const RP_NAME = 'Bancada';
const challenges = new Map(); // flow -> { challenge, kind, userId, sid, rpID, origin, exp }
const TTL = 5 * 60000;

const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

// Origem e RP ID vêm do endereço que o navegador está usando (já validado por sameOrigin)
export function relyingParty(req) {
  const origin = req.headers.origin;
  if (!origin) throw Object.assign(new Error('Pedido sem origem.'), { status: 400 });
  const { hostname, protocol } = new URL(origin);
  if (isIp(hostname)) {
    const port = new URL(origin).port;
    throw Object.assign(new Error(`Passkeys não funcionam pelo endereço IP. Abra a Bancada por http://localhost${port ? ':' + port : ''} ou pelo endereço https do Tailscale.`), { status: 400 });
  }
  if (protocol !== 'https:' && hostname !== 'localhost') throw Object.assign(new Error('Passkeys exigem https (ou localhost).'), { status: 400 });
  return { rpID: hostname, origin };
}

function saveChallenge(data) {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.exp < now) challenges.delete(k);
  const flow = crypto.randomBytes(16).toString('hex');
  challenges.set(flow, { ...data, exp: now + TTL });
  return flow;
}
function takeChallenge(flow, kind) {
  const c = challenges.get(String(flow || ''));
  challenges.delete(String(flow || ''));
  if (!c || c.kind !== kind || c.exp < Date.now()) throw Object.assign(new Error('O pedido expirou. Tente de novo.'), { status: 400 });
  return c;
}

const b64 = (u8) => Buffer.from(u8).toString('base64url');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64url'));

export const passkeysOf = (u) => (u.passkeys || []).map((p) => ({ id: p.id, name: p.name, rpID: p.rpID, created: p.created, lastUsed: p.lastUsed || null }));

// ---------- Cadastrar uma passkey (pessoa já logada) ----------
export async function registerOptions(req, user, sid) {
  const { rpID, origin } = relyingParty(req);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME, rpID,
    userName: user.login, userDisplayName: user.name,
    userID: new TextEncoder().encode(user.id),
    attestationType: 'none',
    excludeCredentials: (user.passkeys || []).filter((p) => p.rpID === rpID).map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const flow = saveChallenge({ kind: 'reg', challenge: options.challenge, userId: user.id, sid, rpID, origin });
  return { flow, options };
}

export async function registerVerify(req, user, sid, body) {
  const c = takeChallenge(body?.flow, 'reg');
  if (c.userId !== user.id || c.sid !== sid) throw Object.assign(new Error('Pedido de outra sessão.'), { status: 403 });
  const v = await verifyRegistrationResponse({
    response: body?.response, expectedChallenge: c.challenge, expectedOrigin: c.origin, expectedRPID: c.rpID, requireUserVerification: true,
  });
  if (!v.verified || !v.registrationInfo) throw new Error('Não foi possível confirmar a passkey.');
  const cred = v.registrationInfo.credential;
  if (allUsers().some((u) => (u.passkeys || []).some((p) => p.id === cred.id))) throw new Error('Essa passkey já está cadastrada.');
  const name = String(body?.name || '').trim().slice(0, 60) || guessDevice(req);
  user.passkeys = [...(user.passkeys || []), {
    id: cred.id, publicKey: b64(cred.publicKey), counter: cred.counter, transports: cred.transports || [],
    rpID: c.rpID, name, created: Date.now(),
  }];
  saveUsers();
  audit({ actor: user.name, action: 'Cadastrou passkey', detail: `${name} (${c.rpID})` });
  return passkeysOf(user);
}

export function removePasskey(user, id) {
  const before = (user.passkeys || []).length;
  user.passkeys = (user.passkeys || []).filter((p) => p.id !== id);
  if (user.passkeys.length === before) throw new Error('Passkey não encontrada.');
  saveUsers();
  audit({ actor: user.name, action: 'Removeu passkey', detail: id.slice(0, 12) });
  return passkeysOf(user);
}

// ---------- Entrar com passkey ----------
export async function loginOptions(req) {
  const { rpID, origin } = relyingParty(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required', allowCredentials: [] });
  return { flow: saveChallenge({ kind: 'auth', challenge: options.challenge, rpID, origin }), options };
}

// Devolve a pessoa autenticada ou lança erro
export async function loginVerify(body) {
  const c = takeChallenge(body?.flow, 'auth');
  const credId = body?.response?.id;
  const user = allUsers().find((u) => (u.passkeys || []).some((p) => p.id === credId && p.rpID === c.rpID));
  if (!user) throw Object.assign(new Error('Passkey não reconhecida. Entre com senha e cadastre esta passkey em Minha conta.'), { status: 401 });
  if (!user.active) throw Object.assign(new Error('Conta desativada. Fale com um administrador.'), { status: 403 });
  if (user.lockedUntil > Date.now()) throw Object.assign(new Error('Conta bloqueada por tentativas erradas. Tente de novo em alguns minutos.'), { status: 403 });
  const pk = user.passkeys.find((p) => p.id === credId);
  const v = await verifyAuthenticationResponse({
    response: body.response, expectedChallenge: c.challenge, expectedOrigin: c.origin, expectedRPID: c.rpID, requireUserVerification: true,
    credential: { id: pk.id, publicKey: fromB64(pk.publicKey), counter: pk.counter, transports: pk.transports },
  });
  if (!v.verified) throw Object.assign(new Error('Não foi possível confirmar a passkey.'), { status: 401 });
  pk.counter = v.authenticationInfo.newCounter; pk.lastUsed = Date.now();
  user.failed = 0; user.lastLogin = Date.now();
  saveUsers();
  audit({ actor: user.name, action: 'Entrou com passkey', detail: pk.name });
  return user;
}

function guessDevice(req) {
  const ua = String(req.headers['user-agent'] || '');
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  return 'Aparelho';
}

// ---------- Touch ID nativo do app do Mac ----------
// O processo principal do app guarda um token aleatório (BANCADA_APP_TOKEN) que a página nunca vê.
// Ele só chama estas funções depois que o macOS confirmou a digital.
const appCodes = new Map(); // code -> { userId, exp }
export const appTokenOk = (req) => {
  const t = process.env.BANCADA_APP_TOKEN || '';
  const got = String(req.headers['x-bancada-app'] || '');
  return t.length === 64 && got.length === 64 && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(got));
};
export function enableMacTouchId(user, on) {
  user.macTouchId = !!on; saveUsers();
  audit({ actor: user.name, action: on ? 'Ativou Touch ID no Mac' : 'Desativou Touch ID no Mac', detail: '' });
}
export function macTouchIdCode(login) {
  const u = findLogin(login);
  if (!u || !u.active || !u.macTouchId || u.lockedUntil > Date.now()) throw Object.assign(new Error('Touch ID não está ativado para esse login neste Mac.'), { status: 403 });
  const code = crypto.randomBytes(24).toString('hex');
  appCodes.set(code, { userId: u.id, exp: Date.now() + 30000 });
  return code;
}
export function takeMacCode(code) {
  const c = appCodes.get(String(code || ''));
  appCodes.delete(String(code || ''));
  if (!c || c.exp < Date.now()) return null;
  const u = findUser(c.userId);
  if (!u || !u.active || !u.macTouchId) return null;
  u.lastLogin = Date.now(); saveUsers();
  audit({ actor: u.name, action: 'Entrou com Touch ID (app do Mac)', detail: '' });
  return u;
}
