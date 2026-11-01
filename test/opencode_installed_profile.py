import importlib.util,json,pathlib,sqlite3,tempfile,unittest
from unittest import mock
spec=importlib.util.spec_from_file_location('profile_inspector',pathlib.Path(__file__).resolve().parents[1]/'native/opencode/inspect-installed-profile.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class ProfileTests(unittest.TestCase):
 def test_metadata_only_and_version_flag_only(self):
  with tempfile.TemporaryDirectory() as folder:
   h=pathlib.Path(folder);b=h/'opencode';b.write_bytes(b'\x7fELFsynthetic-not-executed');b.chmod(0o700)
   d=h/'.local/share/opencode';d.mkdir(parents=True);(d/'auth.json').write_text(json.dumps({'opencode':{'type':'oauth','access':'TOKEN_PRIVATE','refresh':'REFRESH_PRIVATE'}}))
   c=h/'.config/opencode';c.mkdir(parents=True);(c/'opencode.json').write_text(json.dumps({'provider':{'opencode':{'options':{'apiKey':'KEY_PRIVATE','baseURL':'https://user:URL_PRIVATE@example.test/v1?token=QUERY_PRIVATE'}}},'plugin':['PLUGIN_PRIVATE']}))
   with sqlite3.connect(d/'opencode.db') as conn:
    conn.execute('CREATE TABLE credential (integration_id TEXT,value TEXT)');conn.execute('INSERT INTO credential VALUES (?,?)',('opencode',json.dumps({'type':'oauth','access':'DB_PRIVATE'})))
    conn.execute('CREATE TABLE session (id TEXT,version TEXT,time_created INTEGER)');conn.execute('INSERT INTO session VALUES (?,?,?)',('session_fixture','1.18.fixture',1))
    conn.execute('CREATE TABLE message (session_id TEXT,time_created INTEGER,data TEXT)');conn.execute('INSERT INTO message VALUES (?,?,?)',('session_fixture',1,json.dumps({'role':'assistant','providerID':'opencode','modelID':'beam-free','finish':'stop','content':'MESSAGE_PRIVATE'})))
   before=(d/'opencode.db').read_bytes()
   with mock.patch.object(m.subprocess,'check_output',return_value='1.18.fixture') as version:
    r=m.inspect_profile(h,b,{'OPENCODE_API_KEY':'ENV_PRIVATE'})
    self.assertEqual(version.call_args.args[0],[str(b),'--version'])
   text=json.dumps(r)
   for secret in ['TOKEN_PRIVATE','REFRESH_PRIVATE','KEY_PRIVATE','URL_PRIVATE','QUERY_PRIVATE','PLUGIN_PRIVATE','DB_PRIVATE','MESSAGE_PRIVATE','ENV_PRIVATE']:self.assertNotIn(secret,text)
   self.assertEqual(r['binary']['version'],'1.18.fixture');self.assertEqual(r['opencode_credential_types'],['oauth']);self.assertEqual(r['recent_sessions'][0]['assistant_metadata'][0]['model'],'beam-free');self.assertEqual((d/'opencode.db').read_bytes(),before)
 def test_empty_profile_does_not_create_state(self):
  with tempfile.TemporaryDirectory() as folder:
   h=pathlib.Path(folder)
   with mock.patch.object(m.shutil,'which',return_value=None):r=m.inspect_profile(h,None,{})
   self.assertFalse(r['database_exists']);self.assertEqual(list(h.iterdir()),[])
 def test_wrapper_is_not_executed_and_modern_sessions_are_not_hidden_by_legacy_tables(self):
  with tempfile.TemporaryDirectory() as folder:
   h=pathlib.Path(folder);b=h/'wrapper';b.write_text('#!/bin/sh\nexport OPENCODE_API_KEY=WRAPPER_PRIVATE\nOPENCODE_DB="$HOME/private-profile.db" exec opencode "$@"\n')
   d=h/'.local/share/opencode';d.mkdir(parents=True)
   with sqlite3.connect(d/'opencode.db') as c:
    for t in ['session','session_v2']:c.execute('CREATE TABLE '+t+'(id TEXT,version TEXT,time_created INTEGER)')
    c.execute('CREATE TABLE message(session_id TEXT,time_created INTEGER,data TEXT)')
    c.execute('CREATE TABLE session_message(session_id TEXT,time_created INTEGER,type TEXT,data TEXT)')
    c.execute('INSERT INTO session VALUES (?,?,?)',('legacy','1.17.7',1));c.execute('INSERT INTO session_v2 VALUES (?,?,?)',('current','2.1.4',2))
    c.execute('INSERT INTO session_message VALUES (?,?,?,?)',('current',2,'assistant',json.dumps({'model':{'providerID':'opencode','id':'beam-free'},'finish':'stop','content':'MESSAGE_PRIVATE'})))
   with mock.patch.object(m.subprocess,'check_output') as version:r=m.inspect_profile(h,b,{'OPENCODE_API_KEY':'public'});version.assert_not_called()
   self.assertEqual(r['binary']['kind'],'script_not_executed');self.assertIn('OPENCODE_DB',r['binary']['assigned_variable_names']);self.assertEqual(r['environment_key_kind'],'public_literal');self.assertEqual(r['recent_sessions'][0]['id'],'current');self.assertEqual(r['recent_sessions'][0]['assistant_metadata'][0]['model'],'beam-free')
   self.assertNotIn('WRAPPER_PRIVATE',json.dumps(r));self.assertNotIn('MESSAGE_PRIVATE',json.dumps(r))
if __name__=='__main__':unittest.main()
