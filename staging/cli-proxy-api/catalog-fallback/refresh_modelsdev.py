#!/usr/bin/env python3
"""Data-only Models.dev snapshot importer. Never executes upstream code or Git.
An optional fixed-host HTTPS refresh downloads a commit-addressed archive. Offline
--archive input makes the exact same transformation testable without a network.
"""
import argparse,datetime,hashlib,io,json,os,posixpath,re,tarfile,tempfile,tomllib,urllib.request
from pathlib import Path,PurePosixPath
MAX_ARCHIVE=32*1024*1024
MAX_EXPANDED=128*1024*1024
REPO='https://api.github.com/repos/anomalyco/models.dev/commits/dev'
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None

def download(url,limit):
 opener=urllib.request.build_opener(NoRedirect())
 req=urllib.request.Request(url,headers={'Accept':'application/vnd.github+json' if url==REPO else 'application/octet-stream'})
 with opener.open(req,timeout=30) as response:
  raw=response.read(limit+1)
  if len(raw)>limit:raise ValueError('metadata response too large')
  return raw

def convert(raw,commit,now):
 if len(raw)>MAX_ARCHIVE or not re.fullmatch(r'[0-9a-f]{40}',commit):raise ValueError('invalid archive size or commit')
 models={};links={};expanded=0;seen=set();count=0;records={};aliases={};archive_root=None
 def relevant(path):
  parts=PurePosixPath(path).parts
  return path.endswith('.toml') and ((len(parts)>=3 and parts[0]=='models') or (len(parts)>=4 and parts[0]=='providers' and parts[2]=='models'))
 with tarfile.open(fileobj=io.BytesIO(raw),mode='r:gz') as archive:
  for member in archive:
   count+=1
   if count>60000:raise ValueError('too many archive members')
   if member.size<0:raise ValueError('invalid archive member')
   expanded+=member.size
   if expanded>MAX_EXPANDED:raise ValueError('archive expanded size limit')
   parts=PurePosixPath(member.name).parts
   if '..' in parts or member.name.startswith('/') or not parts:raise ValueError('unsafe archive path')
   if archive_root is None:archive_root=parts[0]
   if parts[0]!=archive_root:raise ValueError('multiple archive roots')
   path='/'.join(parts[1:])
   if not relevant(path):continue
   if path in seen:raise ValueError('duplicate metadata path')
   seen.add(path)
   if member.issym():
    target=posixpath.normpath(posixpath.join(posixpath.dirname(path),member.linkname))
    if member.linkname.startswith('/') or target.startswith('../') or not relevant(target):raise ValueError('unsafe metadata alias')
    aliases[path]=target
   elif member.isfile() and not member.islnk() and member.size<=1024*1024:
    with archive.extractfile(member) as source:records[path]=source.read()
   else:raise ValueError('nonregular or oversized metadata record: '+path)
 def resolve(path,trail=()):
  if path in trail or len(trail)>16:raise ValueError('cyclic or deep metadata alias')
  if path in records:return records[path]
  if path in aliases:return resolve(aliases[path],trail+(path,))
  raise ValueError('dangling metadata alias')
 for path in sorted(seen):
  relative=PurePosixPath(path).parts
  record=tomllib.loads(resolve(path).decode())
  if record.get('schema')!=2:raise ValueError('unsupported Models.dev authored schema: '+path)
  if relative[0]=='models':
   model_id='/'.join(relative[1:])[:-5]
   model={k:record[k] for k in ['name','description','family','type','benchmarks','weights','links','license','release_date','last_updated'] if k in record}
   model['id']=model_id;models[model_id]=model
  else:
   provider=relative[1];source_id='/'.join(relative[3:])[:-5];base=record.get('base_model')
   if base is not None:
    if not isinstance(base,str):raise ValueError('invalid canonical link')
    links.setdefault(provider,{'models':{}})['models'][source_id]={'id':source_id,'canonical_model_id':base}
 if not models:raise ValueError('no canonical models')
 for provider in links.values():
  for link in provider['models'].values():
   if link['canonical_model_id'] not in models:raise ValueError('dangling canonical link')
 return {'models':models,'providers':links,'_evidence':{'schema':1,'source_commit':commit,'retrieved_at':now.isoformat().replace('+00:00','Z'),'archive_sha256':hashlib.sha256(raw).hexdigest(),'source':'https://github.com/anomalyco/models.dev','license':'MIT'}}

def atomic_write(path,data):
 path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
 fd,tmp=tempfile.mkstemp(prefix='.'+path.name+'.',dir=path.parent)
 try:
  with os.fdopen(fd,'wb') as out:
   os.fchmod(out.fileno(),0o600);out.write(data);out.flush();os.fsync(out.fileno())
  os.replace(tmp,path)
  directory=os.open(path.parent,os.O_RDONLY)
  try:os.fsync(directory)
  finally:os.close(directory)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',type=Path,required=True);p.add_argument('--archive',type=Path);p.add_argument('--commit');a=p.parse_args()
 if a.archive:
  if not a.commit:p.error('--archive requires --commit')
  raw=a.archive.read_bytes();commit=a.commit
 else:
  commit=json.loads(download(REPO,1024*1024))['sha']
  if not re.fullmatch(r'[0-9a-f]{40}',commit):raise ValueError('invalid upstream commit')
  raw=download('https://codeload.github.com/anomalyco/models.dev/tar.gz/'+commit,MAX_ARCHIVE)
 result=convert(raw,commit,datetime.datetime.now(datetime.timezone.utc))
 payload=json.dumps(result,separators=(',',':'),sort_keys=True,allow_nan=False).encode()
 if len(payload)>32*1024*1024:raise ValueError('compiled catalog too large')
 atomic_write(a.output,payload)
 print(json.dumps({'models':len(result['models']),'providers':len(result['providers']),'source_commit':commit,'output':str(a.output),'provider_inference_requests':0}))
if __name__=='__main__':main()
