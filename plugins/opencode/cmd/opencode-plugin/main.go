// Command opencode-plugin builds the tokligence OpenCode provider plugin for
// CLIProxyAPI v8.0.49 (c-shared dynamic library, plugin ABI v1, RPC schema
// version 10).
//
// Build: go build -buildmode=c-shared -o opencode.so .
package main

/*
#include <stdint.h>
#include <stdlib.h>

typedef struct {
	void* ptr;
	size_t len;
} cliproxy_buffer;

typedef int (*cliproxy_host_call_fn)(void*, const char*, const uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);

typedef struct {
	uint32_t abi_version;
	void* host_ctx;
	cliproxy_host_call_fn call;
	cliproxy_host_free_fn free_buffer;
} cliproxy_host_api;

typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);

extern int cliproxyPluginCall(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxyPluginFree(void*, size_t);
extern void cliproxyPluginShutdown(void);

typedef struct {
	uint32_t abi_version;
	cliproxy_plugin_call_fn call;
	cliproxy_plugin_free_fn free_buffer;
	cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api;

static const cliproxy_host_api* stored_host;

static void store_host_api(const cliproxy_host_api* host) {
	stored_host = host;
}

static int call_host_api(const char* method, const uint8_t* request, size_t request_len, cliproxy_buffer* response) {
	if (stored_host == NULL || stored_host->call == NULL) {
		return 1;
	}
	return stored_host->call(stored_host->host_ctx, method, request, request_len, response);
}

static void free_host_buffer(void* ptr, size_t len) {
	if (stored_host != NULL && stored_host->free_buffer != NULL && ptr != NULL) {
		stored_host->free_buffer(ptr, len);
	}
}
*/
import "C"

import (
	"encoding/json"
	"unsafe"

	opencode "github.com/tokligence/gateway/plugins/opencode"
)

const abiVersion uint32 = 1

func main() {}

// callHost invokes a host callback method and unwraps the RPC envelope.
func callHost(method string, payload []byte) ([]byte, error) {
	cMethod := C.CString(method)
	defer C.free(unsafe.Pointer(cMethod))
	var response C.cliproxy_buffer
	var req *C.uint8_t
	if len(payload) > 0 {
		req = (*C.uint8_t)(C.CBytes(payload))
		defer C.free(unsafe.Pointer(req))
	}
	if rc := C.call_host_api(cMethod, req, C.size_t(len(payload)), &response); rc != 0 {
		if response.ptr != nil {
			C.free_host_buffer(response.ptr, response.len)
		}
		return nil, &hostCallError{method: method}
	}
	if response.ptr == nil {
		return nil, &hostCallError{method: method}
	}
	size := int(response.len)
	if size == 0 {
		C.free_host_buffer(response.ptr, response.len)
		return nil, &hostCallError{method: method}
	}
	raw := C.GoBytes(response.ptr, C.int(size))
	C.free_host_buffer(response.ptr, response.len)
	var envelope struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, err
	}
	if !envelope.OK {
		return nil, &hostCallError{method: method}
	}
	return envelope.Result, nil
}

type hostCallError struct{ method string }

func (e *hostCallError) Error() string { return "host callback " + e.method + " failed" }

var handler = opencode.NewHandler(opencode.NewHostBridge(callHost), nil)

func init() {
	// Bind the plugin stream bridge used by the streaming executor path.
	opencode.StreamEmitter = func(streamID string, payload []byte) error {
		request := map[string]any{"stream_id": streamID, "payload": payload}
		return hostCallJSON("host.stream.emit", request)
	}
	opencode.StreamCloser = func(streamID string, err error) {
		request := map[string]any{"stream_id": streamID}
		if err != nil {
			request["error"] = err.Error()
		}
		if se, ok := opencode.AsStatusError(err); ok {
			request["error_detail"] = map[string]any{
				"code":                se.Code(),
				"message":             err.Error(),
				"http_status":         se.Status(),
				"retry_after_seconds": se.RetryAfterSeconds(),
			}
		}
		_ = hostCallJSON("host.stream.close", request)
	}
}

func hostCallJSON(method string, request any) error {
	raw, err := json.Marshal(request)
	if err != nil {
		return err
	}
	_, err = callHost(method, raw)
	return err
}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
	if plugin == nil {
		return 1
	}
	C.store_host_api(host)
	plugin.abi_version = C.uint32_t(abiVersion)
	plugin.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	plugin.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	plugin.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, requestLen C.size_t, response *C.cliproxy_buffer) C.int {
	if response != nil {
		response.ptr = nil
		response.len = 0
	}
	if method == nil {
		writeResponse(response, opencode.ErrorEnvelope(&staticError{code: "invalid_method", message: "method is required"}))
		return 1
	}
	var payload []byte
	if request != nil && requestLen > 0 {
		payload = C.GoBytes(unsafe.Pointer(request), C.int(requestLen))
	}
	result, err := handler.HandleMethod(C.GoString(method), payload)
	if err != nil {
		writeResponse(response, opencode.ErrorEnvelope(err))
		return 1
	}
	writeResponse(response, result)
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, length C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
	_ = length
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() {}

type staticError struct {
	code    string
	message string
}

func (e *staticError) Error() string { return e.message }

func writeResponse(response *C.cliproxy_buffer, raw []byte) {
	if response == nil || len(raw) == 0 {
		return
	}
	ptr := C.CBytes(raw)
	if ptr == nil {
		return
	}
	response.ptr = ptr
	response.len = C.size_t(len(raw))
}
