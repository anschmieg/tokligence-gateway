#!/usr/bin/env python3
"""Tokligence catalog watchdog.

Watches provider model catalogs (Cline free feed, OpenRouter) for changes that
affect gateway.routes.yaml, auto-applies mechanical renames/supersessions,
and queues ambiguous changes for human approval.

Auto-apply rule: a declared model that vanished from its provider's live
catalog is renamed to a unique same-family replacement (version bumps like
gpt-5.6-luna -> gpt-6-luna, deepseek-v4-flash -> deepseek-v4.1-flash). The
rename is applied everywhere the old id appears: routing profiles, provider
model lists, aliases (targets, fallbacks, patterns) and the test fixtures
that pin candidate names. Ambiguous or unverifiable cases (e.g. codex models,
which have no public feed) are queued in the state file and re-reported until
resolved with `--approve OLD=NEW`.

Every run also canaries each routing profile with a tiny completion and
alerts when a profile stops working.

Stdlib only. Run:  python3 tools/catalog_watchdog.py [--dry-run] [--approve OLD=NEW]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from dataclasses import dataclass, field, asdict
from pathlib import Path

REPO_DIR = Path(os.environ.get("WATCHDOG_REPO", "/home/ubuntu/tokligence-gateway"))
STATE_PATH = Path(os.environ.get("WATCHDOG_STATE",
                                 Path.home() / ".local/state/tokligence-watchdog/state.json"))
GATEWAY_URL = os.environ.get("TOKLIGENCE_GATEWAY_URL", "https://code.nothing.pink")
CANARY_PROFILES = ["agent-default", "agentic-worker", "free-pool"]
FIXTURE_GLOB = "test/*.mjs"

# Providers with a machine-readable live catalog that reflects model rotation.
# Values: (feed_url, id_normalizer)
FEEDS = {
    "cline-oauth": ("https://api.cline.bot/api/v1/ai/cline/recommended-models",
                    lambda i: i if i.startswith("cline/") else f"cline/{i}"),
    "openrouter": ("https://openrouter.ai/api/v1/models", lambda i: i),
}
# How a provider's public ids are styled in gateway.routes.yaml references.
PUBLIC_PREFIX = {"cline-oauth": "cline/", "openrouter": "openrouter/"}

# The codex upstream is CLIProxyAPI running inside the gateway container
# (127.0.0.1:8317, api-key = CODEX_PROXY_API_KEY). Its /v1/models reflects the
# models the OAuth accounts actually serve, so codex supersessions are
# feed-verifiable and auto-applyable like the public feeds.
CLIPROXY_PORT = os.environ.get("WATCHDOG_CLIPROXY_PORT", "8317")


@dataclass
class Ref:
    provider: str
    model: str
    kind: str  # candidate | provider_model | alias_target


@dataclass
class Rename:
    old: str
    new: str
    provider: str
    reason: str


@dataclass
class Ask:
    old: str
    provider: str
    options: list
    reason: str
    seen: int = 0


@dataclass
class WatchState:
    last_run: str = ""
    applied: list = field(default_factory=list)
    pending: list = field(default_factory=list)
    canary: dict = field(default_factory=dict)  # profile -> {ok:int, fail:int, last_error:str}

    def to_json(self) -> dict:
        return {"last_run": self.last_run,
                "applied": self.applied,
                "pending": [asdict(a) for a in self.pending],
                "canary": self.canary}

    @classmethod
    def from_json(cls, raw: dict) -> "WatchState":
        return cls(last_run=raw.get("last_run", ""),
                   applied=raw.get("applied", []),
                   pending=[Ask(**a) for a in raw.get("pending", [])],
                   canary=raw.get("canary", {}))


# ---------------------------------------------------------------- extraction

CANDIDATE_PROVIDER = re.compile(r"^\s*- provider:\s*(\S+)\s*(?:#.*)?$")
CANDIDATE_MODEL = re.compile(r"^\s+model:\s*(.+?)\s*(?:#.*)?$")
ALIAS_TARGET = re.compile(r"^\s*(target|fallback):\s*(.+?)\s*(?:#.*)?$")
TOP_LEVEL_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*:\s*(?:#.*)?$")
PROVIDER_ID = re.compile(r"^ {2}- id:\s*(\S+)\s*(?:#.*)?$")
MODEL_ENTRY = re.compile(r"^ {4,}-(?: id:\s*)?(\S+)\s*(?:#.*)?$")
INLINE_EMPTY_LIST = re.compile(r"^\s+models:\s*\[\s*\]\s*(?:#.*)?$")
MODELS_KEY = re.compile(r"^\s+models:\s*(?:#.*)?$")


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    return value


def extract_declared(routes_text: str) -> list[Ref]:
    refs: list[Ref] = []
    section = ""
    provider = ""
    in_models = False
    models_indent = 0
    alias_provider = ""
    alias_ids: set = set()
    lines = routes_text.splitlines()

    def _end_models(line: str) -> bool:
        return bool(re.match(r"^ {1,4}[A-Za-z_-]+\s*:", line)) and not MODELS_KEY.match(line)

    for i, line in enumerate(lines):
        if TOP_LEVEL_KEY.match(line):
            section = line.split(":", 1)[0]
            provider = ""
            in_models = False
            alias_provider = ""
            continue
        if section == "aliases" and re.match(r"^ {2}- id:", line):
            alias_ids.add(_unquote(line.split("id:", 1)[1]))

    for i, line in enumerate(lines):
        if TOP_LEVEL_KEY.match(line):
            section = line.split(":", 1)[0]
            provider = ""
            in_models = False
            alias_provider = ""
            continue
        if section == "providers":
            m = PROVIDER_ID.match(line)
            if m:
                provider = m.group(1)
                in_models = False
                continue
            inline = re.match(r"^\s+models:\s*\[(.+)\]\s*(?:#.*)?$", line)
            if inline:
                for item in inline.group(1).split(","):
                    item = _unquote(item)
                    if item:
                        refs.append(Ref(provider, item, "provider_model"))
                in_models = False
                continue
            if INLINE_EMPTY_LIST.match(line):
                in_models = False
                continue
            if MODELS_KEY.match(line):
                in_models = True
                models_indent = len(line) - len(line.lstrip())
                continue
            if in_models:
                m = MODEL_ENTRY.match(line)
                if m and not line.lstrip().startswith("- provider:"):
                    refs.append(Ref(provider, _unquote(m.group(1)), "provider_model"))
                elif _end_models(line):
                    in_models = False
        elif section == "profiles":
            m = CANDIDATE_PROVIDER.match(line)
            nxt = lines[i + 1] if i + 1 < len(lines) else ""
            mm = CANDIDATE_MODEL.match(nxt) if m else None
            if m and mm:
                refs.append(Ref(m.group(1), _unquote(mm.group(1)), "candidate"))
        elif section == "aliases":
            if re.match(r"^ {2}- id:", line):
                alias_provider = ""
            m = re.match(r"^\s+provider:\s*(\S+)\s*(?:#.*)?$", line)
            if m:
                alias_provider = m.group(1)
            m = ALIAS_TARGET.match(line)
            if m and alias_provider and m.group(2) not in alias_ids:
                refs.append(Ref(alias_provider, _unquote(m.group(2)), "alias_target"))
    # keep first occurrence per (provider, model, kind)
    seen = {}
    for r in refs:
        seen.setdefault((r.provider, r.model, r.kind), r)
    return list(seen.values())


# ---------------------------------------------------------------- family rule

def _skeleton(model_id: str) -> str:
    s = model_id.lower()
    s = re.sub(r"v?\d+(?:\.\d+)*", "#", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s


def _version_tuple(model_id: str):
    m = re.search(r"\d+(?:\.\d+)*", model_id)
    return tuple(int(p) for p in m.group(0).split(".")) if m else ()


def same_family(old: str, new: str) -> bool:
    return _skeleton(old) == _skeleton(new)


def _style_like(old: str, bare: str, provider: str) -> str:
    prefix = PUBLIC_PREFIX.get(provider)
    if prefix and old.startswith(prefix) and not bare.startswith(prefix):
        return prefix + bare
    return bare


# ---------------------------------------------------------------- decisions

def classify_changes(routes_text: str, catalogs: dict) -> tuple[list[Rename], list[Ask]]:
    refs = extract_declared(routes_text)
    renames, asks = [], []
    for r in refs:
        catalog = catalogs.get(r.provider)
        if catalog is None:  # no feed data for this provider -> cannot verify
            continue
        prefix = PUBLIC_PREFIX.get(r.provider, "")
        bare_old = r.model[len(prefix):] if prefix and r.model.startswith(prefix) else r.model
        if r.model in catalog or bare_old in catalog:
            continue
        options = sorted({c for c in catalog if same_family(bare_old, _bare(c, r.provider))})
        if not options:
            asks.append(Ask(old=r.model, provider=r.provider, options=[],
                            reason="no same-family replacement in live catalog"))
            continue
        # deterministic supersession: highest version wins (ties impossible:
        # equal skeleton + equal version implies equal id)
        new_bare = max(options, key=_version_tuple)
        new = _style_like(r.model, new_bare, r.provider)
        if not any(x.old == r.model and x.new == new for x in renames):
            renames.append(Rename(old=r.model, new=new, provider=r.provider,
                                  reason=f"family match in {r.provider} live catalog"))
    return renames, asks


def _bare(model_id: str, provider: str) -> str:
    prefix = PUBLIC_PREFIX.get(provider, "")
    return model_id[len(prefix):] if prefix and model_id.startswith(prefix) else model_id


def _token_pattern(model_id: str) -> re.Pattern:
    return re.compile(r"(?<![\w./:-])" + re.escape(model_id) + r"(?![\w./:-])")


def apply_renames(routes_text: str, fixtures: dict, renames: list[Rename],
                  catalogs: dict | None = None) -> tuple[str, dict]:
    routes = routes_text
    fixed = dict(fixtures)
    refs = extract_declared(routes_text)
    for r in renames:
        if catalogs is not None:
            catalog = catalogs.get(r.provider)
            bare_new = _bare(r.new, r.provider)
            if catalog is None or (bare_new not in catalog and r.new not in catalog):
                raise ValueError(f"refusing rename {r.old} -> {r.new}: "
                                 f"target not in {r.provider} live catalog")
        if _token_pattern(r.new).search(routes) and not _token_pattern(r.old).search(routes):
            continue  # already applied
        if not _token_pattern(r.old).search(routes):
            continue  # nothing to do (stale pending approval)
        if r.new in {x.model for x in refs}:
            raise ValueError(f"refusing rename {r.old} -> {r.new}: target already declared")
        routes = _token_pattern(r.old).sub(r.new, routes)
        for name in fixed:
            fixed[name] = _token_pattern(r.old).sub(r.new, fixed[name])
        # "include the new model in the gateway's catalog": if the provider
        # declares an explicit models list and the new id is not an entry of
        # that list, add it as a sibling entry.
        had_provider_model = any(x.provider == r.provider and x.model == r.old
                                 and x.kind == "provider_model" for x in refs)
        if not had_provider_model and _provider_has_explicit_models(routes, r.provider) \
                and not _models_list_has(routes, r.provider, r.new):
            routes = _insert_into_models_list(routes, r.provider, r.new)
    return routes, fixed


def _models_list_has(routes_text: str, provider: str, model_id: str) -> bool:
    section = ""
    current = ""
    in_models = False
    for line in routes_text.splitlines():
        if TOP_LEVEL_KEY.match(line):
            section = line.split(":", 1)[0]
            current = ""
            in_models = False
            continue
        if section == "providers":
            m = PROVIDER_ID.match(line)
            if m:
                current = m.group(1)
                in_models = False
                continue
            if current == provider:
                if INLINE_EMPTY_LIST.match(line):
                    in_models = False
                    continue
                inline = re.match(r"^\s+models:\s*\[(.+)\]\s*(?:#.*)?$", line)
                if inline:
                    items = {_unquote(x) for x in inline.group(1).split(",")}
                    if model_id in items:
                        return True
                    continue
                if MODELS_KEY.match(line):
                    in_models = True
                    continue
                if in_models:
                    if re.match(r"^ {1,4}[A-Za-z_-]+\s*:", line) and not MODELS_KEY.match(line):
                        in_models = False
                        continue
                    m = MODEL_ENTRY.match(line)
                    if m and _unquote(m.group(1)) == model_id:
                        return True
    return False


def _provider_has_explicit_models(routes_text: str, provider: str) -> bool:
    section = ""
    current = ""
    for line in routes_text.splitlines():
        if TOP_LEVEL_KEY.match(line):
            section = line.split(":", 1)[0]
            current = ""
            continue
        if section == "providers":
            m = PROVIDER_ID.match(line)
            if m:
                current = m.group(1)
                continue
            if current == provider:
                if INLINE_EMPTY_LIST.match(line):
                    return False
                if MODELS_KEY.match(line):
                    return True
    return False


def _insert_into_models_list(routes_text: str, provider: str, model_id: str) -> str:
    lines = routes_text.splitlines(keepends=True)
    section = ""
    current = ""
    last_entry_idx = None
    entry_indent = "      "
    for i, line in enumerate(lines):
        if TOP_LEVEL_KEY.match(line):
            section = line.split(":", 1)[0]
            current = ""
            continue
        if section == "providers":
            m = PROVIDER_ID.match(line)
            if m:
                current = m.group(1)
                if current == provider:
                    last_entry_idx = None
                continue
            if current == provider:
                if MODELS_KEY.match(line):
                    entry_indent = " " * (len(line) - len(line.lstrip()) + 2)
                    continue
                if MODEL_ENTRY.match(line) and not line.lstrip().startswith("- provider:"):
                    last_entry_idx = i
    if last_entry_idx is None:
        raise ValueError(f"no models list found for provider {provider}")
    style = "- id: " if "id:" in lines[last_entry_idx] else "- "
    lines.insert(last_entry_idx + 1, f"{entry_indent}{style}{model_id}\n")
    return "".join(lines)


def approve(asks: list[Ask], spec: str) -> list[Rename]:
    old, _, new = spec.partition("=")
    if not new:
        raise ValueError(f"approval must be OLD=NEW, got {spec!r}")
    for a in asks:
        if a.old == old:
            if a.options and new not in a.options:
                raise ValueError(f"{new!r} is not among the proposed options {a.options}")
            return [Rename(old=old, new=new, provider=a.provider, reason="human approval")]
    raise ValueError(f"no pending ask for {old!r}")


# ---------------------------------------------------------------- runtime io

def _http_json(url: str, timeout: int = 20, headers: dict | None = None) -> object:
    req = urllib.request.Request(url, headers=headers or {"User-Agent": "tokligence-watchdog"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def fetch_codex_catalog() -> set | None:
    """Query CLIProxyAPI inside the gateway container for served codex models."""
    try:
        container = _gateway_container()
        cmd = (f'wget -qO- --timeout=10 '
               f'--header="Authorization: Bearer $CODEX_PROXY_API_KEY" '
               f'"http://127.0.0.1:{CLIPROXY_PORT}/v1/models"')
        proc = subprocess.run(["docker", "exec", container, "sh", "-c", cmd],
                              capture_output=True, text=True)
        payload = json.loads(proc.stdout)
        return {m["id"] for m in payload.get("data", []) if m.get("id")}
    except Exception as error:  # noqa: BLE001 - codex falls back to ask-mode
        print(f"watchdog: codex catalog fetch failed: {error}", file=sys.stderr)
        return None


def fetch_catalogs() -> dict:
    catalogs = {}
    for provider, (url, normalize) in FEEDS.items():
        try:
            payload = _http_json(url)
            ids = set()
            if provider == "cline-oauth":
                for arr in ("free", "stealth"):
                    for entry in payload.get(arr) or []:
                        nid = normalize(entry.get("id") if isinstance(entry, dict) else entry)
                        if nid:
                            ids.add(nid)
            else:
                for entry in payload.get("data") or []:
                    nid = entry.get("id")
                    if nid:
                        ids.add(nid)
            if ids:
                catalogs[provider] = ids
        except Exception as error:  # noqa: BLE001 - feed failure must not abort the run
            print(f"watchdog: catalog fetch failed for {provider}: {error}", file=sys.stderr)
    codex = fetch_codex_catalog()
    if codex:
        catalogs["codex-oauth"] = codex
    return catalogs


def gateway_auth_secret() -> str:
    secret = os.environ.get("TOKLIGENCE_AUTH_SECRET")
    if secret:
        return secret
    out = subprocess.run(
        ["docker", "inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}",
         _gateway_container()],
        capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        if line.startswith("TOKLIGENCE_AUTH_SECRET="):
            return line.split("=", 1)[1]
    raise RuntimeError("TOKLIGENCE_AUTH_SECRET not found")


def _gateway_container() -> str:
    out = subprocess.run(
        ["docker", "ps", "--filter", "label=coolify.applicationId=26", "--format", "{{.Names}}"],
        capture_output=True, text=True, check=True).stdout.split()
    if not out:
        raise RuntimeError("gateway container not found")
    return out[0]


def canary_profiles() -> dict:
    secret = gateway_auth_secret()
    results = {}
    for profile in CANARY_PROFILES:
        body = json.dumps({"model": profile,
                           "messages": [{"role": "user", "content": "Reply with the single word ok"}],
                           "max_tokens": 10}).encode()
        req = urllib.request.Request(
            f"{GATEWAY_URL}/v1/chat/completions", data=body, method="POST",
            headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json",
                     "User-Agent": "tokligence-watchdog/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                payload = json.loads(resp.read().decode("utf-8", "replace"))
                served = resp.headers.get("x-gateway-upstream-model", "")
                ok = resp.status == 200 and bool(payload.get("choices"))
                results[profile] = {"ok": ok, "upstream": served,
                                    "error": "" if ok else f"HTTP {resp.status}"}
        except Exception as error:  # noqa: BLE001
            results[profile] = {"ok": False, "upstream": "", "error": str(error)[:200]}
    return results


def git(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(REPO_DIR), *args],
                          capture_output=True, text=True, check=check)


def push_env() -> dict:
    env = dict(os.environ)
    token = env.get("GITHUB_TOKEN")
    if token:
        env["GIT_ASKPASS"] = ""
        env["GIT_CONFIG_COUNT"] = "1"
        env["GIT_CONFIG_KEY_0"] = "credential.helper"
        env["GIT_CONFIG_VALUE_0"] = f"!f() {{ printf 'username=x-access-token\\npassword={token}\\n'; }}; f"
    return env


def load_state() -> WatchState:
    try:
        return WatchState.from_json(json.loads(STATE_PATH.read_text()))
    except Exception:  # noqa: BLE001 - missing/corrupt state starts fresh
        return WatchState()


def save_state(state: WatchState) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state.to_json(), indent=2) + "\n")


def notify(title: str, body: str, priority: str = "default") -> None:
    print(f"watchdog: {title}: {body}")
    url = os.environ.get("WATCHDOG_NOTIFY_URL")
    if not url:
        return
    payload = json.dumps({"title": title, "message": body[:2000], "priority": priority}).encode()
    req = urllib.request.Request(url, data=payload, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=15)
    except Exception as error:  # noqa: BLE001
        print(f"watchdog: notify failed: {error}", file=sys.stderr)


def validate_routes_yaml(routes_text: str) -> None:
    """Parse with the gateway container's own yaml module (authoritative)."""
    try:
        container = _gateway_container()
    except Exception as error:  # noqa: BLE001
        print(f"watchdog: skipping yaml validation (no container): {error}")
        return
    proc = subprocess.run(
        ["docker", "exec", "--interactive", container, "node", "--input-type=module", "-e",
         "import{readFileSync}from'node:fs';import{parse}from'yaml';"
         "const c=parse(readFileSync(0,'utf8'));if(!c.profiles||!c.providers)throw new Error('bad routes');"
         "console.log('yaml ok');"],
        input=routes_text, capture_output=True, text=True)
    if proc.returncode != 0:
        raise ValueError(f"routes yaml failed container validation: {proc.stderr.strip()[-300:]}")


