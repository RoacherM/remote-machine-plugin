// Live: the real transport and agent against a real computer over ssh. Runs only with DSH_REMOTE_LIVE=1
// (`npm run test:live`); host from DSH_REMOTE_LIVE_HOST (default `omarchy`). Everything it creates is
// under ~/dsh-remote-test/<run>/ and ~/.local/state/dsh-computer/ on the remote, and removed afterwards
// (the installed agent stays at its fixed path).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { normalizeComputers } from '../src/host/config.js';
import { remoteMachineRoutes } from '../src/host/routes.js';
import { createRemoteMachine } from '../src/host/tools.js';
import { createTransport } from '../src/host/transport.js';

const LIVE = process.env.DSH_REMOTE_LIVE === '1';
const HOST = process.env.DSH_REMOTE_LIVE_HOST || 'omarchy';
const run = randomBytes(6).toString('hex');
const root = `~/dsh-remote-test/${run}`;
const owner = `live-owner-${run}`;
const computer = { id: 'live', transport: { type: 'ssh', host: HOST } };
const transport = createTransport();
const sessions = [];
// Job ids made by the tools (`j<time>-<hex>`, generated here), removed with the run's own jobs.
const toolJobs = [];

describe(`live against ssh ${HOST}`, { skip: !LIVE && 'set DSH_REMOTE_LIVE=1 to run against a real computer' }, () => {
  after(async () => {
    if (sessions.length) await transport.call(computer, { op: 'end_sessions', sessions }).catch(() => {});
    // `run` and the tool job ids are [0-9a-z-] we generated: this cleanup command carries no request data.
    assert.ok(toolJobs.every((id) => /^j[0-9a-z]+-[0-9a-f]{12}$/.test(id)));
    const jobs = toolJobs.map((id) => ` "$HOME/.local/state/dsh-computer/jobs/${id}"`).join('');
    execFileSync('ssh', ['-o', 'BatchMode=yes', '--', HOST,
      `rm -rf "$HOME/dsh-remote-test/${run}" "$HOME/.local/state/dsh-computer/jobs/live-${run}-"*${jobs}; rmdir "$HOME/dsh-remote-test" 2>/dev/null; true`]);
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

  describe('through the computer_* tools', () => {
    const saved = [];
    const machine = createRemoteMachine({
      computers: normalizeComputers([{
        id: 'omarchy', name: 'Omarchy', platform: 'linux', transport: { type: 'ssh', host: HOST },
        cua: { path: '~/.local/bin/cua-driver', service: 'dsh-cua-driver.service' }, workRoot: root, fileRoots: [root],
        capabilities: { input: false, inputUnavailableReason: 'production Hyprland input plugin is unavailable' },
      }]),
      transport,
      attachments: () => ({
        async saveImage({ data, mediaType }) {
          saved.push({ data, mediaType });
          return { attachmentId: `live-${saved.length}`, mediaType, bytes: data.length };
        },
      }),
    });
    const tools = new Map(machine.tools.map((tool) => [tool.name, tool]));
    const exec = { agent: { id: `live-dsh-session-${run}` } };
    const use = (name, args) => tools.get(name).execute({ computer_id: 'omarchy', ...args }, exec);
    after(() => machine.dispose());

    test('computer_list reaches the computer', async () => {
      const { computers: [entry] } = await tools.get('computer_list').execute({}, exec);
      assert.equal(entry.reachable, true, JSON.stringify(entry.error));
      assert.equal(entry.cua.service_state, 'active');
    });

    test('computer_screenshot saves a PNG attachment and keeps it per session and computer', async () => {
      const value = await use('computer_screenshot', {});
      assert.equal(saved.at(-1).mediaType, 'image/png');
      assert.equal(value.attachment.attachmentId, `live-${saved.length}`);
      assert.ok(value.capture_id && value.frame_scale > 0 && value.screen.width > 0 && value.image.width > 0);
      assert.equal(machine.screenshots(exec.agent.id, 'omarchy').at(-1).capture_id, value.capture_id);
      console.log(`# tool screenshot ${value.image.width}x${value.image.height} of ${value.screen.width}x${value.screen.height}, ${value.windows.length} window(s)`);
    });

    test('panel routes: status, refresh capture and the PNG served from memory', async () => {
      const routes = new Map(remoteMachineRoutes(machine).map((route) => [route.path, route.fetch]));
      const get = (name, query) => routes.get(`/api/remote-machine/${name}`)(new Request(`http://dsh.test/api/remote-machine/${name}?${new URLSearchParams(query)}`));
      const status = await (await get('status', { computer: 'omarchy' })).json();
      assert.equal(status.reachable, true, JSON.stringify(status.error));
      const response = await routes.get('/api/remote-machine/capture')(new Request('http://dsh.test/api/remote-machine/capture', {
        method: 'POST', body: JSON.stringify({ session: exec.agent.id, computer_id: 'omarchy' }),
      }));
      const shot = await response.json();
      assert.equal(response.status, 200, JSON.stringify(shot));
      assert.ok(shot.capture_id && shot.frame_scale > 0 && shot.attachment === undefined);
      const { screenshots } = await (await get('screenshots', { session: exec.agent.id, computer: 'omarchy' })).json();
      assert.equal(screenshots.at(-1).capture_id, shot.capture_id);
      const image = await get('screenshot', { session: exec.agent.id, computer: 'omarchy', capture: shot.capture_id });
      assert.equal(image.headers.get('content-type'), 'image/png');
      assert.equal((await image.arrayBuffer()).byteLength, shot.image.bytes);
      console.log(`# panel capture ${shot.capture_id} at ${shot.captured_at}, ${shot.image.width}x${shot.image.height}`);
    });

    test('computer_exec_* : output, exit code and a confirmed cancel', async () => {
      await transport.call(computer, { op: 'hello', work_root: root });
      const job = await use('computer_exec_start', { command: 'echo "$PWD"; echo 你好; exit 2' });
      toolJobs.push(job.job_id);
      let status = await use('computer_exec_status', { job_id: job.job_id, wait_s: 5 });
      for (let i = 0; i < 10 && status.state === 'running'; i += 1) status = await use('computer_exec_status', { job_id: job.job_id, wait_s: 2 });
      assert.equal(status.exit.exit_code, 2);
      assert.match(status.stdout.text, /dsh-remote-test\/[0-9a-f]+\n你好\n$/);
      const long = await use('computer_exec_start', { argv: ['sleep', '120'] });
      toolJobs.push(long.job_id);
      assert.equal((await use('computer_exec_cancel', { job_id: long.job_id })).cancel, 'confirmed');
    });

    test('computer_file_* : round trip of a Chinese file name with spaces', async () => {
      const path = `${root}/报告 目录/第 1 份 notes.txt`;
      const content = '远程文件 round trip\n';
      const written = await use('computer_file_write', { path, content, mkdirs: true });
      const read = await use('computer_file_read', { path });
      assert.equal(read.content, content);
      assert.equal(read.sha256, written.sha256);
      assert.ok(read.path.endsWith('/报告 目录/第 1 份 notes.txt'));
    });

    test('computer_cua_call: observation works, input is refused as capability_unavailable', async () => {
      const windows = await use('computer_cua_call', { tool: 'list_windows', arguments: {} });
      assert.ok(windows.value);
      await assert.rejects(use('computer_cua_call', { tool: 'click', arguments: { x: 1, y: 1 } }), (error) => error.code === 'capability_unavailable');
    });
  });
});
