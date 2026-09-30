// Offline: client.js loaded the way DSH loads it (window.__ModuleLoader__), with a minimal React stand-in
// (createElement + hooks) and `fetch` wired to the real /api/remote-machine routes over a fake ssh.
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import vm from 'node:vm';
import { normalizeComputers } from '../src/host/config.js';
import { remoteMachineRoutes } from '../src/host/routes.js';
import { createRemoteMachine } from '../src/host/tools.js';
import { createTransport } from '../src/host/transport.js';

const FAKE_SSH = new URL('./fixtures/fake-ssh.mjs', import.meta.url).pathname;
const FAKE_CUA = new URL('./fixtures/fake-cua-driver.py', import.meta.url).pathname;
const SESSION = 'dsh-session-panel';
let home;
let machine;

// Just enough of React for function components: state, refs, callbacks and effects, re-rendered by hand.
function createReact() {
  const slots = [];
  let index = 0;
  let dirty = false;
  const pending = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState(initial) {
      const i = index++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], (next) => {
        const value = typeof next === 'function' ? next(slots[i]) : next;
        if (!Object.is(value, slots[i])) { slots[i] = value; dirty = true; }
      }];
    },
    useRef(initial) {
      const i = index++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useMemo(make, deps) {
      const i = index++;
      if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { deps, value: make() };
      return slots[i].value;
    },
    useCallback: (fn, deps) => React.useMemo(() => fn, deps),
    useEffect(effect, deps) {
      const i = index++;
      const previous = slots[i];
      if (previous && deps && same(previous.deps, deps)) return;
      const record = { deps, cleanup: undefined };
      slots[i] = record;
      pending.push(() => { previous?.cleanup?.(); record.cleanup = effect(); });
    },
  };
  return {
    React,
    // Renders `component` until its state settles or `until(tree)` holds; returns the last tree.
    async render(component, props, until = () => false, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        index = 0;
        dirty = false;
        const tree = component(props);
        for (const run of pending.splice(0)) run();
        if (until(tree)) return tree;
        if (Date.now() > deadline) assert.fail(`render did not settle: ${textOf(tree)}`);
        await new Promise((resolve) => setTimeout(resolve, dirty ? 0 : 20));
      }
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}

// Text of a rendered tree, expanding hook-free function components such as ComputerStatus.
function expand(node) {
  if (node == null || typeof node === 'boolean') return null;
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }));
  return { ...node, children: node.children.map(expand) };
}
function textOf(node) {
  if (node == null) return '';
  if (typeof node !== 'object') return String(node);
  return node.children.map(textOf).join(' ');
}
function findAll(node, match, out = []) {
  if (node && typeof node === 'object') {
    if (match(node)) out.push(node);
    for (const child of node.children) findAll(child, match, out);
  }
  return out;
}

function loadClient(react, fetchImpl) {
  let loaded;
  const style = [];
  const context = {
    window: { __ModuleLoader__: { load: ({ id, factory }) => { loaded = { id, exports: factory((name) => { assert.equal(name, 'react'); return react; }) }; } } },
    document: {
      baseURI: 'http://dsh.test/',
      head: { appendChild: (tag) => style.push(tag) },
      createElement: () => ({ dataset: {}, remove() { style.splice(style.indexOf(this), 1); } }),
    },
    fetch: fetchImpl, URL, AbortController, setInterval, clearInterval, setTimeout, clearTimeout, Promise, Error, JSON, Object, Array, String, Number, Date, Map, Set,
  };
  vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), context, { filename: 'client.js' });
  return { ...loaded, style };
}

function fakeCtx() {
  const registrations = { tabs: [], slots: [], locale: new Map(), opened: [] };
  const disposers = [];
  const ctx = {
    effect: (setup, label) => { assert.equal(typeof label, 'string'); disposers.push(setup()); },
    locale: {
      register: (ns, dicts) => { registrations.locale.set(ns, dicts); return () => registrations.locale.delete(ns); },
      bind: (ns) => (key) => registrations.locale.get(ns)?.zh?.[key] ?? key,
    },
    sidebarRightTabs: { register: (definition) => { registrations.tabs.push(definition); return () => registrations.tabs.splice(registrations.tabs.indexOf(definition), 1); } },
    sidebarRight: { openTab: (kind, options) => registrations.opened.push({ kind, options }) },
    slots: {
      inject: (name, make) => make(),
      register: (meta, component) => { const entry = { meta, component }; registrations.slots.push(entry); return () => registrations.slots.splice(registrations.slots.indexOf(entry), 1); },
    },
  };
  return { ctx, registrations, dispose: () => disposers.forEach((dispose) => dispose()) };
}

function routeFetch() {
  const routes = new Map(remoteMachineRoutes(machine).map((route) => [`${route.method} ${route.path}`, route.fetch]));
  return async (url, init = {}) => {
    const request = new Request(url, init);
    const { pathname } = new URL(request.url);
    const handler = routes.get(`${request.method} ${pathname}`);
    return handler ? handler(request) : new Response('{}', { status: 404 });
  };
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-remote-client-'));
  mkdirSync(join(home, 'bin'));
  copyFileSync(FAKE_CUA, join(home, 'bin/cua-driver'));
  chmodSync(join(home, 'bin/cua-driver'), 0o755);
  process.env.FAKE_SSH_HOME = home;
  process.env.FAKE_SSH_LOG = join(home, 'ssh.log');
  machine = createRemoteMachine({
    computers: normalizeComputers([
      {
        id: 'box', name: 'Test box', transport: { type: 'ssh', host: 'fake' }, cua: { path: '~/bin/cua-driver' },
        capabilities: { inputUnavailableReason: 'production Hyprland input plugin is unavailable' },
      },
      { id: 'offline', transport: { type: 'ssh', host: 'down' } },
    ]),
    transport: createTransport({ sshCommand: [process.execPath, FAKE_SSH] }),
    attachments: () => ({ saveImage: async ({ data, mediaType }) => ({ attachmentId: 'att', mediaType, bytes: data.length, width: 4, height: 3 }) }),
  });
});

