#!/usr/bin/env python3
"""Prepare an OPT-IN draft backend, never mutate an installed tree or deploy.
The existing .14 canonical preparation is reused; only scratch output is edited.
"""
import argparse,hashlib,json,shutil,subprocess,sys
from pathlib import Path
HERE=Path(__file__).resolve().parent
q=argparse.ArgumentParser();q.add_argument('--source',type=Path,required=True);q.add_argument('--output',type=Path,required=True);a=q.parse_args()
if a.output.exists():q.error('output must be NEW')
subprocess.run([sys.executable,str(HERE.parent/'prepare_canonical_catalog.py'),'--source',str(a.source),'--output',str(a.output)],check=True)
def edit(name,old,new):
 p=a.output/name;s=p.read_text()
 if s.count(old)!=1:raise RuntimeError('unique draft anchor differs: '+name+' '+old[:60])
 p.write_text(s.replace(old,new,1))
def copy(source,target):
 p=a.output/target;p.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,p)
for p in (HERE/'policy').glob('*.go'):copy(p,'internal/catalogfallback/'+p.name)
copy(HERE/'cmd/main.go','cmd/catalog-fallback-preview/main.go')
for p in (HERE/'host').glob('*.go'):
 if '_handlers' in p.stem:dest='sdk/api/handlers/'
 elif '_auth' in p.stem:dest='sdk/cliproxy/auth/'
 elif '_service' in p.stem:dest='sdk/cliproxy/'
 elif '_api' in p.stem:dest='internal/api/'
 else:dest='internal/registry/'
 copy(p,dest+p.name)
edit('sdk/api/handlers/canonical_policy_test.go','CanonicalRoutingConfig{MaxAttempts: 8}', 'CanonicalRoutingConfig{MaxAttempts: 8,EvidenceCatalog:"fixture-test"}')
# Remove the deliberately replaced name/weighted-score implementation and its
# implementation-specific tests in this scratch candidate only. Safety tests stay.
for name in ['canonical_similarity.go','canonical_similarity_test.go','canonical_history.go']:
 (a.output/'sdk/api/handlers'/name).unlink()
p=a.output/'sdk/api/handlers/canonical_policy.go';s=p.read_text()
i=s.index('type canonicalRequirements struct {');j=s.index('type canonicalStage struct {',i);s=s[:i]+s[j:]
i=s.index('func canonicalRequestRequirements(');j=s.index('func containsCanonical(',i);s=s[:i]+s[j:]
i=s.index('func canonicalCompatible(');j=s.index('func (h *BaseAPIHandler) canonicalPlan(',i);s=s[:i]+s[j:]
s=s.replace('Alternative bool\n','Alternative bool\n Allowed map[string]bool\n PlannedBindings map[string]registry.CanonicalDispatchBinding\n Evidence *canonicalComparison\n',1)
old='''		var alternatives []string
		if crossModel {
			alternatives = canonicalRankedFallbacks(base, r, policy)
		}
		for _, alt := range alternatives {
			p.Stages = append(p.Stages, canonicalStage{alt + ":free", 0, true})
		}'''
