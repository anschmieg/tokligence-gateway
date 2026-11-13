#!/usr/bin/env python3
"""Extend a NEW copy of reviewed native.9; no network, secrets or execution."""
import argparse,hashlib,json,shutil
from pathlib import Path
P=Path(__file__).resolve().parent/'patches/canonical_catalog'
# SHA pins written from the exact reviewed native.9 source, never release heads.
INPUTS={'internal/registry/catalog_config.go': 'f5d2d53a1a05da5eead4fb231ab3f8de2cf1538a8b7949e71f487ad3e93951e9', 'internal/registry/model_registry.go': '274b7fa3f29fcd7005ef5da190658ed76627e3448722e35cd653ef98751a6777', 'sdk/cliproxy/service_executors.go': '670196048e337037e62308ad1d93031866aeff296895e61c31add2129ff30b90', 'sdk/cliproxy/model_registry.go': 'cc1b8af846ae107ebbe9a61c8bec611138275264aef4da9ccdc7eb0a8531b0eb', 'internal/registry/catalog_metadata.go':'d04a063b0bc27cd125a4d875480ba74d0948a21946c59a6accbcb7ed69c3deca', 'sdk/cliproxy/catalog_discovery.go':'d5a424e715986d88fad12f5dc264611d38943b8b56e2a4686c94e0c6372bb2b5', 'sdk/cliproxy/auth/conductor_models.go': '6fb7d4855e597da5d602b835b8496788473b261f17584e82a3fcd596a56e8c52'}
INPUTS.update({'internal/config/config_types.go': 'e70f9cb825e8dbf8eda9f474a8d90ccf1e671835fd05318b4428dcd1953d6d09', 'internal/config/config_v8.go': '8c62c796a5169491a8053eb0738b79493849f23318250ba912a2a1082c7f9c73', 'sdk/api/handlers/handlers_execution.go': 'c83308f96120e8f104446b9a2042e9491a64cb2655401a9b3d0ade866dfec84e', 'sdk/api/handlers/handlers_stream.go': 'fd12c411d8457bd9d1cc622effad295adce862fbf6e20839ca0058976c7f679b', 'sdk/api/handlers/handlers.go': 'a0f85b6f0eac1ce53dac192156a5cb63071c535592fd435b26931da3362ecfe4', 'sdk/api/handlers/handlers_routing.go': '06a3cf7f2b8a2a9d942a928f06f90d817c8b5825962e2f3c0173d8500535803c', 'sdk/cliproxy/auth/conductor_execution.go': '6dfb51e3f9d0b4d9eff66a12a8b70f1e8255fdd89299f275dc42bf9e384eaa1d', 'sdk/cliproxy/auth/conductor_stream.go': 'c0766dc6ac459861e40fb4ba07a1266572f6fe13c8dafb7c62c9c871833a56d7'})
INPUTS.update({'internal/registry/catalog_sources.go': '1cc8d139ab0a88464ad334de81c7aaa2aadc56c80eff72b57ed491cf3e5f488d'})
INPUTS.update({'sdk/pluginapi/types.go': 'b33ed046a906346af95956bd368f0ebf65b078df2f0508de82e9117033f22372', 'internal/pluginhost/adapters.go': '014f6cb594b61dd8d1467a4d6a3a1854ac07334589f2cac66a30ca889c713975'})
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 q=argparse.ArgumentParser();q.add_argument('--source',type=Path,required=True);q.add_argument('--output',type=Path,required=True);a=q.parse_args()
 if a.output.exists():q.error('output must be new')
 for name,digest in INPUTS.items():
  if sha(a.source/name)!=digest:raise RuntimeError('source differs: '+name)
 shutil.copytree(a.source,a.output,ignore=shutil.ignore_patterns('.git','*.so','*.a','cli-proxy-api'))
 def edit(name,old,new):
  p=a.output/name;s=p.read_text()
  if s.count(old)!=1:raise RuntimeError('anchor differs: '+name+' '+old[:45])
  p.write_text(s.replace(old,new,1))
 edit('internal/registry/catalog_config.go','type CatalogSources struct {','type CatalogSources struct {\n CanonicalOnly bool `yaml:"canonical-only,omitempty" json:"canonical-only,omitempty"`\n CanonicalRouting CanonicalRoutingConfig `yaml:"canonical-routing,omitempty" json:"canonical-routing,omitempty"`\n FreeTierProviders []string `yaml:"free-tier-providers,omitempty" json:"free-tier-providers,omitempty"`')
 edit('internal/registry/model_registry.go','type ModelInfo struct {','type ModelInfo struct {\n HideFromDiscovery bool `json:"-"`\n CanonicalSourceID string `json:"-"`\n CanonicalID string `json:"-"`\n CanonicalOverride bool `json:"-"`\n CanonicalFree bool `json:"-"`\n CanonicalPolicy string `json:"-"`\n PluginCostTier string `json:"-"`\n PluginSourceModelID string `json:"-"`')
 edit('sdk/cliproxy/service_executors.go','if len(normalizedModels) == 0 {','normalizedModels = s.canonicalizeRegisteredModels(s.currentConfig(), a, normalizedModels)\n if len(normalizedModels) == 0 {')
 edit('sdk/cliproxy/model_registry.go','preserveAvailability bool','preserveAvailability bool\n canonicalOnly bool\n canonicalSignature [32]byte')
 edit('sdk/cliproxy/model_registry.go','var exclusions map[string]diff.ExcludedModelsSummary','canonicalOnly := cfg != nil && cfg.Models.CanonicalOnly\n var exclusions map[string]diff.ExcludedModelsSummary')
 edit('sdk/cliproxy/model_registry.go','return modelRegistrationFence{globalExclusions: exclusions}','return modelRegistrationFence{globalExclusions: exclusions, canonicalOnly:canonicalOnly, canonicalSignature:canonicalPolicySignature(cfg), preserveAvailability:canonicalOnly}')
 edit('sdk/cliproxy/model_registry.go','globalExclusions:  exclusions,','globalExclusions:  exclusions, canonicalOnly:canonicalOnly, canonicalSignature:canonicalPolicySignature(cfg), preserveAvailability:canonicalOnly,')
 edit('sdk/cliproxy/model_registry.go','next.preserveAvailability = f.preserveAvailability','next.canonicalSignature = f.canonicalSignature\n next.canonicalOnly = f.canonicalOnly\n next.preserveAvailability = f.preserveAvailability')
 edit('sdk/cliproxy/model_registry.go','\t\t\ts.cfgMu.RLock()\n\t\t\tdefer s.cfgMu.RUnlock()','')
 edit('sdk/cliproxy/model_registry.go','publishWithConfig := func() bool {','''publishWithConfig := func() bool {
  if s != nil { s.cfgMu.RLock(); defer s.cfgMu.RUnlock(); if canonicalPolicySignature(s.cfg) != f.canonicalSignature {return false} }
''')
 edit('sdk/cliproxy/auth/conductor_models.go','prefix := strings.TrimSpace(auth.Prefix)\n\tif prefix == "" {','''if source := registry.GetGlobalRegistry().CanonicalRouteSource(auth.ID, model); source != "" { model = source
 } else if parsed := thinking.ParseSuffix(model); parsed.ModelName != model {
  if source := registry.GetGlobalRegistry().CanonicalRouteSource(auth.ID, parsed.ModelName); source != "" { model = preserveRequestedModelSuffix(model, source) }
 }
 prefix := strings.TrimSpace(auth.Prefix)
 if prefix == "" {''')
 edit('internal/registry/model_registry.go','model := r.convertModelToMap(commonModelInfo(registration), handlerType)','info := r.canonicalInfoLocked(registration.Info.ID, registration, "")\n if info == nil || info.HideFromDiscovery || (canonicalDiscoveryOnly.Load() && info.CanonicalPolicy!="canonical") { continue }\n model := r.convertModelToMap(info, handlerType)')
 edit('internal/registry/model_registry.go','\n\t\tresult = append(result, cloneModelInfo(registration.Info))','\n\t\tinfo := r.canonicalInfoLocked(registration.Info.ID, registration, "")\n if info != nil && !info.HideFromDiscovery && (!canonicalDiscoveryOnly.Load() || info.CanonicalPolicy=="canonical") { result = append(result, info) }')
 edit('internal/registry/model_registry.go','return commonModelInfo(reg)','return r.canonicalInfoLocked(modelID, reg, "")')
 edit('internal/registry/model_registry.go','return cloneModelInfo(info)\n\t\t\t\t\t}', 'return r.canonicalInfoLocked(modelID, reg, provider)\n\t\t\t\t\t}')
 edit('internal/registry/model_registry.go','for _, id := range models {\n\t\tif strings.EqualFold(strings.TrimSpace(id), modelID) {\n\t\t\treturn true','for _, id := range models {\n\t\tif strings.EqualFold(strings.TrimSpace(id), modelID) {\n if info := r.clientModelInfos[clientID][id]; info != nil && !canonicalRouteEntry(info) && r.hasCanonicalLocked(id) { return false }\n\t\t\treturn true')
 edit('internal/registry/model_registry.go','for name, count := range registration.Providers {\n\t\tif count <= 0 {','''for name, count := range registration.Providers {
  if r.hasCanonicalLocked(modelID) {
   count=0
   for client,byID:=range r.clientModelInfos {if r.clientProviders[client]==name {if info:=byID[modelID];info!=nil && canonicalRouteEntry(info) {count++}}}
  }
  if count <= 0 {''')
 edit('internal/registry/catalog_metadata.go','out := map[string]any{"providers": GetGlobalRegistry().GetModelProviders(id)}','out := map[string]any{"providers": GetGlobalRegistry().GetModelProviders(id)}\n if info.CanonicalID==id {out["canonical"]=true;out["free_only_id"]=id+":free";out["has_free_routes"]=len(GetGlobalRegistry().CanonicalRouteInfos(id+":free"))>0;out["routing_policy"]="free-then-paid-same-model"}\n if overrides:=GetGlobalRegistry().CanonicalOverrides(id);len(overrides)>0 {out["overrides"]=overrides}')
 edit('sdk/cliproxy/catalog_discovery.go','if len(candidates) == 0 {\n\t\t\tcontinue','if len(candidates) == 0 {\n s.catalogDiscovery.mu.Lock();s.catalogDiscovery.next[key]=now.Add(10*time.Second);s.catalogDiscovery.mu.Unlock()\n\t\t\tcontinue')
 edit('internal/config/config_types.go','type GeminiKey struct {','type GeminiKey struct {\n FreeTier bool `yaml:"free-tier,omitempty" json:"free-tier,omitempty"`')
 edit('internal/config/config_v8.go','var sharedKeyFields = map[string]bool{','var sharedKeyFields = map[string]bool{\n "free-tier": true,')

 edit('sdk/api/handlers/handlers_execution.go','func (h *BaseAPIHandler) executeWithAuthManagerFormats(', 'func (h *BaseAPIHandler) executeCanonicalNonstreamAttempt(')
 edit('sdk/api/handlers/handlers_stream.go','func (h *BaseAPIHandler) executeStreamWithAuthManagerFormats(', 'func (h *BaseAPIHandler) executeCanonicalStreamAttempt(')
 edit('sdk/api/handlers/handlers.go','meta := make(map[string]any)','''meta := make(map[string]any)
 if ctx != nil {if attempt,ok:=ctx.Value(canonicalAttemptContextKey{}).(canonicalAttemptContext);ok {
 meta["gateway.canonical_dispatch"]=true;meta["gateway.canonical_excluded_auths"]=attempt.Excluded;meta["gateway.canonical_route"]=attempt.Route;meta["gateway.canonical_bindings"]=attempt.Bindings;meta["gateway.canonical_permit"]=attempt.Permit
 }}''')
 edit('sdk/api/handlers/handlers_routing.go','var decision modelRouteDecision','var decision modelRouteDecision\n if ctx!=nil && ctx.Value(canonicalAttemptContextKey{})!=nil {return decision}')
 edit('sdk/api/handlers/handlers_stream.go','maxBootstrapRetries := StreamingBootstrapRetries(h.CurrentConfig())','maxBootstrapRetries := StreamingBootstrapRetries(h.CurrentConfig())\n if ctx!=nil && ctx.Value(canonicalAttemptContextKey{})!=nil {maxBootstrapRetries=0}')
 def edits(name,old,new,count):
  p=a.output/name;t=p.read_text()
  if t.count(old)!=count:raise RuntimeError('multi-anchor differs: '+name+' '+old)
  p.write_text(t.replace(old,new))
 edits('sdk/cliproxy/auth/conductor_execution.go','defaultRequestRetry, maxRetryCredentials, maxWait := m.retrySettings()','defaultRequestRetry, maxRetryCredentials, maxWait := m.retrySettings()\n if canonicalOneDispatch(opts.Metadata) {defaultRequestRetry=0;maxRetryCredentials=1;maxWait=0}',3)
 edits('sdk/cliproxy/auth/conductor_execution.go','tried := make(map[string]struct{})','tried := make(map[string]struct{})\n for _,id:=range canonicalAttemptExclusions(opts.Metadata) {tried[id]=struct{}{}}',3)
 edits('sdk/cliproxy/auth/conductor_execution.go','errExec, didRefreshOnUnauthorized, execOpts.Headers','errExec, didRefreshOnUnauthorized || canonicalOneDispatch(execOpts.Metadata), execOpts.Headers',2)
 edits('sdk/cliproxy/auth/conductor_stream.go','alreadyTried := didRefreshOnUnauthorized','alreadyTried := didRefreshOnUnauthorized || canonicalOneDispatch(execOpts.Metadata)',2)
 edits('sdk/cliproxy/auth/conductor_execution.go','if hasAntigravityProvider(normalized) && shouldAttempt','if !canonicalOneDispatch(opts.Metadata) && hasAntigravityProvider(normalized) && shouldAttempt',2)

 edits('sdk/cliproxy/auth/conductor_execution.go','models, pooled, aliasResult, routing := m.preparedExecutionModelsWithAlias(auth, routeModel)','models, pooled, aliasResult, routing := m.preparedExecutionModelsWithAlias(auth, routeModel)\n if canonicalOneDispatch(opts.Metadata) && len(models)>1 {models=models[:1]}',2)
 edit('internal/registry/catalog_sources.go','func StartModelCatalogUpdaters(ctx context.Context, sources CatalogSources, home bool) {','func StartModelCatalogUpdaters(ctx context.Context, sources CatalogSources, home bool) {\n setCanonicalDiscoveryOnly(sources.CanonicalOnly)')
 edit('internal/registry/catalog_sources.go','func UpdateModelCatalogSources(sources CatalogSources, home bool) {','func UpdateModelCatalogSources(sources CatalogSources, home bool) {\n setCanonicalDiscoveryOnly(sources.CanonicalOnly)')

 edit('sdk/cliproxy/auth/conductor_models.go','routing := m.loadAPIKeyModelRouting()\n\trequestedModel := rewriteModelForAuth(routeModel, auth)', 'routing := m.loadAPIKeyModelRouting()\n if source,ok:=canonicalPinnedModel(auth,routeModel);ok {return []string{source},false,OAuthModelAliasResult{},routing}\n\trequestedModel := rewriteModelForAuth(routeModel, auth)')
 edit('sdk/cliproxy/auth/conductor_models.go','func (m *Manager) executionModelCandidates(auth *Auth, routeModel string) []string {','func (m *Manager) executionModelCandidates(auth *Auth, routeModel string) []string {\n if source,ok:=canonicalPinnedModel(auth,routeModel);ok{return []string{source}}')
 edit('internal/pluginhost/adapters.go','return pluginapi.ModelInfo{\n\t\tID:', 'return pluginapi.ModelInfo{\n CostTier:model.PluginCostTier,SourceModelID:model.PluginSourceModelID,\n\t\tID:')
 edit('sdk/cliproxy/catalog_discovery.go','case map[string]any:\n\t\t\tif v, exists := p["request"]; exists {','case map[string]any:\n for _,price:=range p {if !zeroCatalogValue(price){return false}}\n\t\t\tif v, exists := p["request"]; exists {')
 # Guard every concrete executor invocation, including pool and retry branches.
 import re
 for file in ['sdk/cliproxy/auth/conductor_execution.go','sdk/cliproxy/auth/conductor_stream.go']:
  p=a.output/file;t=p.read_text()
  for method,guard in [('Execute','executeCanonicalGuarded'),('ExecuteStream','streamCanonicalGuarded'),('CountTokens','countCanonicalGuarded')]:
   t=re.sub(r'executor\.'+method+r'\(([^,]+), auth, ([^,]+), ([^)]+)\)',lambda m:guard+'('+m[1]+', executor, auth, '+m[2]+', '+m[3]+')',t)
  p.write_text(t)
 edit('sdk/pluginapi/types.go','type ModelInfo struct {','type ModelInfo struct {\n CostTier string\n SourceModelID string')
 edit('internal/pluginhost/adapters.go','func pluginModelInfoToRegistryModelInfo(model pluginapi.ModelInfo) *registry.ModelInfo {\n\treturn &registry.ModelInfo{','func pluginModelInfoToRegistryModelInfo(model pluginapi.ModelInfo) *registry.ModelInfo {\n\treturn &registry.ModelInfo{\n PluginCostTier:model.CostTier,PluginSourceModelID:model.SourceModelID,')
 dest={'identity.go':'internal/modelidentity/identity.go','canonical_registration.go':'sdk/cliproxy/canonical_registration.go','canonical_registry.go':'internal/registry/canonical_registry.go','identity_test.go':'internal/modelidentity/identity_test.go','canonical_registration_test.go':'sdk/cliproxy/canonical_registration_test.go','canonical_registry_test.go':'internal/registry/canonical_registry_test.go','canonical_auth_test.go':'sdk/cliproxy/auth/canonical_auth_test.go','routing_types.go':'internal/registry/routing_types.go','canonical_policy_execution.go':'sdk/cliproxy/auth/canonical_policy_execution.go','canonical_policy.go':'sdk/api/handlers/canonical_policy.go','canonical_policy_test.go':'sdk/api/handlers/canonical_policy_test.go'}
 dest.update({'canonical_similarity.go':'sdk/api/handlers/canonical_similarity.go','canonical_similarity_test.go':'sdk/api/handlers/canonical_similarity_test.go','canonical_history.go':'sdk/api/handlers/canonical_history.go'})
 dest.update({'canonical_adversarial_handlers_test.go':'sdk/api/handlers/canonical_adversarial_test.go','canonical_adversarial_auth_test.go':'sdk/cliproxy/auth/canonical_adversarial_test.go','canonical_adversarial_registration_test.go':'sdk/cliproxy/canonical_adversarial_test.go','canonical_adversarial_identity_test.go':'internal/modelidentity/canonical_adversarial_test.go'})
 for source,target in dest.items():
  if not (P/source).exists():continue
  p=a.output/target;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(P/source,p)
 (a.output/'canonical-catalog-patch.json').write_text(json.dumps({'inputs':INPUTS,'patches':{p.name:sha(p) for p in P.glob('*.go')}},indent=2)+'\n')
 print(json.dumps({'prepared':str(a.output),'deployed':False}))
if __name__=='__main__':main()
