import datetime,importlib.util,io,json,tarfile,tempfile,unittest
from pathlib import Path
spec=importlib.util.spec_from_file_location('refresh_modelsdev',Path(__file__).with_name('refresh_modelsdev.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class ImporterTest(unittest.TestCase):
 def archive(self,extras=()):
  out=io.BytesIO()
  records=[('models/lab/model.toml',b'schema=2\nname="Fixture"\nfamily="fixture"\n'),('providers/p/models/source.toml',b'schema=2\nbase_model="lab/model"\n')]
  with tarfile.open(fileobj=out,mode='w:gz') as t:
   for name,data in records:
    info=tarfile.TarInfo('repo/'+name);info.size=len(data);t.addfile(info,io.BytesIO(data))
   for name,target,kind in extras:
    info=tarfile.TarInfo('repo/'+name);info.type=kind;info.linkname=target;t.addfile(info)
  return out.getvalue()
 def test_valid_data_and_in_archive_alias(self):
  raw=self.archive([('providers/p/models/alias.toml','source.toml',tarfile.SYMTYPE)])
  result=m.convert(raw,'a'*40,datetime.datetime(2026,11,3,tzinfo=datetime.timezone.utc))
  self.assertEqual(result['providers']['p']['models']['alias']['canonical_model_id'],'lab/model')
  self.assertEqual(result['_evidence']['retrieved_at'],'2026-11-03T00:00:00Z')
 def test_no_filesystem_extraction_or_unsafe_alias(self):
  for target in ['/etc/passwd','../../../../../etc/passwd','missing.toml','loop.toml']:
   with self.assertRaises(ValueError):m.convert(self.archive([('providers/p/models/loop.toml',target,tarfile.SYMTYPE)]),'a'*40,datetime.datetime.now(datetime.timezone.utc))
 def test_hardlinks_refused(self):
  with self.assertRaises(ValueError):m.convert(self.archive([('providers/p/models/alias.toml','source.toml',tarfile.LNKTYPE)]),'a'*40,datetime.datetime.now(datetime.timezone.utc))
 def test_failed_refresh_cannot_replace_existing_output(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'catalog.json';m.atomic_write(p,b'last-good')
   with self.assertRaises(ValueError):
    candidate=m.convert(b'not-a-valid-archive','not-a-commit',datetime.datetime.now(datetime.timezone.utc));m.atomic_write(p,json.dumps(candidate).encode())
   self.assertEqual(p.read_bytes(),b'last-good')
   self.assertEqual(p.stat().st_mode&0o777,0o600)
if __name__=='__main__':unittest.main()
