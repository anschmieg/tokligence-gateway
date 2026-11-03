// Package modelidentity removes transport namespaces without guessing revisions,
// reasoning modes, quantizations or virtual-router identities.
package modelidentity

import (
	"regexp"
	"strings"
)

var glmVersion = regexp.MustCompile(`^glm-([0-9]+)-([0-9]+)(-|$)`)
var knownPublisher = map[string][]string{
	"openai":    {"gpt-", "o1", "o3", "o4", "codex-", "text-embedding-", "chatgpt-"},
	"anthropic": {"claude-"}, "google": {"gemini-", "gemma-", "lyria-", "imagen-", "veo-"},
	"z-ai": {"glm-"}, "zai-org": {"glm-"}, "nvidia": {"nemotron-", "llama-nemotron-"},
	"mistralai": {"mistral-", "codestral-", "ministral-", "magistral-", "devstral-", "leanstral-", "pixtral-"},
	"mistral":   {"mistral-", "codestral-", "ministral-", "magistral-", "devstral-", "leanstral-", "pixtral-"},
	"deepseek":  {"deepseek-"}, "deepseek-ai": {"deepseek-"},
	"minimax": {"minimax-"}, "minimaxai": {"minimax-"},
	"meta": {"llama-", "muse-"}, "meta-llama": {"llama-"},
	"qwen": {"qwen"}, "qwen-ai": {"qwen"}, "moonshotai": {"kimi-"},
	"cohere": {"command-", "north-"}, "cohereforai": {"command-", "north-"},
	"reflection": {"beam"}, "stealth": {"glyph-cluster"}, "recursive": {"flint-"},
	"dots-studio": {"dots-"}, "liquid": {"lfm-"}, "xingchen-agi": {"xing"},
	"thinkingmachines": {"inkling"}, "poolside": {"laguna-"}, "inclusionai": {"ling-"},
	"allenai": {"olmo"}, "stepfun-ai": {"step-"}, "stepfun": {"step-"},
	"perplexity": {"sonar"}, "x-ai": {"grok-"}, "xai": {"grok-"}, "grok": {"grok-"},
	"01-ai": {"yi-"}, "baidu": {"ernie-"}, "bytedance": {"seed-"}, "tencent": {"hunyuan-", "hy"},
}

// Name is deterministic for new catalogs. Only known economic suffixes and exact
// reviewed equivalences are collapsed. Unknown publisher namespaces stay intact.
func TransportSource(source, owner string) string {
	source = strings.TrimSpace(source)
	owner = strings.ToLower(strings.TrimSpace(owner))
	if owner != "" && !strings.Contains(owner, ",") {
		if strings.HasPrefix(strings.ToLower(source), owner+"-") {
			source = source[len(owner)+1:]
		}
		if strings.HasPrefix(strings.ToLower(source), owner+"/") {
			source = source[len(owner)+1:]
		}
	}
	return source
}
func Name(source, owner string, paid bool) string {
	source = strings.TrimSpace(source)
	owner = strings.ToLower(strings.TrimSpace(owner))
	if source == "" {
		return ""
	}
	id := strings.ToLower(source)
	id = strings.ToLower(TransportSource(source, owner))
	id = strings.TrimSuffix(id, ":free")
	// Requesty's hosting vendor does not identify weights; the following publisher
	// still does. Preserve service variants such as :flex rather than stripping them.
	for _, host := range []string{"deepinfra/", "novita/", "fireworks/", "together/"} {
		id = strings.TrimPrefix(id, host)
	}
	if pair := strings.SplitN(id, "/", 2); len(pair) == 2 {
		for _, family := range knownPublisher[pair[0]] {
			if strings.HasPrefix(pair[1], family) {
				id = pair[1]
				break
			}
		}
	}
	if strings.HasPrefix(id, "meta-llama-") {
		id = strings.TrimPrefix(id, "meta-")
	}
	id = glmVersion.ReplaceAllString(id, "glm-$1.$2$3")
	// Explicit provider-declared equivalences, not general removal of model sizes.
	switch id {
	case "glm-5.3-flash-free":
		id = "glm-5.3-flash"
	case "nemotron-3.5-lightning-30b-a3b", "nemotron-3.5-lightning:free", "nemotron-3.5-lightning-free":
		id = "nemotron-3.5-lightning"
	case "gpt-oss:20b":
		id = "gpt-oss-20b"
	}
	_ = paid // Cost is a routing policy, never part of model identity.
	return id
}
