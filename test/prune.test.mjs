// Offline: the agent's job housekeeping, run directly under a temporary HOME. Finished jobs go after the
// retention period; running jobs, jobs whose process group lives on and anything that might still be
// starting stay.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const AGENT = new URL('../src/remote/agent.py', import.meta.url).pathname;
const DAY_MS = 24 * 3600 * 1000;
const owner = 'session-prune';
let home;
let jobs;
let shots;

const call = (request) => {
  const response = JSON.parse(execFileSync('python3', [AGENT], { input: JSON.stringify(request), encoding: 'utf8', env: { ...process.env, HOME: home } }));
  if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
  return response.result;
};

async function finished(jobId) {
  for (let i = 0; i < 50; i += 1) {
    const status = call({ op: 'exec_status', job_id: jobId, owner, wait_s: 0.2 });
    if (status.state !== 'running' && status.state !== 'starting') return status;
  }
  throw new Error(`${jobId} did not finish`);
}

// Moves a job's end (or creation) `days` into the past, as if it had happened then.
function backdate(jobId, days) {
  const dir = join(jobs, jobId);
  const then = Date.now() - days * DAY_MS;
  const exitPath = join(dir, 'exit.json');
  if (existsSync(exitPath)) writeFileSync(exitPath, JSON.stringify({ ...JSON.parse(readFileSync(exitPath, 'utf8')), finished_ms: then }));
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...meta, created_ms: then }));
}

function fakeJob(name, meta, days) {
  mkdirSync(join(jobs, name));
  if (meta) writeFileSync(join(jobs, name, 'meta.json'), JSON.stringify({ job_id: name, owner, created_ms: Date.now() - days * DAY_MS, ...meta }));
  const then = new Date(Date.now() - days * DAY_MS);
  utimesSync(join(jobs, name), then, then);
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-remote-prune-'));
  mkdirSync(join(home, 'work'));
  jobs = join(home, '.local/state/dsh-computer/jobs');
  shots = join(home, '.local/state/dsh-computer/shots');
});

after(() => {
  try { call({ op: 'exec_cancel', job_id: 'old-running', owner }); } catch { /* already gone */ }
  // The straggler's job has exited, so cancel would not touch it: end its process group directly.
  try { process.kill(-JSON.parse(readFileSync(join(jobs, 'old-straggler', 'started.json'), 'utf8')).pgid, 'SIGKILL'); } catch { /* already gone */ }
  rmSync(home, { recursive: true, force: true });
});

test('prune removes finished jobs past retention and keeps everything that may still matter', async () => {
  call({ op: 'exec_start', job_id: 'old-done', owner, argv: ['true'], cwd: '~/work' });
  call({ op: 'exec_start', job_id: 'recent-done', owner, argv: ['true'], cwd: '~/work' });
  call({ op: 'exec_start', job_id: 'old-running', owner, argv: ['sleep', '30'], cwd: '~/work' });
  // Exits at once but leaves a member of its process group behind.
  call({ op: 'exec_start', job_id: 'old-straggler', owner, shell_script: 'sleep 30 & exit 0', cwd: '~/work' });
  await finished('old-done');
  await finished('recent-done');
  assert.equal((await finished('old-straggler')).exit.group_remaining, true);
  for (const job of ['old-done', 'old-running', 'old-straggler']) backdate(job, 8);
  fakeJob('old-lost', { boot_id: 'an-earlier-boot' }, 8); // the computer restarted under it
  fakeJob('fresh-lost', { boot_id: 'an-earlier-boot' }, 0);
  fakeJob('old-half', null, 8); // a start that died before writing meta.json
  fakeJob('fresh-half', null, 0);
  writeFileSync(join(jobs, 'not.a-job'), 'x');
  mkdirSync(shots, { recursive: true });
  writeFileSync(join(shots, 'left.png'), 'x');
  const hourAgo = new Date(Date.now() - 2 * 3600 * 1000);
  utimesSync(join(shots, 'left.png'), hourAgo, hourAgo);
  writeFileSync(join(shots, 'in-flight.png'), 'x');

  const result = call({ op: 'prune' });
  assert.deepEqual(result.removed, ['old-done', 'old-half', 'old-lost']);
  assert.equal(result.shots_removed, 1);
  for (const kept of ['recent-done', 'old-running', 'old-straggler', 'fresh-lost', 'fresh-half', 'not.a-job']) {
    assert.ok(existsSync(join(jobs, kept)), kept);
  }
  assert.ok(existsSync(join(shots, 'in-flight.png')) && !existsSync(join(shots, 'left.png')));
  assert.throws(() => call({ op: 'exec_status', job_id: 'old-done', owner }), (error) => error.code === 'job_not_found' && /removed 7 days after/.test(error.message));
  assert.equal(call({ op: 'exec_status', job_id: 'old-running', owner }).state, 'running');

  // retention_s is clamped: a job that ended just now is never removed, even when asked for 0.
  const clamped = call({ op: 'prune', retention_s: 0 });
  assert.deepEqual(clamped.removed, []);
  assert.equal(clamped.retention_s, 300);
  assert.ok(existsSync(join(jobs, 'recent-done')) && existsSync(join(jobs, 'fresh-lost')));
});

test('exec_start prunes at most once per interval', async () => {
  const stamp = join(jobs, '.pruned');
  call({ op: 'exec_start', job_id: 'old-2', owner, argv: ['true'], cwd: '~/work' });
  await finished('old-2');
  backdate('old-2', 8);
  // The stamp is fresh: the next start leaves old-2 alone.
  call({ op: 'exec_start', job_id: 'next-1', owner, argv: ['true'], cwd: '~/work' });
  assert.ok(existsSync(join(jobs, 'old-2')));
  // An hour later the next start prunes, and renews the stamp.
  const hourAgo = new Date(Date.now() - 3601 * 1000);
  utimesSync(stamp, hourAgo, hourAgo);
  const started = call({ op: 'exec_start', job_id: 'next-2', owner, argv: ['true'], cwd: '~/work' });
  assert.equal(started.job_id, 'next-2');
  assert.ok(!existsSync(join(jobs, 'old-2')));
  assert.ok(existsSync(join(jobs, 'next-2')));
  assert.ok(Date.now() - statSync(stamp).mtimeMs < 60_000);
});
