// The `computer_*` tools. Every call names an explicit computer_id; a failing computer is reported as
// failing, never replaced by another one. Jobs and Cua sessions belong to the DSH session the host
// injects (`exec.agent.id`), never to an id supplied by the model. Screenshots are kept in memory per
// DSH session and computer, and reach the model as attachments.

import { createHash, randomBytes } from 'node:crypto';
import { RemoteError } from './transport.js';

const SHOTS_PER_KEY = 5;
const MAX_WRITE_BYTES = 4 * 1024 * 1024;
const DEFAULT_READ_BYTES = 256 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_IMAGE_DIMENSION = 1568;
const PROBE_TIMEOUT_MS = 25_000;

// Cua tools the model may call through computer_cua_call. Observation tools read state only; input tools
// drive the desktop and need `capabilities.input: true`. Session lifecycle, clipboard, browser, config,
// recording, update and kill tools are deliberately absent.
export const CUA_OBSERVE_TOOLS = Object.freeze([
  'get_desktop_state', 'get_screen_size', 'get_cursor_position', 'list_windows', 'list_apps',
  'get_window_state', 'get_accessibility_tree', 'zoom', 'verify_state',
]);
export const CUA_INPUT_TOOLS = Object.freeze([
  'click', 'double_click', 'right_click', 'drag', 'scroll', 'type_text', 'press_key', 'hotkey',
  'move_cursor', 'set_value', 'launch_app', 'bring_to_front', 'set_window_frame', 'invoke_menu',
]);

export class ToolError extends Error {
  constructor(code, message, details = {}) {
    super(`${code}: ${message}`);
    this.name = 'ToolError';
    this.code = code;
    Object.assign(this, details);
  }
}

// Transport and agent failures, rephrased so the model sees which computer failed and whether the
// request may have taken effect.
function remoteFailure(computer, error) {
  if (error instanceof ToolError) return error;
  if (!(error instanceof RemoteError)) return error;
  const hint = error.remote
    ? ''
    : error.uncertain
      ? ' (the request may have reached the computer; check its effect before retrying)'
      : ' (the request did not take effect)';
  return new ToolError(error.code, `computer ${computer.id}: ${error.message}${hint}`, {
    computer_id: computer.id, uncertain: Boolean(error.uncertain), ...(error.job_id ? { job_id: error.job_id } : {}),
  });
}

function sessionOf(exec) {
  const id = exec?.agent?.id;
  if (typeof id !== 'string' || !id) throw new ToolError('no_session', 'this tool needs a DSH session');
  return id;
}

