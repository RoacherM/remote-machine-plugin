// Offline: the plugin entry and the computer_* tools against a fake ssh (running the real agent locally
// under a temporary HOME) and a fake cua-driver.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import * as plugin from '../index.js';
import { normalizeComputers } from '../src/host/config.js';
import { remoteMachineRoutes, ROUTE_PREFIX } from '../src/host/routes.js';
import { createRemoteMachine } from '../src/host/tools.js';
import { createTransport } from '../src/host/transport.js';

const FAKE_SSH = new URL('./fixtures/fake-ssh.mjs', import.meta.url).pathname;
const FAKE_CUA = new URL('./fixtures/fake-cua-driver.py', import.meta.url).pathname;
let home;
let machine;
let tools;
const saved = [];
const attachments = {
  async saveImage({ data, mediaType, name }) {
    const bytes = Buffer.from(data);
    saved.push({ bytes, mediaType, name });
    return { attachmentId: `att-${saved.length}`, mediaType, bytes: bytes.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  },
};
const execFor = (id) => ({ signal: new AbortController().signal, agent: { id, session: { header: { cwd: '/tmp' } } } });
const execA = execFor('dsh-session-a');
const execB = execFor('dsh-session-b');
const run = (name, args, exec = execA) => tools.get(name).execute(args, exec);
const rejectsWith = (promise, code) => assert.rejects(promise, (error) => error.code === code || assert.fail(`${error.code}: ${error.message}`));

before(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-remote-plugin-'));
  mkdirSync(join(home, 'work'));
  mkdirSync(join(home, 'bin'));
  copyFileSync(FAKE_CUA, join(home, 'bin/cua-driver'));
  chmodSync(join(home, 'bin/cua-driver'), 0o755);
  process.env.FAKE_SSH_HOME = home;
  process.env.FAKE_SSH_LOG = join(home, 'ssh.log');
  machine = createRemoteMachine({
    computers: normalizeComputers([
      {
        id: 'box', name: 'Test box', platform: 'linux', transport: { type: 'ssh', host: 'fake' },
        cua: { path: '~/bin/cua-driver' }, workRoot: '~/work', fileRoots: ['~/work'],
        capabilities: { input: false, inputUnavailableReason: 'production Hyprland input plugin is unavailable' },
      },
      { id: 'offline', transport: { type: 'ssh', host: 'down' } },
    ]),
    transport: createTransport({ sshCommand: [process.execPath, FAKE_SSH] }),
    attachments: () => attachments,
  });
  tools = new Map(machine.tools.map((tool) => [tool.name, tool]));
});

after(() => rmSync(home, { recursive: true, force: true }));

test('config: defaults, capabilities and refusals', () => {
  assert.deepEqual(normalizeComputers(undefined), []);
  const [computer] = normalizeComputers([{ id: 'omarchy', transport: { type: 'ssh', host: 'omarchy' }, cua: {} }]);
  assert.equal(computer.cua.path, '~/.local/bin/cua-driver');
  assert.deepEqual(computer.capabilities, { exec: true, files: false, screenshot: true, input: false });
  const [bare] = normalizeComputers([{ id: 'bare', transport: { type: 'ssh', host: 'bare' }, capabilities: { input: true } }]);
  assert.equal(bare.capabilities.screenshot, false);
  assert.equal(bare.capabilities.input, false, 'input needs a Cua driver');
  for (const bad of [[{ transport: {} }], [{ id: 'a b', transport: {} }], [{ id: 'x' }], [{ id: 'x', transport: {} }, { id: 'x', transport: {} }], 'x']) {
    assert.throws(() => normalizeComputers(bad), (error) => error.code === 'invalid_config');
  }
});

test('plugin entry registers every tool and panel route through ctx.effect and disposes them', () => {
  const registered = [];
  const routes = new Map();
  const disposers = [];
  const ctx = {
    tools: { register: (tool) => { registered.push(tool.name); return () => registered.splice(registered.indexOf(tool.name), 1); } },
    connection: {
      fetch: {
        register: (route) => {
          assert.ok(!routes.has(route.path), `route ${route.path} registered twice`);
          routes.set(route.path, route);
          return () => routes.delete(route.path);
        },
      },
    },
    get: () => attachments,
    effect: (setup, label) => { assert.equal(typeof label, 'string'); disposers.push(setup()); },
  };
  assert.equal(plugin.name, 'dsh-remote-machine');
  assert.deepEqual(plugin.inject, ['connection', 'tools']);
  plugin.apply(ctx, { computers: [] });
  assert.deepEqual([...registered].sort(), [
    'computer_cua_call', 'computer_exec_cancel', 'computer_exec_start', 'computer_exec_status',
    'computer_file_read', 'computer_file_write', 'computer_list', 'computer_screenshot',
  ]);
  assert.deepEqual([...routes.keys()].sort(), ['capture', 'computers', 'screenshot', 'screenshots', 'status'].map((name) => `${ROUTE_PREFIX}/${name}`));
  for (const route of routes.values()) {
    assert.equal(route.requestBody, 'buffered');
    assert.equal(route.methods.length, 1);
    assert.equal(typeof route.fetch, 'function');
  }
  for (const dispose of disposers) dispose();
  assert.deepEqual(registered, []);
  assert.equal(routes.size, 0);
});

