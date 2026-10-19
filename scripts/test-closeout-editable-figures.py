#!/usr/bin/env python3
"""Mutation tests for native figure handoff checks; no simulations."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
import zipfile

spec=importlib.util.spec_from_file_location('checks',Path(__file__).with_name('check-closeout-editable-figures.py'))
checks=importlib.util.module_from_spec(spec);spec.loader.exec_module(checks)
STEM='fig01_stage2i_endpoints'
SVG=checks.BASE/'figures_v1'/f'{STEM}_master.svg'
PPTX=checks.BASE/'figures_pptx_v1'/f'{STEM}_editable.pptx'

class NativeFigureChecks(unittest.TestCase):
    def mutate(self,operation):
        temporary=tempfile.TemporaryDirectory(prefix='plumenav-figure-check-')
        self.addCleanup(temporary.cleanup)
        path=Path(temporary.name)/'mutated.pptx'
        with zipfile.ZipFile(PPTX) as src,zipfile.ZipFile(path,'w') as dst:
            for name in src.namelist():
                body=src.read(name)
                if name=='ppt/slides/slide1.xml':body=operation(body)
                dst.writestr(name,body)
        return path

    def test_original(self):
        self.assertTrue(checks.check_pptx(SVG,PPTX)['nativeTextAndMarks'])

    def test_changed_label_rejected(self):
        path=self.mutate(lambda b:b.replace(b'Coverage',b'Invented',1))
        with self.assertRaisesRegex(AssertionError,'Text missing'):checks.check_pptx(SVG,path)

    def test_shifted_circle_rejected(self):
        def shift(body):
            root=ET.fromstring(body)
            for sp in root.findall('.//p:sp',checks.NS):
                geo=sp.find('p:spPr/a:prstGeom',checks.NS)
                if geo is not None and geo.attrib['prst']=='ellipse':
                    off=sp.find('p:spPr/a:xfrm/a:off',checks.NS)
                    off.attrib['x']=str(int(off.attrib['x'])+36000);break
            return ET.tostring(root)
        path=self.mutate(shift)
        with self.assertRaisesRegex(AssertionError,'circle'):checks.check_pptx(SVG,path)

    def test_raster_object_rejected(self):
        path=self.mutate(lambda b:b)
        with zipfile.ZipFile(path,'a') as z:z.writestr('ppt/media/image1.png',b'test-placeholder')
        with self.assertRaisesRegex(AssertionError,'Raster'):checks.check_pptx(SVG,path)

    def test_neutral_palette(self):
        for matrix in checks.MATRICES.values():
            self.assertEqual(checks.colour('#FFFFFF',matrix),'#FFFFFF')
            self.assertEqual(checks.colour('#000000',matrix),'#000000')

if __name__=='__main__':unittest.main()
