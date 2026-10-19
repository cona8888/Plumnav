#!/usr/bin/env python3
"""Vector-first, data-linked author-review figures; no inference or simulation."""
import argparse
import hashlib
from html import escape
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT/'research/publication_closeout_2026-09-22/evidence/figure_data.json'
EXPECTED = '474b9b9c1b60b852a862a2344e9b6779b91189f9f3f56b45355cdc548160e88f'
INK, BLUE, ORANGE, GRAY = '#202124', '#2F6F9F', '#CC7900', '#72777B'
PT = 25.4/72


def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()


class Svg:
    def __init__(self, height, name, wireframe=False, grayscale=False):
        self.height, self.name, self.wireframe, self.grayscale = height, name, wireframe, grayscale
        self.parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="183mm" height="{height}mm" viewBox="0 0 183 {height}" role="img">',
                      f'<title>{escape(name)}</title>',
                      '<desc>Author-review figure derived from closed numerical studies. Error bars are pointwise Wilson 95% intervals; no physical validation.</desc>',
                      '<defs><style>text { font-variant-numeric: tabular-nums; }</style></defs>',
                      '<rect width="183" height="100%" fill="#FFFFFF"/>']
        self.points = []

    def color(self, color):
        if not self.grayscale or not color.startswith('#'): return color
        r,g,b = [int(color[i:i+2],16) for i in [1,3,5]]
        x=round(.2126*r+.7152*g+.0722*b)
        return '#'+f'{x:02x}'*3

    def group(self, name): self.parts.append(f'<g id="{name}">')
    def endgroup(self): self.parts.append('</g>')

    def text(self, x, y, value, size=14, anchor='start', weight='normal', rotate=None):
        trans = f' transform="rotate({rotate} {x} {y})"' if rotate is not None else ''
        self.parts.append(f'<text x="{x:.4f}" y="{y:.4f}" font-family="Arial, Helvetica, sans-serif" font-size="{size*PT:.6f}" font-weight="{weight}" text-anchor="{anchor}" fill="{INK}"{trans}>{escape(str(value))}</text>')

    def line(self, x1, y1, x2, y2, color=INK, width=.3, dash=None):
        d=f' stroke-dasharray="{dash}"' if dash else ''
        self.parts.append(f'<line x1="{x1:.4f}" y1="{y1:.4f}" x2="{x2:.4f}" y2="{y2:.4f}" stroke="{self.color(color)}" stroke-width="{width}"{d}/>')

    def marker(self, x, y, kind, color, filled=True):
        fill=self.color(color) if filled else '#FFFFFF'; color=self.color(color); r=1.2
        if kind == 'circle':
            self.parts.append(f'<circle cx="{x:.4f}" cy="{y:.4f}" r="{r}" fill="{fill}" stroke="{color}" stroke-width="0.3"/>')
        elif kind == 'square':
            self.parts.append(f'<rect x="{x-r:.4f}" y="{y-r:.4f}" width="{2*r}" height="{2*r}" fill="{fill}" stroke="{color}" stroke-width="0.3"/>')
        else:
            self.parts.append(f'<path d="M {x:.4f} {y-r:.4f} L {x+r:.4f} {y:.4f} L {x:.4f} {y+r:.4f} L {x-r:.4f} {y:.4f} Z" fill="{fill}" stroke="{color}" stroke-width="0.3"/>')

    def frame(self, left, top, right, bottom):
        self.parts.append(f'<rect x="{left}" y="{top}" width="{right-left}" height="{bottom-top}" fill="none" stroke="{INK}" stroke-width="0.35"/>')

    def hinterval(self, value, bounds, y, scale, color, kind, source):
        self.points.append(dict(value=value, interval=bounds, source=source))
        if self.wireframe: return
        lo, hi = map(scale, bounds)
        self.line(lo,y,hi,y,color)
        for x in [lo,hi]: self.line(x,y-1,x,y+1,color)
        self.marker(scale(value),y,kind,color,filled=kind=='circle')

    def save(self, folder, stem):
        (folder/f'{stem}_master.svg').write_text('\n'.join(self.parts+['</svg>'])+'\n')
        return dict(stem=stem, widthMm=183, heightMm=self.height, points=self.points,
                    grayscale=self.grayscale, wireframe=self.wireframe)


