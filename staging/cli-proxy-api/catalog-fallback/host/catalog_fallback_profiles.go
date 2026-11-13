package registry

import (
	"context"
	"errors"
	"github.com/router-for-me/CLIProxyAPI/v8/internal/catalogfallback"
	"regexp"
)

type ModelProfile struct {
	PreferredModel string               `yaml:"preferred-model,omitempty" json:"preferred-model,omitempty"`
	Task           catalogfallback.Task `yaml:"task" json:"task"`
	MaxModels      int                  `yaml:"max-models,omitempty" json:"max-models,omitempty"`
	CostPolicy     string               `yaml:"cost-policy,omitempty" json:"cost-policy,omitempty"`
}

var profileName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

func ValidateModelProfiles(profiles map[string]ModelProfile) error {
	if len(profiles) > 32 {
		return errors.New("too many model profiles")
	}
	for name, p := range profiles {
		if !profileName.MatchString(name) || name == "admin" || name == "v1" || name == "dashboard" {
			return errors.New("invalid/reserved model profile name")
		}
		if p.Task != catalogfallback.Coding && p.Task != catalogfallback.Agent && p.Task != catalogfallback.Reasoning && p.Task != catalogfallback.Structured && p.Task != catalogfallback.LongContext && p.Task != catalogfallback.General {
			return errors.New("unsupported model profile task")
		}
		if p.MaxModels < 0 || p.MaxModels > 50 {
			return errors.New("profile model limit out of range")
		}
		if p.CostPolicy != "" && p.CostPolicy != "free-only" && p.CostPolicy != "session" {
			return errors.New("profile cost policy must be session or free-only")
		}
	}
	return nil
}
func (p CanonicalRoutingConfig) Profile(name string) (ModelProfile, bool) {
	if len(p.Profiles) == 0 {
		if name == "coding" || name == "chat" {
			task := catalogfallback.Coding
			if name == "chat" {
				task = catalogfallback.General
			}
			return ModelProfile{Task: task, MaxModels: 12, CostPolicy: "session"}, true
		}
		return ModelProfile{}, false
	}
	v, ok := p.Profiles[name]
	if !ok {
		return ModelProfile{}, false
	}
	if v.MaxModels == 0 {
		v.MaxModels = 12
	}
	if v.CostPolicy == "" {
		v.CostPolicy = "session"
	}
	return v, true
}

type profileContextKey struct{}

func WithModelProfile(ctx context.Context, name string) context.Context {
	return context.WithValue(ctx, profileContextKey{}, name)
}
func ModelProfileFromContext(ctx context.Context) string {
	v, _ := ctx.Value(profileContextKey{}).(string)
	return v
}