if s.count(old)!=1:raise RuntimeError('fallback stage anchor differs')
s=s.replace(old,'if crossModel {p.Stages=append(p.Stages,h.canonicalEvidenceStages(ctx,base,r,policy)...)}')
s=s.replace('[]canonicalStage{{base + ":free", 0, false}}','[]canonicalStage{{Model:base + ":free", Tier:0}}')
s=s.replace('canonicalStage{base + ":paid", 2, false}, canonicalStage{base + ":paid", 3, false}','canonicalStage{Model:base + ":paid", Tier:2}, canonicalStage{Model:base + ":paid", Tier:3}')
s=s.replace('if suffix != "" {\n\t\tr.Reasoning = true\n\t}', 'if suffix != "" {canonicalSuffixRequirements(model, &r)}')
s=s.replace('skip := tried[canonicalPair(auth, info)]','skip := (stage.Alternative && stage.Allowed!=nil && !stage.Allowed[auth]) || tried[canonicalPair(auth, info)]')
s=s.replace('\n\t"encoding/json"','') # parser now lives in pure package; canonicalBody still uses JSON below
if 'json.' in s:s=s.replace('import (','import (\n "encoding/json"',1)
# Empty stages are absence of a route, not an upstream/client400 to retry.
s=s.replace('attemptCtx, bindings := canonicalAttemptContextFor(ctx, stage, p.Requirements, tried, quota, &selected)', 'attemptCtx, bindings := canonicalAttemptContextFor(ctx, stage, p.Requirements, tried, quota, &selected)\n if len(bindings)==0 {break}')
s=s.replace('attemptCtx, bindings := canonicalAttemptContextFor(attemptCtx, stage, p.Requirements, tried, quota, &selected)', 'attemptCtx, bindings := canonicalAttemptContextFor(attemptCtx, stage, p.Requirements, tried, quota, &selected)\n if len(bindings)==0 {cancel();break}')
p.write_text(s)
edit('internal/registry/routing_types.go','Free                                                             bool','Free                                                             bool\n Capabilities string')
edit('internal/registry/routing_types.go','CostTier: info.PluginCostTier, Free: info.CanonicalFree','CostTier: info.PluginCostTier, Free: info.CanonicalFree,Capabilities:catalogfallback.CapabilitiesHash(CanonicalFallbackCapabilities(info))')
edit('internal/registry/routing_types.go','import "sync/atomic"','import ("sync/atomic";"github.com/router-for-me/CLIProxyAPI/v8/internal/catalogfallback")')
edit('internal/registry/routing_types.go','type CanonicalRoutingConfig struct {','''type CanonicalRoutingConfig struct {
 Profiles map[string]ModelProfile `yaml:"profiles,omitempty" json:"profiles,omitempty"`
 NoChargeAllowances []NoChargeAllowance `yaml:"no-charge-allowances,omitempty" json:"no-charge-allowances,omitempty"`
 EvidenceCache string `yaml:"evidence-cache,omitempty" json:"evidence-cache,omitempty"`
 EvidenceCatalog string `yaml:"evidence-catalog,omitempty" json:"evidence-catalog,omitempty"`
 EvidenceMaxAgeHours int `yaml:"evidence-max-age-hours,omitempty" json:"evidence-max-age-hours,omitempty"`
 RequireComparableEvidence bool `yaml:"require-comparable-evidence,omitempty" json:"require-comparable-evidence,omitempty"`
''')
edit('internal/registry/catalog_config.go','func (m CatalogSources) Validate() error {','func (m CatalogSources) Validate() error {\n if err:=ValidateModelProfiles(m.CanonicalRouting.Profiles);err!=nil{return err};if err:=ValidateNoChargeAllowances(m.CanonicalRouting.NoChargeAllowances);err!=nil{return err};if err:=ValidateFallbackEvidenceSource(m.CanonicalRouting.EvidenceCatalog);err!=nil{return err};if m.CanonicalRouting.EvidenceCache!=""&&!filepath.IsAbs(m.CanonicalRouting.EvidenceCache){return fmt.Errorf("evidence cache path must be absolute")};if m.CanonicalRouting.EvidenceMaxAgeHours<0||m.CanonicalRouting.EvidenceMaxAgeHours>2160{return fmt.Errorf("evidence max age out of range")}')
edit('internal/registry/catalog_sources.go','sources = effectiveCatalogSources(sources, local, home)','''evidenceSource:=sources.CanonicalRouting.EvidenceCatalog
 if evidenceSource==""||home {evidenceSource="disabled"}
 configureFallbackEvidence(ctx,evidenceSource,sources.CanonicalRouting.EvidenceCache)
 sources = effectiveCatalogSources(sources, local, home)''')


