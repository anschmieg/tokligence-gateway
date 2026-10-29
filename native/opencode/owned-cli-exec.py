#!/usr/bin/env python3
"""Exec a native reference process that cannot outlive its owning driver."""
import ctypes
import os
import signal
import sys


def main():
    if len(sys.argv) < 5 or sys.argv[1] != '--parent' or sys.argv[3] != '--': return 125
    parent = int(sys.argv[2]); command = sys.argv[4:]
    # Set this in a dedicated single-threaded exec wrapper, not preexec_fn in
    # the multithreaded meter process. Check the parent-death setup race.
    if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent: return 125
    os.execvpe(command[0], command, os.environ)


if __name__ == '__main__': raise SystemExit(main())