def wait_for_deploy(sha: str, attempts: int = 12, pause: int = 30) -> bool:
    prefix = sha[:12]
    for _ in range(attempts):
        out = subprocess.run(
            ["docker", "ps", "--filter", "label=coolify.applicationId=26", "--format", "{{.Image}}"],
            capture_output=True, text=True).stdout
        if prefix in out:
            return True
        time.sleep(pause)
    return False


def fixture_files() -> dict:
    fixtures = {}
    test_dir = REPO_DIR / "test"
    if test_dir.is_dir():
        for path in sorted(test_dir.glob("*.mjs")):
            fixtures[str(path.relative_to(REPO_DIR))] = path.read_text()
    return fixtures


def write_fixtures(fixtures: dict) -> list:
    changed = []
    for name, text in fixtures.items():
        path = REPO_DIR / name
        if path.read_text() != text:
            path.write_text(text)
            changed.append(name)
    return changed


def commit_and_push(message: str, paths: list) -> str:
    git("add", "--", *paths)
    if not git("diff", "--cached", "--quiet", check=False).returncode == 0:
        git("commit", "-m", message)
    sha = git("rev-parse", "HEAD").stdout.strip()
    push = subprocess.run(["git", "-C", str(REPO_DIR), "push", "origin", "HEAD:main"],
                          capture_output=True, text=True, env=push_env())
    if push.returncode != 0:
        raise RuntimeError(f"git push failed: {push.stderr.strip()[-300:]}")
    return sha


