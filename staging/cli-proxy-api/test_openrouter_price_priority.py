import unittest
from openrouter_price_priority import price_tiers

class PriceTiers(unittest.TestCase):
 def test_mixed_models_keep_aliases_keys_and_other_providers(self):
  src=[{'name':'openrouter','base-url':'https://openrouter.ai/api/v1','prefix':'or','keys':[{'api-key':'fake'}],'models':[{'name':'nvidia/x:free','alias':'canonical'},{'name':'nvidia/x','alias':'paid'}]}, {'name':'other','base-url':'https://other.invalid/v1','priority':3}]
  got=price_tiers(src)
  self.assertEqual([p.get('priority') for p in got],[0,-10,3])
  self.assertEqual([p['models'][0]['alias'] for p in got[:2]],['canonical','paid'])
  self.assertEqual(got[0]['keys'],got[1]['keys']);self.assertNotIn('priority',src[0]);self.assertEqual(got[2],src[1])
 def test_alias_spelling_cannot_promote_paid_upstream(self):
  src=[{'name':'or','base-url':'https://openrouter.ai/api/v1','models':[{'name':'paid-model','alias':'foo-free'}]}]
  self.assertEqual(price_tiers(src)[0]['priority'],-10)
 def test_known_free_promoted_without_adding_paygo(self):
  src=[{'name':'or','priority':-10,'base-url':'https://openrouter.ai/api/v1','models':[{'name':'openrouter/free'},{'name':'publisher/model:free'}]}]
  got=price_tiers(src);self.assertEqual(len(got),1);self.assertEqual(got[0]['priority'],0)
 def test_empty_or_wildcard_catalog_is_not_assumed_free(self):
  for models in [[],[{'name':'*:free'}]]:
   self.assertEqual(price_tiers([{'name':'or','base-url':'https://openrouter.ai/api/v1','models':models}])[0]['priority'],-10)
 def test_existing_split_name_fails_without_merging_keys(self):
  with self.assertRaises(ValueError):price_tiers([{'name':'or','base-url':'https://openrouter.ai/api/v1','models':[{'name':'x:free'},{'name':'x'}]},{'name':'or-paygo'}])
if __name__=='__main__':unittest.main()
