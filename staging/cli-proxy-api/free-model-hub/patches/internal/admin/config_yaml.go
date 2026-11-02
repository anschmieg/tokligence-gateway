package admin

import (
	"fmt"
	"gopkg.in/yaml.v3"
)

// The native host may serialize plugin subtrees as flow YAML (including
// JSON-style mappings). Normalize with its own pinned YAML library before
// passing scalar/list values to the upstream configuration decoder.
func canonicalHostConfig(raw []byte) ([]byte, error) {
	var document yaml.Node
	if err := yaml.Unmarshal(raw, &document); err != nil {
		return nil, fmt.Errorf("invalid plugin configuration YAML")
	}
	if len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("plugin configuration must be a mapping")
	}
	var block func(*yaml.Node)
	block = func(node *yaml.Node) {
		node.Style = 0
		for _, child := range node.Content {
			block(child)
		}
	}
	block(&document)
	return yaml.Marshal(document.Content[0])
}
