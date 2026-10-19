#!/usr/bin/env python3
"""Synthetic fixtures only; no modification to any campaign file."""
import copy
import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from lib.outdoor_budget_statistics import summarise


def module(name,file):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(file))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m


c=module('checker','check-outdoor-budget-inference.py')
fixtures=module('fixtures','test-outdoor-budget-statistics.py')


def write(root,name,value):
    (root/name).write_text(json.dumps(value))


def close(root):
    write(root,'closure.json',dict(accepted=True,mode='campaign',**{
        key+'Sha256':c.sha(root/name) for key,name in [('manifest','manifest.json'),('audit','audit.json'),
            ('report','report.md'),('executionReceipt','execution-complete.json')]}))


class InferenceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory(prefix='plumenav-inference-fixtures-')
        cls.root=Path(cls.temp.name);traces=fixtures.fixture();files=[]
        for i,t in enumerate(traces):
            file=f'trace-{i:03d}.json.gz';(cls.root/file).write_bytes(gzip.compress(json.dumps(t).encode()))
            files.append(dict(file=file,sha256=c.sha(cls.root/file)))
        write(cls.root,'manifest.json',dict(specs=[t['spec'] for t in traces]))
        write(cls.root,'execution-complete.json',dict(files=files))
        (cls.root/'report.md').write_text('# Synthetic test fixture, not research evidence\n')
        cls.audit=dict(accepted=True,statistics=summarise(traces))

    @classmethod
    def tearDownClass(cls):cls.temp.cleanup()

    def setUp(self):
        write(self.root,'audit.json',self.audit);close(self.root)

    def test_complete_fixture(self):
        result=c.check(self.root)
        self.assertEqual([p['lateAlarms'] for p in result['primary']],[20,2])

    def test_wrong_interval(self):
        damaged=copy.deepcopy(self.audit);damaged['statistics']['primary'][0]['interval975'][0]+=.01
        write(self.root,'audit.json',damaged);close(self.root)
        with self.assertRaises(ValueError):c.check(self.root)

    def test_wrong_denominator_or_budget(self):
        for change in ['denominator','cap']:
            damaged=copy.deepcopy(self.audit)
            if change=='denominator':damaged['statistics']['primary'][0]['n']=4096
            else:damaged['statistics']['groups'][0]['budgets'][1]['budgetSeconds']=600
            write(self.root,'audit.json',damaged);close(self.root)
            with self.assertRaises(ValueError):c.check(self.root)

    def test_unclosed_change(self):
        write(self.root,'audit.json',dict(self.audit,accepted=False))
        with self.assertRaises(ValueError):c.check(self.root)


if __name__=='__main__':unittest.main()
