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
s=s.replace('Alternative bool\n','Alternative bool\n Allowed map[string]bool\n',1)
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
p.write_text(s)
edit('internal/registry/routing_types.go','Free                                                             bool','Free                                                             bool\n Capabilities string')
edit('internal/registry/routing_types.go','CostTier: info.PluginCostTier, Free: info.CanonicalFree','CostTier: info.PluginCostTier, Free: info.CanonicalFree,Capabilities:catalogfallback.CapabilitiesHash(CanonicalFallbackCapabilities(info))')
edit('internal/registry/routing_types.go','import "sync/atomic"','import ("sync/atomic";"github.com/router-for-me/CLIProxyAPI/v8/internal/catalogfallback")')
edit('internal/registry/routing_types.go','type CanonicalRoutingConfig struct {','''type CanonicalRoutingConfig struct {
 EvidenceCache string `yaml:"evidence-cache,omitempty" json:"evidence-cache,omitempty"`
 EvidenceCatalog string `yaml:"evidence-catalog,omitempty" json:"evidence-catalog,omitempty"`
 EvidenceMaxAgeHours int `yaml:"evidence-max-age-hours,omitempty" json:"evidence-max-age-hours,omitempty"`
 RequireComparableEvidence bool `yaml:"require-comparable-evidence,omitempty" json:"require-comparable-evidence,omitempty"`
''')
edit('internal/registry/catalog_config.go','func (m CatalogSources) Validate() error {','func (m CatalogSources) Validate() error {\n if err:=ValidateFallbackEvidenceSource(m.CanonicalRouting.EvidenceCatalog);err!=nil{return err};if m.CanonicalRouting.EvidenceCache!=""&&!filepath.IsAbs(m.CanonicalRouting.EvidenceCache){return fmt.Errorf("evidence cache path must be absolute")};if m.CanonicalRouting.EvidenceMaxAgeHours<0||m.CanonicalRouting.EvidenceMaxAgeHours>2160{return fmt.Errorf("evidence max age out of range")}')
edit('internal/registry/catalog_sources.go','sources = effectiveCatalogSources(sources, local, home)','''evidenceSource:=sources.CanonicalRouting.EvidenceCatalog
 if evidenceSource==""||home {evidenceSource="disabled"}
 configureFallbackEvidence(ctx,evidenceSource,sources.CanonicalRouting.EvidenceCache)
 sources = effectiveCatalogSources(sources, local, home)''')
manifest={str(p.relative_to(HERE)):hashlib.sha256(p.read_bytes()).hexdigest() for folder in ['host','policy'] for p in (HERE/folder).glob('*.go')}
(a.output/'catalog-fallback-draft.json').write_text(json.dumps({'draft':True,'production_changes':False,'files':manifest},indent=2)+'\n')
print(json.dumps({'draft_prepared':str(a.output),'deployed':False}))
