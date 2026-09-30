#!/usr/bin/env python3
# Stand-in for cua-driver in offline tests. Supports `--version`, `describe <tool>` and
# `call <tool> <json>` for a few tools; every call is appended to $HOME/cua.log as JSON.
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
}


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
        if tool == "get_desktop_state":
            with open(arguments["screenshot_out_file"], "wb") as handle:
                handle.write(png(4, 3))
            print(json.dumps({"capture_id": "capture_fake_1", "screenshot_width": 4, "screenshot_height": 3,
                              "screen_width": 8, "screen_height": 6, "frame_scale": 2.0, "scale_factor": 1,
                              "screenshot_file_path": arguments["screenshot_out_file"],
                              "windows": [{"window_id": 7, "pid": 42, "app_name": "foot", "title": "term",
                                           "bounds": {"x": 0, "y": 0, "width": 8, "height": 6}}]}))
            return 0
        if tool == "list_windows":
            print(json.dumps({"windows": [{"window_id": 7, "title": "term"}], "session": arguments.get("session")}))
            return 0
        if tool == "end_session":
            print(json.dumps({"ended": arguments.get("session")}))
            return 0
        print("production Hyprland input plugin is unavailable", file=sys.stderr)
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
