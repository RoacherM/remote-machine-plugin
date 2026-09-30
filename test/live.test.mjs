// Live: the real transport and agent against a real computer over ssh. Runs only with DSH_REMOTE_LIVE=1
// (`npm run test:live`); host from DSH_REMOTE_LIVE_HOST (default `omarchy`). Everything it creates is
// under ~/dsh-remote-test/<run>/ and ~/.local/state/dsh-computer/ on the remote, and removed afterwards
// (the installed agent stays at its fixed path).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { createTransport } from '../src/host/transport.js';

const LIVE = process.env.DSH_REMOTE_LIVE === '1';
const HOST = process.env.DSH_REMOTE_LIVE_HOST || 'omarchy';
const run = randomBytes(6).toString('hex');
const root = `~/dsh-remote-test/${run}`;
const owner = `live-owner-${run}`;
const computer = { id: 'live', transport: { type: 'ssh', host: HOST } };
const transport = createTransport();
const sessions = [];

describe(`live against ssh ${HOST}`, { skip: !LIVE && 'set DSH_REMOTE_LIVE=1 to run against a real computer' }, () => {
  after(async () => {
    if (sessions.length) await transport.call(computer, { op: 'end_sessions', sessions }).catch(() => {});
    // `run` is hex we generated: this fixed cleanup command carries no request data.
    execFileSync('ssh', ['-o', 'BatchMode=yes', '--', HOST,
      `rm -rf "$HOME/dsh-remote-test/${run}" "$HOME/.local/state/dsh-computer/jobs/live-${run}-"*; rmdir "$HOME/dsh-remote-test" 2>/dev/null; true`]);
  });

  const status = (jobId, extra = {}) => transport.call(computer, { op: 'exec_status', job_id: jobId, owner, ...extra });
  async function collect(jobId) {
    let stdout = '';
    let cursor = 0;
    const end = Date.now() + 30_000;
    for (;;) {
      const s = await status(jobId, { stdout_cursor: cursor, wait_s: 2 });
      stdout += s.stdout.text;
      cursor = s.stdout.cursor;
      if ((s.state !== 'running' && s.state !== 'starting' && !s.stdout.more) || Date.now() > end) return { ...s, all: stdout };
    }
  }

  test('hello reports the installed agent and the Cua service', async () => {
    const hello = await transport.call(computer, { op: 'hello', cua_service: 'dsh-cua-driver.service', work_root: root });
    assert.equal(hello.agent_sha256, transport.agent.sha256);
    assert.ok(hello.boot_id);
    console.log(`# ${HOST}: ${hello.system} ${hello.machine} python ${hello.python}; cua ${hello.cua.version ?? 'missing'} service=${hello.cua.service_state}`);
  });

  test('a job keeps running after the ssh call that started it ends; output streams by cursor', async () => {
    const job = await transport.startJob(computer, {
      job_id: `live-${run}-stream`, owner, cwd: root,
      shell_script: 'for i in 1 2 3; do echo "line $i"; sleep 1; done; echo "to stderr" >&2; exit 4',
    });
    assert.equal(job.state, 'running');
    const first = await status(job.job_id, { wait_s: 0.5 });
    assert.equal(first.state, 'running', 'still running after its start connection closed');
    const done = await collect(job.job_id);
    assert.equal(done.state, 'exited');
    assert.equal(done.exit.exit_code, 4);
    assert.equal(done.all, 'line 1\nline 2\nline 3\n');
    assert.equal((await status(job.job_id)).stderr.text, 'to stderr\n');
  });

  test('cancel is confirmed and independently verified: the process group is gone', async () => {
    const job = await transport.startJob(computer, { job_id: `live-${run}-cancel`, owner, cwd: root, shell_script: 'sleep 300 & sleep 300; wait' });
    const { started } = await status(job.job_id);
    const result = await transport.call(computer, { op: 'exec_cancel', job_id: job.job_id, owner });
    assert.equal(result.cancel, 'confirmed');
    assert.equal(result.process_group_alive, false);
    const probe = await transport.startJob(computer, {
      job_id: `live-${run}-probe`, owner, cwd: root, argv: ['sh', '-c', 'kill -0 -- "-$1" 2>/dev/null && echo alive || echo gone', 'probe', String(started.pgid)],
    });
    assert.equal((await collect(probe.job_id)).all, 'gone\n');
  });

  test('a TERM-ignoring job is killed and still reported confirmed', async () => {
    const job = await transport.startJob(computer, { job_id: `live-${run}-stubborn`, owner, cwd: root, shell_script: 'trap "" TERM; while :; do sleep 0.2; done' });
    const result = await transport.call(computer, { op: 'exec_cancel', job_id: job.job_id, owner });
    assert.equal(result.cancel, 'confirmed');
    assert.equal(result.exit.signal, 'SIGKILL');
  });

  test('jobs are bound to their DSH session', async () => {
    await assert.rejects(transport.call(computer, { op: 'exec_status', job_id: `live-${run}-stream`, owner: 'someone-else' }),
      (error) => error.code === 'job_not_owned');
  });

  test('small file round trip with sha256, confined to the roots', async () => {
    const data = randomBytes(4096);
    const path = `${root}/files/sample.bin`;
    const written = await transport.call(computer, { op: 'file_write', path, roots: [root], mkdirs: true, data_b64: data.toString('base64') });
    const read = await transport.call(computer, { op: 'file_read', path, roots: [root] });
    assert.deepEqual(Buffer.from(read.data_b64, 'base64'), data);
    assert.equal(read.sha256, written.sha256);
    await assert.rejects(transport.call(computer, { op: 'file_read', path: '~/.ssh/config', roots: [root] }),
      (error) => error.code === 'path_outside_roots');
  });

  test('screenshot through Cua returns a PNG and its frame metadata', async () => {
    const session = `dsh-live-${run}`;
    sessions.push(session);
    const shot = await transport.call(computer, { op: 'screenshot', session, max_image_dimension: 1280 }, { timeoutMs: 90_000 });
    const png = Buffer.from(shot.png_b64, 'base64');
    assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
    assert.equal(png.length, shot.bytes);
    assert.ok(shot.meta.capture_id);
    assert.ok(shot.meta.screenshot_width > 0 && shot.meta.frame_scale > 0);
    console.log(`# screenshot ${shot.meta.screenshot_width}x${shot.meta.screenshot_height} of ${shot.meta.screen_width}x${shot.meta.screen_height}, frame_scale ${shot.meta.frame_scale}`);
  });
});
