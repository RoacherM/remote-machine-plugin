# @local/dsh-remote-machine

DSH plugin for running work on other computers: every tool call names an explicit `computer_id`, and P1
reaches computers over SSH. This repository is the plugin root.

## Layout

- `src/remote/agent.py` — remote executor, Python 3 standard library only. One JSON request on stdin, one
  JSON response on stdout (`{ok:true,result}` / `{ok:false,error:{code,message}}`). Ops: `hello`,
  `exec_start`, `exec_status`, `exec_cancel`, `file_read`, `file_write`, `screenshot`, `cua`, `cua_schema`,
  `end_sessions`. Jobs run under a detached supervisor, so a dropped SSH connection neither kills nor
  cancels them; state lives in `~/.local/state/dsh-computer/jobs/<job_id>/` (mode 0700).
- `src/host/transport.js` — host side of the SSH transport (`createTransport()` → `call`, `startJob`).

## SSH transport

- Every call is `ssh -o BatchMode=yes -o ConnectTimeout=15 -T -- <host> <constant>`. The request goes
  only on stdin; the remote command line is built from the agent's sha256 alone, never from a path,
  command or argument. `transport.host` must look like an ssh host/alias (no leading `-`, no spaces or
  shell characters) or the call is refused before ssh runs.
- The agent lives at `~/.local/state/dsh-computer/agent-<sha256>.py`. If it is missing the command exits
  **97** without reading stdin; the host then installs the agent over stdin (written to a temp file,
  sha256-verified by the remote `python3`, exit **98** on mismatch, then renamed) and retries once.
- Exit **255** is a `transport_error`; **127** is `python_unavailable`. Transport errors carry
  `uncertain: true` when the request may have reached the agent.
- `startJob` never re-runs a start whose reply was lost: it looks the job up by its `job_id` and returns
  it with `recovered: true`, reports "not started" if the agent has no such job, or fails with
  `start_uncertain` (keep the `job_id`, query it later) if the computer cannot be reached at all.
- `exec_cancel` answers `confirmed` only when the job is recorded as cancelled **and** its process group
  is gone; `cancelling` while it is still alive; `not_running` if it had already ended; `unknown`
  otherwise. TERM is escalated to KILL after 3 s.

## Configuration (planned shape)

Computers come from `config.computers[]`; the bundle default is an empty list. Example profile entry for
the Omarchy test machine:

```yaml
computers:
  - id: omarchy
    name: Omarchy (Arch Linux, Hyprland)
    platform: linux
    transport: { type: ssh, host: omarchy }        # an alias from ~/.ssh/config
    cua:
      path: ~/.local/bin/cua-driver
      service: dsh-cua-driver.service
    workRoot: ~/dsh-work
    fileRoots: [~/dsh-work]
    capabilities:
      screenshot: true
      input: false   # "production Hyprland input plugin is unavailable"
```

## Current state

Tested for real (2026-09-30) against Omarchy (`ssh omarchy`: Arch Linux aarch64, Python 3.14.7,
cua-driver 0.30.4, `dsh-cua-driver.service` active) with `npm run test:live`:

- agent install over stdin on first contact, then reuse; `hello` reports the agent hash and Cua service;
- a job keeps running after the SSH call that started it closes; stdout/stderr stream by byte cursor;
  exit code is reported;
- cancel is `confirmed`, and an independent probe job confirms the process group is gone; a job that
  ignores SIGTERM is killed and reported with `signal: SIGKILL`;
- jobs are bound to their owner (another owner gets `job_not_owned`);
- 4 KiB binary file round trip with matching sha256; reads outside `fileRoots` are refused;
- Cua `get_desktop_state` screenshot: PNG 1280×804 of a 1512×950 display, `frame_scale` 1.18125, with
  `capture_id`; the Cua session used is ended afterwards.

Offline (`npm test`, no network): the same transport and agent are exercised through
`test/fixtures/fake-ssh.mjs`, which runs the remote command locally under a temporary `HOME`, including
a lost `exec_start` reply, an unreachable host, abort mid-call and hostile host names.

Fixed while testing: a cancel whose SIGTERM landed between two supervisor polls was reported as
`finished_before_cancel`; job output and agent state were world-readable; files created by
`file_write` were always mode 0600.

Not usable yet:

- The DSH plugin itself: no `index.js`/tools (`computer_*`), no right-panel `client.js`, no
  `cordis.patch.yml`/`dsh` manifest in `package.json`. Only the transport and agent exist.
- Cua input on Omarchy is known to fail (`production Hyprland input plugin is unavailable`); only the
  screenshot path has been tried. `cua`/`cua_schema` ops are untested on a real machine.
- macOS remotes are untested (the offline suite runs the agent on macOS locally only).
- Job directories are never garbage-collected.

## Checks

- `npm test` — offline, must pass without any remote computer.
- `npm run test:live` — `DSH_REMOTE_LIVE=1`; host from `DSH_REMOTE_LIVE_HOST` (default `omarchy`). Creates
  files only under `~/dsh-remote-test/<run>/` and `~/.local/state/dsh-computer/` and removes them after.
