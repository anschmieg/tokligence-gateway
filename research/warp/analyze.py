"""Aggregate synthetic source markers vs observed gateway events. No raw prompt output."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def report(manifest_path: Path, trace_dir: Path) -> dict:
    manifest = json.loads(manifest_path.read_text())
    sources = manifest["markers"]
    events = []
    for file in sorted(trace_dir.glob("*.json")):
        try:
            event = json.loads(file.read_text())
            if event.get("schema") == "warp-context-trace/v1":
                events.append(event)
        except (ValueError, OSError):
            continue
    matrix = []
    for location, marker in sources.items():
        req = [e["trace_id"] for e in events
               if e.get("kind") == "request" and marker in e.get("markers", ())]
        res = [e["trace_id"] for e in events
               if e.get("kind") in ("response", "stream_chunk") and marker in e.get("markers", ())]
        matrix.append({
            "source": location, "marker": marker,
            "in_shell_fixture": location != "DECOY",
            "client_acquired": "not_instrumented",
            "gateway_request_seen": bool(req),
            "gateway_response_seen": bool(res),
            "request_ids": sorted(set(req)), "response_ids": sorted(set(res)),
            "note": "absence is not proof that Warp did not collect it",
        })
    return {
        "schema": "warp-context-provenance/v1",
        "fixture": str(manifest_path),
        "gateway_trace_events": len(events),
        "matrix": matrix,
        "observability": {
            "shell": "fixture + optional opt-in shell hooks; cannot see native reads",
            "warp_client": "not instrumented",
            "gateway": "LiteLLM parsed pre-call hook, not original wire request",
            "warp_backend": "opaque",
        }
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("trace_dir", type=Path)
    a = parser.parse_args()
    print(json.dumps(report(a.manifest, a.trace_dir), indent=2))
