#!/usr/bin/env python3
"""Prepare a NEW native.8 tree from the reviewed native.7 model-catalog tree.
No network, credentials, config writes, builds or runtime operations.
"""
import argparse,shutil,json,hashlib
from pathlib import Path
PATCH=Path(__file__).resolve().parent/'patches/model_discovery'
INPUTS={'internal/config/config_types.go': 'e3718f5e4557602f9d407549c613c9f3999b32266fe44f4b88845a4967de7731', 'sdk/cliproxy/service.go': '169ef030cb560fb744180fbba5383bdbcbe7821943698ec5883a78e8039b0e24', 'sdk/cliproxy/service_models.go': '03ec38d009df33eaee10438986724f46fb666aedbce5cbe19088c810af4aeaaf', 'sdk/cliproxy/service_lifecycle.go': 'd53ab78677254adb7bb3f82d4f9482f561acf42acce1529454ee018231a26ab3', 'sdk/cliproxy/model_registry.go': '102d8949f2b26a77b1e0c4a6568e0869a6471bebc3418810193dd9a4eafd4a45'}
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',required=True,type=Path);p.add_argument('--output',required=True,type=Path);a=p.parse_args()
 if a.output.exists():p.error('output must not exist')
 for name,digest in INPUTS.items():
  if sha(a.source/name)!=digest:raise RuntimeError('input differs: '+name)
 shutil.copytree(a.source,a.output,ignore=shutil.ignore_patterns('.git','*.so','cli-proxy-api'))
 def edit(name,old,new):
  target=a.output/name;s=target.read_text()
  if s.count(old)!=1:raise RuntimeError('anchor differs '+name+': '+old[:60])
  target.write_text(s.replace(old,new,1))
 edit('internal/config/config_types.go','type OpenAICompatibility struct {','''type ModelDiscoveryConfig struct {
 Enabled bool `yaml:"enabled" json:"enabled"`
 FreeOnly bool `yaml:"free-only" json:"free-only"`
 RefreshSeconds int `yaml:"refresh-seconds,omitempty" json:"refresh-seconds,omitempty"`
}

type OpenAICompatibility struct {
 ModelDiscovery *ModelDiscoveryConfig `yaml:"model-discovery,omitempty" json:"model-discovery,omitempty"`''')
 edit('internal/config/config_types.go','type PluginsConfig struct {','''type PluginsConfig struct {
 ModelRefreshSeconds int `yaml:"model-refresh-seconds,omitempty" json:"model-refresh-seconds,omitempty"`
 ModelRefreshProviders []string `yaml:"model-refresh-providers,omitempty" json:"model-refresh-providers,omitempty"`''')
 edit('sdk/cliproxy/service.go','type Service struct {','type Service struct {\n catalogDiscovery catalogDiscoveryState')
 edit('sdk/cliproxy/service_models.go','ms := buildOpenAICompatibilityConfigModels(compat)','ms := s.discoveredCompatModels(compat, buildOpenAICompatibilityConfigModels(compat))')
 edit('sdk/cliproxy/service_models.go','ms := cached.models','ms := s.discoveredCompatModelsForAuth(cfg, a, compatName, cached.models)')
 edit('sdk/cliproxy/service_models.go','fence := newModelRegistrationFence(a, cfg)','fence := newModelRegistrationFence(a, cfg)\n fence.preserveAvailability, _ = ctx.Value(catalogRefreshContextKey{}).(bool)')
 edit('sdk/cliproxy/service_lifecycle.go','go s.runAntigravityModelRefresh(ctx)','go s.runAntigravityModelRefresh(ctx)\n go s.runCatalogDiscovery(ctx)')
 edit('sdk/cliproxy/model_registry.go','type modelRegistrationFence struct {','type modelRegistrationFence struct {\n preserveAvailability bool')
 edit('sdk/cliproxy/model_registry.go','next.globalExclusions = f.globalExclusions','next.preserveAvailability = f.preserveAvailability\n next.globalExclusions = f.globalExclusions')
 edit('sdk/cliproxy/model_registry.go','return GlobalModelRegistry().RegisterClientIfEpochCurrent(authID, providerKey, f.registryEpoch, models, func() bool { return true })','''if f.preserveAvailability { _, ok := registry.GetGlobalRegistry().ReplaceClientModels(authID, providerKey, f.registryEpoch, models); return ok }
 return GlobalModelRegistry().RegisterClientIfEpochCurrent(authID, providerKey, f.registryEpoch, models, func() bool { return true })''')
 for name in ['catalog_discovery.go','catalog_discovery_test.go']:shutil.copyfile(PATCH/name,a.output/'sdk/cliproxy'/name)
 (a.output/'model-discovery-patch.json').write_text(json.dumps({'inputs':INPUTS,'patches':{x.name:sha(x) for x in PATCH.glob('*.go')}},indent=2)+'\n')
 print(json.dumps({'prepared':str(a.output),'deployed':False}))
if __name__=='__main__':main()
