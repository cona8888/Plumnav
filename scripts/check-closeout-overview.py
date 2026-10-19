#!/usr/bin/env python3
"""Check editable conceptual artwork and generate private accessibility previews."""
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET
import zipfile
from PIL import Image, ImageChops

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'research/publication_closeout_2026-09-22/draft_v2'
OUT=BASE/'figures'
BUILD=BASE/'.figure_build'
spec=importlib.util.spec_from_file_location('prior',ROOT/'scripts/check-closeout-editable-figures.py')
prior=importlib.util.module_from_spec(spec);spec.loader.exec_module(prior)


def main():
    source=(OUT/'fig01_configuration_master.svg').read_text()
    root=ET.fromstring(source)
    assert root.attrib['width']=='178mm' and root.attrib['height']=='180mm'
    expected=[e.text for e in root.iter() if e.tag.endswith('}text')]
    ns=prior.NS
    pptx=OUT/'fig01_configuration_editable_v2.pptx'
    with zipfile.ZipFile(pptx) as z:
        assert not any(n.startswith('ppt/media/') for n in z.namelist())
        slide=ET.fromstring(z.read('ppt/slides/slide1.xml'))
        texts=[e.text for e in slide.findall('.//a:t',ns)]
        assert texts==expected
        shapes=slide.findall('.//p:sp',ns)
        assert len(shapes)==104
        families={e.attrib['typeface'] for e in slide.findall('.//a:latin',ns)}
        sizes={int(e.attrib['sz']) for e in slide.findall('.//a:rPr',ns) if 'sz' in e.attrib}
        assert families=={'Arial'} and sizes=={1200,1400}
    png=Image.open(OUT/'fig01_configuration_600dpi.png').convert('RGBA')
    tiff=Image.open(OUT/'fig01_configuration_600dpi.tiff').convert('RGBA')
    assert png.size==tiff.size
    assert all(channel.getbbox() is None for channel in ImageChops.difference(png,tiff).split())
    preview=png.convert('RGB');preview.thumbnail((1200,1200))
    preview.save(BUILD/'raster_preview.png')
    preview.convert('L').save(BUILD/'grayscale_preview.png')
    views=[]
    for name,matrix in prior.MATRICES.items():
        altered=re.sub(r'#[A-Fa-f0-9]{6}',lambda m:prior.colour(m.group(),matrix),source)
        dst=BUILD/f'{name}_preview.svg'
        with dst.open('x') as stream:stream.write(altered)
        subprocess.run(['/opt/homebrew/bin/rsvg-convert','-w','900','-o',str(dst.with_suffix('.png')),str(dst)],check=True)
        views.append(name)
    receipt={'figureSizeMm':[178,180],'liveTextElements':len(expected),'nativePptxObjects':len(shapes),
             'fonts':sorted(families),'fontSizesPt':sorted(x/100 for x in sizes),'svgPptxTextEqual':True,
             'embeddedPptxImages':0,'pngTiffAllChannelsEqual':True,'rasterPixels':png.size,
             'svgSha256':hashlib.sha256(source.encode()).hexdigest(),'pptxSha256':hashlib.sha256(pptx.read_bytes()).hexdigest(),
             'accessibilityPreviews':views,'method':'Prior documented Machado severity-100 palette transform; labels carry meaning without color',
             'scope':'Technical checks only; visual inspection recorded separately; no simulation'}
    with (BUILD/'technical_check.json').open('x') as stream:json.dump(receipt,stream,indent=2);stream.write('\n')
    print(json.dumps(receipt,indent=2))


if __name__=='__main__':main()
