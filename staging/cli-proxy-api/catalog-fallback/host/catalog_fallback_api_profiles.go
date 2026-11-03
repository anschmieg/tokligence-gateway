package api

import (
	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers/claude"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/api/handlers/openai"
)

func (s *Server) registerModelProfileRoutes(o *openai.OpenAIAPIHandler, c *claude.ClaudeCodeAPIHandler, r *openai.OpenAIResponsesAPIHandler) {
	profile := s.engine.Group("/:profile/v1")
	profile.Use(AuthMiddleware(s.accessManager))
	profile.Use(func(ctx *gin.Context) {
		name := ctx.Param("profile")
		if s.handlers.AuthManager == nil || s.handlers.AuthManager.HomeEnabled() {
			ctx.AbortWithStatus(503)
			return
		}
		if _, ok := s.handlers.AuthManager.CanonicalRoutingPolicy().Profile(name); !ok {
			ctx.AbortWithStatus(404)
			return
		}
		ctx.Request = ctx.Request.WithContext(registry.WithModelProfile(ctx.Request.Context(), name))
		ctx.Next()
	})
	profile.GET("/models", func(ctx *gin.Context) {
		// All these native handlers finish through the shared, profile-filtered
		// writer. Do not enter unrelated Home/Grok direct serializers via user agent.
		if _, ok := ctx.Request.URL.Query()["client_version"]; ok {
			o.OpenAIModels(ctx)
			return
		}
		if isAnthropicModelsRequest(ctx) {
			c.ClaudeModels(ctx)
			return
		}
		o.OpenAIModels(ctx)
	})
	profile.POST("/chat/completions", o.ChatCompletions)
	profile.POST("/messages", c.ClaudeMessages)
	profile.POST("/responses", r.Responses)
	// No management aliases, images, WebSockets, compact-response state or token
	// counters are accidentally exposed through a flexible task profile.
}