# Cost authority is route-level proof, not authentication mechanism.
p=a.output/'sdk/cliproxy/canonical_registration.go';s=p.read_text()
i=s.index('\t\tif compat == nil {',s.index('free := true'));j=s.index('\n\t\tlabel :=',i)
s=s[:i]+"\t\tif compat==nil {free=m.PluginCostTier==\"free\"||canonicalAccountNoCharge(cfg,a,source)}\n"+s[j:]
s=s.replace('route.CanonicalFree = free','route.CanonicalFree = free; if compat!=nil&&free {route.CanonicalCostBasis=\"catalog-zero-price\"}')
s=s.replace('candidate.CanonicalFree = free','candidate.CanonicalFree = free; if compat!=nil&&free {candidate.CanonicalCostBasis=\"catalog-zero-price\"}')
p.write_text(s)
edit('internal/registry/model_registry.go','CanonicalSourceID string `json:"-"`','CanonicalSourceID string `json:"-"`\n CanonicalCostBasis string `json:"-"`')
# The final guard runs with the manager's current config, never a frozen receipt.
p=a.output/'sdk/cliproxy/auth/canonical_policy_execution.go';s=p.read_text()
s=s.replace('func validateCanonicalDispatch(', 'func (m *Manager) validateCanonicalDispatch(')
s=s.replace('func executeCanonicalGuarded(', 'func (m *Manager) executeCanonicalGuarded(').replace('func streamCanonicalGuarded(', 'func (m *Manager) streamCanonicalGuarded(').replace('func countCanonicalGuarded(', 'func (m *Manager) countCanonicalGuarded(')
s=s.replace('if err := validateCanonicalDispatch(', 'if err := m.validateCanonicalDispatch(')
s=s.replace('strings.HasSuffix(route, ":free") && !bound.Free','strings.HasSuffix(route, ":free") && (!bound.Free||!m.CanonicalNoChargeAllowed(a,current,time.Now()))')
s=s.replace('"strings"','"strings";"time"');p.write_text(s)
for file in ['sdk/cliproxy/auth/conductor_execution.go','sdk/cliproxy/auth/conductor_stream.go']:
 p=a.output/file;s=p.read_text()
 for call in ['executeCanonicalGuarded','streamCanonicalGuarded','countCanonicalGuarded']:s=s.replace(call+'(', 'm.'+call+'(')
 p.write_text(s)
# Fake executors need an explicit positive cost receipt too. Scope this to the
# existing test fixtures; no runtime auth kind is made equivalent to no-charge.
for name in ['sdk/api/handlers/canonical_policy_test.go','sdk/api/handlers/canonical_adversarial_test.go','sdk/cliproxy/auth/canonical_auth_test.go','sdk/cliproxy/auth/canonical_adversarial_test.go']:
 p=a.output/name
 if not p.exists():continue
 lines=p.read_text().splitlines()
 for i,line in enumerate(lines):
  if 'CanonicalFree:' in line and 'PluginCostTier:' not in line:
   if 'CanonicalFree: true,' in line:lines[i]=line.replace('CanonicalFree: true,','CanonicalFree: true, PluginCostTier:"free",')
   elif 'CanonicalFree: v.policy == "free",' in line:lines[i]=line.replace('CanonicalFree: v.policy == "free",','CanonicalFree: v.policy == "free",PluginCostTier:v.policy,')
 p.write_text('\n'.join(lines)+'\n')

# All profile requests use the native coordinator, auth and protocol handlers.
edit('sdk/api/handlers/canonical_policy.go','Requested, Base, Policy, Suffix string','Requested, Base, Policy, Suffix string; Profile string')
edit('sdk/api/handlers/canonical_policy.go','if h.AuthManager == nil || !h.AuthManager.CanonicalRoutingEnabled() {','if profile:=registry.ModelProfileFromContext(ctx);profile!="" {return h.profileCanonicalPlan(ctx,profile,model,raw,opts)}\n if h.AuthManager == nil || !h.AuthManager.CanonicalRoutingEnabled() {')
edit('sdk/api/handlers/canonical_policy.go','skip := (stage.Alternative && stage.Allowed!=nil && !stage.Allowed[auth])','skip := (stage.Allowed!=nil && !stage.Allowed[auth]) || (stage.PlannedBindings!=nil && stage.PlannedBindings[auth]!=registry.NewCanonicalDispatchBinding(auth,stage.Model,info))')
edit('sdk/api/handlers/canonical_policy.go','headers.Set("X-Gateway-Cost-Policy", p.Policy)','headers.Set("X-Gateway-Cost-Policy", p.Policy);canonicalSelectionHeaders(headers,p,stage);if p.Profile!="" {headers.Set("X-Gateway-Profile",p.Profile);headers.Set("X-Gateway-Model-Mode","hint");headers.Set("X-Gateway-Similarity-Anchor",p.Base)}')
edit('internal/api/server_routes.go','// OpenAI compatible API routes','s.registerModelProfileRoutes(openaiHandlers,claudeCodeHandlers,openaiResponsesHandlers)\n // OpenAI compatible API routes')
edit('sdk/api/handlers/request_body.go','func ReadRequestBody(c *gin.Context)', 'func readNativeRequestBody(c *gin.Context)')
edit('sdk/api/handlers/handlers.go','newCtx, cancel := context.WithCancel(parentCtx)','if requestCtx!=nil {if profile:=registry.ModelProfileFromContext(requestCtx);profile!="" {parentCtx=registry.WithModelProfile(parentCtx,profile)}}\n newCtx, cancel := context.WithCancel(parentCtx)')

