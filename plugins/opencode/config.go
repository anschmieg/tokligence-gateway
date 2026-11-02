package opencode

import (
	"fmt"
	"strings"

	"gopkg.in/yaml.v3"
)

// PluginConfig is the YAML the host delivers under plugins.configs.opencode.
// Every value is operator-owned. The plugin reads no environment and no
// files; the credential arrives only through the host auth-dir parse and the
// executor request StorageJSON.
type PluginConfig struct {
	// ConsoleHeaders is the provider header overlay returned by the native
	// Console configuration. It is not a caller header passthrough.
	ConsoleHeaders map[string]string `yaml:"console_headers"`

	// ConsoleDisabledModels is the reviewed Console model policy snapshot.
	// It restricts the explicit local allowlist; it never grants new models.
	ConsoleDisabledModels ConsoleModelDenylist `yaml:"console_disabled_models"`

	Enabled bool `yaml:"enabled"`

	// InferenceBaseURL is the OpenCode inference endpoint root, for example
	// https://opencode.ai/inference/openai/v1. Requests go to
	// <InferenceBaseURL>/chat/completions.
	InferenceBaseURL string `yaml:"inference_base_url"`

	// Models is the explicit bare model allowlist (for example beam-free).
	// No model is served when the list is empty.
	Models []string `yaml:"models"`

	// AppName/Version/Channel are the native App.Info the user agent reports
	// (opencode/<channel>/<version>/<name>). They must describe the OpenCode
	// runtime this deployment actually represents; the plugin never invents
	// a version. Defaults mirror the pinned working runtime (2.0.32, channel
	// latest is the release channel, name cli).
	AppName string `yaml:"app_name"`
	Version string `yaml:"version"`
	Channel string `yaml:"channel"`

	// ProjectID is the x-opencode-project value for requests whose host
	// conversation carries no project identity. The native default project
	// identity is "global".
	ProjectID string `yaml:"project_id"`

	// SessionStatePath is the plugin-owned persistent session registry file
	// (see registry.go). Empty keeps the registry in memory only (mappings
	// lost on restart). The registry holds an exclusive OS lock on the file.
	SessionStatePath string `yaml:"session_state_path"`
}

// registryStatePath returns the configured persistent state path.
func (c PluginConfig) registryStatePath() string {
	return strings.TrimSpace(c.SessionStatePath)
}

// DefaultAppInfo returns the default App.Info matching the pinned working
// OpenCode runtime the audited evidence records (CLI 2.0.32, release channel
// "latest", artifact name "cli").
func DefaultAppInfo() AppInfo {
	return AppInfo{Name: "cli", Version: "2.0.32", Channel: "latest"}
}

// DefaultProjectID is the native global project identity.
const DefaultProjectID = "global"

func (c PluginConfig) App() AppInfo {
	app := AppInfo{Name: c.AppName, Version: c.Version, Channel: c.Channel}
	if strings.TrimSpace(app.Name) == "" {
		app.Name = "cli"
	}
	if strings.TrimSpace(app.Version) == "" {
		app.Version = DefaultAppInfo().Version
	}
	if strings.TrimSpace(app.Channel) == "" {
		app.Channel = DefaultAppInfo().Channel
	}
	return app
}

// DecodeConfig parses and normalizes the plugin configuration subtree. The
// host hands the original YAML subtree (yaml.v3, the library upstream itself
// uses). Model ids are deduplicated in order.
func DecodeConfig(raw []byte) (PluginConfig, error) {
	var cfg PluginConfig
	if len(strings.TrimSpace(string(raw))) == 0 {
		// An empty subtree leaves defaults in place; the host always sends the
		// merged configuration on register/reconfigure.
		cfg = PluginConfig{}
	} else if err := yaml.Unmarshal(raw, &cfg); err != nil {
		return PluginConfig{}, err
	}
	cfg.InferenceBaseURL = strings.TrimRight(strings.TrimSpace(cfg.InferenceBaseURL), "/")
	cfg.AppName = strings.TrimSpace(cfg.AppName)
	cfg.Version = strings.TrimSpace(cfg.Version)
	cfg.Channel = strings.TrimSpace(cfg.Channel)
	cfg.ProjectID = strings.TrimSpace(cfg.ProjectID)
	if cfg.Models != nil {
		seen := make(map[string]struct{}, len(cfg.Models))
		models := make([]string, 0, len(cfg.Models))
		for _, model := range cfg.Models {
			model = strings.TrimSpace(model)
			if model == "" {
				continue
			}
			if _, dup := seen[model]; dup {
				continue
			}
			seen[model] = struct{}{}
			models = append(models, model)
		}
		cfg.Models = models
	}
	headers := make(map[string]string, len(cfg.ConsoleHeaders))
	for key, value := range cfg.ConsoleHeaders {
		name := strings.ToLower(key)
		if name == "" || strings.ContainsAny(value, "\r\n\x00") {
			return PluginConfig{}, fmt.Errorf("invalid Console header")
		}
		for _, r := range name {
			if !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || strings.ContainsRune("!#$%&'*+-.^_`|~", r)) {
				return PluginConfig{}, fmt.Errorf("invalid Console header name")
			}
		}
		if _, duplicate := headers[name]; duplicate {
			return PluginConfig{}, fmt.Errorf("duplicate Console header")
		}
		switch name {
		case "authorization", "cookie", "host", "connection", "content-length", "transfer-encoding", "proxy-authorization":
			return PluginConfig{}, fmt.Errorf("Console overlay cannot replace transport authentication or framing")
		}
		headers[name] = value
	}
	cfg.ConsoleHeaders = headers
	seenDisabled := make(map[string]bool)
	disabled := make([]string, 0, len(cfg.ConsoleDisabledModels))
	for _, model := range cfg.ConsoleDisabledModels {
		if model == "" || strings.TrimSpace(model) != model || strings.ContainsAny(model, "\r\n\x00") {
			return PluginConfig{}, fmt.Errorf("invalid Console disabled model identity")
		}
		if !seenDisabled[model] {
			disabled = append(disabled, model)
			seenDisabled[model] = true
		}
	}
	cfg.ConsoleDisabledModels = disabled
	return cfg, nil
}

// ModelAllowed reports whether the bare model id is in the configured
// allowlist. Free-tier eligibility is never inferred from a model id: only
// the explicit operator allowlist serves.
func (c PluginConfig) ModelAllowed(model string) bool {
	model = strings.TrimSpace(model)
	if model == "" {
		return false
	}
	for _, disabled := range c.ConsoleDisabledModels {
		if disabled == model {
			return false
		}
	}
	for _, allowed := range c.Models {
		if allowed == model {
			return true
		}
	}
	return false
}

// ConsoleModelDenylist refuses YAML's implicit null-to-empty-list conversion.
// A malformed restriction must fail configuration instead of disappearing.
type ConsoleModelDenylist []string

func (list *ConsoleModelDenylist) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind != yaml.SequenceNode {
		return fmt.Errorf("Console disabled models must be a string list")
	}
	for _, item := range node.Content {
		if item.Kind != yaml.ScalarNode || item.Tag != "!!str" {
			return fmt.Errorf("Console disabled models must contain strings")
		}
	}
	var values []string
	if err := node.Decode(&values); err != nil {
		return err
	}
	*list = values
	return nil
}
