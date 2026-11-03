import unittest,yaml
from deploy_canonical_policy import planned_config,normalized
class CanonicalPolicyConfigTest(unittest.TestCase):
 def test_only_intended_nodes_change(self):
  before={'config-version':8,'models':{'catalog':''},'api-keys':{'gemini':[{'name':'gemini-free','keys':[{'api-key':'fake-key'}],'models':[{'name':'fixture'}]}]},'plugins':{'configs':{'opaque':{'auth_index':'keep-me','enabled':False,'raw':'yes'}}}}
  after=yaml.safe_load(planned_config(yaml.safe_dump(before)))
  self.assertTrue(after['models'].pop('canonical-only'))
  self.assertEqual(after['models'].pop('canonical-routing'),{'max-attempts':8,'max-fallback-models':3})
  self.assertTrue(after['api-keys']['gemini'][0].pop('free-tier'));self.assertEqual(after,before)
 def test_duplicate_or_missing_group_refused(self):
  for groups in [[],[{'name':'other'}],[{'name':'gemini-free'},{'name':'gemini-free'}]]:
   with self.assertRaises(RuntimeError):planned_config(yaml.safe_dump({'api-keys':{'gemini':groups}}))
 def test_runtime_indexes_cleaned_only_inside_keys(self):
  c={'api-keys':{'gemini':[{'auth_index':'runtime','api-key':'fake'}]},'plugins':{'auth_index':'opaque'}}
  self.assertEqual(normalized(c),{'api-keys':{'gemini':[{'api-key':'fake'}]},'plugins':{'auth_index':'opaque'}})
if __name__=='__main__':unittest.main()
