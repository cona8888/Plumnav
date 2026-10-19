#!/usr/bin/env python3
"""Check plotted records, editable SVG text, and PNG/TIFF export agreement."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET
from PIL import Image, ImageChops

ROOT=Path(__file__).resolve().parents[1]


def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def read(p):return json.loads(Path(p).read_text())
def require(x,msg):
    if not x:raise ValueError(msg)


def pixels_equal(a,b):
    # getbbox() on RGBA can inspect alpha only; check every channel explicitly.
    return all(bounds==(0,0) for bounds in ImageChops.difference(a.convert('RGBA'),b.convert('RGBA')).getextrema())


def pointer(data,path):
    value=data
    for part in path.strip('/').split('/'):
        value=value[int(part)] if isinstance(value,list) else value[part]
    return value


def check(folder):
    provenance=read(folder/'figure_provenance.json')
    data_path=ROOT/provenance['sourceData'];require(sha(data_path)==provenance['sourceSha256'],'Figure data changed')
    require(sha(ROOT/'scripts/render-closeout-figures.py')==provenance['generatorSha256'],'Figure generator changed')
    data=read(data_path);records=[]
    for fig in provenance['figures']:
        require(not fig['wireframe'] and not fig['grayscale'],'Expected production colour figures')
        stem=fig['stem'];master=folder/f'{stem}_master.svg'
        require(sha(master)==provenance['outputs'][master.name],'SVG changed after generation')
        for point in fig['points']:
            source=pointer(data,point['source'])
            require(point['value']==source.get('estimate',source.get('proportion')) and point['interval']==source['wilson95'],'Plotted point differs from accepted record')
        tree=ET.parse(master).getroot();ns='{http://www.w3.org/2000/svg}'
        texts=list(tree.iter(ns+'text'));require(texts and not list(tree.iter(ns+'image')),'Rasterised or missing SVG text')
        sizes={round(float(t.attrib['font-size'])*72/25.4,3) for t in texts}
        require(sizes=={12.,14.},'Unexpected figure text sizes')
        require(all('Arial' in t.attrib['font-family'] for t in texts),'Font family changed')
        for text in texts:
            require(0<=float(text.attrib['x'])<=183 and 0<=float(text.attrib['y'])<=fig['heightMm'],'Text anchor outside canvas')
        technical=read(folder/f'{stem}_technical_review.json')
        require(technical['errors']==[] and technical['warnings']==[],'SVG technical validation')
        png=folder/f'{stem}_print_600dpi.png';tiff=folder/f'{stem}_print_600dpi.tiff'
        with Image.open(png) as a,Image.open(tiff) as b:
            expected=(round(183/25.4*600),round(fig['heightMm']/25.4*600))
            require(all(abs(x-y)<=1 for x,y in zip(a.size,expected)),'PNG physical-resolution dimensions')
            require(a.size==b.size,'TIFF size mismatch')
            require(all(abs(d-600)<1 for d in b.info['dpi']),'TIFF DPI metadata')
            require(pixels_equal(a,b),'PNG/TIFF pixels differ')
            size=list(a.size)
        require((folder/f'{stem}_print.pdf').exists(),'Missing PDF')
        records.append(dict(figure=stem,plottedRecords=len(fig['points']),liveTextObjects=len(texts),fontSizesPt=sorted(sizes),rasterPixels=size,pngTiffPixelsEqual=True))
    require(sum(x['plottedRecords'] for x in records)==40,'Plotted record inventory')
    return dict(checkedAt=datetime.now(timezone.utc).isoformat(),passed=True,checkerSha256=sha(Path(__file__)),
                figures=records,scope='Closed source values/intervals, live SVG text, technical checks and PNG/TIFF agreement. Visual review and PDF rendering are separate.',
                outputs={p.name:sha(p) for p in sorted(folder.iterdir()) if p.is_file()},physicalValidation=False)


def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    require(not a.output.exists(),'Choose a new check receipt')
    result=check(a.input)
    with a.output.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps({k:result[k] for k in ['passed','figures']}))


if __name__=='__main__':main()