after(async () => {
  await machine.dispose();
  rmSync(home, { recursive: true, force: true });
});

test('client registers tab type, tab body, screenshot card and styles through ctx.effect', () => {
  const { React } = createReact();
  const client = loadClient(React, routeFetch());
  assert.equal(client.id, '@local/dsh-remote-machine');
  assert.deepEqual([...client.exports.inject], ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']);
  const { ctx, registrations, dispose } = fakeCtx();
  client.exports.apply(ctx);
  assert.equal(registrations.tabs.length, 1);
  assert.equal(registrations.tabs[0].id, '@local/dsh-remote-machine');
  assert.equal(registrations.tabs[0].priority, 'extension');
  assert.equal(registrations.tabs[0].title(), '远程电脑');
  assert.deepEqual(registrations.slots.map((slot) => [slot.meta.name, slot.meta.key]), [
    ['sidebar.right.pane.tab', '@local/dsh-remote-machine'], ['tool.call.toolview', 'computer_screenshot'],
  ]);
  const dicts = registrations.locale.get('local-remote-machine');
  assert.deepEqual(Object.keys(dicts.zh).sort(), Object.keys(dicts.en).sort(), 'zh and en have the same keys');
  assert.equal(client.style.length, 1);
  dispose();
  assert.equal(registrations.tabs.length + registrations.slots.length + registrations.locale.size + client.style.length, 0);
});

test('panel: status, refresh screenshot with time and frame data, switching computers clears the picture', async () => {
  const runtime = createReact();
  const client = loadClient(runtime.React, routeFetch());
  const { ctx, registrations, dispose } = fakeCtx();
  client.exports.apply(ctx);
  const Tab = registrations.slots.find((slot) => slot.meta.name === 'sidebar.right.pane.tab').component;
  const props = { sessionId: SESSION, useTabInfo: () => ({ tab: { visible: true } }) };
  const view = (tree) => expand(tree);

  let tree = view(await runtime.render(Tab, props, (t) => /可连接/.test(textOf(expand(t)))));
  assert.match(textOf(tree), /本会话还没有这台电脑的截图/);
  assert.match(textOf(tree), /桌面输入不可用：production Hyprland input plugin is unavailable/);

  const [refresh] = findAll(tree, (node) => node.type === 'button' && textOf(node).trim() === '截图');
  refresh.props.onClick();
  tree = view(await runtime.render(Tab, props, (t) => findAll(expand(t), (node) => node.type === 'img').length > 0));
  const [img] = findAll(tree, (node) => node.type === 'img');
  const src = new URL(img.props.src);
  assert.equal(src.pathname, '/api/remote-machine/screenshot');
  assert.equal(src.searchParams.get('session'), SESSION);
  assert.equal(src.searchParams.get('computer'), 'box');
  assert.match(textOf(tree), /静态截图，非实时画面/);
  assert.match(textOf(tree), /box · .* · 捕获 capture_fake_\d+/);
  assert.match(textOf(tree), /图像 4×3，屏幕 8×6，frame_scale 2/);
  const image = await (await routeFetch()(src.href)).arrayBuffer();
  assert.equal(Buffer.from(image).subarray(1, 4).toString('ascii'), 'PNG');

  const [select] = findAll(tree, (node) => node.type === 'select');
  select.props.onChange({ target: { value: 'offline' } });
  tree = view(await runtime.render(Tab, props, () => true));
  assert.equal(findAll(tree, (node) => node.type === 'img').length, 0, 'the previous computer\'s picture is gone at once');
  tree = view(await runtime.render(Tab, props, (t) => /无法连接/.test(textOf(expand(t)))));
  assert.match(textOf(tree), /无法连接：transport_error: computer offline: ssh down failed/);
  assert.match(textOf(tree), /没有配置截图能力/);
  assert.equal(findAll(tree, (node) => node.type === 'button' && textOf(node).trim() === '截图').length, 0);

  runtime.unmount();
  dispose();
});

test('screenshot tool card: summary, thumbnail from the panel store, opens the panel on that computer', async () => {
  const runtime = createReact();
  const client = loadClient(runtime.React, routeFetch());
  const { ctx, registrations, dispose } = fakeCtx();
  client.exports.apply(ctx);
  const Card = registrations.slots.find((slot) => slot.meta.key === 'computer_screenshot').component;
  const tool = machine.tools.find((item) => item.name === 'computer_screenshot');
  const value = await tool.execute({ computer_id: 'box' }, { agent: { id: SESSION } });
  const block = { content: tool.output.render({ computer_id: 'box' }, value) };

  const tree = expand(await runtime.render(Card, { phase: 'result', block, toolName: 'computer_screenshot', sessionId: SESSION }, () => true));
  assert.match(textOf(tree), /box 的截图/);
  const [img] = findAll(tree, (node) => node.type === 'img');
  assert.equal(new URL(img.props.src).searchParams.get('capture'), value.capture_id);
  const [open] = findAll(tree, (node) => node.type === 'button');
  open.props.onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(registrations.opened)), [{ kind: 'remote-machine', options: { params: { computer_id: 'box' } } }]);

  const failed = expand(await runtime.render(Card, {
    phase: 'result', toolName: 'computer_screenshot', sessionId: SESSION,
    block: { isError: true, content: [{ type: 'text', text: 'capability_unavailable: computer offline cannot take screenshots' }] },
  }, () => true));
  assert.match(textOf(failed), /capability_unavailable/);
  runtime.unmount();
  dispose();
});
