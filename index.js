// DSH plugin entry: registers the `computer_*` tools for the computers in `config.computers`, and the
// `/api/remote-machine/*` routes the right-side panel (client.js) reads screenshots from.
import { normalizeComputers } from './src/host/config.js';
import { registerRoutes } from './src/host/routes.js';
import { createRemoteMachine } from './src/host/tools.js';
import { createTransport } from './src/host/transport.js';

export const name = 'dsh-remote-machine';
export const inject = ['connection', 'tools'];

export function apply(ctx, config = {}) {
  const machine = createRemoteMachine({
    computers: normalizeComputers(config.computers),
    transport: createTransport(),
    attachments: () => ctx.get('attachments'),
  });
  for (const tool of machine.tools) {
    ctx.effect(() => {
      const registration = ctx.tools.register(tool);
      return typeof registration === 'function' ? registration : () => registration?.dispose?.();
    }, `remote-machine tool ${tool.name}`);
  }
  registerRoutes(ctx, machine);
  ctx.effect(() => () => {
    void machine.dispose();
  }, 'remote-machine cua sessions');
}
