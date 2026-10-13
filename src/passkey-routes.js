// Rotas de passkey e do Touch ID do app do Mac. Ficam antes da exigência de login.
import express from 'express';
import { sameOrigin, sessionOf, newSession } from './auth.js';
import {
  registerOptions, registerVerify, removePasskey, loginOptions, loginVerify,
  appTokenOk, enableMacTouchId, macTouchIdCode, takeMacCode,
} from './passkeys.js';

const fails = new Map();
const tooMany = (req) => {
  const ip = req.socket.remoteAddress || '?';
  const f = fails.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - f.t > 15 * 60000) { f.n = 0; f.t = Date.now(); }
  fails.set(ip, f);
  return f;
};

export function mountPasskeys(app) {
  const json = express.json({ limit: '64kb' });
  const guard = (fn) => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!sameOrigin(req, 'POST')) return res.status(403).json({ error: 'Origem não permitida' });
    try { await fn(req, res); } catch (e) { res.status(e.status || 400).json({ error: e.message || 'Erro' }); }
  };
  const logged = (req) => {
    const x = sessionOf(req);
    if (!x || x.session.setup) throw Object.assign(new Error('Entre na sua conta primeiro.'), { status: 401 });
    return x;
  };

  // Entrar
  app.post('/passkey/login/options', json, guard(async (req, res) => res.json(await loginOptions(req))));
  app.post('/passkey/login', json, guard(async (req, res) => {
    const f = tooMany(req);
    if (f.n >= 20) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 15 minutos.' });
    try {
      const u = await loginVerify(req.body);
      newSession(res, u, u.mustChange ? { setup: true } : {});
      res.json({ next: u.mustChange ? '/account' : '/' });
    } catch (e) { f.n++; throw e; }
  }));

  // Cadastrar e remover (Minha conta)
  app.post('/account/passkey/options', json, guard(async (req, res) => { const x = logged(req); res.json(await registerOptions(req, x.user, x.sid)); }));
  app.post('/account/passkey', json, guard(async (req, res) => { const x = logged(req); res.json({ passkeys: await registerVerify(req, x.user, x.sid, req.body) }); }));
  app.post('/account/passkey/remove', json, guard(async (req, res) => { const x = logged(req); res.json({ passkeys: removePasskey(x.user, String(req.body?.id || '')) }); }));

  // Touch ID nativo: só o processo principal do app (que tem o token) chama estas duas
  app.post('/app/touchid/enable', json, async (req, res) => {
    if (!appTokenOk(req)) return res.status(404).end();
    const x = sessionOf(req);
    if (!x || x.session.setup) return res.status(401).json({ error: 'Entre na sua conta primeiro.' });
    enableMacTouchId(x.user, req.body?.on !== false);
    res.json({ ok: true });
  });
  app.post('/app/touchid/login', json, (req, res) => {
    if (!appTokenOk(req)) return res.status(404).end();
    try { res.json({ code: macTouchIdCode(req.body?.login) }); } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
  });
  app.get('/app/touchid/finish', (req, res) => {
    const u = takeMacCode(req.query.code);
    if (!u) return res.redirect('/login');
    newSession(res, u, u.mustChange ? { setup: true } : {});
    res.redirect(u.mustChange ? '/account' : '/');
  });
}
