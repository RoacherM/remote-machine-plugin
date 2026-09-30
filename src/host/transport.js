// SSH transport to the remote executor (src/remote/agent.py).
//
// Every call is one `ssh -o BatchMode=yes <host> <fixed command>` whose request travels only on stdin as
// one JSON document. The remote command line is a constant built from the agent's sha256: no path,
// command or argument from a request is ever put into it. The agent lives at a fixed, content-addressed
// path; when it is missing the command exits AGENT_MISSING_EXIT without reading stdin, the agent is
// installed over stdin, and the request is retried once.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const AGENT_MISSING_EXIT = 97;
export const AGENT_INSTALL_MISMATCH_EXIT = 98;
export const SSH_TRANSPORT_EXIT = 255;
export const PYTHON_MISSING_EXIT = 127;
export const REMOTE_STATE_DIR = '.local/state/dsh-computer';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const STDERR_TAIL_BYTES = 2000;
// ssh config aliases, user@host, IPv4/IPv6 literals. Never a leading '-' (it would be read as an option).
const HOST_PATTERN = /^[A-Za-z0-9_.%:@[\]][A-Za-z0-9_.%:@[\]-]*$/;

export class RemoteError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    // `uncertain`: the request reached (or may have reached) the agent, so it may have taken effect.
    Object.assign(this, details);
  }
}

export function loadAgent(path = new URL('../remote/agent.py', import.meta.url)) {
  const source = readFileSync(path);
  return { source, sha256: createHash('sha256').update(source).digest('hex') };
}

export function agentRemotePath(sha256) {
  return `$HOME/${REMOTE_STATE_DIR}/agent-${sha256}.py`;
}

// Constant per agent version; `sha256` is 64 hex characters, so nothing here needs quoting.
export function runCommand(sha256) {
  assertSha(sha256);
  return `sh -c 'f="${agentRemotePath(sha256)}"; [ -f "$f" ] || exit ${AGENT_MISSING_EXIT}; exec python3 "$f"'`;
}

export function installCommand(sha256) {
  assertSha(sha256);
  const dir = `$HOME/${REMOTE_STATE_DIR}`;
  const verify = `import hashlib,sys; sys.exit(0 if hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest()==sys.argv[2] else ${AGENT_INSTALL_MISMATCH_EXIT})`;
  return `sh -c 'umask 077; d="${dir}"; t="$d/.agent-${sha256}.$$"; mkdir -p "$d" && cat > "$t" && python3 -c '"'"'${verify}'"'"' "$t" ${sha256} && mv -f "$t" "$d/agent-${sha256}.py"; s=$?; rm -f "$t"; exit $s'`;
}

function assertSha(sha256) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('agent sha256 must be 64 hex characters');
}

export function sshHost(computer) {
  const transport = computer?.transport;
  if (transport?.type !== 'ssh') {
    throw new RemoteError('transport_unsupported', `computer ${computer?.id} has no ssh transport configured`);
  }
  const host = transport.host;
  if (typeof host !== 'string' || !HOST_PATTERN.test(host)) {
    throw new RemoteError('invalid_config', `computer ${computer.id}: transport.host must be an ssh host or alias`);
  }
  return host;
}

function tail(buffer) {
  const text = buffer.toString('utf8').trim();
  return text.length > STDERR_TAIL_BYTES ? `…${text.slice(-STDERR_TAIL_BYTES)}` : text;
}

/**
 * Creates a transport. `sshCommand` (argv prefix, default ['ssh']) exists so tests can substitute a fake
 * ssh; it is not read from user configuration.
 */