function newJobId() {
  return `j${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

function imageMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes.subarray(1, 4).toString('ascii') === 'PNG') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

function decodeText(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const text = (value) => ({ type: 'text', text: value });
const imageBlock = (attachment) => (attachment ? [{ type: 'image', attachment }] : []);

const computerIdParam = { type: 'string', description: 'Target computer id from computer_list. Required on every call; there is no default computer.' };

/**
 * Builds the tool definitions for `ctx.tools.register`.
 * - `computers`: normalized by `normalizeComputers`.
 * - `transport`: `createTransport()` (tests pass one wired to a fake ssh).
 * - `attachments`: returns the host attachments service (`saveImage`), looked up per call.
 */
export function createRemoteMachine({ computers, transport, attachments }) {
  const byId = new Map(computers.map((computer) => [computer.id, computer]));
  // `${session}\0${computer}` → newest-last screenshots; memory only, never written to disk here.
  const shots = new Map();
  // computer id → Cua session names this plugin created there, ended on dispose.
  const cuaSessions = new Map();

  function computerOf(args) {
    const id = args?.computer_id;
    if (typeof id !== 'string' || !id) throw new ToolError('computer_id_required', 'give computer_id explicitly (see computer_list)');
    const computer = byId.get(id);
    if (!computer) {
      const known = [...byId.keys()];
      throw new ToolError('unknown_computer', `no computer ${id} is configured${known.length ? `; configured: ${known.join(', ')}` : '; none are configured'}`);
    }
    return computer;
  }

  function requireCapability(computer, capability, why) {
    if (computer.capabilities[capability]) return;
    const reason = capability === 'input' && computer.inputUnavailableReason ? ` (${computer.inputUnavailableReason})` : '';
    throw new ToolError('capability_unavailable', `computer ${computer.id} cannot ${why}${reason}`, { computer_id: computer.id, capability });
  }

  // One Cua session per DSH session and computer; the name is derived, so nothing secret goes to Cua.
  function cuaSessionFor(session, computer) {
    const name = `dsh-${createHash('sha256').update(session).digest('hex').slice(0, 16)}`;
    const names = cuaSessions.get(computer.id) ?? new Set();
    names.add(name);
    cuaSessions.set(computer.id, names);
    return name;
  }

  async function call(computer, request, exec, timeoutMs) {
    try {
      return await transport.call(computer, request, { signal: exec?.signal, timeoutMs });
    } catch (error) {
      throw remoteFailure(computer, error);
    }
  }

  async function saveImage(bytes, name) {
    const mediaType = imageMediaType(bytes);
    if (!mediaType) throw new ToolError('invalid_image', 'the computer returned an image in an unknown format');
    const service = attachments?.();
    if (!service?.saveImage) throw new ToolError('attachments_unavailable', 'the DSH attachments service is not available, so the image cannot be shown');
    const saved = await service.saveImage({ data: new Uint8Array(bytes), mediaType, name });
    return {
      attachmentId: saved.attachmentId, mediaType: saved.mediaType ?? mediaType, bytes: saved.bytes ?? bytes.length,
      width: saved.width, height: saved.height, name,
    };
  }

  function remember(session, shot) {
    const key = `${session}\0${shot.computer_id}`;
    const list = shots.get(key) ?? [];
    list.push(shot);
    if (list.length > SHOTS_PER_KEY) list.splice(0, list.length - SHOTS_PER_KEY);
    shots.set(key, list);
  }

  const tools = [
    {
      name: 'computer_list',
      description: 'List the configured computers with their capabilities. With probe (default true) each computer is contacted over its transport and reports whether it is reachable.',
      parameters: {
        type: 'object',
        properties: { probe: { type: 'boolean', description: 'Contact each computer (default true).' } },
        additionalProperties: false,
      },
      timeoutMs: PROBE_TIMEOUT_MS + 5_000,
      output: {
        schema: { type: 'object', properties: { computers: { type: 'array' } }, required: ['computers'] },
        render: (args, value) => [text(value.computers.length
          ? value.computers.map((c) => `${c.id} (${c.name}): ${c.reachable === undefined ? 'not probed' : c.reachable ? 'reachable' : `unreachable — ${c.error.code}`}; ${Object.entries(c.capabilities).filter(([, on]) => on).map(([k]) => k).join(', ') || 'no capabilities'}`).join('\n')
          : 'No computers are configured.')],
      },
      async execute(args, exec) {
        const probe = args?.probe !== false;
        const list = await Promise.all(computers.map(async (computer) => {
          const entry = {
            id: computer.id, name: computer.name, platform: computer.platform, capabilities: { ...computer.capabilities },
            work_root: computer.workRoot, file_roots: computer.fileRoots,
          };
          if (!probe) return entry;
          try {
            const hello = await transport.call(computer, {
              op: 'hello', cua_path: computer.cua?.path, cua_service: computer.cua?.service, cua_socket: computer.cua?.socket,
            }, { signal: exec?.signal, timeoutMs: PROBE_TIMEOUT_MS });
            return {
              ...entry, reachable: true,
              host: { hostname: hello.hostname, user: hello.user, system: hello.system, machine: hello.machine, python: hello.python },
              ...(computer.cua ? { cua: hello.cua } : {}),
            };
          } catch (error) {
            const failure = remoteFailure(computer, error);
            return { ...entry, reachable: false, error: { code: failure.code ?? 'error', message: failure.message } };
          }
        }));
        return { computers: list };
      },
    },

    {
      name: 'computer_screenshot',
      description: 'Capture the full display of one computer. The image is attached for you to see; keep capture_id and frame_scale to relate coordinates to the screen.',
      parameters: {
        type: 'object',
        properties: {
          computer_id: computerIdParam,
          max_image_dimension: { type: 'integer', minimum: 256, maximum: 4096, description: `Long-edge cap for the image in pixels (default ${DEFAULT_IMAGE_DIMENSION}).` },
        },
        required: ['computer_id'],
        additionalProperties: false,
      },
      timeoutMs: 120_000,
      output: {
        schema: { type: 'object', properties: { computer_id: { type: 'string' }, capture_id: { type: 'string' } }, required: ['computer_id', 'capture_id'] },
        render: (args, value) => [
          text(`Screenshot of ${value.computer_id} (capture ${value.capture_id}) at ${value.captured_at}: ${value.image.width}×${value.image.height} image of a ${value.screen.width}×${value.screen.height} screen, frame_scale ${value.frame_scale}.`),
          ...imageBlock(value.attachment),
        ],
      },
      async execute(args, exec) {
        const computer = computerOf(args);
        requireCapability(computer, 'screenshot', 'take screenshots (no Cua driver is configured)');
        const session = sessionOf(exec);
        const shot = await call(computer, {
          op: 'screenshot', session: cuaSessionFor(session, computer), cua_path: computer.cua.path,
          max_image_dimension: args.max_image_dimension ?? DEFAULT_IMAGE_DIMENSION,
        }, exec, 90_000);
        const meta = shot.meta ?? {};
        if (!meta.capture_id) throw new ToolError('cua_error', `computer ${computer.id}: the screenshot has no capture_id`);
        const png = Buffer.from(shot.png_b64, 'base64');
        const attachment = await saveImage(png, `${computer.id}-${meta.capture_id}.png`);
        const value = {
          computer_id: computer.id,
          capture_id: meta.capture_id,
          captured_at: new Date(shot.time_ms).toISOString(),
          image: { width: meta.screenshot_width, height: meta.screenshot_height, bytes: png.length },
          screen: { width: meta.screen_width, height: meta.screen_height },
          frame_scale: meta.frame_scale,
          scale_factor: meta.scale_factor,
          windows: (meta.windows ?? []).map((w) => ({ window_id: w.window_id, pid: w.pid, app_name: w.app_name, title: w.title, bounds: w.bounds })),
          attachment,
        };
        remember(session, { ...value, png });
        return value;
      },
    },

    {
      name: 'computer_exec_start',
      description: 'Start a command on one computer as a background job and return its job_id at once. Give exactly one of `command` (a bash script) or `argv`. Poll with computer_exec_status; stop with computer_exec_cancel. The job keeps running if the connection drops.',
      parameters: {
        type: 'object',
        properties: {
          computer_id: computerIdParam,
          command: { type: 'string', description: 'Bash script to run.' },
          argv: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Program and arguments, run without a shell.' },
          cwd: { type: 'string', description: 'Remote working directory (absolute or ~/…); defaults to the computer work root.' },
          timeout_s: { type: 'number', minimum: 0, description: 'Stop the job after this many seconds (0 = no limit).' },
        },
        required: ['computer_id'],
        additionalProperties: false,
      },
      timeoutMs: 90_000,
      output: {
        schema: { type: 'object', properties: { computer_id: { type: 'string' }, job_id: { type: 'string' }, state: { type: 'string' } }, required: ['computer_id', 'job_id', 'state'] },
        render: (args, value) => [text(`Job ${value.job_id} on ${value.computer_id}: ${value.state}${value.recovered ? ' (start confirmed after a lost reply)' : ''}${value.cwd ? ` in ${value.cwd}` : ''}.`)],
      },
      async execute(args, exec) {
        const computer = computerOf(args);
        requireCapability(computer, 'exec', 'run commands');
        const owner = sessionOf(exec);
        const hasCommand = typeof args.command === 'string' && args.command !== '';
        const hasArgv = Array.isArray(args.argv) && args.argv.length > 0;
        if (hasCommand === hasArgv) throw new ToolError('invalid_arguments', 'give exactly one of command or argv');
        const job_id = newJobId();
        let result;
        try {
          result = await transport.startJob(computer, {
            job_id, owner, computer_id: computer.id,
            ...(hasCommand ? { shell_script: args.command } : { argv: args.argv }),
            cwd: args.cwd || computer.workRoot || '~', timeout_s: args.timeout_s ?? 0,
          }, { signal: exec?.signal, timeoutMs: 60_000 });
        } catch (error) {
          throw remoteFailure(computer, error);
        }
        return { computer_id: computer.id, ...result, job_id };
      },
    },

    {
      name: 'computer_exec_status',
      description: 'Read a job\'s state and new output. Pass back stdout_cursor/stderr_cursor from the previous answer to get only new output; `more` means output is waiting beyond max_bytes. wait_s waits (≤20 s) for new output or the end of the job.',
      parameters: {
        type: 'object',
        properties: {
          computer_id: computerIdParam,
          job_id: { type: 'string' },
          stdout_cursor: { type: 'integer', minimum: 0 },
          stderr_cursor: { type: 'integer', minimum: 0 },
          wait_s: { type: 'number', minimum: 0, maximum: 20 },
          max_bytes: { type: 'integer', minimum: 1, maximum: 1048576 },
        },
        required: ['computer_id', 'job_id'],
        additionalProperties: false,
      },
      timeoutMs: 90_000,
      output: {
        schema: { type: 'object', properties: { computer_id: { type: 'string' }, job_id: { type: 'string' }, state: { type: 'string' } }, required: ['computer_id', 'job_id', 'state'] },
        render: (args, value) => {
          const exit = value.exit ? ` (${value.exit.signal ? `signal ${value.exit.signal}` : `exit ${value.exit.exit_code ?? '?'}`})` : '';
          const parts = [`Job ${value.job_id} on ${value.computer_id}: ${value.state}${exit}${value.reason ? ` — ${value.reason}` : ''}`];
          if (value.stdout.text) parts.push(`stdout:\n${value.stdout.text}`);
          if (value.stderr.text) parts.push(`stderr:\n${value.stderr.text}`);
          parts.push(`cursors: stdout ${value.stdout.cursor}${value.stdout.more ? ' (more)' : ''}, stderr ${value.stderr.cursor}${value.stderr.more ? ' (more)' : ''}`);
          return [text(parts.join('\n'))];
        },
      },
      async execute(args, exec) {
        const computer = computerOf(args);
        const result = await call(computer, {
          op: 'exec_status', job_id: args.job_id, owner: sessionOf(exec),
          stdout_cursor: args.stdout_cursor ?? 0, stderr_cursor: args.stderr_cursor ?? 0,
          wait_s: args.wait_s ?? 0, max_bytes: args.max_bytes,
        }, exec, 60_000);
        return { computer_id: computer.id, ...result };
      },
    },

    {
      name: 'computer_exec_cancel',
      description: 'Cancel a job. `cancel` is confirmed (stopped and its process group is gone), cancelling (still stopping — check with computer_exec_status), not_running / finished_before_cancel (it had already ended), or unknown (the computer could not confirm; do not assume it stopped).',
      parameters: {
        type: 'object',
        properties: { computer_id: computerIdParam, job_id: { type: 'string' } },
        required: ['computer_id', 'job_id'],
        additionalProperties: false,
      },
      timeoutMs: 90_000,
      output: {
        schema: { type: 'object', properties: { computer_id: { type: 'string' }, job_id: { type: 'string' }, cancel: { type: 'string' } }, required: ['computer_id', 'job_id', 'cancel'] },
        render: (args, value) => [text(`Cancel job ${value.job_id} on ${value.computer_id}: ${value.cancel}${value.state ? ` (state ${value.state})` : ''}${value.error ? ` — ${value.error.message}` : ''}`)],
      },
      async execute(args, exec) {
        const computer = computerOf(args);
        const owner = sessionOf(exec);
        try {
          const result = await transport.call(computer, { op: 'exec_cancel', job_id: args.job_id, owner }, { signal: exec?.signal, timeoutMs: 60_000 });
          return { computer_id: computer.id, ...result };
        } catch (error) {
          // The agent answered with an error (no such job, not ours): that is a real failure, not a cancel state.
          if (!(error instanceof RemoteError) || error.remote) throw remoteFailure(computer, error);
          // No answer: the cancel may or may not have landed. Never report it as done.
          return { computer_id: computer.id, job_id: args.job_id, cancel: 'unknown', error: { code: error.code, message: remoteFailure(computer, error).message } };
        }
      },
    },

    {
      name: 'computer_file_read',
      description: 'Read a small file (inside the computer\'s configured file roots). Text comes back as utf8; other bytes as base64. sha256 is of the whole file; pass it as expected_sha256 when writing back.',
      parameters: {
        type: 'object',
        properties: {
          computer_id: computerIdParam,
          path: { type: 'string', description: 'Absolute or ~/… path on the computer.' },
          offset: { type: 'integer', minimum: 0 },
          max_bytes: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES },
          encoding: { type: 'string', enum: ['auto', 'utf8', 'base64'], description: 'auto (default): utf8 when the bytes are valid UTF-8, otherwise base64.' },
        },
        required: ['computer_id', 'path'],
        additionalProperties: false,
      },
      timeoutMs: 90_000,
      output: {
        schema: { type: 'object', properties: { computer_id: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' } }, required: ['computer_id', 'path', 'content'] },
        render: (args, value) => [text(`${value.computer_id}:${value.path} — ${value.bytes} of ${value.size} bytes from ${value.offset}${value.eof ? '' : ' (not at end)'}, ${value.encoding}, sha256 ${value.sha256}\n${value.encoding === 'utf8' ? value.content : '[base64 content]'}`)],
      },
      async execute(args, exec) {
        const computer = computerOf(args);
        requireCapability(computer, 'files', 'read files (no fileRoots are configured)');
        const result = await call(computer, {
          op: 'file_read', path: args.path, roots: computer.fileRoots, offset: args.offset ?? 0, max_bytes: args.max_bytes ?? DEFAULT_READ_BYTES,
        }, exec, 60_000);
        const bytes = Buffer.from(result.data_b64, 'base64');
        const encoding = args.encoding ?? 'auto';
        const asText = encoding === 'base64' ? null : decodeText(bytes);
        if (encoding === 'utf8' && asText === null) throw new ToolError('not_utf8', `${args.path} is not valid UTF-8 in the requested range; read it with encoding base64`);
        const { data_b64: _data, ...rest } = result;
        return { computer_id: computer.id, ...rest, encoding: asText === null ? 'base64' : 'utf8', content: asText ?? result.data_b64 };
      },
    },

    {
      name: 'computer_file_write',
      description: 'Write a small file (≤4 MiB) inside the computer\'s file roots. Refuses to replace an existing file unless overwrite is true; with expected_sha256 it also refuses if the file changed since it was read.',
      parameters: {
        type: 'object',
        properties: {
          computer_id: computerIdParam,
          path: { type: 'string', description: 'Absolute or ~/… path on the computer.' },
          content: { type: 'string' },
          encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'How content is encoded (default utf8).' },
          overwrite: { type: 'boolean' },
          expected_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          mkdirs: { type: 'boolean', description: 'Create missing parent directories (inside the roots).' },
        },
        required: ['computer_id', 'path', 'content'],
        additionalProperties: false,
      },
      timeoutMs: 90_000,
      output: {
        schema: { type: 'object', properties: { computer_id: { type: 'string' }, path: { type: 'string' }, sha256: { type: 'string' } }, required: ['computer_id', 'path', 'sha256'] },
        render: (args, value) => [text(`${value.created ? 'Created' : 'Replaced'} ${value.computer_id}:${value.path} (${value.size} bytes, sha256 ${value.sha256}).`)],
      },
      async execute(args, exec) {
        const computer = computerOf(args);
        requireCapability(computer, 'files', 'write files (no fileRoots are configured)');
        if (typeof args.content !== 'string') throw new ToolError('invalid_arguments', 'content must be a string');
        const data = (args.encoding ?? 'utf8') === 'base64' ? Buffer.from(args.content, 'base64') : Buffer.from(args.content, 'utf8');
        if (data.length > MAX_WRITE_BYTES) throw new ToolError('too_large', `writes are limited to ${MAX_WRITE_BYTES} bytes`);
        const result = await call(computer, {
          op: 'file_write', path: args.path, roots: computer.fileRoots, data_b64: data.toString('base64'),
          overwrite: args.overwrite === true, expected_sha256: args.expected_sha256, mkdirs: args.mkdirs === true,
        }, exec, 60_000);
        return { computer_id: computer.id, ...result };
      },
    },

    {
      name: 'computer_cua_call',
      description: `Call one Cua driver tool on a computer. Observation tools: ${CUA_OBSERVE_TOOLS.join(', ')}. Input tools (only where the computer has the input capability): ${CUA_INPUT_TOOLS.join(', ')}. Arguments are checked against the driver's own schema; the Cua session is managed for you.`,
      parameters: {
        type: 'object',
        properties: {
          computer_id: computerIdParam,
          tool: { type: 'string', enum: [...CUA_OBSERVE_TOOLS, ...CUA_INPUT_TOOLS] },
          arguments: { type: 'object', description: 'Arguments for the Cua tool (without session).' },
        },
        required: ['computer_id', 'tool'],
        additionalProperties: false,
      },
      timeoutMs: 120_000,
      output: {
        schema: { type: 'object', properties: { computer_id: { type: 'string' }, tool: { type: 'string' } }, required: ['computer_id', 'tool'] },
        render: (args, value) => [text(`Cua ${value.tool} on ${value.computer_id}:\n${JSON.stringify(value.value, null, 2)}`), ...imageBlock(value.attachment)],
      },
      async execute(args, exec) {
        const computer = computerOf(args);
        const tool = args.tool;
        const input = CUA_INPUT_TOOLS.includes(tool);
        if (!input && !CUA_OBSERVE_TOOLS.includes(tool)) throw new ToolError('tool_not_allowed', `Cua tool ${tool} is not allowed; allowed: ${[...CUA_OBSERVE_TOOLS, ...CUA_INPUT_TOOLS].join(', ')}`);
        if (!computer.cua) throw new ToolError('capability_unavailable', `computer ${computer.id} has no Cua driver configured`, { computer_id: computer.id, capability: 'cua' });
        if (input) requireCapability(computer, 'input', 'drive the desktop (input capability is off)');
        const session = sessionOf(exec);
        // The session and output file are the plugin's: the agent overrides both whatever the model sent.
        const { session: _s, screenshot_out_file: _f, ...toolArgs } = args.arguments && typeof args.arguments === 'object' ? args.arguments : {};
        const result = await call(computer, {
          op: 'cua', tool, arguments: toolArgs, session: cuaSessionFor(session, computer), cua_path: computer.cua.path, timeout_s: 60,
        }, exec, 100_000);
        let attachment;
        if (result.image?.png_b64) {
          const bytes = Buffer.from(result.image.png_b64, 'base64');
          const id = result.value?.capture_id ?? randomBytes(4).toString('hex');
          attachment = await saveImage(bytes, `${computer.id}-${tool}-${id}.${imageMediaType(bytes) === 'image/jpeg' ? 'jpg' : 'png'}`);
        }
        return { computer_id: computer.id, tool, value: result.value, ...(attachment ? { attachment } : {}) };
      },
    },
  ];

  return {
    tools,
    /** Screenshots of one DSH session on one computer, oldest first (for the right-side panel). */
    screenshots(session, computerId) {
      return [...(shots.get(`${session}\0${computerId}`) ?? [])];
    },
    /** Ends the Cua sessions this plugin opened and forgets screenshots. Best effort; never throws. */
    async dispose() {
      shots.clear();
      const pending = [...cuaSessions].map(([id, names]) => {
        const computer = byId.get(id);
        return transport.call(computer, { op: 'end_sessions', sessions: [...names], cua_path: computer.cua?.path }, { timeoutMs: 20_000 })
          .catch(() => null);
      });
      cuaSessions.clear();
      await Promise.all(pending);
    },
  };
}
