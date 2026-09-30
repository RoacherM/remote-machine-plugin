// Browser half of @local/dsh-remote-machine, hand-written (no build step): a right-sidebar tab showing one
// computer at a time with its status and the screenshots taken in this DSH session, and a chat card for
// computer_screenshot. Screenshots come from the plugin's authenticated /api/remote-machine/* routes,
// which serve them from host memory only.
window.__ModuleLoader__.load({
  id: '@local/dsh-remote-machine',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const PKG = '@local/dsh-remote-machine';
    const NS = 'local-remote-machine';
    const KIND = 'remote-machine';
    const POLL_MS = 3000;

    const zh = {
      'type.label': '远程电脑',
      'guide.title': '远程电脑',
      'guide.description': '查看已配置电脑的状态与本会话的截图',
      'computer': '电脑',
      'none': '还没有配置电脑：在 profile 的 dsh-remote-machine 配置里添加 computers。',
      'loading': '加载中…',
      'loadFailed': '加载失败：{error}',
      'status.checking': '正在连接…',
      'status.ready': '可连接',
      'status.offline': '无法连接：{error}',
      'status.check': '重新检测',
      'capabilities': '能力',
      'cap.exec': '命令', 'cap.files': '文件', 'cap.screenshot': '截图', 'cap.input': '桌面输入',
      'inputUnavailable': '桌面输入不可用：{reason}',
      'refresh': '截图',
      'refreshing': '截图中…',
      'refreshFailed': '截图失败：{error}',
      'noScreenshot': '本会话还没有这台电脑的截图。点击“截图”或让 Agent 调用 computer_screenshot。',
      'noScreenshotCapability': '这台电脑没有配置截图能力（需要 cua 配置）。',
      'notLive': '静态截图，非实时画面',
      'caption': '{computer} · {time} · 捕获 {capture}',
      'size': '图像 {iw}×{ih}，屏幕 {sw}×{sh}，frame_scale {scale}',
      'older': '较早的截图',
      'noSession': '打开一个会话后再查看远程电脑。',
      'tool.open': '在面板中查看',
      'tool.shot': '{computer} 的截图 · {time}',
    };
    const en = {
      'type.label': 'Remote computer',
      'guide.title': 'Remote computer',
      'guide.description': 'Status and this session\'s screenshots of a configured computer',
      'computer': 'Computer',
      'none': 'No computers are configured: add computers to the dsh-remote-machine config in your profile.',
      'loading': 'Loading…',
      'loadFailed': 'Could not load: {error}',
      'status.checking': 'Connecting…',
      'status.ready': 'Reachable',
      'status.offline': 'Unreachable: {error}',
      'status.check': 'Check again',
      'capabilities': 'Capabilities',
      'cap.exec': 'commands', 'cap.files': 'files', 'cap.screenshot': 'screenshots', 'cap.input': 'desktop input',
      'inputUnavailable': 'Desktop input unavailable: {reason}',
      'refresh': 'Screenshot',
      'refreshing': 'Capturing…',
      'refreshFailed': 'Screenshot failed: {error}',
      'noScreenshot': 'No screenshot of this computer in this session yet. Click Screenshot or let the agent call computer_screenshot.',
      'noScreenshotCapability': 'This computer has no screenshot capability (it needs a cua section).',
      'notLive': 'Still screenshot, not a live view',
      'caption': '{computer} · {time} · capture {capture}',
      'size': 'image {iw}×{ih}, screen {sw}×{sh}, frame_scale {scale}',
      'older': 'Earlier screenshots',
      'noSession': 'Open a session to see remote computers.',
      'tool.open': 'Show in panel',
      'tool.shot': 'Screenshot of {computer} · {time}',
    };

    const format = (text, params) => (params ? String(text).replace(/\{(\w+)\}/g, (m, key) => (params[key] === undefined ? m : String(params[key]))) : text);

    // ── Host routes (document-relative, so they work on Web and on the Desktop dsh-app:// origin) ──

    const endpoint = (path, query = {}) => {
      const url = new URL('api/remote-machine/' + path, document.baseURI);
      for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value);
      return url;
    };
    async function request(method, path, { query, body, signal } = {}) {
      const init = { method, credentials: 'same-origin', signal, headers: {} };
      if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
      const response = await fetch(endpoint(path, query), init);
      let json;
      try { json = await response.json(); } catch { json = undefined; }
      if (!response.ok) throw new Error(json?.error?.message ?? `HTTP ${response.status}`);
      return json;
    }
    const api = {
      computers: (signal) => request('GET', 'computers', { signal }),
      status: (computer, signal) => request('GET', 'status', { query: { computer }, signal }),
      screenshots: (session, computer, signal) => request('GET', 'screenshots', { query: { session, computer }, signal }),
      capture: (session, computer) => request('POST', 'capture', { body: { session, computer_id: computer } }),
      imageUrl: (session, computer, capture) => endpoint('screenshot', { session, computer, capture }).href,
    };

    // The computer a chat card asked the panel to show, per session (in case the tab ignores open params).
    const requested = { bySession: new Map(), listeners: new Set() };
    function requestComputer(sessionId, computerId) {
      requested.bySession.set(sessionId, computerId);
      requested.listeners.forEach((listener) => listener());
    }

    const css = `
      .dshrm { display:flex; flex-direction:column; gap:12px; height:100%; padding:14px; overflow:auto; box-sizing:border-box; color:var(--dsw-alias-label-primary); font-size:13px; }
      .dshrm-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
      .dshrm select, .dshrm-btn { padding:5px 10px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-1); color:inherit; font:inherit; }
      .dshrm-btn { cursor:pointer; white-space:nowrap; }
      .dshrm-btn:hover:not(:disabled) { background:var(--dsw-alias-interactive-bg-hover); }
      .dshrm-btn:disabled { opacity:.5; cursor:not-allowed; }
      .dshrm-muted { color:var(--dsw-alias-label-tertiary); }
      .dshrm-error { color:var(--dsw-alias-state-error-primary); }
      .dshrm-dot { width:8px; height:8px; border-radius:50%; background:var(--dsw-alias-label-tertiary); flex:none; }
      .dshrm-dot.ok { background:#2e9d5b; } .dshrm-dot.bad { background:var(--dsw-alias-state-error-primary); }
      .dshrm-shot { display:flex; flex-direction:column; gap:6px; }
      .dshrm-shot img { width:100%; height:auto; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:#000; }
      .dshrm-thumbs { display:flex; gap:6px; flex-wrap:wrap; }
      .dshrm-thumbs button { padding:0; border:2px solid transparent; border-radius:6px; background:none; cursor:pointer; }
      .dshrm-thumbs button[aria-pressed="true"] { border-color:var(--dsw-alias-brand-primary); }
      .dshrm-thumbs img { display:block; width:88px; height:auto; border-radius:4px; }
      .dshrm-card { display:flex; flex-direction:column; gap:6px; padding:4px 0; color:var(--dsw-alias-label-secondary); font-size:13px; }
      .dshrm-card b { color:var(--dsw-alias-label-primary); font-weight:500; }
      .dshrm-card img { max-width:240px; height:auto; border:1px solid var(--dsw-alias-border-l2); border-radius:6px; }
    `;

    function useT(props, bound) {
      const t = typeof props.t === 'function' ? props.t : bound;
      return (key, params) => format(t(key), params);
    }

    const localTime = (iso) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(); };

    function ComputerStatus({ t, computer, status, onCheck }) {
      const caps = Object.entries(computer.capabilities).filter(([, on]) => on).map(([key]) => t('cap.' + key));
      const state = !status || status.loading ? 'checking' : status.reachable ? 'ready' : 'offline';
      return h('div', { className: 'dshrm-status' },
        h('div', { className: 'dshrm-row' },
          h('span', { className: 'dshrm-dot' + (state === 'ready' ? ' ok' : state === 'offline' ? ' bad' : '') }),
          h('span', { className: state === 'offline' ? 'dshrm-error' : undefined },
            state === 'checking' ? t('status.checking') : state === 'ready' ? t('status.ready') : t('status.offline', { error: status.error?.message ?? '?' })),
          status?.checked_at ? h('span', { className: 'dshrm-muted' }, localTime(status.checked_at)) : null,
          h('button', { type: 'button', className: 'dshrm-btn', onClick: onCheck, disabled: state === 'checking' }, t('status.check'))),
        h('div', { className: 'dshrm-muted' }, t('capabilities') + ': ' + (caps.join(', ') || '—')),
        computer.input_unavailable_reason ? h('div', { className: 'dshrm-muted' }, t('inputUnavailable', { reason: computer.input_unavailable_reason })) : null);
    }

    function RemoteMachineTab(props, bound) {
      const t = useT(props, bound);
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : undefined;
      const tab = info?.tab;
      const visible = tab?.visible !== false;
      const sessionId = props.sessionId;
      const [computers, setComputers] = React.useState({ list: null, error: null });
      const [selected, setSelected] = React.useState(tab?.params?.computer_id ?? (sessionId === undefined ? undefined : requested.bySession.get(sessionId)));
      const [status, setStatus] = React.useState(null);
      const [shots, setShots] = React.useState({ computer: null, list: [] });
      const [chosen, setChosen] = React.useState(null);
      const [capture, setCapture] = React.useState({ busy: false, error: null });
      const current = React.useRef(undefined);

      React.useEffect(() => {
        const controller = new AbortController();
        api.computers(controller.signal).then(
          (result) => setComputers({ list: result.computers, error: null }),
          (error) => { if (!controller.signal.aborted) setComputers({ list: [], error: error.message }); },
        );
        return () => controller.abort();
      }, []);

      // Follow chat cards that point this session's panel at a computer.
      React.useEffect(() => {
        if (sessionId === undefined) return undefined;
        const follow = () => { const id = requested.bySession.get(sessionId); if (id) setSelected(id); };
        requested.listeners.add(follow);
        return () => { requested.listeners.delete(follow); };
      }, [sessionId]);
      React.useEffect(() => { if (tab?.params?.computer_id) setSelected(tab.params.computer_id); }, [tab?.params?.computer_id]);

      const list = computers.list ?? [];
      const computer = list.find((item) => item.id === selected) ?? (selected === undefined ? list[0] : undefined);
      const computerId = computer?.id;
      // Replies for a computer that is no longer shown are dropped.
      current.current = computerId;

      const check = React.useCallback((signal) => {
        if (!computerId) return;
        setStatus({ loading: true });
        api.status(computerId, signal).then(
          (result) => { if (current.current === computerId) setStatus(result); },
          (error) => { if (!signal?.aborted && current.current === computerId) setStatus({ reachable: false, error: { message: error.message } }); },
        );
      }, [computerId]);

      // Switching computers drops the previous computer's picture and status at once, so they cannot be mistaken.
      React.useEffect(() => {
        setShots({ computer: computerId ?? null, list: [] });
        setChosen(null);
        setStatus(null);
        setCapture({ busy: false, error: null });
        if (!computerId) return undefined;
        const controller = new AbortController();
        check(controller.signal);
        return () => controller.abort();
      }, [computerId, check]);

      const loadShots = React.useCallback((signal) => {
        if (!computerId || sessionId === undefined) return Promise.resolve();
        return api.screenshots(sessionId, computerId, signal).then((result) => {
          if (result.computer_id !== computerId) return;
          setShots((prev) => (prev.computer === computerId && prev.list.map((s) => s.capture_id).join() === result.screenshots.map((s) => s.capture_id).join()
            ? prev : { computer: computerId, list: result.screenshots }));
        }, () => {});
      }, [computerId, sessionId]);

      React.useEffect(() => {
        if (!visible || !computerId || sessionId === undefined) return undefined;
        const controller = new AbortController();
        loadShots(controller.signal);
        const timer = setInterval(() => loadShots(controller.signal), POLL_MS);
        return () => { clearInterval(timer); controller.abort(); };
      }, [visible, computerId, sessionId, loadShots]);

      if (sessionId === undefined) return h('div', { className: 'dshrm dshrm-muted' }, t('noSession'));
      if (computers.list === null) return h('div', { className: 'dshrm dshrm-muted' }, t('loading'));
      if (computers.error) return h('div', { className: 'dshrm dshrm-error' }, t('loadFailed', { error: computers.error }));
      if (list.length === 0) return h('div', { className: 'dshrm dshrm-muted' }, t('none'));

      const shotList = shots.computer === computerId ? shots.list : [];
      const shot = shotList.find((item) => item.capture_id === chosen) ?? shotList[shotList.length - 1];
      const takeShot = () => {
        const id = computerId;
        setCapture({ busy: true, error: null });
        api.capture(sessionId, id).then(
          (value) => { if (current.current === id) { setCapture({ busy: false, error: null }); setChosen(value.capture_id); loadShots(); } },
          (error) => { if (current.current === id) setCapture({ busy: false, error: error.message }); },
        );
      };

      return h('div', { className: 'dshrm' },
        h('div', { className: 'dshrm-row' },
          h('label', { htmlFor: 'dshrm-computer' }, t('computer')),
          h('select', {
            id: 'dshrm-computer', value: computerId ?? '',
            onChange: (event) => setSelected(event.target.value),
          },
          computer ? null : h('option', { value: '' }, selected ?? '—'),
          ...list.map((item) => h('option', { key: item.id, value: item.id }, item.name === item.id ? item.id : `${item.name} (${item.id})`))),
          computer && computer.capabilities.screenshot
            ? h('button', { type: 'button', className: 'dshrm-btn', disabled: capture.busy, onClick: takeShot }, capture.busy ? t('refreshing') : t('refresh'))
            : null),
        computer ? h(ComputerStatus, { t, computer, status, onCheck: () => check() }) : h('div', { className: 'dshrm-error' }, t('loadFailed', { error: selected })),
        capture.error ? h('div', { className: 'dshrm-error' }, t('refreshFailed', { error: capture.error })) : null,
        !computer ? null
          : !computer.capabilities.screenshot ? h('div', { className: 'dshrm-muted' }, t('noScreenshotCapability'))
            : !shot ? h('div', { className: 'dshrm-muted' }, t('noScreenshot'))
              : h('div', { className: 'dshrm-shot' },
                h('div', { className: 'dshrm-muted' }, t('notLive')),
                h('div', null, t('caption', { computer: shot.computer_id, time: localTime(shot.captured_at), capture: shot.capture_id })),
                h('img', { src: api.imageUrl(sessionId, shot.computer_id, shot.capture_id), alt: t('caption', { computer: shot.computer_id, time: shot.captured_at, capture: shot.capture_id }) }),
                h('div', { className: 'dshrm-muted' }, t('size', { iw: shot.image?.width, ih: shot.image?.height, sw: shot.screen?.width, sh: shot.screen?.height, scale: shot.frame_scale })),
                shotList.length > 1 ? h('div', { className: 'dshrm-muted' }, t('older')) : null,
                shotList.length > 1 ? h('div', { className: 'dshrm-thumbs' }, ...shotList.slice().reverse().map((item) => h('button', {
                  key: item.capture_id, type: 'button', 'aria-pressed': item.capture_id === shot.capture_id ? 'true' : 'false',
                  title: localTime(item.captured_at), onClick: () => setChosen(item.capture_id),
                }, h('img', { src: api.imageUrl(sessionId, item.computer_id, item.capture_id), alt: localTime(item.captured_at) })))) : null));
    }

    // Parses the text block rendered by computer_screenshot (see src/host/tools.js).
    function screenshotOf(block) {
      for (const part of Array.isArray(block?.content) ? block.content : []) {
        const match = part?.type === 'text' && /^Screenshot of (\S+) \(capture (\S+)\) at (\S+):/.exec(part.text);
        if (match) return { computer: match[1], capture: match[2], time: match[3] };
      }
      return undefined;
    }

    function ScreenshotToolCard(props, bound, ctx) {
      const t = useT(props, bound);
      const [imageFailed, setImageFailed] = React.useState(false);
      const result = props.phase === 'result' ? props.block ?? {} : undefined;
      if (!result) return h('div', { className: 'dshrm-card' }, h('span', null, h('b', null, props.toolName), ' …'));
      const firstText = (result.content ?? []).find((part) => part?.type === 'text')?.text ?? '';
      if (result.isError === true) return h('div', { className: 'dshrm-card' }, h('span', null, h('b', null, props.toolName), ' ', h('span', { className: 'dshrm-error' }, firstText.split('\n')[0].slice(0, 200))));
      const shot = screenshotOf(result);
      if (!shot) return h('div', { className: 'dshrm-card' }, h('span', null, h('b', null, props.toolName), ' ', firstText.split('\n')[0].slice(0, 200)));
      const open = () => {
        if (props.sessionId !== undefined) requestComputer(props.sessionId, shot.computer);
        if (typeof ctx.sidebarRight?.openTab === 'function') ctx.sidebarRight.openTab(KIND, { params: { computer_id: shot.computer } });
      };
      return h('div', { className: 'dshrm-card' },
        h('div', { className: 'dshrm-row' },
          h('b', null, props.toolName),
          h('span', null, t('tool.shot', { computer: shot.computer, time: localTime(shot.time) })),
          h('button', { type: 'button', className: 'dshrm-btn', onClick: open }, t('tool.open'))),
        props.sessionId !== undefined && !imageFailed
          ? h('img', { src: api.imageUrl(props.sessionId, shot.computer, shot.capture), alt: firstText.split('\n')[0], onError: () => setImageFailed(true) })
          : null);
    }

    const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'remote-machine: dictionaries');
      const bound = ctx.locale.bind(NS);

      ctx.effect(() => {
        const tag = document.createElement('style');
        tag.dataset.plugin = PKG;
        tag.textContent = css;
        document.head.appendChild(tag);
        return () => tag.remove();
      }, 'remote-machine: styles');

      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: PKG, kind: KIND, priority: 'extension',
        title: () => bound('type.label'),
        guide: [{ id: 'open', order: 45, title: () => bound('guide.title'), description: () => bound('guide.description') }],
      }), 'remote-machine: tab type');

      const Tab = (props) => RemoteMachineTab(props, bound);
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
        name: 'sidebar.right.pane.tab', key: PKG, locale: NS,
      }, Tab)), 'remote-machine: tab body');

      const Card = (props) => ScreenshotToolCard(props, bound, ctx);
      ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview', key: 'computer_screenshot', locale: NS,
      }, Card)), 'remote-machine: tool card computer_screenshot');
    }

    return { inject, apply };
  },
});
