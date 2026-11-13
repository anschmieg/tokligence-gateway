package modelidentity

import "testing"

func TestCanonicalNamesAreSemanticAndLossless(t *testing.T) {
	cases := []struct {
		source, owner string
		paid          bool
		want          string
	}{
		{"llm7-llm7/GLM-5.3-Flash", "llm7", false, "glm-5.3-flash"},
		{"GLM-5-3-Flash", "llm7", false, "glm-5.3-flash"},
		{"z-ai/glm-5.3-flash-free", "OrcaRouter", false, "glm-5.3-flash"},
		{"z-ai/glm-5.3-flash", "OrcaRouter", true, "glm-5.3-flash"},
		{"nvidia/nemotron-3.5-lightning-30b-a3b", "Requesty", false, "nemotron-3.5-lightning"},
		{"kilo-kilo/nvidia/nemotron-3.5-lightning:free", "kilo", false, "nemotron-3.5-lightning"},
		{"deepinfra/google/gemma-4-31B-it:flex", "Requesty", false, "gemma-4-31b-it:flex"},
		{"sambanova-sambanova/Meta-Llama-3.3-70B-Instruct", "sambanova", false, "llama-3.3-70b-instruct"},
		{"nvidia-nvidia/nvidia/nemotron-3.5-lightning-30b-a3b", "nvidia", false, "nemotron-3.5-lightning"},
		{"gemini-3.8-flash-high", "antigravity", false, "gemini-3.8-flash-high"},
		{"glm-5.3-flash-thinking:free", "UnoRouter", false, "glm-5.3-flash-thinking"},
		{"vendor/model-fp8-2026-10-01", "kilo", false, "vendor/model-fp8-2026-10-01"},
		{"kilo-kilo/kilo-auto/free", "kilo", false, "kilo-auto/free"},
		{"paygo/custom", "custom", false, "paygo/custom"},
	}
	for _, c := range cases {
		if got := Name(c.source, c.owner, c.paid); got != c.want {
			t.Errorf("%s -> %s != %s", c.source, got, c.want)
		}
	}
	if Name("glm-5.3-flash-search:free", "uno", false) == Name("glm-5.3-flash", "uno", false) {
		t.Fatal("search merged")
	}
}