# ---------------------------------------------------------------- main flow

def run_once(state: WatchState, dry_run: bool = False) -> WatchState:
    state.last_run = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    git("pull", "--ff-only", "origin", "main", check=False)
    routes_path = REPO_DIR / "gateway.routes.yaml"
    routes_text = routes_path.read_text()
    catalogs = fetch_catalogs()
    renames, asks = classify_changes(routes_text, catalogs)

    # pending approvals asked before are re-reported
    for pending in state.pending:
        pending.seen += 1
    known_olds = {a.old for a in state.pending}
    new_asks = [a for a in asks if a.old not in known_olds]
    state.pending = state.pending + new_asks

    deployed = False
    if renames and not dry_run:
        fixtures = fixture_files()
        new_routes, new_fixtures = apply_renames(routes_text, fixtures, renames, catalogs)
        validate_routes_yaml(new_routes)
        routes_path.write_text(new_routes)
        changed = write_fixtures(new_fixtures)
        summary = ", ".join(f"{r.old} -> {r.new}" for r in renames)
        sha = commit_and_push(f"chore: catalog watchdog rename {summary}",
                              ["gateway.routes.yaml", *changed])
        print(f"watchdog: pushed {sha[:12]} ({summary}); waiting for deploy")
        deployed = wait_for_deploy(sha)
        state.applied.append({"date": state.last_run, "sha": sha,
                              "renames": [asdict(r) for r in renames]})
        if any(r.provider == "codex-oauth" for r in renames):
            notify("tokligence watchdog: codex rename applied",
                   f"{summary}\nReminder: the Claude-compat surface uses Coolify env "
                   "CODEX_HAIKU_MODEL/CODEX_SONNET_MODEL/CODEX_OPUS_MODEL/CODEX_FABLE_MODEL — "
                   "update those manually if they reference a renamed model.",
                   priority="high")
    elif renames and dry_run:
        print("watchdog: DRY RUN would rename: "
              + ", ".join(f"{r.old} -> {r.new}" for r in renames))

    canary = canary_profiles()
    alerts = []
    for profile, result in canary.items():
        prev = state.canary.get(profile, {"ok": 0, "fail": 0, "last_error": ""})
        entry = {"ok": prev["ok"] + (1 if result["ok"] else 0),
                 "fail": prev["fail"] + (0 if result["ok"] else 1),
                 "last_error": result["error"]}
        if not result["ok"]:
            entry["fail_streak"] = prev.get("fail_streak", 0) + 1
        else:
            entry["fail_streak"] = 0
        if (deployed and not result["ok"]) or entry["fail_streak"] >= 2:
            alerts.append(f"{profile} canary failing: {result['error'] or 'non-200'}")
        state.canary[profile] = entry

    if state.pending:
        listing = "; ".join(f"{a.old} ({a.provider}): "
                            + (", ".join(a.options) or "no replacement found")
                            for a in state.pending)
        notify("tokligence watchdog: approval needed",
               f"{listing}\nApprove with: catalog_watchdog.py --approve OLD=NEW",
               priority="high" if alerts else "default")
    if alerts:
        notify("tokligence watchdog: profile canary failing", " | ".join(alerts), priority="high")
    if not state.pending and not alerts:
        if all(r["ok"] for r in canary.values()):
            print("watchdog: catalogs healthy, profiles canary ok, nothing to do")
        else:
            print("watchdog: no pending approvals; canary failures below alert threshold")
    save_state(state)
    return state


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--dry-run", action="store_true", help="detect and print, change nothing")
    parser.add_argument("--approve", metavar="OLD=NEW",
                        help="apply a previously queued rename and deploy it")
    parser.add_argument("--canary-only", action="store_true", help="skip catalog diff, just canary")
    args = parser.parse_args()

    state = load_state()
    if args.approve:
        routes_path = REPO_DIR / "gateway.routes.yaml"
        renames = approve(state.pending, args.approve)
        catalogs = fetch_catalogs()
        fixtures = fixture_files()
        new_routes, new_fixtures = apply_renames(routes_path.read_text(), fixtures, renames, catalogs)
        validate_routes_yaml(new_routes)
        routes_path.write_text(new_routes)
        changed = write_fixtures(new_fixtures)
        sha = commit_and_push(f"chore: catalog watchdog apply approved rename "
                              f"{renames[0].old} -> {renames[0].new}",
                              ["gateway.routes.yaml", *changed])
        state.pending = [a for a in state.pending if a.old != renames[0].old]
        state.applied.append({"date": state.last_run, "sha": sha,
                              "renames": [asdict(r) for r in renames], "approved": True})
        wait_for_deploy(sha)
        state.canary = {}
        canary = canary_profiles()
        failed = [f"{p}: {r['error']}" for p, r in canary.items() if not r["ok"]]
        notify("tokligence watchdog: approved rename deployed",
               f"{renames[0].old} -> {renames[0].new} deployed ({sha[:12]}). "
               + ("All profiles canary ok." if not failed else "FAILING: " + " | ".join(failed)),
               priority="high" if failed else "default")
        save_state(state)
        return 0

    if args.canary_only:
        canary = canary_profiles()
        failed = [f"{p}: {r['error']}" for p, r in canary.items() if not r["ok"]]
        print(json.dumps(canary, indent=2))
        return 1 if failed else 0

    run_once(state, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())