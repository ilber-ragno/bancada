import './setup.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
const { sameOrigin } = await import('../src/auth.js');

// Reproduz o crash do app: headers é getter do IncomingMessage e não sobrevive a { ...req }
test('sameOrigin funciona com IncomingMessage real e com método informado', async () => {
  const req = await new Promise((resolve) => {
    const srv = http.createServer((r, res) => { res.end(); srv.close(); resolve(r); }).listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      http.get({ port, host: '127.0.0.1', headers: { origin: `http://127.0.0.1:${port}` } }, (res) => res.resume());
    });
  });
  assert.equal(sameOrigin(req, 'POST'), true);
  assert.equal(sameOrigin({ headers: { origin: 'http://evil.example', host: '127.0.0.1:1' } }, 'POST'), false);
  assert.equal(sameOrigin({ headers: {} }, 'POST'), false);
  assert.doesNotThrow(() => sameOrigin({}, 'POST'));
});
