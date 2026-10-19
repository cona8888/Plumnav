#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest
from PIL import Image

spec=importlib.util.spec_from_file_location('figure_check',Path(__file__).with_name('check-closeout-figures.py'))
mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)


class PixelTests(unittest.TestCase):
    def test_identical_rgba(self):
        a=Image.new('RGBA',(2,2),(1,2,3,255));self.assertTrue(mod.pixels_equal(a,a.copy()))

    def test_rgb_difference_same_alpha(self):
        a=Image.new('RGBA',(2,2),(1,2,3,255));b=a.copy();b.putpixel((0,0),(4,2,3,255))
        self.assertFalse(mod.pixels_equal(a,b))

    def test_alpha_difference_same_rgb(self):
        a=Image.new('RGBA',(2,2),(1,2,3,255));b=a.copy();b.putpixel((0,0),(1,2,3,254))
        self.assertFalse(mod.pixels_equal(a,b))


if __name__=='__main__':unittest.main()
