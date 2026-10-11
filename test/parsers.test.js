import { test } from 'node:test';
import './setup.js';
import assert from 'node:assert/strict';
const { parseClaude, parseCodex } = await import('../src/agents.js');
const { parseUsage } = await import('../src/usage.js');

test('lê eventos do Claude Code', () => {
  assert.deepEqual(parseClaude('{"type":"system","subtype":"init","session_id":"abc"}'), [{ kind: 'session', id: 'abc' }]);
  const ev = parseClaude(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Pronto' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }));
  assert.deepEqual(ev, [{ kind: 'text', text: 'Pronto' }, { kind: 'tool', text: '$ npm test' }]);
  assert.deepEqual(parseClaude('não é json'), []);
});

test('lê eventos do Codex', () => {
  const ev = parseCodex(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Feito' } }));
  assert.deepEqual(ev, [{ kind: 'text', text: 'Feito' }]);
});

test('lê percentuais de consumo', () => {
  const u = parseUsage('Current session\n  ███ 42% used\n  Resets 6:40pm\nCurrent week (all models)\n  █ 18% used', 'claude');
  assert.equal(u.session, 42);
  assert.equal(u.week, 18);
  const c = parseUsage('5h limit: 73% left\nWeekly limit: 10% used', 'codex');
  assert.equal(c.session, 27);
  assert.equal(c.week, 10);
});