def stage_figure(data, out, wireframe, grayscale):
    s=Svg(176,'Stage 2i: distinct decision endpoints in the continuous field',wireframe,grayscale)
    left,right,top,bottom=73,176,23,128
    scale=lambda p:left+(p+.05)/1.10*(right-left)
    s.group('axes');s.frame(left,top,right,bottom)
    for p in [0,.25,.5,.75,1]:
        x=scale(p);s.line(x,bottom-1,x,bottom+1);s.text(x,bottom+7,int(p*100),anchor='middle')
    s.text((left+right)/2,144,'Missions with outcome (%)',anchor='middle')
    s.text(right,13,'n = 32 paired worlds per arm',12,anchor='end')
    s.endgroup();s.group('data')
    rows=[(i,r) for i,r in enumerate(data['stage2i']['rows']) if r['field']=='si-continuous']
    styles=[('encounter',BLUE,'circle',-4),('supportedExact',ORANGE,'square',0),('supportedReleaseWithinPointOne',GRAY,'diamond',4)]
    for j,(i,r) in enumerate(rows):
        y=38+j*25
        name=r['algorithm']; lines={'Surge–cast-inspired':['Surge–cast','inspired'],'Encounter-gated quad':['Encounter-gated','quad']}.get(name,[name])
        for k,line in enumerate(lines):s.text(67,y+(k-(len(lines)-1)/2)*5.8+1.6,line,anchor='end')
        for metric,color,kind,offset in styles:
            d=r['binary'][metric]
            s.hinterval(d['proportion'],d['wilson95'],y+offset,scale,color,kind,f'/stage2i/rows/{i}/binary/{metric}')
    s.endgroup();s.group('legend')
    for y,(label,color,kind) in zip([154,162,170],[('Gas encounter',BLUE,'circle'),('Supported concentration maximum',ORANGE,'square'),('Supported release within 0.10 m',GRAY,'diamond')]):
        s.marker(14,y-1.4,kind,color,filled=kind=='circle');s.text(19,y,label,12)
    s.endgroup();return s.save(out,'fig01_stage2i_endpoints')


def screen_figure(data, out, wireframe, grayscale):
    s=Svg(169,'Outdoor screen: sensor noise, response and survey speed',wireframe,grayscale)
    left,right,top,bottom=31,175,19,115
    sx=lambda v:left+9+(math.log10(v)-math.log10(.02))/2*(right-left-18)
    sy=lambda p:bottom-4-p*(bottom-top-8)
    s.group('axes');s.frame(left,top,right,bottom)
    for v in [.02,.2,2]:
        x=sx(v);s.line(x,bottom-1,x,bottom+1);s.text(x,bottom+7,str(v),anchor='middle')
    for p in [0,.25,.5,.75,1]:
        y=sy(p);s.line(left-1,y,left+1,y);s.text(left-3,y+1.6,int(p*100),anchor='end')
    s.text((left+right)/2,134,'Sensor noise SD (ppm)',anchor='middle')
    s.text(8,(top+bottom)/2,'Event alarms (%)',anchor='middle',rotate=-90)
    s.text(right,10,'n = 128 paired worlds per setting',12,anchor='end');s.endgroup()
    s.group('data')
    for speed,color in [(1,BLUE),(.5,ORANGE)]:
        for tau,kind in [(.5,'circle'),(5,'square')]:
            rows=[(i,g) for i,g in enumerate(data['screen']['groups']) if g['wind']==.5 and g['speed']==speed and g['rateKgPerSecond']==1e-4 and g['k']==5 and g['sensor'].endswith('tau'+str(tau))]
            rows.sort(key=lambda item:float(item[1]['sensor'].split('sigma')[1].split('-')[0]))
            if len(rows)!=3:raise ValueError('Screen selection is incomplete')
            coords=[]
            for i,g in rows:
                noise=float(g['sensor'].split('sigma')[1].split('-')[0]);x,y=sx(noise),sy(g['estimate']);coords.append((x,y))
                s.points.append(dict(value=g['estimate'],interval=g['wilson95'],source=f'/screen/groups/{i}',noisePpm=noise))
            if wireframe:continue
            for a,b in zip(coords,coords[1:]):s.line(*a,*b,color,dash='1.5 1.1' if tau==5 else None)
            for (_,g),(x,y) in zip(rows,coords):
                lo,hi=map(sy,g['wilson95']);s.line(x,lo,x,hi,color)
                for yy in [lo,hi]:s.line(x-1,yy,x+1,yy,color)
                s.marker(x,y,kind,color,filled=tau==.5)
    s.endgroup();s.group('legend')
    for x,y,speed,tau,color,kind in [(33,147,1,.5,BLUE,'circle'),(105,147,1,5,BLUE,'square'),(33,159,.5,.5,ORANGE,'circle'),(105,159,.5,5,ORANGE,'square')]:
        s.line(x,y-1.5,x+6,y-1.5,color,dash='1.5 1.1' if tau==5 else None)
        s.marker(x+3,y-1.5,kind,color,filled=tau==.5);s.text(x+9,y,f'{speed} m/s; τ = {tau} s',12)
    s.endgroup();return s.save(out,'fig02_outdoor_sensor_screen')


