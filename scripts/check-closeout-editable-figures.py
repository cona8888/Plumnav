#!/usr/bin/env python3
"""Read-only PPTX structure/mark checks; separate SVG colour-vision QA exports.

No physics or statistical evaluation is rerun. Outputs are exclusive-created.
Machado et al. 2009 severity-100 matrices checked 2026-09-22 against:
https://raw.githubusercontent.com/njsmith/colorspacious/master/colorspacious/cvd.py
Paper: https://doi.org/10.1109/TVCG.2009.113
The author's supplementary website timed out; the library's documented
transcription supplies these numerical matrices, not a claim of human testing.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'research/publication_closeout_2026-09-22'
NS = {'p':'http://schemas.openxmlformats.org/presentationml/2006/main',
      'a':'http://schemas.openxmlformats.org/drawingml/2006/main'}
MATRICES = {
    'protan': [[.152286,1.052583,-.204868],[.114503,.786281,.099216],[-.003882,-.048116,1.051998]],
    'deutan': [[.367322,.860646,-.227968],[.280085,.672501,.047413],[-.011820,.042940,.968881]],
    'tritan': [[1.255528,-.076749,-.178779],[-.078411,.930809,.147602],[.004733,.691367,.303900]],
}

def colour(hexcode, matrix):
    rgb = [int(hexcode[i:i+2],16)/255 for i in (1,3,5)]
    linear = [v/12.92 if v <= .04045 else ((v+.055)/1.055)**2.4 for v in rgb]
    transformed = [max(0,min(1,sum(a*b for a,b in zip(row,linear)))) for row in matrix]
    encoded = [12.92*v if v<=.0031308 else 1.055*v**(1/2.4)-.055 for v in transformed]
    return '#' + ''.join(f'{round(255*v):02X}' for v in encoded)

def check_pptx(svg_path, pptx_path):
    svg = ET.parse(svg_path).getroot()
    expected_text = [e.text or '' for e in svg.iter() if e.tag.endswith('}text')]
    expected_circles = [(float(e.attrib['cx']),float(e.attrib['cy']),float(e.attrib['r']))
                        for e in svg.iter() if e.tag.endswith('}circle')]
    expected_squares = [(float(e.attrib['x']),float(e.attrib['y'])) for e in svg.iter()
                        if e.tag.endswith('}rect') and e.attrib.get('width')=='2.4']
    with zipfile.ZipFile(pptx_path) as z:
        assert not any(n.startswith('ppt/media/') for n in z.namelist()), 'Raster/embedded media found'
        s = ET.fromstring(z.read('ppt/slides/slide1.xml'))
        text = [e.text or '' for e in s.findall('.//a:t',NS)]
        assert text == expected_text, 'Text missing or changed'
        sizes = {int(e.attrib['sz']) for e in s.findall('.//a:rPr',NS) if 'sz' in e.attrib}
        assert sizes <= {1200,1400} and sizes, sizes
        families = {e.attrib['typeface'] for e in s.findall('.//a:latin',NS)}
        assert families == {'Arial'}, families
        circles, squares = [], []
        for sp in s.findall('.//p:sp',NS):
            geo = sp.find('p:spPr/a:prstGeom',NS)
            xf = sp.find('p:spPr/a:xfrm',NS)
            if geo is None or xf is None: continue
            off,ext = xf.find('a:off',NS),xf.find('a:ext',NS)
            x,y,cx,cy = [int(v)/36000 for v in (off.attrib['x'],off.attrib['y'],ext.attrib['cx'],ext.attrib['cy'])]
            if geo.attrib['prst']=='ellipse': circles.append((x+cx/2,y+cy/2,cx/2))
            if geo.attrib['prst']=='rect' and abs(cx-2.4)<1e-4 and abs(cy-2.4)<1e-4: squares.append((x,y))
        for label,found,expected in [('circle',circles,expected_circles),('square',squares,expected_squares)]:
            assert len(found)==len(expected),(label,len(found),len(expected))
            assert all(abs(a-b)<1e-4 for aa,bb in zip(found,expected) for a,b in zip(aa,bb)),label
        notes=ET.fromstring(z.read('ppt/notesSlides/notesSlide1.xml'))
        assert hashlib.sha256(svg_path.read_bytes()).hexdigest() in ''.join(notes.itertext())
    return {'textObjects':len(text),'circlesIncludingLegend':len(circles),'squaresIncludingLegend':len(squares),
            'fontSizesPt':sorted(x/100 for x in sizes),'nativeTextAndMarks':True,'embeddedImages':0,
            'sourceHashInNotes':True,'pptxSha256':hashlib.sha256(pptx_path.read_bytes()).hexdigest()}

def main():
    out=BASE/'figures_accessibility_v1'
    out.mkdir(exist_ok=False)
    receipt={'method':'Machado et al. 2009 severity-100 palette transform in linear sRGB, clipped to display gamut',
             'meaning':'Diagnostic approximation, not testing with visually impaired participants',
             'matrices':MATRICES,'figures':[]}
    for svg in sorted((BASE/'figures_v1').glob('*_master.svg')):
        stem=svg.name.removesuffix('_master.svg')
        row={'stem':stem,'pptx':check_pptx(svg,BASE/'figures_pptx_v1'/f'{stem}_editable.pptx'),'views':{}}
        source=svg.read_text()
        for name,matrix in MATRICES.items():
            palette={c:colour(c,matrix) for c in sorted(set(re.findall(r'#[A-Fa-f0-9]{6}',source)))}
            converted=re.sub(r'#[A-Fa-f0-9]{6}',lambda m:palette[m.group()],source)
            # Colour-only SVG edit: exact original text and geometry are preserved.
            target=out/f'{stem}_{name}.svg'
            with target.open('x') as f: f.write(converted)
            subprocess.run(['/opt/homebrew/bin/rsvg-convert','--dpi-x','150','--dpi-y','150',
                            '-o',str(target.with_suffix('.png')),str(target)],check=True)
            row['views'][name]={'palette':palette,'svgSha256':hashlib.sha256(converted.encode()).hexdigest()}
        receipt['figures'].append(row)
    with (out/'checks.json').open('x') as f: json.dump(receipt,f,indent=2);f.write('\n')
    print(json.dumps({'nativeFigureChecks':len(receipt['figures']),'colourVisionViews':9,'passed':True}))

if __name__=='__main__': main()