test('package manifest: DSH bundle patch and web client', () => {
  const root = new URL('../', import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.name, '@local/dsh-remote-machine');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh.client.platform, 'web');
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-sidebar-right']);
  assert.equal(pkg.exports['.'], './index.js');
  assert.equal(pkg.exports['./client'], './client.js');
  const patch = readFileSync(new URL('cordis.patch.yml', root), 'utf8');
  assert.match(patch, /^- insert:\n {4}- id: dsh-remote-machine\n {6}name: '@local\/dsh-remote-machine'\n$/);
  for (const file of pkg.files) assert.ok(existsSync(new URL(file, root)), `packaged file ${file} exists`);
  assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'no runtime npm dependencies');
});

test('computer_list probes each computer and reports the unreachable one as such', async () => {
  const { computers } = await run('computer_list', {});
  const [box, offline] = computers;
  assert.equal(box.reachable, true);
  assert.equal(box.cua.exists, true);
  assert.equal(box.capabilities.input, false);
  assert.equal(offline.reachable, false);
  assert.equal(offline.error.code, 'transport_error');
  assert.match(tools.get('computer_list').output.render({}, { computers })[0].text, /offline .*unreachable/);
  const quick = await run('computer_list', { probe: false });
  assert.equal(quick.computers[0].reachable, undefined);
});

test('every call needs an explicit, configured computer_id', async () => {
  await rejectsWith(run('computer_exec_start', { command: 'true' }), 'computer_id_required');
  await rejectsWith(run('computer_exec_start', { computer_id: 'nope', command: 'true' }), 'unknown_computer');
  await rejectsWith(run('computer_file_read', { computer_id: 'offline', path: '~/x' }), 'capability_unavailable');
  await rejectsWith(run('computer_screenshot', { computer_id: 'box' }, { agent: {} }), 'no_session');
});

test('screenshot: attachment for the model, frame metadata, kept in memory per session and computer', async () => {
  const tool = tools.get('computer_screenshot');
  const value = await run('computer_screenshot', { computer_id: 'box' });
  assert.equal(value.computer_id, 'box');
  assert.equal(value.capture_id, 'capture_fake_1');
  assert.deepEqual(value.image, { width: 4, height: 3, bytes: saved.at(-1).bytes.length });
  assert.deepEqual(value.screen, { width: 8, height: 6 });
  assert.equal(value.frame_scale, 2);
  assert.ok(!Number.isNaN(Date.parse(value.captured_at)));
  assert.equal(saved.at(-1).mediaType, 'image/png');
  assert.deepEqual(value.attachment, { attachmentId: `att-${saved.length}`, mediaType: 'image/png', bytes: saved.at(-1).bytes.length, width: 4, height: 3, name: 'box-capture_fake_1.png' });
  const blocks = tool.output.render({ computer_id: 'box' }, value);
  assert.deepEqual(blocks.at(-1), { type: 'image', attachment: value.attachment });
  assert.ok(!JSON.stringify(value).includes('png_b64'), 'no base64 image in the tool value');
  const kept = machine.screenshots('dsh-session-a', 'box');
  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].png, saved.at(-1).bytes);
  assert.deepEqual(machine.screenshots('dsh-session-b', 'box'), []);
  assert.deepEqual(readdirSync(join(home, '.local/state/dsh-computer/shots')), [], 'no image left on the computer');
});

