import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { filterFor, mergeFrom } = await import('../src/acl.js');
const { canUseAccount } = await import('../src/permissions.js');
const users = await import('../src/users.js');
const { createInvite, findByToken } = await import('../src/invites.js');
const { safeRel, SENSITIVE } = await import('../src/files.js');

const ana = { id: 'ua', name: 'Ana', role: 'admin', projects: '*', active: true, extra: [], deny: [] };
const bia = { id: 'ub', name: 'Bia', role: 'dev', projects: ['p1'], active: true, extra: [], deny: [] };
const caio = { id: 'uc', name: 'Caio', role: 'dev', projects: ['p1'], active: true, extra: [], deny: [] };
const doc = {
  projects: [{ id: 'p1', name: 'A', env: 'dev', collab: false }],
  nodes: [
    { id: 'n1', type: 'agent', projectId: 'p1', owner: 'ub', share: 'private', label: 'Da Bia' },
    { id: 'n2', type: 'agent', projectId: 'p1', owner: 'ub', share: 'people', people: ['uc'], label: 'Bia e Caio' },
    { id: 'n3', type: 'agent', projectId: 'p1', owner: 'ub', share: 'project', label: 'Do projeto', accountId: 'acc1' },
  ],
  links: [], accounts: [{ id: 'acc1', owner: 'ub', name: 'Conta da Bia', engine: 'claude', target: 'bia@h', share: 'private', people: [] }],
};

test('agente privado só aparece para o dono e administradores', () => {
  assert.deepEqual(filterFor(doc, bia).nodes.map((n) => n.id), ['n1', 'n2', 'n3']);
  assert.deepEqual(filterFor(doc, caio).nodes.map((n) => n.id), ['n2', 'n3']);
  assert.equal(filterFor(doc, ana).nodes.length, 3);
});

test('só o dono muda compartilhamento e conta do agente', () => {
  const inc = { ...filterFor(doc, caio), nodes: filterFor(doc, caio).nodes.map((n) => ({ ...n, share: 'private', owner: 'uc', accountId: '' })) };
  const out = mergeFrom(doc, inc, caio);
  const n3 = out.nodes.find((n) => n.id === 'n3');
  assert.equal(n3.owner, 'ub'); assert.equal(n3.share, 'project'); assert.equal(n3.accountId, 'acc1');
  assert.ok(out.nodes.some((n) => n.id === 'n1'), 'agente privado da Bia continua');
});

test('conta de IA: uso e alteração só pelo dono, salvo compartilhamento', () => {
  assert.ok(canUseAccount(doc.accounts[0], bia));
  assert.ok(!canUseAccount(doc.accounts[0], caio));
  assert.ok(canUseAccount({ ...doc.accounts[0], share: 'people', people: ['uc'] }, caio));
  const out = mergeFrom(doc, { ...filterFor(doc, caio), accounts: [{ id: 'acc1', owner: 'uc', name: 'roubada', share: 'all' }, { id: 'acc9', name: 'Do Caio', engine: 'codex', target: 'caio@h' }] }, caio);
  assert.equal(out.accounts.find((a) => a.id === 'acc1').name, 'Conta da Bia');
  assert.equal(out.accounts.find((a) => a.id === 'acc9').owner, 'uc');
  assert.equal(filterFor(doc, caio).accounts.length, 0, 'Caio não vê a conta privada da Bia');
});

test('convite respeita papel e projetos de quem convida', () => {
  assert.throws(() => createInvite(bia, { role: 'dev', projects: ['p1'] }, ['p1']), /convidar/);
  const lider = { ...bia, id: 'ul', role: 'lider' };
  assert.throws(() => createInvite(lider, { role: 'admin', projects: [] }, ['p1']), /papel/);
  assert.throws(() => createInvite(lider, { role: 'dev', projects: ['p2'] }, ['p1', 'p2']), /projetos/);
  const { token } = createInvite(lider, { role: 'dev', projects: ['p1'], label: 'Edu' }, ['p1']);
  assert.ok(findByToken(token));
  assert.equal(findByToken('x'.repeat(43)), null);
});

test('árvore de arquivos bloqueia caminhos e segredos', () => {
  assert.throws(() => safeRel('../etc/passwd'));
  assert.throws(() => safeRel('.git/config'));
  assert.equal(safeRel('./src/app.ts'), 'src/app.ts');
  for (const f of ['.env', 'config/.env.production', 'id_rsa', 'certs/server.key', 'aws-credentials.json']) assert.ok(SENSITIVE.test(f), f);
  assert.ok(!SENSITIVE.test('src/index.ts'));
  void users;
});
