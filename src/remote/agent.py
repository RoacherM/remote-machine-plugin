#!/usr/bin/env python3
"""DSH Computer remote executor (P1 SSH transport).

The DSH host runs `python3 <this file>` over SSH, writes one JSON request to stdin and reads one
JSON response from stdout: {"ok": true, "result": ...} or {"ok": false, "error": {"code", "message"}}.
Diagnostics go to stderr only. Standard library only; no user data ever travels in the SSH command
line. Jobs are supervised by a detached process (`--supervise <dir>`) so a dropped SSH connection
neither kills nor "cancels" them: cancellation is an explicit request whose effect is verified.
"""
import base64
import hashlib
import json
import os
import platform
import pwd
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

AGENT_VERSION = 1
STATE_DIR = os.path.join(os.path.expanduser("~"), ".local", "state", "dsh-computer")
JOBS_DIR = os.path.join(STATE_DIR, "jobs")
SHOTS_DIR = os.path.join(STATE_DIR, "shots")
KILL_GRACE_S = 3.0
MAX_READ_BYTES = 4 * 1024 * 1024
MAX_STATUS_WAIT_S = 20.0
MAX_JOB_ID_LEN = 80
# Finished jobs (output included) are removed this long after they ended; running jobs never are.
JOB_RETENTION_S = 7 * 24 * 3600
MIN_RETENTION_S = 300
# exec_start prunes at most this often; the stamp's name cannot be a job id.
PRUNE_INTERVAL_S = 3600
PRUNE_STAMP = ".pruned"
# Screenshot files are handed back in the same call; one this old was left by an agent that died.
STALE_SHOT_S = 3600
# The login umask, before main() makes the agent's own files private; user commands run with it.
USER_UMASK = 0o022


