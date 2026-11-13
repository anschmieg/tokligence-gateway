import hashlib,importlib.util,json,pathlib,sqlite3,tempfile,unittest,subprocess,sys,os,shutil
spec=importlib.util.spec_from_file_location('scope',pathlib.Path(__file__).resolve().parents[1]/'native/opencode/compare-profile-scope.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ScopeTests(unittest.TestCase):
 def test_active_scope_metadata_only_and_no_database_mutation(self):
  with tempfile.TemporaryDirectory() as folder:
   p=pathlib.Path(folder)/'db'
   fields={'email':'EMAIL_PRIVATE','orgID':'ORG_PRIVATE','server':'SERVER_PRIVATE'}
   reference={'metadata_sha256':{k:hashlib.sha256(v.encode()).hexdigest() for k,v in fields.items()}}
   with sqlite3.connect(p) as c:
    c.execute('CREATE TABLE credential(id TEXT,integration_id TEXT,active INTEGER,time_created INTEGER,value TEXT)')
    c.execute('INSERT INTO credential VALUES(?,?,?,?,?)',('active','opencode',1,1,json.dumps({'type':'oauth','metadata':fields,'access':'ACCESS_PRIVATE','refresh':'REFRESH_PRIVATE'})))
    c.execute('INSERT INTO credential VALUES(?,?,?,?,?)',('newer','opencode',0,2,json.dumps({'type':'oauth','metadata':{}})))
   before=p.read_bytes();r=m.compare(p,reference)
   self.assertEqual(r['matches_staging'],dict.fromkeys(m.FIELDS,True));self.assertEqual(p.read_bytes(),before)
   for private in [*fields.values(),'ACCESS_PRIVATE','REFRESH_PRIVATE']:self.assertNotIn(private,json.dumps(r))
   reference['metadata_sha256']['orgID']='0'*64
   self.assertFalse(m.compare(p,reference)['matches_staging']['orgID'])
 def test_missing_fields_are_unknown_not_equal(self):
  with tempfile.TemporaryDirectory() as folder:
   p=pathlib.Path(folder)/'db'
   with sqlite3.connect(p) as c:
    c.execute('CREATE TABLE credential(id TEXT,integration_id TEXT,active INTEGER,time_created INTEGER,value TEXT)')
    c.execute('INSERT INTO credential VALUES(?,?,?,?,?)',('one','opencode',0,1,json.dumps({'type':'oauth'})))
   r=m.compare(p,{'metadata_sha256':dict.fromkeys(m.FIELDS,'0'*64)})
   self.assertEqual(r['matches_staging'],dict.fromkeys(m.FIELDS,None))
 def test_invalid_reference_rejected_before_database_access(self):
  with self.assertRaises(ValueError):m.compare('/does/not/exist',{'metadata_sha256':{'access':'PRIVATE'}})
 def test_isolated_cli_ignores_neighbor_inspect_module(self):
  with tempfile.TemporaryDirectory() as folder:
   d=pathlib.Path(folder);script=d/'compare.py';shutil.copyfile(spec.origin,script)
   (d/'inspect.py').write_text('raise RuntimeError("Neighbor module must not execute")')
   ref=d/'ref.json';ref.write_text(json.dumps({'metadata_sha256':dict.fromkeys(m.FIELDS,'0'*64)}))
   result=subprocess.run([sys.executable,'-I',str(script),'--reference',str(ref)],capture_output=True,text=True,env={**os.environ,'OPENCODE_DB':str(d/'absent.db')})
   self.assertEqual(result.returncode,1);self.assertEqual(json.loads(result.stdout)['inspection_failed'],'FileNotFoundError');self.assertEqual(result.stderr,'')
if __name__=='__main__':unittest.main()