def budget_figure(data,out,wireframe,grayscale):
    s=Svg(246,'Mission-budget comparison on new paired worlds',wireframe,grayscale)
    left,right=51,176;scale=lambda p:left+(p+.05)/1.1*(right-left)
    s.group('legend')
    for x,label,color,kind in [(38,'600 s',BLUE,'circle'),(105,'Full route',ORANGE,'square')]:
        s.marker(x,9,kind,color,filled=kind=='circle');s.text(x+5,10.5,label,12)
    s.endgroup()
    for j,tau in enumerate([.5,5]):
        top=33+j*116;bottom=top+75
        s.group('panel-'+str(j));s.text(5,top-5,'(a)' if j==0 else '(b)',weight='bold')
        s.text(51,top-5,f'Rise τ = {tau} s',12);s.text(176,top-5,'n = 128',12,anchor='end')
        s.frame(left,top,right,bottom)
        for p in [0,.25,.5,.75,1]:
            x=scale(p);s.line(x,bottom-1,x,bottom+1);s.text(x,bottom+7,int(p*100),anchor='middle')
        s.text((left+right)/2,bottom+17,'Event alarms (%)',anchor='middle')
        s.text(8,(top+bottom)/2,'Wind / speed (m/s)',anchor='middle',rotate=-90)
        for k,(wind,speed) in enumerate([(.5,.5),(.5,1),(2,.5),(2,1)]):
            i,g=next((i,g) for i,g in enumerate(data['budget']['groups']) if g['wind']==wind and g['speed']==speed and g['rateKgPerSecond']==1e-4 and g['sensor'].endswith('tau'+str(tau)))
            y=top+8+k*19
            s.text(46,y+1.6,f'{wind} / {speed}',anchor='end')
            for n,(color,kind,offset) in enumerate([(BLUE,'circle',-2.5),(ORANGE,'square',2.5)]):
                b=g['budgets'][n];s.hinterval(b['estimate'],b['wilson95'],y+offset,scale,color,kind,f'/budget/groups/{i}/budgets/{n}')
        s.endgroup()
    return s.save(out,'fig03_mission_budget')


