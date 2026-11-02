#!/usr/bin/env python3
"""Apply model discovery patches to a NEW copy of the deployed native.6 source.

Input is the previously prepared pinned native tree, including its existing
Access/quarantine/dispatch patches. All modified inputs are SHA-pinned below.
No network, build, credentials, runtime or configuration changes.
"""
import argparse,hashlib,json,shutil
from pathlib import Path
P=Path(__file__).resolve().parent
DIGESTS = {'internal/registry/model_registry.go': '7f291e0807d632fd9d43b2017f780996af1e2d1baf7452766cf1a253b254cfb5', 'sdk/api/handlers/openai/openai_handlers.go': '869ddc464fa86956e4e6f4730ddf2b96ec06cdd91686db0251f8458a019d2e3f', 'internal/client/codex/models/models.go': '0eede1f5e743348b5f655a5ececc9cf54dd45c2ef6b55e291fbed093542b7aa9'}
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
 if a.output.exists():p.error('output must not exist')
 for name,expected in DIGESTS.items():
  if digest(a.source/name)!=expected:raise RuntimeError('native input differs: '+name)
 shutil.copytree(a.source,a.output,ignore=shutil.ignore_patterns('.git','*.so','*.a','cli-proxy-api'))
 def edit(name,old,new):
  target=a.output/name;s=target.read_text()
  if s.count(old)!=1:raise RuntimeError('anchor differs: '+name)
  target.write_text(s.replace(old,new,1))
 edit('internal/registry/model_registry.go','r.convertModelToMap(registration.Info, handlerType)','r.convertModelToMap(commonModelInfo(registration), handlerType)')
 edit('internal/registry/model_registry.go','return cloneModelInfo(reg.Info)','return commonModelInfo(reg)')
 edit('sdk/api/handlers/openai/openai_handlers.go','filteredModels[i] = filteredModel','for key, value := range registry.CatalogMetadata(model["id"].(string)) { filteredModel[key] = value }\n\t\tfor _, key := range []string{"display_name", "description", "type", "version"} { if value, ok := model[key]; ok { filteredModel[key] = value } }\n\t\tfilteredModels[i] = filteredModel')
 edit('internal/client/codex/models/models.go','applyCodexClientNonTemplatePriorities(result, templates)','applyDisclosedCatalogMetadata(result)\n\tapplyCodexClientNonTemplatePriorities(result, templates)')
 for source,target in [('catalog_metadata.go','internal/registry/catalog_metadata.go'),('catalog_metadata_test.go','internal/registry/catalog_metadata_test.go'),('codex_catalog_metadata.go','internal/client/codex/models/catalog_metadata.go'),('codex_catalog_metadata_test.go','internal/client/codex/models/catalog_metadata_test.go')]:
  shutil.copyfile(P/'patches/model_catalog'/source,a.output/target)
 (a.output/'model-catalog-patch.json').write_text(json.dumps({'input_digests':DIGESTS,'patch_digests':{str(x.relative_to(P)):digest(x) for x in (P/'patches/model_catalog').glob('*.go')}},indent=2)+'\n')
 print(json.dumps({'prepared':str(a.output),'deployed':False}))
if __name__=='__main__':main()
