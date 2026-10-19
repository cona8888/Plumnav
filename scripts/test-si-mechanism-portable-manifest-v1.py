"""Portable-metadata regression fixtures; no outcome generation or cloud calls."""
import copy
import importlib.util
import json
from pathlib import Path
import unittest

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('portable',HERE/'prepare-si-mechanism-portable-manifest-v1.py')
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)


class PortableFixtures(unittest.TestCase):
    def setUp(self):
        self.document=json.loads(module.ORIGINAL.read_bytes())

    def test_exact_science(self):
        old=copy.deepcopy(self.document)
        result=module.portable(old)
        self.assertEqual(old,self.document)
        self.assertEqual(len(result['sources']),374)
        for key in ('worlds','cases','protocolSha256','purpose','version'):
            self.assertEqual(result[key],old[key])

    def test_alias_digest_mismatch(self):
        next(r for r in self.document['sources'] if r['path']==module.ALIAS)['sha256']='0'*64
        with self.assertRaises(ValueError): module.portable(self.document)

    def test_unexpected_absolute_source(self):
        self.document['sources'].append({'path':'/different/source.py','sha256':'0'*64})
        with self.assertRaises(ValueError): module.portable(self.document)

    def test_missing_alias_is_not_silently_accepted(self):
        self.document['sources']=[r for r in self.document['sources'] if r['path']!=module.ALIAS]
        with self.assertRaises(ValueError): module.portable(self.document)


if __name__=='__main__': unittest.main()
