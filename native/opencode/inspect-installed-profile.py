#!/usr/bin/env python3
"""Read-only installed OpenCode profile metadata; never generates inference."""
import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import sqlite3
import subprocess
import urllib.parse


def key_kind(value):
    return 'unset' if not value else 'public_literal' if value == 'public' else 'nonpublic'


def binary_metadata(binary):
    file = pathlib.Path(binary).resolve()
    digest = hashlib.sha256()
    with file.open('rb') as stream:
        prefix = stream.read(65536); digest.update(prefix)
        for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
    result = {'path': str(file), 'sha256': digest.hexdigest()}
    if prefix.startswith(b'\x7fELF'):
        version = subprocess.check_output([str(file), '--version'], stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True, timeout=15).strip()
        result.update(kind='elf', version=version if re.fullmatch(r'\d+\.\d+\.(?:\d+|fixture)(?:[-+][A-Za-z0-9.-]+)?', version) else 'unrecognized_version_output')
    elif prefix.startswith(b'#!'):
        text = prefix.decode('utf-8', errors='replace')
        result.update(kind='script_not_executed',
            assigned_variable_names=sorted(set(re.findall(r'(?m)(?:^|[\s;])([A-Z][A-Z0-9_]+)=', text))),
            referenced_variable_names=sorted(set(re.findall(r'\$\{?([A-Z][A-Z0-9_]*)', text))),
            launcher_names=[name for name in ['docker', 'podman', 'lxc', 'ssh', 'bun', 'node', 'opencode'] if re.search(r'(?<![A-Za-z0-9_-])'+name+r'(?![A-Za-z0-9_-])', text)])
    else: result['kind'] = 'unknown_not_executed'
    return result