CAPTIONS = '''# Provisional figure legends — author review

These figures contain simulated results only. All intervals and numerical values
are copied from accepted source records through the evidence index. The captions
are provisional Stage 1 shells, not journal-polished manuscript prose.

## Figure 1 — Decision endpoints are not interchangeable

Continuous-field Stage 2i outcomes for the four frozen methods in 32 fresh paired
worlds per arm. Circles show eligible gas encounters, squares show exact-coordinate
supported local concentration maxima, and diamonds show supported points within
0.10 m of the actual atmospheric release. Horizontal bars are pointwise Wilson
95% intervals; offsets within each method row separate endpoints visually.
The denominator includes unresolved missions. All four arms have zero supported
within-tolerance release outcomes; this must not be relabelled successful source
localisation. The paired gated-minus-periodic maximum-support contrast is
71.875 percentage points, paired percentile bootstrap 95% interval 56.25–87.5;
that paired interval is distinct from the plotted arm-rate intervals. Pulsed
and absent-field results remain in the full evidence table: no pulsed inspection
supports a maximum. Source: figure_data.json `/stage2i/rows` and the preserved
Stage 2i summary/audit; 10 m open-terrain model, nominal sensor only.

## Figure 2 — A sensor specification is conditional on the survey

Event-alarm fraction versus assumed output-noise standard deviation for the
100 m outdoor screen, at 0.1 g/s continuous release, 0.5 m/s wind, k=5 and a
600 s prescribed survey. Blue denotes 1 m/s travel, orange 0.5 m/s; filled
circles/solid lines denote rise time constant τ=0.5 s, open squares/dashed lines
τ=5 s. τ is not T90. Each point uses the same 128 paired worlds; vertical bars
are pointwise Wilson 95% intervals. Curves connect tested settings as guides
only, not a calibrated continuous response function. Some points overlap.
Changing noise at fixed k also changes the absolute alarm threshold, so these
curves do not isolate noise with an unchanged ppm threshold. Abstract profiles
are not commercial sensor calibrations. All wind/rate/threshold settings and
matched blanks remain in the source table. At the primary noise of 0.2 ppm and
1 m/s, both responses alarm in the same 81/128 worlds; that equality does not
prove sensor equivalence. Source: figure_data.json `/screen/groups`.

## Figure 3 — Mission completion changes observed detection capability

Fractions with event alarms after 600 s (blue circles) and at full-route
completion (orange open squares), for rise constants (a) 0.5 s and (b) 5 s.
Row labels give wind speed / robot speed in m/s. Both sensors have noise SD
0.2 ppm and k=5; release is 0.1 g/s. These are 128 new paired worlds, not the
Figure 2 worlds. Horizontal bars are descriptive pointwise Wilson 95% intervals.
The 990 m route takes 2016 s at 0.5 m/s and 1026 s at 1 m/s; the 600 s prefixes
cover 295 and 580 m respectively. Sensor memory and physical-clock noise are
continuous across both budgets. Equal full-route distance does not equalise
elapsed time, source age, sample count or energy. The primary wind=0.5 m/s,
speed=1 m/s, τ=0.5 s contrast is 44/128 additional detections: +34.375 percentage
points, exact 97.5% interval 25.157–44.528 pp. The paired additional blank-alarm
count is 0/128, exact 97.5% interval 0–3.366 pp; the two intervals jointly have
at least 95% coverage under independent-world sampling. Every blank cell has
zero observed alarms, not a guaranteed zero risk. At 2 m/s wind, 12–14 of 128
events remain undetected after the full route. Source: figure_data.json
`/budget/groups` and `/budget/primary`. Event detection is not localisation.
'''


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);p.add_argument('--wireframe',action='store_true');p.add_argument('--grayscale',action='store_true');a=p.parse_args()
    if a.output.exists():raise ValueError('Choose a new output directory')
    if sha(DATA)!=EXPECTED:raise ValueError('Derived figure data hash changed')
    data=json.loads(DATA.read_text());a.output.mkdir(parents=True,exist_ok=False)
    figures=[f(data,a.output,a.wireframe,a.grayscale) for f in [stage_figure,screen_figure,budget_figure]]
    (a.output/'captions.md').write_text(CAPTIONS)
    receipt=dict(sourceData=str(DATA.relative_to(ROOT)),sourceSha256=EXPECTED,generatorSha256=sha(Path(__file__)),
                 figures=figures,fontsPt=[14,12],fontFamily='Arial',finalJournalLayoutApproved=False,
                 visualReviewComplete=False,physicalValidation=False,
                 outputs={p.name:sha(p) for p in sorted(a.output.iterdir()) if p.is_file()})
    (a.output/'figure_provenance.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(dict(output=str(a.output),figures=len(figures),points=sum(len(x['points']) for x in figures),wireframe=a.wireframe)))


if __name__=='__main__':main()