test('exec: start, incremental status, ownership by DSH session, confirmed cancel', async () => {
  const job = await run('computer_exec_start', { computer_id: 'box', command: 'printf "a\\n"; sleep 0.5; printf "b\\n"; exit 5' });
  assert.match(job.job_id, /^j[0-9a-z]+-[0-9a-f]{12}$/);
  assert.equal(job.cwd, realpathSync(join(home, 'work')), 'defaults to the work root');
  let status = await run('computer_exec_status', { computer_id: 'box', job_id: job.job_id, wait_s: 0.3 });
  let out = status.stdout.text;
  for (let i = 0; i < 20 && status.state !== 'exited'; i += 1) {
    status = await run('computer_exec_status', { computer_id: 'box', job_id: job.job_id, stdout_cursor: status.stdout.cursor, wait_s: 1 });
    out += status.stdout.text;
  }
  assert.equal(out, 'a\nb\n');
  assert.equal(status.exit.exit_code, 5);
  assert.match(tools.get('computer_exec_status').output.render({}, status)[0].text, /exited \(exit 5\)/);
  await rejectsWith(run('computer_exec_status', { computer_id: 'box', job_id: job.job_id }, execB), 'job_not_owned');
  await rejectsWith(run('computer_exec_start', { computer_id: 'box', command: 'true', argv: ['true'] }), 'invalid_arguments');

  const long = await run('computer_exec_start', { computer_id: 'box', argv: ['sleep', '30'] });
  await rejectsWith(run('computer_exec_cancel', { computer_id: 'box', job_id: long.job_id }, execB), 'job_not_owned');
  const cancelled = await run('computer_exec_cancel', { computer_id: 'box', job_id: long.job_id });
  assert.equal(cancelled.cancel, 'confirmed');
  assert.equal(cancelled.process_group_alive, false);
});

test('cancel that cannot reach the computer is unknown, never success', async () => {
  const result = await run('computer_exec_cancel', { computer_id: 'offline', job_id: 'j-anything' });
  assert.equal(result.cancel, 'unknown');
  assert.equal(result.error.code, 'transport_error');
});

test('files: utf8 round trip with a Chinese name with spaces, binary as base64, roots enforced', async () => {
  const path = '~/work/报告 目录/第 1 份.txt';
  const content = '你好, remote\n';
  const written = await run('computer_file_write', { computer_id: 'box', path, content, mkdirs: true });
  assert.equal(written.created, true);
  assert.equal(readFileSync(join(home, 'work/报告 目录/第 1 份.txt'), 'utf8'), content);
  const read = await run('computer_file_read', { computer_id: 'box', path });
  assert.equal(read.encoding, 'utf8');
  assert.equal(read.content, content);
  assert.equal(read.sha256, written.sha256);
  await rejectsWith(run('computer_file_write', { computer_id: 'box', path, content: 'x' }), 'exists');
  const replaced = await run('computer_file_write', { computer_id: 'box', path, content: 'v2', overwrite: true, expected_sha256: read.sha256 });
  assert.equal(replaced.created, false);
  await rejectsWith(run('computer_file_write', { computer_id: 'box', path, content: 'v3', overwrite: true, expected_sha256: read.sha256 }), 'conflict');

  const binary = Buffer.from([0xff, 0xfe, 0, 1]);
  await run('computer_file_write', { computer_id: 'box', path: '~/work/b.bin', content: binary.toString('base64'), encoding: 'base64' });
  const back = await run('computer_file_read', { computer_id: 'box', path: '~/work/b.bin' });
  assert.equal(back.encoding, 'base64');
  assert.deepEqual(Buffer.from(back.content, 'base64'), binary);
  await rejectsWith(run('computer_file_read', { computer_id: 'box', path: '~/work/b.bin', encoding: 'utf8' }), 'not_utf8');
  await rejectsWith(run('computer_file_read', { computer_id: 'box', path: '~/ssh.log' }), 'path_outside_roots');
});

test('cua_call: whitelist, upstream schema, input capability, plugin-owned session', async () => {
  const listed = await run('computer_cua_call', { computer_id: 'box', tool: 'list_windows', arguments: { session: 'hijack' } });
  assert.match(listed.value.session, /^dsh-[0-9a-f]{16}$/, 'the model cannot choose the Cua session');
  await assert.rejects(run('computer_cua_call', { computer_id: 'box', tool: 'click', arguments: { x: 1, y: 1 } }),
    (error) => error.code === 'capability_unavailable' && /Hyprland input plugin is unavailable/.test(error.message));
  await rejectsWith(run('computer_cua_call', { computer_id: 'box', tool: 'kill_app', arguments: { pid: 1 } }), 'tool_not_allowed');
  await rejectsWith(run('computer_cua_call', { computer_id: 'box', tool: 'list_windows', arguments: { bogus: 1 } }), 'invalid_arguments');
  const shot = await run('computer_cua_call', { computer_id: 'box', tool: 'get_desktop_state', arguments: {} });
  assert.equal(shot.attachment.mediaType, 'image/png');
  await rejectsWith(run('computer_cua_call', { computer_id: 'offline', tool: 'list_windows' }), 'capability_unavailable');
});

