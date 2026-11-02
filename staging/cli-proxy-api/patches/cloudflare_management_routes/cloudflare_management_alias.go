package api

import (
 "net/http"
 "strings"

 "github.com/gin-gonic/gin"
)

// Keep browser administration inside the deployment's existing Access-protected
// /admin namespace. Re-enter the native management router and its authentication;
// no request is proxied, authenticated here, or dispatched to inference.
func (s *Server) cloudflareManagementAlias(c *gin.Context) {
 path := c.Param("path")
 if path != "/v8/management" && !strings.HasPrefix(path,"/v8/management/") && path != "/v0/management" && !strings.HasPrefix(path,"/v0/management/") {
  c.AbortWithStatus(http.StatusNotFound); return
 }
 c.Request.URL.Path = path
 c.Request.URL.RawPath = ""
 s.engine.HandleContext(c)
 // HandleContext restores the old index but leaves the selected handler chain.
 // Abort the outer chain so native handlers cannot run a second time.
 c.Abort()
}