# Exclude expired/revoked allowances BEFORE selection as well as at final guard.
p=a.output/'sdk/api/handlers/canonical_policy.go';s=p.read_text()
s=s.replace('selected *string) (context.Context, map[string]registry.CanonicalDispatchBinding)', 'selected *string, managers ...*coreauth.Manager) (context.Context, map[string]registry.CanonicalDispatchBinding)')
s=s.replace('"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking"', '"github.com/router-for-me/CLIProxyAPI/v8/internal/thinking";coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth";"time"')
s=s.replace('if !blocked[id] {\n\t\t\tbindings[id]', 'if len(managers)>0&&managers[0]!=nil&&strings.HasSuffix(stage.Model,":free")&&!managers[0].CanonicalFallbackAvailable(id,stage.Model,time.Now()){blocked[id]=true;excluded=append(excluded,id)}\n if !blocked[id] {\n\t\t\tbindings[id]')
s=s.replace('p.Requirements, tried, quota, &selected)', 'p.Requirements, tried, quota, &selected,h.AuthManager)')
p.write_text(s)
edit('sdk/api/handlers/handlers.go','"github.com/router-for-me/CLIProxyAPI/v8/internal/interfaces"','"github.com/router-for-me/CLIProxyAPI/v8/internal/interfaces";"github.com/router-for-me/CLIProxyAPI/v8/internal/registry"')
edit('internal/registry/catalog_metadata.go','out["free_only_id"]=id+":free";', '')

edit('sdk/cliproxy/auth/canonical_policy_execution.go','p := cfg.Models.CanonicalRouting','p := cfg.Models.CanonicalRouting\n if p.Profiles!=nil {cloned:=map[string]registry.ModelProfile{};for name,profile:=range p.Profiles{cloned[name]=profile};p.Profiles=cloned}\n p.NoChargeAllowances=append([]registry.NoChargeAllowance(nil),p.NoChargeAllowances...);for i:=range p.NoChargeAllowances{p.NoChargeAllowances[i].SourceModels=append([]string(nil),p.NoChargeAllowances[i].SourceModels...)}')

edit('sdk/api/handlers/canonical_policy.go','if suffix != "" {canonicalSuffixRequirements(model, &r)}','if free&&r.UnverifiedCostFeatures{return canonicalPlan{},true,&interfaces.ErrorMessage{StatusCode:400,Error:errors.New("free-only request contains unverified metered features")}}\n if suffix != "" {canonicalSuffixRequirements(model, &r)}')
edit('sdk/api/handlers/canonical_policy.go','return p, true, nil','if !free&&r.UnverifiedCostFeatures {p.Stages=p.Stages[1:]}\n return p, true, nil')

# Apply curation after native client-format generation and response interceptors.
edit('sdk/api/handlers/handlers_interceptors.go','if modelID, detail := c.Get(ModelDetailIDContextKey); detail {','if filtered,status:=h.filterProfileModelList(c,body);status!=200 {lifecycle.complete(pluginapi.RequestCompletionFailed,status,nil);c.Writer.Header().Del("Content-Length");c.Header("Content-Type","application/json; charset=utf-8");c.Status(status);_,_=c.Writer.Write(filtered);return}else{body=filtered}\n if modelID, detail := c.Get(ModelDetailIDContextKey); detail {')
subprocess.run([sys.executable,str(HERE/'prepare_billing.py'),'--source',str(a.output)],check=True)
manifest={str(p.relative_to(HERE)):hashlib.sha256(p.read_bytes()).hexdigest() for folder in ['host','policy','cmd'] for p in (HERE/folder).glob('*.go')}
(a.output/'catalog-fallback-draft.json').write_text(json.dumps({'draft':True,'production_changes':False,'files':manifest},indent=2)+'\n')
print(json.dumps({'draft_prepared':str(a.output),'deployed':False}))