test('panel routes: computers, status, refresh capture, screenshots by session and computer', async () => {
  const handlers = new Map(remoteMachineRoutes(machine).map((route) => [`${route.method} ${route.path}`, route.fetch]));
  const fetchRoute = async (method, path, { query = {}, body } = {}) => {
    const url = new URL(`http://dsh.test${ROUTE_PREFIX}/${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const request = new Request(url, { method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    return handlers.get(`${method} ${ROUTE_PREFIX}/${path}`)(request);
  };
  const jsonOf = async (response, status = 200) => {
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };

  const { computers } = await jsonOf(await fetchRoute('GET', 'computers'));
  assert.deepEqual(computers.map((c) => c.id), ['box', 'offline']);
  assert.equal(computers[0].input_unavailable_reason, 'production Hyprland input plugin is unavailable');
  assert.ok(!JSON.stringify(computers).includes('"host"'), 'transport details stay on the host');

  const ready = await jsonOf(await fetchRoute('GET', 'status', { query: { computer: 'box' } }));
  assert.equal(ready.reachable, true);
  assert.equal(ready.computer_id, 'box');
  const down = await jsonOf(await fetchRoute('GET', 'status', { query: { computer: 'offline' } }));
  assert.equal(down.reachable, false);
  assert.equal(down.error.code, 'transport_error');
  assert.equal((await jsonOf(await fetchRoute('GET', 'status', { query: { computer: 'nope' } }), 404)).error.code, 'unknown_computer');

  const before = machine.screenshots('dsh-session-a', 'box').length;
  const shot = await jsonOf(await fetchRoute('POST', 'capture', { body: { session: 'dsh-session-a', computer_id: 'box' } }));
  assert.equal(shot.computer_id, 'box');
  assert.notEqual(shot.capture_id, 'capture_fake_1', 'a new capture, not the earlier one');
  assert.equal(shot.frame_scale, 2);
  assert.equal(shot.attachment, undefined, 'a panel refresh is not sent to the model');
  assert.equal(machine.screenshots('dsh-session-a', 'box').length, before + 1);

  const listed = await jsonOf(await fetchRoute('GET', 'screenshots', { query: { session: 'dsh-session-a', computer: 'box' } }));
  assert.equal(listed.screenshots.at(-1).capture_id, shot.capture_id);
  assert.ok(listed.screenshots.every((item) => item.png === undefined && item.computer_id === 'box'));
  const other = await jsonOf(await fetchRoute('GET', 'screenshots', { query: { session: 'dsh-session-b', computer: 'box' } }));
  assert.deepEqual(other.screenshots, [], 'screenshots stay with their DSH session');

  const image = await fetchRoute('GET', 'screenshot', { query: { session: 'dsh-session-a', computer: 'box', capture: shot.capture_id } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('cache-control'), 'private, no-store');
  const bytes = Buffer.from(await image.arrayBuffer());
  assert.equal(bytes.readUInt32BE(16), 4);
  assert.equal(bytes.length, shot.image.bytes);
  await jsonOf(await fetchRoute('GET', 'screenshot', { query: { session: 'dsh-session-b', computer: 'box', capture: shot.capture_id } }), 404);

  assert.equal((await jsonOf(await fetchRoute('POST', 'capture', { body: { session: 'dsh-session-a', computer_id: 'offline' } }), 409)).error.code, 'capability_unavailable');
  await jsonOf(await fetchRoute('POST', 'capture', { body: 'not json' }), 400);
  await jsonOf(await fetchRoute('POST', 'capture', { body: { computer_id: 'box' } }), 400);
  await jsonOf(await fetchRoute('GET', 'screenshots', { query: { computer: 'box' } }), 400);
  const wrongMethod = await handlers.get(`GET ${ROUTE_PREFIX}/computers`)(new Request(`http://dsh.test${ROUTE_PREFIX}/computers`, { method: 'DELETE' }));
  assert.equal(wrongMethod.status, 405);
});

test('dispose ends the Cua sessions the plugin opened', async () => {
  await machine.dispose();
  const ended = readFileSync(join(home, 'cua.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    .filter((args) => args[0] === 'call' && args[1] === 'end_session').map((args) => JSON.parse(args[2]).session);
  assert.equal(ended.length, 1);
  assert.match(ended[0], /^dsh-[0-9a-f]{16}$/);
  assert.deepEqual(machine.screenshots('dsh-session-a', 'box'), []);
});
