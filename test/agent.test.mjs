import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

const AGENT = new URL('../src/remote/agent.py', import.meta.url).pathname;
const call = (request) => JSON.parse(execFileSync('python3', [AGENT], { input: JSON.stringify(request), encoding: 'utf8' }));

test('agent compiles', () => {
  execFileSync('python3', ['-m', 'py_compile', AGENT]);
});

test('hello answers with identity on this machine', () => {
  const response = call({ op: 'hello' });
  assert.equal(response.ok, true);
  assert.equal(response.result.agent_version, 1);
  assert.match(response.result.agent_sha256, /^[0-9a-f]{64}$/);
});

test('unknown op is a structured error', () => {
  const response = call({ op: 'nope' });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'unknown_op');
});
