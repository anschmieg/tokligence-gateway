package api

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/catalogfallback"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
)

func routingAdmission(c *gin.Context) bool {
	path := c.Request.URL.Path
	control := strings.HasSuffix(path, "/v1/routing/session") || strings.HasSuffix(path, "/v1/routing/requests")
	inference := c.Request.Method == "POST" && (strings.HasSuffix(path, "/v1/messages") || strings.HasSuffix(path, "/v1/chat/completions") || strings.HasSuffix(path, "/v1/responses") || strings.HasSuffix(path, "/v1/responses/compact") || strings.HasSuffix(path, "/v1/messages/count_tokens"))
	if c.Request.Method == "GET" && strings.HasSuffix(path, "/v1/responses") && c.GetHeader("X-Gateway-Session") != "" {
		c.AbortWithStatusJSON(409, gin.H{"error": "session billing policies require HTTP requests, not a persistent WebSocket"})
		return false
	}
	if !control && !inference {
		return true
	}
	principal := c.GetString("userApiKey")
	if principal == "" {
		c.AbortWithStatusJSON(401, gin.H{"error": "authenticated identity required"})
		return false
	}
	sum := sha256.Sum256([]byte(c.GetString("accessProvider") + "\x00" + principal))
	identity := hex.EncodeToString(sum[:])
	session := c.GetHeader("X-Gateway-Session")
	parent := c.GetHeader("X-Gateway-Parent-Session")
	for _, name := range []string{"X-Gateway-Session", "X-Gateway-Parent-Session", "X-Gateway-Prompt-ID", "X-Gateway-Agent", "X-Gateway-Parent-Request-ID", "X-Gateway-Request-Kind"} {
		if len(c.Request.Header.Values(name)) > 1 {
			c.AbortWithStatusJSON(400, gin.H{"error": "ambiguous routing header"})
			return false
		}
	}
	for _, id := range []string{session, parent, c.GetHeader("X-Gateway-Prompt-ID"), c.GetHeader("X-Gateway-Agent"), c.GetHeader("X-Gateway-Parent-Request-ID")} {
		if id != "" && !registry.RoutingID.MatchString(id) {
			c.AbortWithStatusJSON(400, gin.H{"error": "invalid routing correlation ID"})
			return false
		}
	}
	if control && session == "" {
		c.AbortWithStatusJSON(400, gin.H{"error": "X-Gateway-Session required"})
		return false
	}
	admission, err := registry.DefaultRoutingStore.Capture(identity, session, parent)
	if err != nil {
		c.AbortWithStatusJSON(409, gin.H{"error": err.Error()})
		return false
	}
	ctx := registry.WithBillingAdmission(c.Request.Context(), admission)
	if inference {
		kind := c.GetHeader("X-Gateway-Request-Kind")
		switch kind {
		case "":
			kind = "unspecified"
			if strings.HasSuffix(path, "/responses/compact") {
				kind = "compaction"
			} else if strings.HasSuffix(path, "/messages/count_tokens") {
				kind = "auxiliary"
			}
		case "main", "subagent", "compaction", "auxiliary":
		default:
			c.AbortWithStatusJSON(400, gin.H{"error": "invalid request kind"})
			return false
		}
		trace := registry.DefaultRoutingStore.Begin(admission, registry.RoutingEvent{Profile: c.Param("profile"), Policy: admission.Policy(c.Param("profile")).Policy, PolicyVersion: admission.Policy(c.Param("profile")).Version, Kind: kind, Agent: c.GetHeader("X-Gateway-Agent"), PromptID: c.GetHeader("X-Gateway-Prompt-ID"), ParentRequest: c.GetHeader("X-Gateway-Parent-Request-ID")})
		ctx = registry.WithRoutingTrace(ctx, trace)
		c.Header("X-Gateway-Request-ID", trace.Snapshot().RequestID)
		c.Request = c.Request.WithContext(ctx)
		c.Next()
		trace.Complete(c.Writer.Status(), c.Request.Context().Err() != nil)
		return false // middleware already ran the rest of the native handler chain
	}
	c.Request = c.Request.WithContext(ctx)
	return true
}
func (s *Server) registerRoutingControlRoutes(group *gin.RouterGroup) {
	profile := func(c *gin.Context) (string, bool) {
		if registry.BillingAdmissionFromContext(c.Request.Context()) == nil {
			c.JSON(401, gin.H{"error": "authenticated session required"})
			return "", false
		}
		name := c.Param("profile")
		q := c.Query("profile")
		if name == "" {
			name = q
		} else if q != "" && q != name {
			c.JSON(400, gin.H{"error": "profile scope mismatch"})
			return "", false
		}
		if name != "" {
			if _, ok := s.handlers.AuthManager.CanonicalRoutingPolicy().Profile(name); !ok {
				c.JSON(404, gin.H{"error": "unknown model profile"})
				return "", false
			}
		}
		return name, true
	}
	group.GET("/routing/session", func(c *gin.Context) {
		name, ok := profile(c)
		if !ok {
			return
		}
		a := registry.BillingAdmissionFromContext(c.Request.Context())
		p := a.Policy(name)
		c.Header("Cache-Control", "no-store")
		c.JSON(200, gin.H{"session": a.Session, "profile": name, "policy": p.Policy, "version": p.Version, "default": "SUB", "persistence": "process-local; 24h idle expiry"})
	})
	group.PUT("/routing/session", func(c *gin.Context) {
		name, ok := profile(c)
		if !ok {
			return
		}
		raw, e := io.ReadAll(io.LimitReader(c.Request.Body, 1025))
		if e != nil || len(raw) > 1024 || catalogfallback.ValidateProtocolJSON(raw) != nil {
			c.JSON(400, gin.H{"error": "invalid session policy body"})
			return
		}
		var body struct {
			Policy registry.BillingPolicy `json:"policy"`
		}
		d := json.NewDecoder(strings.NewReader(string(raw)))
		d.DisallowUnknownFields()
		if d.Decode(&body) != nil || !registry.ValidBillingPolicy(body.Policy) {
			c.JSON(400, gin.H{"error": "policy must be FREE, SUB or PAID"})
			return
		}
		a := registry.BillingAdmissionFromContext(c.Request.Context())
		p, e := registry.DefaultRoutingStore.Set(a, name, body.Policy)
		if e != nil {
			c.JSON(400, gin.H{"error": e.Error()})
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(200, gin.H{"session": a.Session, "profile": name, "policy": p.Policy, "version": p.Version})
	})
	group.GET("/routing/requests", func(c *gin.Context) {
		name, ok := profile(c)
		if !ok {
			return
		}
		a := registry.BillingAdmissionFromContext(c.Request.Context())
		rows := registry.DefaultRoutingStore.Events(a, name)
		id := c.Query("request_id")
		if id != "" {
			filtered := []registry.RoutingEvent{}
			for _, r := range rows {
				if r.RequestID == id {
					filtered = append(filtered, r)
				}
			}
			rows = filtered
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{"session": a.Session, "profile": name, "data": rows})
	})
}
