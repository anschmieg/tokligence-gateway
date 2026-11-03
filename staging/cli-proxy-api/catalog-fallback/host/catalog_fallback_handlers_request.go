package handlers

import (
	"bytes"
	"errors"
	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/catalogfallback"
	"strings"
)

// Validate the original decoded body BEFORE model/stream selection or protocol
// conversion, including exact provider overrides. Keep multipart/native binaries
// under the existing native handler's rules.
func ReadRequestBody(c *gin.Context) ([]byte, error) {
	raw, err := readNativeRequestBody(c)
	if err != nil {
		return nil, err
	}
	contentType := c.GetHeader("Content-Type")
	trimmed := bytes.TrimSpace(raw)
	jsonBody := strings.Contains(strings.ToLower(contentType), "json") || (len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '['))
	if jsonBody {
		if catalogfallback.ValidateProtocolJSON(raw) != nil {
			return nil, errors.New("invalid or ambiguous JSON request")
		}
	}
	return raw, nil
}
