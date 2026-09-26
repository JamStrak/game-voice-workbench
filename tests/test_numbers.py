"""Numbered Windows exports must not overwrite one another after unzip."""
import sys, unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'upstream/voicebox'))
from backend.app import app
from backend.routes.local_workbench import Batch, Line
from pydantic import ValidationError

class NumberTests(unittest.TestCase):
    def line(self,number):return dict(number=number,role='角色',text='台词',profile_id='test')
    def test_reject_case_collisions(self):
        with self.assertRaises(ValidationError):Batch(lines=[self.line('A001'),self.line('a001')])
    def test_reject_reserved_and_path_names(self):
        for number in ('CON','aux','COM1','lpt9','../A001','a/b','a:b','a.',''):
            with self.subTest(number=number),self.assertRaises(ValidationError):Line(**self.line(number))
    def test_allow_readable_unique_numbers(self):
        self.assertEqual(len(Batch(lines=[self.line('角色_001'),self.line('A-002')]).lines),2)
