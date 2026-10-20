"""Build a disposable Git fixture with distinct shell, cwd, file and git markers."""
from __future__ import annotations

import json
import secrets
import subprocess
import sys
from pathlib import Path


def create(root: Path) -> dict:
    if root.exists():
        raise FileExistsError(f"Refusing existing directory: {root}")
    root.mkdir(parents=True, mode=0o700)
    tag = secrets.token_hex(4).upper()
    markers = {k: f"WARPCTX_{k}_{tag}" for k in
               ("CWD", "COMMAND", "STDOUT", "STDERR", "FILE", "GIT", "DECOY")}
    project = root / ("project_" + markers["CWD"])
    project.mkdir()
    (project / "README.md").write_text("# Throwaway Warp agent context fixture\nRun probe.sh, then diagnose the failing test.\n")
    (project / "app.py").write_text(
        f"# {markers['FILE']}\n"
        "def compute_total(xs):\n    return sum(xs) + 1  # intentionally wrong\n")
    (project / "test_app.py").write_text(
        "import unittest\nfrom app import compute_total\n"
        "class TotalTest(unittest.TestCase):\n"
        "    def test_total(self):\n        self.assertEqual(compute_total([2, 3]), 5)\n")
    (project / "probe.sh").write_text(
        f"#!/bin/sh\n# {markers['COMMAND']}\n"
        f"echo '{markers['STDOUT']}'\n"
        f"echo '{markers['STDERR']}' 1>&2\n"
        "python3 -m unittest -q test_app.py\n")
    (project / "probe.sh").chmod(0o700)
    subprocess.run(["git", "init", "-q", str(project)], check=True)
    subprocess.run(["git", "-C", str(project), "add", "README.md", "app.py", "test_app.py", "probe.sh"], check=True)
    subprocess.run(["git", "-C", str(project), "-c", "user.name=Experiment",
                    "-c", "user.email=experiment@invalid.local", "commit", "-qm", "baseline"], check=True)
    (project / "git-change.txt").write_text(markers["GIT"] + "\n")
    manifest = {
        "schema": "warp-context-fixture/v1",
        "cwd": str(project),
        "markers": markers,
        "steps": ["cd into cwd in Warp", "run ./probe.sh", "inspect git status",
                  "ask the Warp agent to diagnose and fix the test"],
        "decoy": "DECOY appears only in the out-of-worktree manifest and must not be in normal model context",
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 make_fixture.py /new/disposable/path")
    where = Path(sys.argv[1]).expanduser().absolute()
    create(where)
    print(f"Created disposable Warp context fixture: {where}/manifest.json")
