import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { code, verify, newSecret } = await import('../src/totp.js');
const { encrypt, decrypt, setSecret, getSecret } = await import('../src/vault.js');
const users = await import('../src/users.js');
const { filterFor, mergeFrom } = await import('../src/acl.js');
const { can, permsOf } = await import('../src/permissions.js');

test('TOTP segue a RFC 6238', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(code(secret, 59000), '287082');
  assert.equal(code(secret, 1111111109000), '081804');
  const s = newSecret();
  assert.ok(verify(s, code(s)));
  assert.ok(!verify(s, '000000') || code(s) === '000000');
});

test('cofre cifra e decifra, e não guarda texto puro', () => {
  const box = encrypt('segredo-123');
  assert.notEqual(box.ct, 'segredo-123');
  assert.equal(decrypt(box), 'segredo-123');
  setSecret('mcp:github', 'TOKEN', 'ghp_abc');
  assert.equal(getSecret('mcp:github', 'TOKEN'), 'ghp_abc');
});

test('contas: senha temporária, troca obrigatória e bloqueio após 5 erros', () => {
  const { user, tempPassword } = users.createUser({ login: 'ana', name: 'Ana', role: 'admin', projects: '*' });
  assert.ok(user.pw.startsWith('scrypt$'));
  assert.ok(!user.pw.includes(tempPassword));
  const ok = users.authenticate('ana', tempPassword, '', false);
  assert.equal(ok.user.id, user.id);
  assert.equal(ok.setupRequired, true);
  for (let i = 0; i < 5; i++) assert.ok(users.authenticate('ana', 'errada', '', false).error);
  assert.match(users.authenticate('ana', tempPassword, '', false).error, /bloqueada/);
  assert.ok(users.passwordProblem('curta'));
  assert.equal(users.passwordProblem('uma frase longa e boa'), null);
});

test('não deixa remover o último administrador nem reduzir o próprio acesso', () => {
  const admin = users.findLogin('ana');
  assert.throws(() => users.updateUser(admin.id, { role: 'dev' }, admin), /próprio acesso/);
  assert.throws(() => users.updateUser(admin.id, { active: false }, null), /administrador/);
});

const doc = {
  projects: [{ id: 'p1', name: 'A', env: 'dev' }, { id: 'p2', name: 'B', env: 'prod' }],
  nodes: [
    { id: 'n1', type: 'agent', projectId: 'p1', label: 'Agente A', danger: false, skills: [] },
    { id: 'n2', type: 'agent', projectId: 'p2', label: 'Agente B', danger: false },
  ],
  links: [{ a: 'n1', b: 'n2' }], groups: [{ id: 'g', name: 'G', projectIds: ['p1', 'p2'] }],
  settings: { mask: true }, security: { fourEyesProd: true }, mcps: [{ id: 'github', env: [{ key: 'TOKEN' }] }],
};
const dev = { id: 'u2', role: 'dev', projects: ['p1'], active: true, extra: [], deny: [] };
const viewer = { id: 'u3', role: 'leitura', projects: ['p1'], active: true, extra: [], deny: [] };

test('cada pessoa só recebe o que pode ver', () => {
  const f = filterFor(doc, dev);
  assert.deepEqual(f.projects.map((p) => p.id), ['p1']);
  assert.deepEqual(f.nodes.map((n) => n.id), ['n1']);
  assert.equal(f.links.length, 0);
  assert.deepEqual(f.groups[0].projectIds, ['p1']);
  assert.equal(f.mcps[0].env[0].set, true);
  assert.ok(!('value' in f.mcps[0].env[0]));
});

test('alterações sem permissão voltam ao valor do servidor', () => {
  const incoming = { ...filterFor(doc, dev), settings: { mask: false }, nodes: [{ ...doc.nodes[0], danger: true, label: 'Hack', x: 99 }, { id: 'n9', type: 'orch', label: 'novo' }] };
  const out = mergeFrom(doc, incoming, dev);
  assert.equal(out.settings.mask, true);
  const n1 = out.nodes.find((n) => n.id === 'n1');
  assert.equal(n1.danger, false);
  assert.equal(n1.label, 'Agente A');
  assert.equal(n1.x, 99);
  assert.ok(out.nodes.some((n) => n.id === 'n2'), 'janela de projeto invisível continua');
  assert.ok(!out.nodes.some((n) => n.id === 'n9'), 'dev não cria orquestrador');
  assert.deepEqual(out.links, doc.links, 'ligação com projeto invisível continua');
});

test('somente leitura não fecha janelas nem cria nada', () => {
  const out = mergeFrom(doc, { ...filterFor(doc, viewer), nodes: [] }, viewer);
  assert.ok(out.nodes.some((n) => n.id === 'n1'));
  assert.ok(!can(viewer, 'message', 'p1'));
  assert.ok(permsOf(viewer).has('view'));
});