def inspect_profile(home, binary=None, environ=None):
    home = pathlib.Path(home)
    environ = os.environ if environ is None else environ
    result = {'home': str(home), 'inference_requested': False}
    binary = binary or shutil.which('opencode')
    if binary:
        result['binary'] = binary_metadata(binary)
    underlying = home / '.opencode/bin/opencode'
    if underlying.is_file() and (not binary or underlying.resolve() != pathlib.Path(binary).resolve()):
        result['home_binary'] = binary_metadata(underlying)
    result['environment_key_kind'] = key_kind(environ.get('OPENCODE_API_KEY'))
    result['environment_present'] = {key: bool(environ.get(key)) for key in [
        'OPENCODE_API_KEY', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_DB', 'OPENCODE_CONFIG_DIR',
        'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
        'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'OPENCODE_CONFIG', 'OPENCODE_TEST_HOME']}
    data_dir = pathlib.Path(environ.get('XDG_DATA_HOME') or home / '.local/share') / 'opencode'
    auth_files = [data_dir / 'auth.json']
    for file in auth_files:
        if not file.exists(): continue
        try:
            value = json.loads(file.read_text()); entry = value.get('opencode', {})
            result['opencode_auth_file'] = {'present': True, 'type': entry.get('type') if entry.get('type') in ['oauth', 'api', 'key'] else 'unspecified', 'key_kind': key_kind(entry.get('key'))}
            if environ.get('OPENCODE_API_KEY') and entry.get('key'):
                result['environment_matches_auth_file'] = environ['OPENCODE_API_KEY'] == entry['key']
        except (ValueError, AttributeError): result['opencode_auth_file'] = {'present': True, 'type': 'unreadable_schema'}
    # Config is summarized; values of keys/options/headers/plugins are not emitted.
    config_dir = pathlib.Path(environ.get('OPENCODE_CONFIG_DIR') or pathlib.Path(environ.get('XDG_CONFIG_HOME') or home / '.config') / 'opencode')
    result['configs'] = []
    for name in ['opencode.json', 'opencode.jsonc']:
        file = config_dir / name
        if not file.exists(): continue
        item = {'name': name}
        try:
            value = json.loads(file.read_text())
            providers = value.get('provider', value.get('providers', {}))
            item['opencode_provider_configured'] = isinstance(providers, dict) and 'opencode' in providers
            item['provider_count'] = len(providers) if isinstance(providers, dict) else None
            item['plugin_count'] = len(value.get('plugin', value.get('plugins', [])))
            provider = providers.get('opencode', {}) if isinstance(providers, dict) else {}
            item['opencode_key_configured'] = any(bool(container.get('apiKey')) for container in [provider, provider.get('options', {}), provider.get('settings', {})] if isinstance(container, dict))
            for container in [provider.get('options', {}), provider.get('settings', {})]:
                if not isinstance(container, dict) or not isinstance(container.get('baseURL'), str): continue
                url = urllib.parse.urlsplit(container['baseURL'])
                item['opencode_endpoint_origin'] = {'scheme': url.scheme, 'host': url.hostname, 'port': url.port}
        except (ValueError, AttributeError, TypeError): item['parse'] = 'jsonc_or_unsupported_schema'
        result['configs'].append(item)
    database = pathlib.Path(environ.get('OPENCODE_DB') or data_dir / 'opencode.db')
    result['database_exists'] = database.exists()
    if database.exists():
        with sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True) as conn:
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            result['credential_inventory'] = {}
            for name in ['credential', 'account', 'control_account']:
                if name in tables: result['credential_inventory'][name] = conn.execute('SELECT count(*) FROM "'+name+'"').fetchone()[0]
            if 'credential' in tables:
                result['opencode_credential_types'] = [row[0] if row[0] in ['oauth', 'api', 'key'] else 'unspecified' for row in conn.execute("SELECT json_extract(value,'$.type') FROM credential WHERE integration_id='opencode'")]
            result['session_tables_present'] = [name for name in ['session_v2', 'session'] if name in tables]
            if 'credential' in tables:
                columns = {row[1] for row in conn.execute('PRAGMA table_info(credential)')}
                if 'active' in columns:
                    result['opencode_active_credentials'] = [{'type': row[0] if row[0] in ['oauth', 'api', 'key'] else 'unspecified', 'active': bool(row[1])}
                        for row in conn.execute("SELECT json_extract(value,'$.type'),active FROM credential WHERE integration_id='opencode'")]
            sessions = []
            for session_table, message_table, kind_column in [('session_v2', 'session_message', 'type'), ('session', 'message', None)]:
                if session_table not in tables or message_table not in tables: continue
                for sid, version, created in conn.execute('SELECT id,version,time_created FROM '+session_table+' ORDER BY time_created DESC LIMIT 5'):
                    query = "SELECT COALESCE(json_extract(data,'$.providerID'),json_extract(data,'$.model.providerID')),COALESCE(json_extract(data,'$.modelID'),json_extract(data,'$.model.id'),json_extract(data,'$.model.modelID')),COALESCE(json_extract(data,'$.finish'),json_extract(data,'$.finishReason')),json_type(data,'$.error') FROM "+message_table+" WHERE session_id=? AND "+("type='assistant'" if kind_column else "json_extract(data,'$.role')='assistant'")+" ORDER BY time_created DESC LIMIT 8"
                    messages = [{'provider': row[0], 'model': row[1], 'finish': row[2], 'has_error': row[3] not in (None, 'null')} for row in conn.execute(query, (sid,))]
                    sessions.append({'id': sid, 'version': version, 'table': session_table, 'created_utc': datetime.datetime.fromtimestamp(created / 1000, datetime.timezone.utc).isoformat(), 'assistant_metadata': messages})
            result['recent_sessions'] = sorted(sessions, key=lambda item: item['created_utc'], reverse=True)[:5]
    return result


if __name__ == '__main__':
    try: print(json.dumps(inspect_profile(pathlib.Path.home()), indent=2))
    except (OSError, ValueError, sqlite3.Error, subprocess.SubprocessError) as error:
        print(json.dumps({'inspection_failed': type(error).__name__, 'inference_requested': False}))
        raise SystemExit(1)
