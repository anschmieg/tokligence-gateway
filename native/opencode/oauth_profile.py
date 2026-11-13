"""Shared, pinned native-source CLI recipe; no auth/header/endpoint overrides."""
import pathlib
import base64
import json
import urllib.parse
import urllib.request
from live_safety import open_gateway


GATEWAY_FILES = ['anthropic-openai-codec.mjs', 'anthropic-passthrough.mjs', 'cache-observer.mjs', 'cline-oauth.mjs', 'cliproxyapi.mjs', 'cloudflare-access.mjs', 'compile-config.mjs', 'copilot-auto.mjs', 'dashboard.mjs', 'gateway-config.mjs', 'gateway.routes.yaml', 'mistral-subscription-quota.mjs', 'model-catalog-metadata.mjs', 'model-catalog.mjs', 'native-session-identity.mjs', 'openai-stream.mjs', 'opencode-account-pool.mjs', 'opencode-free-models.mjs', 'opencode-zen-credential.mjs', 'opencode-zen-gate.mjs', 'opencode-zen-session.mjs', 'package-lock.json', 'package.json', 'preferences.mjs', 'protocol-codecs.mjs', 'provider-adapters.mjs', 'quota-cache.mjs', 'quota.mjs', 'request-executor.mjs', 'request-trace.mjs', 'route-config.mjs', 'routing-planner.mjs', 'sanitize-headers.mjs', 'specialist-routes.mjs', 'sse-stream.mjs', 'systemone.mjs', 'tgw-proxy.mjs', 'upstream-model.mjs', 'usage-observer.mjs']

def cli_command(source, bun):
    source = pathlib.Path(source)
    return [str(bun), '--smol', '--use-system-ca', '--user-agent=opencode/latest/2.1.4/cli', '--no-env-file', '--config=/dev/null', '--preload', str(source / 'packages/cli/node_modules/@opentui/solid/scripts/preload.js'),
            '--define', 'OPENCODE_VERSION="2.1.4"', '--define', 'OPENCODE_CHANNEL="latest"',
            '--define', 'OPENCODE_ARTIFACT="cli"', str(source / 'packages/cli/src/index.ts')]


def control_config(tokens):
    if type(tokens) is not int or not 1 <= tokens <= 1024: raise ValueError('Invalid control output budget')
    return {'policies': [{'action': 'tool.use', 'resource': '*', 'effect': 'deny'}],
            'permissions': [{'action': '*', 'resource': '*', 'effect': 'deny'}],
            'providers': {'opencode': {'compatibility': {'maxTokensField': 'max_tokens'},
                                       'body': {'max_tokens': tokens, 'tools': []}}}}


def selected_free_model(catalog, model):
    if not isinstance(catalog, list): raise ValueError('Native model catalog unavailable')
    rows = [row for row in catalog if row.get('providerID') == 'opencode' and row.get('id') == model]
    if len(rows) != 1: raise ValueError('Selected native model unavailable')
    row = rows[0]
    if row.get('enabled') is not True or not isinstance(row.get('modelID'), str) or not row['modelID']:
        raise ValueError('Selected native model identity changed')
    caps = row.get('capabilities', {})
    if 'text' not in caps.get('input', []) or 'text' not in caps.get('output', []):
        raise ValueError('Selected native model is not text-compatible')
    if not isinstance(row.get('cost'), list): raise ValueError('Selected model pricing unavailable')
    for price in row['cost']:
        cache = price.get('cache', {})
        values = [price.get('input'), price.get('output'), cache.get('read'), cache.get('write')]
        if any(type(value) not in (int, float) or value != 0 for value in values):
            raise ValueError('Selected native model is priced; no inference allowed')
    return row['modelID']


def verify_free_model(endpoint, password, directory, model):
    query = urllib.parse.urlencode({'location[directory]': str(directory)})
    authorization = 'Basic ' + base64.b64encode(('opencode:' + password).encode()).decode()
    request = urllib.request.Request(endpoint + '/api/model?' + query, headers={'Authorization': authorization})
    with open_gateway(request, timeout=15) as response:
        raw = response.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024: raise ValueError('Native catalog response exceeded limit')
    return selected_free_model(json.loads(raw).get('data'), model)