class Fail(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def now_ms():
    return int(time.time() * 1000)


def agent_sha():
    with open(os.path.abspath(__file__), "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def boot_id():
    try:
        with open("/proc/sys/kernel/random/boot_id") as handle:
            return handle.read().strip()
    except OSError:
        # macOS: boot time is stable for one boot.
        try:
            out = subprocess.run(["sysctl", "-n", "kern.boottime"], capture_output=True, text=True, timeout=5).stdout
            return hashlib.sha256(out.encode()).hexdigest()[:32]
        except Exception:
            return "unknown"


def read_json(path):
    try:
        with open(path) as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def write_json_atomic(path, value):
    directory = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-")
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def pid_alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def signal_group(pgid, sig):
    """True if the signal was delivered. EPERM (macOS while the group's members are exiting; Linux when
    the group holds another user's process, e.g. after sudo) is "not delivered", never an exception:
    callers keep waiting, and group_alive still counts such a group as alive, so nothing is confirmed."""
    try:
        os.killpg(pgid, sig)
        return True
    except (ProcessLookupError, PermissionError):
        return False


def sha256_file(path, limit=None):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        remaining = limit
        while True:
            chunk = handle.read(1 << 20 if remaining is None else min(1 << 20, remaining))
            if not chunk:
                break
            digest.update(chunk)
            if remaining is not None:
                remaining -= len(chunk)
                if remaining <= 0:
                    break
    return digest.hexdigest()


def decode_utf8_prefix(data):
    """Decode as much of `data` as ends on a character boundary; returns (text, bytes_used)."""
    try:
        return data.decode("utf-8"), len(data)
    except UnicodeDecodeError as error:
        # A character split by the read limit: stop before it, the next read starts there.
        if error.reason == "unexpected end of data" and error.start >= len(data) - 3 and error.start > 0:
            return data[:error.start].decode("utf-8", errors="replace"), error.start
        return data.decode("utf-8", errors="replace"), len(data)


# ---------------------------------------------------------------- hello

def op_hello(req):
    cua_path = os.path.expanduser(req.get("cua_path") or "~/.local/bin/cua-driver")
    cua = {"path": cua_path, "exists": os.access(cua_path, os.X_OK)}
    if cua["exists"]:
        try:
            out = subprocess.run([cua_path, "--version"], capture_output=True, text=True, timeout=10)
            cua["version"] = out.stdout.strip().split("\n")[0]
        except Exception as error:  # noqa: BLE001
            cua["version_error"] = str(error)
    service = req.get("cua_service")
    if service and shutil.which("systemctl"):
        out = subprocess.run(["systemctl", "--user", "is-active", service], capture_output=True, text=True, timeout=10)
        cua["service"] = service
        cua["service_state"] = out.stdout.strip() or out.stderr.strip()
    socket_path = req.get("cua_socket")
    if socket_path:
        socket_path = os.path.expanduser(socket_path)
        cua["socket"] = socket_path
        cua["socket_exists"] = os.path.exists(socket_path)
    hostname = platform.node()
    try:
        with open("/etc/hostname") as handle:
            hostname = handle.read().strip() or hostname
    except OSError:
        pass
    work_root = req.get("work_root")
    if work_root:
        os.makedirs(os.path.expanduser(work_root), exist_ok=True)
    return {
        "agent_version": AGENT_VERSION,
        "agent_sha256": agent_sha(),
        "user": pwd.getpwuid(os.getuid()).pw_name,
        "home": os.path.expanduser("~"),
        "hostname": hostname,
        "system": platform.system(),
        "machine": platform.machine(),
        "release": platform.release(),
        "python": platform.python_version(),
        "boot_id": boot_id(),
        "time_ms": now_ms(),
        "cua": cua,
        "desktop_env": {k: os.environ.get(k) for k in ("WAYLAND_DISPLAY", "DISPLAY", "XDG_SESSION_TYPE") if os.environ.get(k)},
    }


# ---------------------------------------------------------------- jobs

def job_dir(job_id):
    if not isinstance(job_id, str) or not job_id or len(job_id) > MAX_JOB_ID_LEN or not all(c.isalnum() or c in "-_" for c in job_id):
        raise Fail("invalid_job_id", "job_id must be 1-80 characters of [A-Za-z0-9_-]")
    return os.path.join(JOBS_DIR, job_id)


def load_job(req):
    directory = job_dir(req.get("job_id"))
    meta = read_json(os.path.join(directory, "meta.json"))
    if meta is None:
        raise Fail("job_not_found", "no job %s on this computer (finished jobs are removed %d days after they end)"
                   % (req.get("job_id"), JOB_RETENTION_S // 86400))
    if meta.get("owner") != req.get("owner"):
        raise Fail("job_not_owned", "job %s belongs to another DSH session" % req.get("job_id"))
    return directory, meta


def job_state(directory, meta):
    exit_info = read_json(os.path.join(directory, "exit.json"))
    started = read_json(os.path.join(directory, "started.json"))
    state = {"started": started, "exit": exit_info}
    if exit_info is not None:
        state["state"] = exit_info.get("state", "exited")
        return state
    if meta.get("boot_id") != boot_id():
        state["state"] = "lost"
        state["reason"] = "the computer restarted after this job started; its outcome is unknown"
        return state
    sup = read_json(os.path.join(directory, "supervisor.json"))
    if sup is not None and pid_alive(sup.get("pid", -1)):
        state["state"] = "running" if started is not None else "starting"
        return state
    if started is not None and group_alive(started["pgid"]):
        state["state"] = "running"
        state["reason"] = "supervisor is gone but the job's process group is still alive"
        return state
    state["state"] = "lost"
    state["reason"] = "supervisor ended without recording an exit status"
    return state


def op_exec_start(req):
    argv = req.get("argv")
    script = req.get("shell_script")
    if (argv is None) == (script is None):
        raise Fail("invalid_request", "give exactly one of argv or shell_script")
    if argv is not None and (not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv)):
        raise Fail("invalid_request", "argv must be a non-empty list of strings")
    cwd = os.path.expanduser(req.get("cwd") or "~")
    # The computer's configured work root (the default cwd) is created on first use; an explicit cwd must exist.
    if req.get("create_cwd") and not os.path.exists(cwd):
        os.makedirs(cwd, mode=0o700, exist_ok=True)
    if not os.path.isdir(cwd):
        raise Fail("cwd_not_found", "remote cwd does not exist: %s" % cwd)
    timeout_s = float(req.get("timeout_s") or 0)
    directory = job_dir(req.get("job_id"))
    os.makedirs(JOBS_DIR, exist_ok=True)
    try:
        os.mkdir(directory)
    except FileExistsError:
        # Same job id again (a retried request): report the existing job instead of starting twice.
        _, meta = load_job(req)
        state = job_state(directory, meta)
        return {"job_id": req["job_id"], "duplicate": True, "state": state["state"]}
    meta = {
        "job_id": req["job_id"], "owner": req.get("owner"), "computer_id": req.get("computer_id"),
        "argv": argv, "shell_script": script, "shell": req.get("shell") or "/bin/bash",
        "cwd": os.path.realpath(cwd), "timeout_s": timeout_s, "created_ms": now_ms(), "boot_id": boot_id(),
        "umask": USER_UMASK,
    }
    write_json_atomic(os.path.join(directory, "meta.json"), meta)
    subprocess.Popen(
        [sys.executable, os.path.abspath(__file__), "--supervise", directory],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True, close_fds=True,
    )
    deadline = time.time() + 5
    while time.time() < deadline:
        if os.path.exists(os.path.join(directory, "started.json")) or os.path.exists(os.path.join(directory, "exit.json")):
            break
        time.sleep(0.05)
    state = job_state(directory, meta)
    # After the job has started, so housekeeping never delays or blocks it.
    maybe_prune()
    return {"job_id": req["job_id"], "state": state["state"], "pid": (state["started"] or {}).get("pid"), "cwd": meta["cwd"],
            "exit": state["exit"]}


def prune_state(retention_s):
    """Removes jobs that ended more than `retention_s` ago, and screenshot files left by dead agents.

    A job is kept while it is running or starting and while its process group is still alive. A job that
    never recorded an end (lost) counts from its creation; a directory without meta.json (a start that
    died half-way) from its mtime. `retention_s` is at least MIN_RETENTION_S so a job that is being
    created right now (meta written, supervisor not yet up, so it looks lost) is never removed.
    """
    retention_s = max(float(retention_s), MIN_RETENTION_S)
    now = time.time()
    removed = []
    kept = 0
    try:
        names = sorted(os.listdir(JOBS_DIR))
    except OSError:
        names = []
    for name in names:
        try:
            directory = job_dir(name)
        except Fail:
            continue  # the prune stamp and anything else that cannot be a job id
        try:
            if not stat.S_ISDIR(os.lstat(directory).st_mode):
                continue
            meta = read_json(os.path.join(directory, "meta.json"))
            if meta is None:
                ended_s = os.lstat(directory).st_mtime
            else:
                state = job_state(directory, meta)
                started = state["started"]
                if state["state"] in ("running", "starting") or (started is not None and group_alive(started["pgid"])):
                    kept += 1
                    continue
                ended_s = ((state["exit"] or {}).get("finished_ms") or meta.get("created_ms") or 0) / 1000.0
        except OSError:
            continue
        if now - ended_s < retention_s:
            kept += 1
            continue
        shutil.rmtree(directory, ignore_errors=True)
        if not os.path.lexists(directory):
            removed.append(name)
    shots_removed = 0
    try:
        shot_names = os.listdir(SHOTS_DIR)
    except OSError:
        shot_names = []
    for name in shot_names:
        path = os.path.join(SHOTS_DIR, name)
        try:
            info = os.lstat(path)
            if stat.S_ISREG(info.st_mode) and now - info.st_mtime >= STALE_SHOT_S:
                os.unlink(path)
                shots_removed += 1
        except OSError:
            continue
    return {"removed": removed, "kept": kept, "shots_removed": shots_removed, "retention_s": retention_s}


def maybe_prune():
    """Prunes with the default retention at most once per PRUNE_INTERVAL_S. Never fails the caller."""
    stamp = os.path.join(JOBS_DIR, PRUNE_STAMP)
    try:
        if time.time() - os.path.getmtime(stamp) < PRUNE_INTERVAL_S:
            return None
    except OSError:
        pass
    try:
        with open(stamp, "a"):
            pass
        os.utime(stamp, None)
        return prune_state(JOB_RETENTION_S)
    except Exception:  # noqa: BLE001
        return None


def op_prune(req):
    return prune_state(req.get("retention_s") if req.get("retention_s") is not None else JOB_RETENTION_S)


def supervise(directory):
    meta = read_json(os.path.join(directory, "meta.json"))
    write_json_atomic(os.path.join(directory, "supervisor.json"), {"pid": os.getpid()})
    out = open(os.path.join(directory, "stdout"), "wb")
    err = open(os.path.join(directory, "stderr"), "wb")
    command = meta["argv"] if meta.get("argv") else [meta.get("shell") or "/bin/bash", "-c", meta["shell_script"]]
    try:
        os.umask(meta.get("umask", 0o022))
        child = subprocess.Popen(command, cwd=meta["cwd"], stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                 start_new_session=True, close_fds=True)
    except OSError as error:
        write_json_atomic(os.path.join(directory, "exit.json"),
                          {"state": "failed_to_start", "error": str(error), "finished_ms": now_ms()})
        return
    pgid = child.pid
    write_json_atomic(os.path.join(directory, "started.json"), {"pid": child.pid, "pgid": pgid, "started_ms": now_ms()})
    timeout_s = meta.get("timeout_s") or 0
    deadline = time.time() + timeout_s if timeout_s > 0 else None
    cancel_path = os.path.join(directory, "cancel")
    reason = None
    term_at = None
    while True:
        code = child.poll()
        if code is not None:
            # A cancel request can land between two polls with its signal already delivered (the child may
            # also exit 0 from a TERM trap); the recorded exit code/signal still says how it ended.
            if reason is None and os.path.exists(cancel_path):
                reason = "cancelled"
            break
        if reason is None and os.path.exists(cancel_path):
            reason = "cancelled"
        if reason is None and deadline is not None and time.time() >= deadline:
            reason = "timed_out"
        if reason is not None and term_at is None:
            signal_group(pgid, signal.SIGTERM)
            term_at = time.time()
        if term_at is not None and time.time() - term_at >= KILL_GRACE_S:
            signal_group(pgid, signal.SIGKILL)
        time.sleep(0.1)
    # The direct child is done; stop stragglers it left in its group when we were asked to stop it.
    if reason is not None and group_alive(pgid):
        signal_group(pgid, signal.SIGTERM)
        end = time.time() + KILL_GRACE_S
        while time.time() < end and group_alive(pgid):
            time.sleep(0.1)
        if group_alive(pgid):
            signal_group(pgid, signal.SIGKILL)
            time.sleep(0.2)
    out.close()
    err.close()
    info = {"state": reason or "exited", "finished_ms": now_ms(), "group_remaining": group_alive(pgid)}
    if code < 0:
        info["signal"] = signal.Signals(-code).name if -code in signal.valid_signals() else -code
    else:
        info["exit_code"] = code
    write_json_atomic(os.path.join(directory, "exit.json"), info)


def read_stream(directory, name, cursor, limit):
    path = os.path.join(directory, name)
    try:
        size = os.path.getsize(path)
    except OSError:
        return {"text": "", "cursor": cursor, "size": 0, "more": False}
    cursor = max(0, min(int(cursor or 0), size))
    with open(path, "rb") as handle:
        handle.seek(cursor)
        data = handle.read(limit)
    text, used = decode_utf8_prefix(data)
    return {"text": text, "cursor": cursor + used, "size": size, "more": cursor + used < size}


def op_exec_status(req):
    directory, meta = load_job(req)
    limit = max(1, min(int(req.get("max_bytes") or 65536), 1024 * 1024))
    wait_s = max(0.0, min(float(req.get("wait_s") or 0), MAX_STATUS_WAIT_S))
    stdout_cursor = int(req.get("stdout_cursor") or 0)
    stderr_cursor = int(req.get("stderr_cursor") or 0)
    end = time.time() + wait_s
    while True:
        state = job_state(directory, meta)
        if state["state"] not in ("running", "starting") or time.time() >= end:
            break
        grown = any(os.path.exists(os.path.join(directory, n)) and os.path.getsize(os.path.join(directory, n)) > c
                    for n, c in (("stdout", stdout_cursor), ("stderr", stderr_cursor)))
        if grown:
            break
        time.sleep(0.2)
    # Read output after the state so a finished job's output is complete.
    return {
        "job_id": meta["job_id"], "state": state["state"], "reason": state.get("reason"), "exit": state["exit"],
        "started": state["started"], "cwd": meta["cwd"], "created_ms": meta["created_ms"],
        "stdout": read_stream(directory, "stdout", stdout_cursor, limit),
        "stderr": read_stream(directory, "stderr", stderr_cursor, limit),
    }


def op_exec_cancel(req):
    directory, meta = load_job(req)
    state = job_state(directory, meta)
    if state["state"] not in ("running", "starting"):
        return {"job_id": meta["job_id"], "cancel": "not_running", "state": state["state"], "exit": state["exit"]}
    with open(os.path.join(directory, "cancel"), "w") as handle:
        handle.write(str(now_ms()))
    started = state["started"] or read_json(os.path.join(directory, "started.json"))
    if started is not None:
        signal_group(started["pgid"], signal.SIGTERM)
    wait_s = max(1.0, min(float(req.get("wait_s") or 8), MAX_STATUS_WAIT_S))
    end = time.time() + wait_s
    killed = False
    while time.time() < end:
        state = job_state(directory, meta)
        if state["state"] not in ("running", "starting"):
            break
        started = started or read_json(os.path.join(directory, "started.json"))
        sup = read_json(os.path.join(directory, "supervisor.json"))
        supervisor_alive = sup is not None and pid_alive(sup.get("pid", -1))
        # Without a live supervisor nobody escalates: do it here.
        if started is not None and not supervisor_alive and not killed and time.time() > end - wait_s + KILL_GRACE_S:
            signal_group(started["pgid"], signal.SIGKILL)
            killed = True
        time.sleep(0.1)
    state = job_state(directory, meta)
    group = started is not None and group_alive(started["pgid"])
    if state["state"] == "cancelled" and not group:
        outcome = "confirmed"
    elif state["state"] in ("exited", "timed_out", "failed_to_start") and not group:
        outcome = "finished_before_cancel"
    elif state["state"] in ("running", "starting") or group:
        outcome = "cancelling"
    else:
        outcome = "unknown"
    return {"job_id": meta["job_id"], "cancel": outcome, "state": state["state"], "exit": state["exit"],
            "process_group_alive": group, "reason": state.get("reason")}


# ---------------------------------------------------------------- files

def resolve_in_roots(path, roots, for_write):
    if not isinstance(path, str) or not path or "\0" in path:
        raise Fail("invalid_path", "a remote path is required")
    if not roots:
        raise Fail("files_unavailable", "no file roots are configured for this computer")
    expanded = os.path.expanduser(path)
    if not os.path.isabs(expanded):
        raise Fail("invalid_path", "remote paths must be absolute or start with ~/: %s" % path)
    real_roots = [os.path.realpath(os.path.expanduser(r)) for r in roots]
    if for_write:
        parent = os.path.dirname(os.path.normpath(expanded))
        target = os.path.join(os.path.realpath(parent), os.path.basename(os.path.normpath(expanded)))
        check = os.path.realpath(parent)
    else:
        target = os.path.realpath(expanded)
        check = target
    for root in real_roots:
        if check == root or check.startswith(root.rstrip("/") + "/"):
            return target, root
    raise Fail("path_outside_roots", "%s resolves to %s, outside the allowed roots %s" % (path, check, ", ".join(real_roots)))


def op_file_read(req):
    target, _ = resolve_in_roots(req.get("path"), req.get("roots"), False)
    if not os.path.exists(target):
        raise Fail("not_found", "no such file: %s" % target)
    if not os.path.isfile(target):
        raise Fail("not_a_file", "not a regular file: %s" % target)
    size = os.path.getsize(target)
    offset = max(0, int(req.get("offset") or 0))
    limit = max(0, min(int(req.get("max_bytes") or 1024 * 1024), MAX_READ_BYTES))
    with open(target, "rb") as handle:
        handle.seek(offset)
        data = handle.read(limit)
    return {"path": target, "size": size, "offset": offset, "bytes": len(data), "eof": offset + len(data) >= size,
            "sha256": sha256_file(target), "data_b64": base64.b64encode(data).decode("ascii"),
            "mtime_ms": int(os.path.getmtime(target) * 1000)}


def op_file_write(req):
    target, root = resolve_in_roots(req.get("path"), req.get("roots"), True)
    data = base64.b64decode(req.get("data_b64") or "", validate=True)
    if len(data) > MAX_READ_BYTES:
        raise Fail("too_large", "writes are limited to %d bytes in P1" % MAX_READ_BYTES)
    parent = os.path.dirname(target)
    if not os.path.isdir(parent):
        if not req.get("mkdirs"):
            raise Fail("parent_missing", "parent directory does not exist: %s" % parent)
        os.makedirs(parent, exist_ok=True)
        # Re-check after creating: an intermediate symlink could have redirected it.
        if not (os.path.realpath(parent) == root or os.path.realpath(parent).startswith(root.rstrip("/") + "/")):
            raise Fail("path_outside_roots", "parent resolved outside the allowed roots")
    if os.path.islink(target):
        raise Fail("symlink_target", "refusing to write through a symbolic link: %s" % target)
    if os.path.exists(target) and not os.path.isfile(target):
        raise Fail("not_a_file", "exists and is not a regular file: %s" % target)
    existed = os.path.exists(target)
    if existed and not req.get("overwrite"):
        raise Fail("exists", "file exists and overwrite is false: %s" % target)
    expected = req.get("expected_sha256")
    if expected and existed and sha256_file(target) != expected:
        raise Fail("conflict", "file changed since it was read (sha256 mismatch)")
    fd, tmp = tempfile.mkstemp(dir=parent, prefix=".dsh-write-")
    try:
        # mkstemp makes 0600 files: keep an overwritten file's mode, give new ones the login umask.
        os.chmod(tmp, (os.stat(target).st_mode & 0o7777) if existed else (0o666 & ~USER_UMASK))
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if existed:
            os.replace(tmp, target)
        else:
            try:
                os.link(tmp, target)  # atomic create-only: fails if someone created it meanwhile
            except FileExistsError:
                raise Fail("exists", "file was created concurrently: %s" % target)
            os.unlink(tmp)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return {"path": target, "size": len(data), "sha256": hashlib.sha256(data).hexdigest(), "created": not existed}


# ---------------------------------------------------------------- Cua

SESSION_ENDED = "session has ended"


def cua_run(cua_path, tool, arguments, timeout_s):
    """Runs one Cua tool. The Driver ends idle sessions and then refuses the label until start_session
    revives it; the plugin's labels are stable per DSH session, so revive once and retry."""
    try:
        return cua_run_once(cua_path, tool, arguments, timeout_s)
    except Fail as error:
        session = arguments.get("session")
        if not session or tool in ("start_session", "end_session") or SESSION_ENDED not in error.message:
            raise
    cua_run_once(cua_path, "start_session", {"session": session}, 15)
    return cua_run_once(cua_path, tool, arguments, timeout_s)


def cua_run_once(cua_path, tool, arguments, timeout_s):
    cua_path = os.path.expanduser(cua_path or "~/.local/bin/cua-driver")
    if not os.access(cua_path, os.X_OK):
        raise Fail("cua_unavailable", "Cua driver not found at %s" % cua_path)
    try:
        out = subprocess.run([cua_path, "call", tool, json.dumps(arguments)], capture_output=True, text=True,
                             timeout=timeout_s)
    except subprocess.TimeoutExpired:
        raise Fail("cua_timeout", "cua-driver %s did not answer within %ss" % (tool, timeout_s))
    text = out.stdout.strip()
    try:
        value = json.loads(text) if text else None
    except ValueError:
        value = None
    if out.returncode != 0:
        detail = (text or out.stderr.strip())[-4000:]
        raise Fail("cua_error", "cua-driver %s failed (exit %d): %s" % (tool, out.returncode, detail))
    if value is None:
        raise Fail("cua_error", "cua-driver %s returned non-JSON output: %s" % (tool, (text or out.stderr)[-2000:]))
    return value


def take_file(path):
    with open(path, "rb") as handle:
        data = handle.read()
    os.unlink(path)
    return base64.b64encode(data).decode("ascii"), len(data)


def op_screenshot(req):
    os.makedirs(SHOTS_DIR, mode=0o700, exist_ok=True)
    out = os.path.join(SHOTS_DIR, uuid.uuid4().hex + ".png")
    arguments = {"session": req["session"], "screenshot_out_file": out}
    if req.get("max_image_dimension"):
        arguments["max_image_dimension"] = int(req["max_image_dimension"])
    try:
        meta = cua_run(req.get("cua_path"), "get_desktop_state", arguments, 60)
        data, size = take_file(out)
    finally:
        if os.path.exists(out):
            os.unlink(out)
    meta.pop("screenshot_file_path", None)
    return {"meta": meta, "png_b64": data, "bytes": size, "time_ms": now_ms()}


def describe_schema(cua_path, tool):
    cua_path = os.path.expanduser(cua_path or "~/.local/bin/cua-driver")
    out = subprocess.run([cua_path, "describe", tool], capture_output=True, text=True, timeout=20)
    if out.returncode != 0 or "input_schema:" not in out.stdout:
        raise Fail("cua_unknown_tool", "cua-driver has no tool %s: %s" % (tool, (out.stdout + out.stderr)[-1000:]))
    return json.loads(out.stdout.split("input_schema:", 1)[1])


def op_cua_schema(req):
    return {"tool": req["tool"], "schema": describe_schema(req.get("cua_path"), req["tool"])}


def op_cua(req):
    tool = req["tool"]
    arguments = dict(req.get("arguments") or {})
    schema = describe_schema(req.get("cua_path"), tool)
    props = schema.get("properties") or {}
    if schema.get("additionalProperties") is False:
        unknown = [k for k in arguments if k not in props]
        if unknown:
            raise Fail("invalid_arguments", "unknown argument(s) for %s: %s. Schema: %s" % (tool, ", ".join(unknown), json.dumps(schema)))
    missing = [k for k in schema.get("required") or [] if k not in arguments and k != "session"]
    if missing:
        raise Fail("invalid_arguments", "missing argument(s) for %s: %s. Schema: %s" % (tool, ", ".join(missing), json.dumps(schema)))
    # Always the plugin-owned session, whether or not the tool's schema lists it: the Driver takes
    # `session` on every call, and without it a call lands in a throwaway session that lacks the
    # context of earlier calls (zoom after get_window_state fails with screenshot_context_missing).
    arguments["session"] = req["session"]
    image_path = None
    # An output file forces a capture, so leave it out when the caller turned screenshots off.
    if "screenshot_out_file" in props and arguments.get("include_screenshot") is not False:
        os.makedirs(SHOTS_DIR, mode=0o700, exist_ok=True)
        image_path = os.path.join(SHOTS_DIR, uuid.uuid4().hex + ".png")
        arguments["screenshot_out_file"] = image_path
    try:
        value = cua_run(req.get("cua_path"), tool, arguments, float(req.get("timeout_s") or 60))
        image = None
        if image_path and os.path.exists(image_path):
            data, size = take_file(image_path)
            image = {"png_b64": data, "bytes": size}
            if isinstance(value, dict):
                value.pop("screenshot_file_path", None)
        # zoom answers with the image inline (a JPEG despite the key name): pass it on as an image,
        # not as base64 text for the model to read.
        if image is None and isinstance(value, dict) and isinstance(value.get("screenshot_png_b64"), str):
            data = value.pop("screenshot_png_b64")
            image = {"png_b64": data, "bytes": len(base64.b64decode(data))}
    finally:
        if image_path and os.path.exists(image_path):
            os.unlink(image_path)
    return {"tool": tool, "value": value, "image": image}


def op_end_sessions(req):
    ended = []
    for session in req.get("sessions") or []:
        try:
            cua_run(req.get("cua_path"), "end_session", {"session": session}, 15)
            ended.append(session)
        except Fail:
            pass
    return {"ended": ended}


OPS = {
    "hello": op_hello, "exec_start": op_exec_start, "exec_status": op_exec_status, "exec_cancel": op_exec_cancel,
    "file_read": op_file_read, "file_write": op_file_write, "screenshot": op_screenshot, "cua": op_cua,
    "cua_schema": op_cua_schema, "end_sessions": op_end_sessions, "prune": op_prune,
}


def main():
    global USER_UMASK
    # Job output, screenshots and state are private to the remote user.
    USER_UMASK = os.umask(0o077)
    if len(sys.argv) == 3 and sys.argv[1] == "--supervise":
        supervise(sys.argv[2])
        return
    try:
        req = json.loads(sys.stdin.read())
        op = OPS.get(req.get("op"))
        if op is None:
            raise Fail("unknown_op", "unknown op %r" % req.get("op"))
        response = {"ok": True, "result": op(req)}
    except Fail as error:
        response = {"ok": False, "error": {"code": error.code, "message": error.message}}
    except Exception as error:  # noqa: BLE001
        response = {"ok": False, "error": {"code": "agent_exception", "message": "%s: %s" % (type(error).__name__, error)}}
    sys.stdout.write(json.dumps(response))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
