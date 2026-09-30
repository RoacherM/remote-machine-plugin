#!/usr/bin/env python3
# Stand-in for macOS `ioreg -n Root -d1 -a` in offline tests, so the agent's lock check does not
# depend on whether the developer's own Mac is locked. The console session is locked while
# $HOME/ioreg-locked exists.
import os
import plistlib
import sys

locked = os.path.exists(os.path.join(os.path.expanduser("~"), "ioreg-locked"))
sys.stdout.buffer.write(plistlib.dumps({"IOConsoleUsers": [{
    "kCGSSessionUserIDKey": os.getuid(), "kCGSSessionOnConsoleKey": True, "CGSSessionScreenIsLocked": locked,
}]}))
