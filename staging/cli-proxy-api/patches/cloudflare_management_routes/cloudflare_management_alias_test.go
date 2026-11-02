package api

import (
 "io"
 "net/http"
 "net/http/httptest"
 "strings"
 "testing"
 "github.com/gin-gonic/gin"
)

func TestCloudflareManagementAliasReentersNativeAuthAndPreservesRequest(t *testing.T) {
 s:=&Server{engine:gin.New()};s.engine.Any("/admin/*path",s.cloudflareManagementAlias)
 hits,auth:=0,0
 group:=s.engine.Group("/v8/management");group.Use(func(c *gin.Context){auth++;if c.GetHeader("Fixture-Auth")!="signed" {c.AbortWithStatus(401);return};c.Next()})
 group.PUT("/config",func(c *gin.Context){hits++;b,_:=io.ReadAll(c.Request.Body);if string(b)!="fixture-body"||c.Query("version")!="1"||c.GetHeader("If-Match")!="fixture-etag"{t.Error("management request changed")};c.String(200,"native")})
 for _,credential:=range []string{"","signed"} {
  req:=httptest.NewRequest("PUT","/admin/v8/management/config?version=1",strings.NewReader("fixture-body"));req.Header.Set("Fixture-Auth",credential);req.Header.Set("If-Match","fixture-etag");rec:=httptest.NewRecorder();s.engine.ServeHTTP(rec,req)
  want:=401;if credential!=""{want=200};if rec.Code!=want{t.Fatalf("status=%d want%d",rec.Code,want)}
 }
 if hits!=1||auth!=2{t.Fatalf("native auth/handler dispatch count differs: %d/%d",auth,hits)}
 req:=httptest.NewRequest("POST","/admin/v1/chat/completions",nil);rec:=httptest.NewRecorder();s.engine.ServeHTTP(rec,req);if rec.Code!=http.StatusNotFound{t.Fatal("alias admitted inference")}
}
