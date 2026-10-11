import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mask, checkRisky, isReadOnlyCmd } from '../src/policy.js';

test('mascara CPF, telefone, e-mail e tokens', () => {
  const r = mask('cpf 123.456.789-09, tel (11) 98765-4321, mail a@b.com, chave sk-ant-abcdefghijklmnopqrstuv');
  assert.equal(r.count, 4);
  assert.ok(!/123\.456/.test(r.text));
  assert.ok(r.text.includes('[CPF oculto]'));
  assert.ok(r.text.includes('[token oculto]'));
});

test('mascara senha em atribuição', () => {
  assert.equal(mask('password=segredo123').text, 'password=[oculto]');
});

test('mascara ICCID', () => {
  assert.ok(mask('chip 8955101234567890123').text.includes('[ICCID oculto]'));
});

test('detecta padrões arriscados', () => {
  assert.equal(checkRisky('faça o deploy agora'), 'deploy');
  assert.equal(checkRisky('rode os testes'), null);
  assert.equal(checkRisky('DROP TABLE clientes'), 'drop table');
});

test('reconhece comandos só de leitura', () => {
  assert.ok(isReadOnlyCmd('git status'));
  assert.ok(isReadOnlyCmd('tail -n 50 app.log'));
  assert.ok(!isReadOnlyCmd('rm arquivo'));
  assert.ok(!isReadOnlyCmd('cat a > b'));
  assert.ok(!isReadOnlyCmd('ls; rm -rf x'));
});
