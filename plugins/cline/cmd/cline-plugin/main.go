// Command cline builds the tokligence Cline plugin for CLIProxyAPI v8.0.49
// (c-shared dynamic library, plugin ABI v1, RPC schema version 10).
//
// Build: go build -buildmode=c-shared -o cline.so .
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

	cline "github.com/tokligence/gateway/plugins/cline"
)

const abiVersion uint32 = 1

func main() {}

// hostTransport adapts the host.http.do callback to the handler Transport.
type hostTransport struct{}

func (hostTransport) Do(hostCallbackID, method, url string, headers map[string][]string, body []byte) (int, []byte, error) {
	request := map[string]any{
		"method":  method,
		"url":     url,
		"headers": headers,
		"body":    body,
	}
	// host_callback_id is per-RPC-call host context: the host validates it
	// belongs to the calling plugin, so it must ride each request, not live in
	// shared mutable state.
	if hostCallbackID != "" {
		request["host_callback_id"] = hostCallbackID
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return 0, nil, err
	}
	raw, err := callHost("host.http.do", payload)
	if err != nil {
		return 0, nil, err
	}
	var response struct {
		StatusCode int    `json:"status_code"`
		Body       []byte `json:"body"`
	}
	if err := json.Unmarshal(raw, &response); err != nil {
		return 0, nil, err
	}
	return response.StatusCode, response.Body, nil
}

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
		return nil, nil
	}
	size := int(response.len)
	if size == 0 {
		C.free_host_buffer(response.ptr, response.len)
		return nil, nil
	}
	raw := C.GoBytes(response.ptr, C.int(size))
	C.free_host_buffer(response.ptr, response.len)
	// The host returns a pluginabi.Envelope; unwrap the result field.
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

// hostStreamBridge forwards validated stream frames to the host stream
// bridge (host.stream.emit / host.stream.close) using the exact stream_id
// the host allocated for this executor.execute_stream call.
type hostStreamBridge struct{}

// hostStreamEmitRequest matches the host's rpcStreamEmitRequest schema.
type hostStreamEmitRequest struct {
	StreamID string `json:"stream_id"`
	Payload  []byte `json:"payload,omitempty"`
}

// hostStreamCloseRequest matches the host's rpcStreamCloseRequest schema.
type hostStreamCloseRequest struct {
	StreamID string `json:"stream_id"`
	Error    string `json:"error,omitempty"`
}

func (hostStreamBridge) Emit(streamID string, payload []byte) error {
	raw, err := json.Marshal(hostStreamEmitRequest{StreamID: streamID, Payload: payload})
	if err != nil {
		return err
	}
	_, err = callHost("host.stream.emit", raw)
	return err
}

func (hostStreamBridge) Close(streamID string, errMsg string) {
	raw, err := json.Marshal(hostStreamCloseRequest{StreamID: streamID, Error: errMsg})
	if err != nil {
		return
	}
	_, _ = callHost("host.stream.close", raw)
}

type hostCallError struct{ method string }

func (e *hostCallError) Error() string { return "host callback " + e.method + " failed" }

var handler = cline.NewHandler(hostTransport{})

func init() {
	handler.SetStreamDeps(&cline.StreamDeps{
		Client: cline.NewHostStreamClient(callHost),
		Bridge: hostStreamBridge{},
	})
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
		writeResponse(response, errorEnvelopeBytes("invalid_method", "method is required"))
		return 1
	}
	var payload []byte
	if request != nil && requestLen > 0 {
		payload = C.GoBytes(unsafe.Pointer(request), C.int(requestLen))
	}
	result, err := handler.HandleMethod(C.GoString(method), payload)
	if err != nil {
		writeResponse(response, cline.ErrorEnvelope(err))
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

func errorEnvelopeBytes(code, message string) []byte {
	return cline.ErrorEnvelope(&staticError{code: code, message: message})
}

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
