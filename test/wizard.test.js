import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const { createProject, trustHost } = await import('../src/wizard.js');
const { getDoc, server } = await import('../src/store.js');

const actor = { id: 'u-test', name: 'Teste' };

test('assistente cria projeto e recusa duplicado e caminho inválido', () => {
  const p = createProject({ name: 'App', server: 'dev@10.0.0.5', path: '/home/dev/app', env: 'prod', collab: false }, actor);
  assert.equal(p.server, 'dev@10.0.0.5');
  assert.equal(p.env, 'prod');
  assert.equal(p.collab, false);
  assert.ok(getDoc().projects.some((x) => x.id === p.id));
  assert.throws(() => createProject({ name: 'App 2', server: 'dev@10.0.0.5:22', path: '/home/dev/app' }, actor), /Já existe/);
  assert.throws(() => createProject({ name: 'X', server: 'dev@10.0.0.5', path: '../etc' }, actor), /inválido/);
  assert.throws(() => createProject({ name: 'X', server: 'sem-arroba', path: '/srv/x' }, actor), /Servidor inválido/);
  assert.equal(createProject({ name: 'Y', server: 'dev@10.0.0.5', path: '/srv/y', env: 'qualquer' }, actor).env, 'dev');
});

test('confiar na chave do servidor não troca uma chave já registrada', () => {
  const fp = 'SHA256:' + 'A'.repeat(43);
  trustHost('dev@10.0.0.9', fp, actor);
  assert.equal(server().hostKeys['10.0.0.9:22'], fp + '=');
  assert.throws(() => trustHost('dev@10.0.0.9', 'SHA256:' + 'B'.repeat(43), actor), /outra chave/);
  assert.throws(() => trustHost('dev@10.0.0.9', 'lixo', actor), /inválida/);
});
