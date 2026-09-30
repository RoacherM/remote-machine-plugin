#!/usr/bin/env python3
# Stand-in for cua-driver in offline tests. Supports `--version`, `describe <tool>` and
# `call <tool> <json>` for a few tools; every call is appended to $HOME/cua.log as JSON.
import base64
import json
import os
import struct
import sys
import zlib

SCHEMAS = {
    "get_desktop_state": {"type": "object", "additionalProperties": False, "properties": {
        "max_image_dimension": {"type": "integer"}, "screenshot_out_file": {"type": "string"}, "session": {"type": "string"}}},
    "list_windows": {"type": "object", "additionalProperties": False, "properties": {"session": {"type": "string"}}},
    "click": {"type": "object", "additionalProperties": False, "required": ["x", "y"], "properties": {
        "x": {"type": "number"}, "y": {"type": "number"}, "session": {"type": "string"}}},
    "end_session": {"type": "object", "properties": {"session": {"type": "string"}}},
    "start_session": {"type": "object", "properties": {"session": {"type": "string"}}},
    "list_apps": {"type": "object", "additionalProperties": False, "properties": {}},
    # Like the real zoom: no `session` in its schema, yet it needs the session's earlier window capture.
    "zoom": {"type": "object", "additionalProperties": False, "required": ["window_id", "x1", "y1", "x2", "y2"], "properties": {
        "pid": {"type": "integer"}, "window_id": {"type": "integer"}, "x1": {"type": "number"}, "y1": {"type": "number"},
        "x2": {"type": "number"}, "y2": {"type": "number"}}},
    "get_window_state": {"type": "object", "additionalProperties": False, "required": ["pid", "window_id"], "properties": {
        "pid": {"type": "integer"}, "window_id": {"type": "integer"}, "screenshot_out_file": {"type": "string"},
        "include_screenshot": {"type": "boolean"}, "session": {"type": "string"}}},
    "get_accessibility_tree": {"type": "object", "additionalProperties": False, "properties": {}},
}

# Like the real Driver: an ended session label is refused until start_session revives it.
ENDED = os.path.join(os.path.expanduser("~"), "cua-ended-sessions")


def ended():
    try:
        with open(ENDED) as handle:
            return set(handle.read().split())
    except OSError:
        return set()


def set_ended(labels):
    with open(ENDED, "w") as handle:
        handle.write("\n".join(sorted(labels)))


def noise(n):
    return [{"name": "kworker/%d" % i, "pid": 100 + i} for i in range(n)]


def png(width, height):
    rows = b"".join(b"\x00" + b"\x80\x40\x20" * width for _ in range(height))
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def main():
    args = sys.argv[1:]
    with open(os.path.join(os.path.expanduser("~"), "cua.log"), "a") as log:
        log.write(json.dumps(args) + "\n")
    if args == ["--version"]:
        print("cua-driver 0.0.0-fake")
        return 0
    if len(args) == 2 and args[0] == "describe":
        if args[1] not in SCHEMAS:
            print("unknown tool %s" % args[1], file=sys.stderr)
            return 1
        print("name: %s\n\ninput_schema:\n%s" % (args[1], json.dumps(SCHEMAS[args[1]], indent=2)))
        return 0
    if len(args) == 3 and args[0] == "call":
        tool, arguments = args[1], json.loads(args[2])
        session = arguments.get("session")
        if tool == "start_session":
            set_ended(ended() - {session})
            print(json.dumps({"active": True, "session": session}))
            return 0
        if session and session in ended() and tool != "end_session":
            print("session has ended; tool call '%s' was rejected. Call start_session with session '%s' to start it again, or use a new session label." % (tool, session), file=sys.stderr)
            return 1
        if tool == "list_apps":
            kernel = [dict(p, active=False, bundle_id=None, kind=None, last_used=None, launch_path=None, running=True, windows=[]) for p in noise(300)]
            desktop = [
                {"name": "Foot Server", "pid": 42, "kind": "desktop", "bundle_id": "foot-server", "running": True, "active": False,
                 "launch_path": "foot --server", "last_used": None, "windows": [{"window_id": 7, "title": "term"}]},
                {"name": "Chromium", "pid": 0, "kind": "desktop", "bundle_id": "chromium", "running": False, "active": False,
                 "launch_path": "/usr/bin/chromium", "last_used": None, "windows": []},
            ]
            print(json.dumps({"apps": kernel + desktop, "processes": noise(300)}))
            return 0
        captured = os.path.join(os.path.expanduser("~"), "cua-window-captures")
        if tool == "get_window_state":
            if arguments.get("screenshot_out_file"):
                with open(arguments["screenshot_out_file"], "wb") as handle:
                    handle.write(png(4, 3))
            with open(captured, "a") as handle:
                handle.write("%s %s\n" % (session, arguments["window_id"]))
            print(json.dumps({"window_id": arguments["window_id"], "snapshot_id": "s1", "capture_id": "capture_win_1",
                              "screenshot_file_path": arguments.get("screenshot_out_file"), "elements": []}))
            return 0
        if tool == "zoom":
            try:
                known = set(open(captured).read().split("\n"))
            except OSError:
                known = set()
            if "%s %s" % (session, arguments["window_id"]) not in known:
                print(json.dumps({"code": "screenshot_context_missing", "window_id": arguments["window_id"]}, indent=2), file=sys.stderr)
                return 1
            jpeg = b"\xff\xd8\xff\xe0" + bytes(40)
            print(json.dumps({"format": "jpeg", "mime_type": "image/jpeg", "screenshot_png_b64": base64.b64encode(jpeg).decode()}))
            return 0
        if tool == "get_accessibility_tree":
            print(json.dumps({"processes": noise(300), "windows": []}))
            return 0
        if tool == "get_desktop_state":
            with open(arguments["screenshot_out_file"], "wb") as handle:
                handle.write(png(4, 3))
            # Capture ids count up per HOME: capture_fake_1, capture_fake_2, ...
            count = sum(1 for line in open(os.path.join(os.path.expanduser("~"), "cua.log"))
                        if line.startswith('["call", "get_desktop_state"'))
            state = {"capture_id": "capture_fake_%d" % count, "screenshot_width": 4, "screenshot_height": 3,
                     "screen_width": 8, "screen_height": 6, "frame_scale": 2.0, "scale_factor": 1,
                     "screenshot_file_path": arguments["screenshot_out_file"],
                     "windows": [{"window_id": 7, "pid": 42, "app_name": "foot", "title": "term",
                                  "bounds": {"x": 0, "y": 0, "width": 8, "height": 6}}]}
            # Like the macOS Driver (0.30.4): no frame_scale and no windows with the desktop capture.
            if os.path.exists(os.path.join(os.path.expanduser("~"), "cua-macos")):
                del state["frame_scale"], state["windows"]
                state["platform"] = "macos"
            print(json.dumps(state))
            return 0
        if tool == "list_windows":
            print(json.dumps({"windows": [{"window_id": 7, "title": "term"}], "session": arguments.get("session")}))
            return 0
        if tool == "end_session":
            set_ended(ended() | {session})
            print(json.dumps({"ended": session}))
            return 0
        print("production Hyprland input plugin is unavailable", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
