import unittest
from routing_client import display
class Status(unittest.TestCase):
 def test_foreground_only_and_unknown(self):
  main={'session':'s','request_id':'r1','kind':'main','started_at':'1','state':'completed','billing_class':'FREE'}
  aux=dict(main,request_id='r2',kind='compaction',started_at='2',billing_class='PAID')
  other=dict(main,session='other',started_at='3',billing_class='SUB')
  self.assertEqual(display([main,aux,other],'s',color=False),'FREE')
  waiting=dict(main,request_id='r3',started_at='4',state='awaiting_route',billing_class='UNKNOWN')
  self.assertEqual(display([main,aux,waiting],'s',color=False),' – ')
  self.assertEqual(display([aux],'s',color=False),' – ')
  self.assertEqual(display([aux],'s','r2',False),'PAID')
 def test_colors_are_actual_class_only(self):
  for name,color in [('FREE','33'),('SUB','34'),('PAID','31')]:
   row={'session':'s','kind':'main','started_at':'1','state':'in_flight','billing_class':name,'policy':'PAID'}
   self.assertEqual(display([row],'s'),f'\x1b[{color}m{name}\x1b[0m')
if __name__=='__main__':unittest.main()
