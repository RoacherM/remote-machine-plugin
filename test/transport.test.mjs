// Offline: the transport against a fake ssh that runs the real agent locally under a temporary HOME.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createTransport, installCommand, RemoteError, runCommand } from '../src/host/transport.js';

const FAKE_SSH = new URL('./fixtures/fake-ssh.mjs', import.meta.url).pathname;
let home;
let log;
let transport;
const computer = (host = 'fake') => ({ id: `pc-${host}`, transport: { type: 'ssh', host } });
const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const owner = 'session-a';

before(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-remote-home-'));
  log = join(home, 'ssh.log');
  mkdirSync(join(home, 'work'));
  process.env.FAKE_SSH_HOME = home;
  process.env.FAKE_SSH_LOG = log;
  transport = createTransport({ sshCommand: [process.execPath, FAKE_SSH] });
});

after(() => rmSync(home, { recursive: true, force: true }));

async function waitFor(jobId, predicate, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const status = await transport.call(computer(), { op: 'exec_status', job_id: jobId, owner, wait_s: 1 });
    if (predicate(status) || Date.now() > end) return status;
  }
}

test('remote command lines are constants of the agent hash', () => {
  const { sha256 } = transport.agent;
  for (const command of [runCommand(sha256), installCommand(sha256)]) {
    assert.match(command, /^sh -c '/);
    assert.ok(command.includes(`agent-${sha256}.py`));
  }
  assert.throws(() => runCommand('$(reboot)'));
});

test('first call installs the agent over stdin, later calls reuse it', async () => {
  const hello = await transport.call(computer(), { op: 'hello' });
  assert.equal(hello.agent_sha256, transport.agent.sha256);
  const installed = join(home, '.local/state/dsh-computer', `agent-${transport.agent.sha256}.py`);
  assert.equal(statSync(installed).mode & 0o777, 0o600);
  assert.equal(calls().length, 3, 'run (missing) → install → run');
  await transport.call(computer(), { op: 'hello' });
  assert.equal(calls().length, 4);
  for (const argv of calls()) {
    assert.deepEqual(argv.slice(0, 5), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-T']);
  }
});

test('request data never appears on the ssh command line', async () => {
  const secret = 'echo marker-7f3a > "$HOME/work/out file.txt"';
  const job = await transport.startJob(computer(), { job_id: 'job-cmdline', owner, shell_script: secret, cwd: '~/work' });
  await waitFor(job.job_id, (s) => s.state !== 'running' && s.state !== 'starting');
  await transport.call(computer(), { op: 'file_read', path: '~/work/out file.txt', roots: ['~/work'] });
  for (const argv of calls()) {
    const line = argv.join(' ');
    assert.ok(!line.includes('marker-7f3a') && !line.includes('out file') && !line.includes('job-cmdline'), line);
  }
});

test('exec: incremental output by cursor, exit code, ownership', async () => {
  const script = 'printf "one\\n"; sleep 0.6; printf "two\\n"; printf "oops\\n" >&2; exit 3';
  const job = await transport.startJob(computer(), { job_id: 'job-incr', owner, shell_script: script, cwd: '~/work' });
  assert.ok(['running', 'starting'].includes(job.state));
  const first = await transport.call(computer(), { op: 'exec_status', job_id: 'job-incr', owner, wait_s: 0.3 });
  assert.equal(first.stdout.text, 'one\n');
  const done = await waitFor('job-incr', (s) => s.state === 'exited');
  assert.equal(done.exit.exit_code, 3);
  const rest = await transport.call(computer(), {
    op: 'exec_status', job_id: 'job-incr', owner, stdout_cursor: first.stdout.cursor, stderr_cursor: 0,
  });
  assert.equal(rest.stdout.text, 'two\n');
  assert.equal(rest.stderr.text, 'oops\n');
  await assert.rejects(transport.call(computer(), { op: 'exec_status', job_id: 'job-incr', owner: 'session-b' }),
    (error) => error instanceof RemoteError && error.code === 'job_not_owned' && error.remote === true);
});

test('cancel is confirmed only once the process group is gone', async () => {
  await transport.startJob(computer(), { job_id: 'job-cancel', owner, shell_script: 'sleep 30 & sleep 30; wait', cwd: '~/work' });
  const result = await transport.call(computer(), { op: 'exec_cancel', job_id: 'job-cancel', owner });
  assert.equal(result.cancel, 'confirmed');
  assert.equal(result.state, 'cancelled');
  assert.equal(result.process_group_alive, false);
  const pgid = (await transport.call(computer(), { op: 'exec_status', job_id: 'job-cancel', owner })).started.pgid;
  assert.throws(() => process.kill(-pgid, 0), { code: 'ESRCH' });
});

test('cancel escalates to SIGKILL when TERM is ignored', async () => {
  await transport.startJob(computer(), { job_id: 'job-stubborn', owner, shell_script: 'trap "" TERM; while :; do sleep 0.1; done', cwd: '~/work' });
  const result = await transport.call(computer(), { op: 'exec_cancel', job_id: 'job-stubborn', owner });
  assert.equal(result.cancel, 'confirmed');
  assert.equal(result.exit.signal, 'SIGKILL');
});

test('cancel after the job finished does not claim success', async () => {
  await transport.startJob(computer(), { job_id: 'job-quick', owner, argv: ['true'], cwd: '~/work' });
  await waitFor('job-quick', (s) => s.state === 'exited');
  const result = await transport.call(computer(), { op: 'exec_cancel', job_id: 'job-quick', owner });
  assert.equal(result.cancel, 'not_running');
});

test('a lost exec_start reply is resolved by job id, never by starting again', async () => {
  const job = await transport.startJob(computer('drop-start'), {
    job_id: 'job-dropped', owner, shell_script: 'echo started >> "$HOME/work/starts.txt"', cwd: '~/work',
  });
  assert.equal(job.recovered, true);
  await waitFor('job-dropped', (s) => s.state === 'exited');
  assert.equal(readFileSync(join(home, 'work/starts.txt'), 'utf8'), 'started\n');
  const again = await transport.startJob(computer(), { job_id: 'job-dropped', owner, argv: ['true'] });
  assert.equal(again.duplicate, true);
  assert.equal(readFileSync(join(home, 'work/starts.txt'), 'utf8'), 'started\n');
});

test('unreachable host is a transport error; nothing is started', async () => {
  await assert.rejects(transport.call(computer('down'), { op: 'hello' }),
    (error) => error.code === 'transport_error' && /Connection refused/.test(error.message));
  await assert.rejects(transport.startJob(computer('down'), { job_id: 'job-down', owner, argv: ['true'] }),
    (error) => error.code === 'start_uncertain' && error.job_id === 'job-down');
  assert.equal(existsSync(join(home, '.local/state/dsh-computer/jobs/job-down')), false);
});

test('hosts that look like ssh options are refused before ssh runs', async () => {
  const before = calls().length;
  for (const host of ['-oProxyCommand=touch /tmp/x', 'a b', 'a;b', '', undefined]) {
    await assert.rejects(transport.call({ id: 'bad', transport: { type: 'ssh', host } }, { op: 'hello' }),
      (error) => error.code === 'invalid_config');
  }
  await assert.rejects(transport.call({ id: 'x', transport: { type: 'vnc' } }, { op: 'hello' }), (error) => error.code === 'transport_unsupported');
  assert.equal(calls().length, before);
});

test('aborting a call reports that it may have happened', async () => {
  await transport.startJob(computer(), { job_id: 'job-abort', owner, argv: ['sleep', '5'] });
  const controller = new AbortController();
  const pending = transport.call(computer(), { op: 'exec_status', job_id: 'job-abort', owner, wait_s: 5 }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(pending, (error) => error.code === 'aborted' && error.uncertain === true);
  const cancelled = await transport.call(computer(), { op: 'exec_cancel', job_id: 'job-abort', owner });
  assert.equal(cancelled.cancel, 'confirmed');
});

test('small files round-trip with hashes, inside the roots only', async () => {
  const data = Buffer.from([0, 1, 2, 255, 0x68, 0x69]);
  const written = await transport.call(computer(), {
    op: 'file_write', path: '~/work/sub/bin.dat', roots: ['~/work'], mkdirs: true, data_b64: data.toString('base64'),
  });
  assert.equal(written.created, true);
  assert.equal(statSync(join(home, 'work/sub/bin.dat')).mode & 0o777, 0o666 & ~process.umask());
  const read = await transport.call(computer(), { op: 'file_read', path: '~/work/sub/bin.dat', roots: ['~/work'] });
  assert.deepEqual(Buffer.from(read.data_b64, 'base64'), data);
  assert.equal(read.sha256, written.sha256);
  await assert.rejects(transport.call(computer(), { op: 'file_write', path: '~/work/sub/bin.dat', roots: ['~/work'], data_b64: '' }),
    (error) => error.code === 'exists');
  await assert.rejects(transport.call(computer(), {
    op: 'file_write', path: '~/work/sub/bin.dat', roots: ['~/work'], overwrite: true, expected_sha256: '0'.repeat(64), data_b64: '',
  }), (error) => error.code === 'conflict');
  await assert.rejects(transport.call(computer(), { op: 'file_read', path: '~/work/../ssh.log', roots: ['~/work'] }),
    (error) => error.code === 'path_outside_roots');
  const jobFiles = readdirSync(join(home, '.local/state/dsh-computer/jobs/job-incr'));
  for (const name of jobFiles) assert.equal(statSync(join(home, '.local/state/dsh-computer/jobs/job-incr', name)).mode & 0o077, 0, name);
});
