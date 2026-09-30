// `/api/remote-machine/*` routes for the right-side panel. Registered through `ctx.connection.fetch`, so
// DSH checks the auth cookie and origin before any handler runs. Screenshots are served from the plugin's
// in-memory store only (per DSH session and computer); nothing is written to disk or a public directory.

export const ROUTE_PREFIX = '/api/remote-machine';
const MAX_BODY_BYTES = 16 * 1024;

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

class RouteError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const STATUS_BY_CODE = {
  unknown_computer: 404, no_session: 400, capability_unavailable: 409, screen_locked: 423, invalid_image: 502, cua_error: 502,
  transport_error: 502, timeout: 504, aborted: 499, python_unavailable: 502, agent_failed: 502,
  agent_protocol_error: 502, agent_install_failed: 502,
};

function failure(error) {
  if (error instanceof RouteError) return json({ error: { code: error.code, message: error.message } }, error.status);
  const code = typeof error?.code === 'string' ? error.code : 'error';
  return json({ error: { code, message: error?.message ?? String(error) } }, STATUS_BY_CODE[code] ?? 500);
}

function param(url, name) {
  const value = url.searchParams.get(name);
  if (!value || value.length > 256) throw new RouteError(400, 'invalid_request', `query parameter ${name} is required`);
  return value;
}

async function body(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) throw new RouteError(413, 'too_large', 'request body is too large');
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object') return value;
  } catch {}
  throw new RouteError(400, 'invalid_request', 'request body must be a JSON object');
}

// Everything about a screenshot except its bytes, which the panel loads from the `screenshot` route.
const shotMeta = ({ png: _png, ...meta }) => meta;

// [method, path, handler(request, url)]; handlers throw, `remoteMachineRoutes` turns errors into JSON.
function routeTable(machine) {
  return [
    ['GET', `${ROUTE_PREFIX}/computers`, async () => json({ computers: machine.computers() })],

    // Contacts one computer (`hello`); the panel calls it when a computer is selected or refreshed.
    ['GET', `${ROUTE_PREFIX}/status`, async (request, url) => {
      const computer = machine.computer(param(url, 'computer'));
      return json({ computer_id: computer.id, checked_at: new Date().toISOString(), ...await machine.probe(computer, request.signal) });
    }],

    ['GET', `${ROUTE_PREFIX}/screenshots`, async (request, url) => {
      const computer = machine.computer(param(url, 'computer'));
      const shots = machine.screenshots(param(url, 'session'), computer.id).map(shotMeta);
      return json({ computer_id: computer.id, screenshots: shots });
    }],

    ['GET', `${ROUTE_PREFIX}/screenshot`, async (request, url) => {
      const computer = machine.computer(param(url, 'computer'));
      const captureId = param(url, 'capture');
      const shot = machine.screenshots(param(url, 'session'), computer.id).find((item) => item.capture_id === captureId);
      if (!shot) throw new RouteError(404, 'not_found', `screenshot ${captureId} of ${computer.id} is no longer kept`);
      return new Response(shot.png, {
        status: 200,
        headers: {
          'Content-Type': 'image/png', 'Content-Length': String(shot.png.length), 'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'",
        },
      });
    }],

    // Refresh from the panel: a new screenshot for this session, kept in memory; the model is not sent it.
    ['POST', `${ROUTE_PREFIX}/capture`, async (request) => {
      const input = await body(request);
      if (typeof input.session !== 'string' || !input.session || input.session.length > 256) {
        throw new RouteError(400, 'invalid_request', 'session is required');
      }
      if (typeof input.computer_id !== 'string' || !input.computer_id) throw new RouteError(400, 'invalid_request', 'computer_id is required');
      return json(await machine.capture(input.session, input.computer_id, { signal: request.signal }));
    }],
  ];
}

/**
 * The routes for `machine` (from `createRemoteMachine`) as `{ method, path, fetch(request) → Response }`;
 * failures become JSON `{ error: { code, message } }` with an HTTP status.
 */
export function remoteMachineRoutes(machine) {
  return routeTable(machine).map(([method, path, handler]) => ({
    method, path,
    fetch: async (request) => {
      if (request.method !== method) return json({ error: { code: 'method_not_allowed', message: `use ${method}` } }, 405);
      try {
        return await handler(request, new URL(request.url));
      } catch (error) {
        return failure(error);
      }
    },
  }));
}

/** Registers the routes; each one is an effect of `ctx`, so disposing the plugin removes them. */
export function registerRoutes(ctx, machine) {
  for (const { method, path, fetch } of remoteMachineRoutes(machine)) {
    ctx.effect(() => ctx.connection.fetch.register({ path, methods: [method], requestBody: 'buffered', fetch }),
      `remote-machine route ${method} ${path}`);
  }
}
