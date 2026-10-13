// Trechos de tela para passkeys e Touch ID (login e Minha conta). Sem dependências: a CSP só permite script da própria página.

const helpers = `
const b64u = {
  toBuf: (s) => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer; },
  fromBuf: (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, ''),
};
async function postJson(url, body) {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Algo deu errado. Tente de novo.');
  return j;
}
function reqOptions(o) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(o);
  return { ...o, challenge: b64u.toBuf(o.challenge), allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64u.toBuf(c.id) })) };
}
function createOptions(o) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(o);
  return { ...o, challenge: b64u.toBuf(o.challenge), user: { ...o.user, id: b64u.toBuf(o.user.id) }, excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64u.toBuf(c.id) })) };
}
function credJson(c) {
  if (c.toJSON) try { return c.toJSON(); } catch {}
  const r = c.response, out = { id: c.id, rawId: b64u.fromBuf(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {}, authenticatorAttachment: c.authenticatorAttachment || undefined, response: { clientDataJSON: b64u.fromBuf(r.clientDataJSON) } };
  if (r.attestationObject) { out.response.attestationObject = b64u.fromBuf(r.attestationObject); out.response.transports = r.getTransports ? r.getTransports() : []; }
  if (r.authenticatorData) { out.response.authenticatorData = b64u.fromBuf(r.authenticatorData); out.response.signature = b64u.fromBuf(r.signature); out.response.userHandle = r.userHandle ? b64u.fromBuf(r.userHandle) : undefined; }
  return out;
}
const isIpHost = /^\\d{1,3}(\\.\\d{1,3}){3}$/.test(location.hostname) || location.hostname.includes(':');
const passkeyOk = !!window.PublicKeyCredential && !isIpHost && (location.protocol === 'https:' || location.hostname === 'localhost');
const friendly = (e) => e && e.name === 'NotAllowedError' ? 'Cancelado ou tempo esgotado.' : (e && e.message) || 'Algo deu errado.';
`;

export const loginExtras = () => `
<div id="quick" class="sec" hidden>
  <button type="button" id="btnMac" hidden>Entrar com Touch ID</button>
  <button type="button" id="btnPasskey" hidden>Entrar com passkey (Touch ID ou Face ID)</button>
  <p id="quickMsg" class="err" role="alert" hidden></p>
  <p id="quickHint" hidden></p>
</div>
<script>
${helpers}
(function () {
  const $ = (id) => document.getElementById(id);
  const msg = (t) => { $('quickMsg').textContent = t; $('quickMsg').hidden = !t; };
  const mac = window.bancadaMac;
  if (mac) {
    mac.canTouchId().then((ok) => { if (ok) { $('quick').hidden = false; $('btnMac').hidden = false; } });
    $('btnMac').onclick = async () => {
      const login = document.querySelector('input[name=login]').value.trim();
      if (!login) { msg('Digite seu login acima e toque em Entrar com Touch ID.'); return; }
      msg('');
      try { await mac.touchIdLogin(login); } catch (e) { msg(friendly(e)); }
    };
  } else if (passkeyOk) {
    $('quick').hidden = false; $('btnPasskey').hidden = false;
    $('btnPasskey').onclick = async () => {
      msg('');
      try {
        const { flow, options } = await postJson('/passkey/login/options');
        const cred = await navigator.credentials.get({ publicKey: reqOptions(options) });
        const r = await postJson('/passkey/login', { flow, response: credJson(cred) });
        location.href = r.next || '/';
      } catch (e) { msg(friendly(e)); }
    };
  } else if (window.PublicKeyCredential && isIpHost) {
    $('quick').hidden = false; $('quickHint').hidden = false;
    $('quickHint').textContent = 'Para entrar com Touch ID ou Face ID, abra a Bancada por localhost (ou pelo endereço https do Tailscale) em vez do IP.';
  }
})();
</script>`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const when = (t) => (t ? new Date(t).toLocaleDateString('pt-BR') : 'nunca');

export const accountExtras = (u) => `
<div class="sec"><b>Entrar sem senha</b>
<p>Cadastre o Touch ID do Mac, o Face ID do iPhone ou o iPad. Na próxima vez, entre só com a digital ou o rosto: a passkey já vale como senha e autenticador.</p>
<div id="pkList">${(u.passkeys || []).map((p) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #F0F0F0"><span><b>${esc(p.name)}</b><br><small style="color:#737373">${esc(p.rpID)} · usada ${when(p.lastUsed)}</small></span><button type="button" data-rm="${esc(p.id)}" style="background:#fff;color:#DC2626;border:1px solid #FCA5A5;padding:6px 10px">Remover</button></div>`).join('') || '<p style="color:#737373">Nenhuma passkey ainda.</p>'}</div>
<label id="pkNameL" hidden>Nome deste aparelho<input id="pkName" maxlength="60" placeholder="MacBook do escritório"></label>
<button type="button" id="pkAdd" hidden>Cadastrar este aparelho</button>
<div id="macBox" hidden><p>Neste Mac, o app entra com o Touch ID do próprio macOS.</p><button type="button" id="macOn">${u.macTouchId ? 'Desativar Touch ID neste Mac' : 'Ativar Touch ID neste Mac'}</button></div>
<p id="pkMsg" role="alert" hidden></p>
</div>
<script>
${helpers}
(function () {
  const $ = (id) => document.getElementById(id);
  const msg = (t, ok) => { const m = $('pkMsg'); m.textContent = t; m.className = ok ? 'ok' : 'err'; m.hidden = !t; };
  if (window.bancadaMac) {
    window.bancadaMac.canTouchId().then((ok) => { $('macBox').hidden = !ok; if (!ok) msg('Este Mac não tem Touch ID disponível.'); });
    $('macOn').onclick = async () => {
      try { const on = ${u.macTouchId ? 'false' : 'true'}; await window.bancadaMac.touchIdEnable(on); location.reload(); } catch (e) { msg(friendly(e)); }
    };
  }
  if (passkeyOk) { $('pkAdd').hidden = false; $('pkNameL').hidden = false; }
  else if (!window.bancadaMac && isIpHost) msg('Para cadastrar uma passkey, abra a Bancada por localhost ou pelo endereço https do Tailscale (não pelo IP).');
  $('pkAdd').onclick = async () => {
    msg('');
    try {
      const { flow, options } = await postJson('/account/passkey/options');
      const cred = await navigator.credentials.create({ publicKey: createOptions(options) });
      await postJson('/account/passkey', { flow, response: credJson(cred), name: $('pkName').value });
      location.reload();
    } catch (e) { msg(friendly(e)); }
  };
  document.querySelectorAll('[data-rm]').forEach((b) => b.onclick = async () => {
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Confirmar remoção'; return; }
    try { await postJson('/account/passkey/remove', { id: b.dataset.rm }); location.reload(); } catch (e) { msg(friendly(e)); }
  });
})();
</script>`;
