#!/usr/bin/env bash
# Offline ABI verification for the OpenCode plugin against the pinned
# CLIProxyAPI v8.0.49 plugin host contract.
#
# Builds the c-shared plugin, then dlopens it from a small C harness whose
# fake host implements the same C ABI and host callback surface the real host
# does (internal/pluginhost: loader_unix.go + host_callbacks.go): the plugin
# struct layout, the cliproxy_buffer ownership, the ok/result envelope, and
# the host.http.do wire shape (pluginapi.HTTPResponse marshals untagged Go
# field names, []byte fields base64). The harness scripts host.http.do and
# records every callback.
#
# Flat, screenable, no network. Requires: go, gcc, python3.
set -euo pipefail
cd "$(dirname "$0")"

WORK="$(mktemp -d /tmp/opencode-abi-verify-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

echo "== building plugin =="
go build -buildmode=c-shared -o "$WORK/opencode.so" ./cmd/opencode-plugin

echo "== building dlopen harness =="
cat > "$WORK/harness.c" <<'EOF'
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct { void* ptr; size_t len; } cliproxy_buffer;
typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);
typedef struct { uint32_t abi_version; void* host_ctx; cliproxy_host_call_fn call; cliproxy_host_free_fn free_buffer; } cliproxy_host_api;
typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);
typedef struct { uint32_t abi_version; cliproxy_plugin_call_fn call; cliproxy_plugin_free_fn free_buffer; cliproxy_plugin_shutdown_fn shutdown; } cliproxy_plugin_api;

static int g_http_calls = 0;
static int g_other_calls = 0;

// Scripted token response for host.http.do, base64 of the JSON body
// {"access_token":"abi-access","refresh_token":"abi-refresh","expires_in":1800}
static const char* kTokenBodyB64 =
    "eyJhY2Nlc3NfdG9rZW4iOiJhYmktYWNjZXNzIiwicmVmcmVzaF90b2tlbiI6ImFiaS1yZWZyZXNoIiwiZXhwaXJlc19pbiI6MTgwMH0=";

static int fake_host_call(void* ctx, const char* method, const uint8_t* request, size_t request_len, cliproxy_buffer* response) {
    (void)ctx; (void)request; (void)request_len;
    if (strcmp(method, "host.http.do") == 0) {
        g_http_calls++;
        size_t n = 128 + strlen(kTokenBodyB64);
        char* out = malloc(n);
        snprintf(out, n,
                 "{\"ok\":true,\"result\":{\"StatusCode\":200,"
                 "\"Headers\":{\"content-type\":[\"application/json\"]},"
                 "\"Body\":\"%s\"}}",
                 kTokenBodyB64);
        response->ptr = out;
        response->len = strlen(out);
        return 0;
    }
    g_other_calls++;
    const char* ok = "{\"ok\":true,\"result\":{}}";
    response->ptr = strdup(ok);
    response->len = strlen(ok);
    return 0;
}

static void fake_host_free(void* ptr, size_t len) { (void)len; free(ptr); }

static cliproxy_plugin_api g_plugin;

static void call_plugin(const char* method, const char* request_json) {
    size_t n = request_json ? strlen(request_json) : 0;
    uint8_t* req = NULL;
    if (n) { req = malloc(n); memcpy(req, request_json, n); }
    cliproxy_buffer resp = {NULL, 0};
    int rc = g_plugin.call((char*)method, req, n, &resp);
    printf("method=%-24s rc=%d response=%s\n", method, rc, resp.ptr ? (char*)resp.ptr : "(none)");
    if (req) free(req);
    if (resp.ptr) g_plugin.free_buffer(resp.ptr, resp.len);
}

int main(int argc, char** argv) {
    if (argc != 2) { fprintf(stderr, "usage: %s <plugin.so>\n", argv[0]); return 2; }
    void* handle = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!handle) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 1; }
    int (*init)(cliproxy_host_api*, cliproxy_plugin_api*) = dlsym(handle, "cliproxy_plugin_init");
    if (!init) { fprintf(stderr, "dlsym(cliproxy_plugin_init): %s\n", dlerror()); return 1; }

    cliproxy_host_api host = {1, NULL, fake_host_call, fake_host_free};
    int rc = init(&host, &g_plugin);
    printf("init rc=%d abi_version=%u\n", rc, g_plugin.abi_version);
    if (rc != 0 || g_plugin.abi_version != 1 || !g_plugin.call || !g_plugin.free_buffer) {
        fprintf(stderr, "FAIL: unexpected init result\n");
        return 1;
    }

    // plugin.register: config_yaml is a []byte field -> base64 of the YAML.
    call_plugin("plugin.register",
        "{\"config_yaml\":\"ZW5hYmxlZDogdHJ1ZQppbmZlcmVuY2VfYmFzZV91cmw6IGh0dHBzOi8vb3BlbmNvZGUuYWkvaW5mZXJlbmNlL29wZW5haS92MQptb2RlbHM6IFtiZWFtLWZyZWVdCg==\",\"schema_version\":10}");
    call_plugin("auth.identifier", "{}");
    call_plugin("auth.login.start", "{}");       // expect explicit refusal
    call_plugin("executor.count_tokens", "{}");  // expect explicit refusal
    // auth.refresh: StorageJSON is a []byte field -> base64 of the native
    // credential JSON (already expired at 3000000000000 to exercise the
    // refresh path; the grant rotates it).
    call_plugin("auth.refresh",
        "{\"AuthID\":\"opencode\",\"AuthProvider\":\"opencode\","
        "\"StorageJSON\":\"eyJ0eXBlIjoib2F1dGgiLCJtZXRob2RJRCI6ImRldmljZSIsImFjY2VzcyI6ImEiLCJyZWZyZXNoIjoiciIsImV4cGlyZXMiOjMwMDAwMDAwMDAwMH0=\"}");
    printf("host.http.do calls during refresh: %d (other callbacks: %d)\n", g_http_calls, g_other_calls);
    if (g_http_calls != 1) {
        fprintf(stderr, "FAIL: refresh did not perform exactly one host.http.do grant call\n");
        return 1;
    }
    if (g_plugin.shutdown) g_plugin.shutdown();
    dlclose(handle);
    printf("OK\n");
    return 0;
}
EOF
gcc -o "$WORK/harness" "$WORK/harness.c" -ldl

echo "== running harness =="
"$WORK/harness" "$WORK/opencode.so"
