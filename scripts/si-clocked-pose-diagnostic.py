"""Post-audit descriptive pose/head geometry differences at matched sample times."""
import gzip,hashlib,json,math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
STUDY=ROOT/'research/evidence/si_clocked_arrival_2026-09-14'
OUT=ROOT/'research/evidence/si_clocked_pose_diagnostic_2026-09-14'
def load(i):return json.loads(gzip.decompress((STUDY/f'run-{i}.json.gz').read_bytes()))
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
manifest=json.loads((STUDY/'manifest.json').read_text());complete=json.loads((STUDY/'complete.json').read_text())
assert complete['complete'] and complete['cases']==66
for e in complete['inventory']:assert sha(STUDY/e['file'])==e['sha256']
rows=json.loads((STUDY/'summary.json').read_text())['rows'];diagnostics=[]
for field in sorted(set(r['field'] for r in rows)):
 for mode in ['nominal','zero']:
  fine_index=next(i for i,r in enumerate(rows) if r['field']==field and r['noiseMode']==mode and r['dt']==.0625)
  fine=load(fine_index)
  for dt in [.25,.125]:
   index=next(i for i,r in enumerate(rows) if r['field']==field and r['noiseMode']==mode and r['dt']==dt)
   coarse=load(index);L=coarse['config']['domainMeters'];half_head=coarse['config']['localInletSampling']['opposingInletSpacingMetres']/2
   positions=[];headings=[];inlet_bounds=[];readouts=[]
   for cv,fv in zip(coarse['visits'],fine['visits']):
    assert [s['time'] for s in cv['samples']]==[s['time'] for s in fv['samples']]
    for cs,fs in zip(cv['samples'],fv['samples']):
     t=cs['time'];ct=coarse['trace'][round(t/dt)];ft=fine['trace'][round(t/.0625)]
     assert abs(ct['time']-t)<1e-9 and abs(ft['time']-t)<1e-9
     d=L*math.hypot(ct['position']['x']-ft['position']['x'],ct['position']['y']-ft['position']['y'])
     angle=math.atan2(math.sin(ct['heading']-ft['heading']),math.cos(ct['heading']-ft['heading']))
     positions.append(d);headings.append(abs(angle));inlet_bounds.append(d+2*half_head*abs(math.sin(angle/2)))
     readouts.append(abs(cs['value']-fs['value']))
   diagnostics.append({'field':field,'noiseMode':mode,'dt':dt,'coarseIndex':index,'fineIndex':fine_index,'matchedReadouts':len(readouts),'maxPositionDifferenceMetres':max(positions),'meanPositionDifferenceMetres':sum(positions)/len(positions),'maxHeadingDifferenceRadians':max(headings),'maxCorrespondingInletDisplacementUpperBoundMetres':max(inlet_bounds),'maxMatchedReadoutDifferenceC0':max(readouts),'medianMatchedReadoutDifferenceC0':sorted(readouts)[len(readouts)//2]})
OUT.mkdir()
body={'scope':'Exploratory diagnostics after frozen Stage 1c audit; equal sample times only. Inlet displacement is an upper bound and does not separate channel history, quadrature or noise contributions.','parentCompleteSha256':sha(STUDY/'complete.json'),'comparisons':diagnostics}
(OUT/'diagnostic.json').write_text(json.dumps(body,indent=2)+'\n');(OUT/'si-clocked-pose-diagnostic.py').write_bytes(Path(__file__).read_bytes());(OUT/'complete.json').write_text(json.dumps({'complete':True,'diagnosticSha256':sha(OUT/'diagnostic.json'),'sourceSha256':sha(OUT/'si-clocked-pose-diagnostic.py')})+'\n')
print(json.dumps({'comparisons':len(diagnostics),'maximumPositionDifferenceMetres':max(x['maxPositionDifferenceMetres'] for x in diagnostics),'maximumHeadingDifferenceRadians':max(x['maxHeadingDifferenceRadians'] for x in diagnostics),'maximumReadoutDifferenceC0':max(x['maxMatchedReadoutDifferenceC0'] for x in diagnostics)}))