export function createTransport({ agent = loadAgent(), sshCommand = ['ssh'], connectTimeoutS = 15 } = {}) {
  // Run one ssh process: resolves { code, stdout, stderr } or rejects on abort/timeout/spawn failure.
  function ssh(host, remoteCommand, input, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const [command, ...prefix] = sshCommand;
    const args = [...prefix, '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${connectTimeoutS}`, '-T', '--', host, remoteCommand];
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new RemoteError('aborted', 'the call was cancelled before it was sent', { uncertain: false }));
        return;
      }
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let failure = null;
      const stop = (error) => {
        if (failure) return;
        failure = error;
        child.kill('SIGTERM');
      };
      const timer = setTimeout(() => stop(new RemoteError('timeout', `ssh ${host} did not answer within ${timeoutMs} ms`, { uncertain: true })), timeoutMs);
      const onAbort = () => stop(new RemoteError('aborted', 'the call was cancelled while in flight', { uncertain: true }));
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_RESPONSE_BYTES) stop(new RemoteError('response_too_large', `response from ${host} exceeded ${MAX_RESPONSE_BYTES} bytes`, { uncertain: true }));
        else stdout.push(chunk);
      });
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      // The remote side may exit (e.g. AGENT_MISSING_EXIT) without reading stdin.
      child.stdin.on('error', () => {});
      child.on('error', (error) => stop(new RemoteError('transport_error', `could not run ssh: ${error.message}`, { uncertain: false })));
      child.on('close', (code, sig) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (failure) reject(failure);
        else resolve({ code: code ?? (sig ? -1 : 0), stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
      });
      child.stdin.end(input);
    });
  }

  async function install(host, options) {
    const { code, stderr } = await ssh(host, installCommand(agent.sha256), agent.source, options);
    if (code === 0) return;
    if (code === SSH_TRANSPORT_EXIT) throw new RemoteError('transport_error', `ssh ${host} failed while installing the agent: ${tail(stderr)}`, { uncertain: false });
    if (code === PYTHON_MISSING_EXIT) throw new RemoteError('python_unavailable', `python3 is not available on ${host}`, { uncertain: false });
    throw new RemoteError('agent_install_failed', `installing the agent on ${host} failed (exit ${code}): ${tail(stderr)}`, { uncertain: false });
  }

  /**
   * Sends one request to the agent on `computer` and returns its `result`. Throws RemoteError: agent
   * errors keep the agent's code (`remote: true`); transport failures say whether the request may have
   * taken effect (`uncertain`).
   */
  async function call(computer, request, options = {}) {
    const host = sshHost(computer);
    const input = JSON.stringify(request);
    let installed = false;
    for (;;) {
      const { code, stdout, stderr } = await ssh(host, runCommand(agent.sha256), input, options);
      if (code === AGENT_MISSING_EXIT && !installed) {
        await install(host, options);
        installed = true;
        continue;
      }
      if (code === SSH_TRANSPORT_EXIT) {
        // 255 covers both "never connected" and "connection dropped mid-call": only a reply proves either.
        throw new RemoteError('transport_error', `ssh ${host} failed: ${tail(stderr) || 'exit 255'}`, { uncertain: true, computer_id: computer.id });
      }
      if (code === PYTHON_MISSING_EXIT) throw new RemoteError('python_unavailable', `python3 is not available on ${host}`, { uncertain: false });
      if (code !== 0) {
        throw new RemoteError('agent_failed', `remote agent on ${host} exited ${code}: ${tail(stderr)}`, { uncertain: true });
      }
      let response;
      try {
        response = JSON.parse(stdout.toString('utf8'));
      } catch {
        throw new RemoteError('agent_protocol_error', `remote agent on ${host} did not answer with JSON: ${tail(stdout) || tail(stderr)}`, { uncertain: true });
      }
      if (response?.ok === true) return response.result;
      const error = response?.error ?? {};
      throw new RemoteError(error.code || 'agent_error', error.message || 'remote agent reported an error', { remote: true, uncertain: false });
    }
  }

  /**
   * Starts a job exactly once. When the start reply is lost the job is looked up by its id instead of
   * being started again: `recovered: true` means the start was confirmed afterwards.
   */
  async function startJob(computer, request, options = {}) {
    try {
      return await call(computer, { ...request, op: 'exec_start' }, options);
    } catch (error) {
      if (!(error instanceof RemoteError) || !error.uncertain) throw error;
      let status;
      try {
        status = await call(computer, { op: 'exec_status', job_id: request.job_id, owner: request.owner }, { timeoutMs: options.timeoutMs });
      } catch (lookup) {
        if (lookup instanceof RemoteError && lookup.code === 'job_not_found') {
          throw new RemoteError(error.code, `${error.message}; the job was not started`, { uncertain: false, job_id: request.job_id });
        }
        throw new RemoteError('start_uncertain', `${error.message}; whether job ${request.job_id} started is unknown — check it with its job_id, do not start it again`, { uncertain: true, job_id: request.job_id });
      }
      return { job_id: status.job_id, state: status.state, pid: status.started?.pid ?? null, cwd: status.cwd, exit: status.exit, recovered: true };
    }
  }

  return { agent, call, startJob };
}
