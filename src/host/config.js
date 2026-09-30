// Plugin configuration: `config.computers[]` → normalized computer records. Nothing here touches the
// network; transport details (ssh host syntax) are checked again by the transport before every call.

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'invalid_config';
  }
}

function stringList(value, where) {
  if (value == null) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item)) {
    throw new ConfigError(`${where} must be a list of paths`);
  }
  return [...value];
}

function optionalString(value, where) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new ConfigError(`${where} must be a string`);
  return value;
}

/**
 * Normalizes `config.computers`. Throws ConfigError for entries that cannot be used safely (missing or
 * duplicate ids, wrong types); an empty or missing list is valid and yields no computers.
 *
 * Capabilities: `exec` defaults on, `files` needs `fileRoots`, `screenshot` needs a `cua` section, and
 * `input` (Cua actions that drive the desktop) is only on when explicitly `true`.
 */
export function normalizeComputers(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new ConfigError('computers must be a list');
  const seen = new Set();
  return list.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new ConfigError(`computers[${index}] must be an object`);
    const { id } = entry;
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new ConfigError(`computers[${index}].id must be 1-64 characters of [A-Za-z0-9_.-]`);
    }
    if (seen.has(id)) throw new ConfigError(`computer id ${id} is configured twice`);
    seen.add(id);
    const where = `computer ${id}`;
    const transport = entry.transport;
    if (!transport || typeof transport !== 'object') throw new ConfigError(`${where}: transport is required`);
    const cua = entry.cua && typeof entry.cua === 'object'
      ? {
          path: optionalString(entry.cua.path, `${where}: cua.path`) ?? '~/.local/bin/cua-driver',
          service: optionalString(entry.cua.service, `${where}: cua.service`),
          socket: optionalString(entry.cua.socket, `${where}: cua.socket`),
        }
      : null;
    const fileRoots = stringList(entry.fileRoots, `${where}: fileRoots`);
    const capabilities = entry.capabilities && typeof entry.capabilities === 'object' ? entry.capabilities : {};
    return {
      id,
      name: optionalString(entry.name, `${where}: name`) ?? id,
      platform: optionalString(entry.platform, `${where}: platform`),
      transport: { ...transport },
      cua,
      workRoot: optionalString(entry.workRoot, `${where}: workRoot`),
      fileRoots,
      capabilities: {
        exec: capabilities.exec !== false,
        files: fileRoots.length > 0 && capabilities.files !== false,
        screenshot: cua !== null && capabilities.screenshot !== false,
        input: cua !== null && capabilities.input === true,
      },
      // Why input is off, shown to the model with capability_unavailable (e.g. the Cua driver's own error).
      inputUnavailableReason: optionalString(capabilities.inputUnavailableReason, `${where}: capabilities.inputUnavailableReason`),
    };
  });
}
