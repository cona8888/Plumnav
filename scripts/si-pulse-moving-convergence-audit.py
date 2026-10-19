"""Independent stdlib audit of the moving fine-step pulse confirmation."""
import gzip,hashlib,json,math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];STUDY=ROOT/'research/evidence/si_pulse_moving_convergence_2026-09-15';OUT=ROOT/'research/evidence/si_pulse_moving_convergence_audit_2026-09-15'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p):return json.loads(p.read_bytes())
def load(i):return json.loads(gzip.decompress((STUDY/f'run-{i}.json.gz').read_bytes()))
def med(a):return sorted(a)[len(a)//2]
def solve(a,b):
 m=[r[:]+[v] for r,v in zip(a,b)]
 for k in range(len(b)):
  p=max(range(k,len(b)),key=lambda i:abs(m[i][k]));m[k],m[p]=m[p],m[k];assert abs(m[k][k])>1e-12
  d=m[k][k];m[k]=[v/d for v in m[k]]
  for i in range(len(b)):
   if i!=k:
    f=m[i][k];m[i]=[x-f*y for x,y in zip(m[i],m[k])]
 return [r[-1] for r in m]
manifest,complete=read(STUDY/'manifest.json'),read(STUDY/'complete.json');assert complete['complete'] and complete['cases']==6
for e in complete['inventory']:assert sha(STUDY/e['file'])==e['sha256']
for e in manifest['sources']:assert sha(STUDY/'source-snapshot'/e['file'])==e['sha256'] and sha(ROOT/e['file'])==e['sha256']
assert manifest['protocol']=='research/protocols/si_pulse_moving_convergence_2026-09-15.md' and manifest['effectiveArrivalRadiusMetres']==.001
runs=[load(i) for i in range(6)];counts={'ticks':0,'valid':0,'retained':0};maxfit=0
for i,r in enumerate(runs):
 assert r['spec']==manifest['configurations'][i]['spec'] and r['config']==manifest['configurations'][i]['config'];assert r['row']['status']!='incomplete' and len(r['visits'])==17
 dt=r['spec']['dt'];L=r['config']['domainMeters'];p=r['config']['localInletSampling'];trace=r['trace'];assert len(trace)==round(600/dt)
 for j,t in enumerate(trace):
  assert math.isclose(t['time'],j*dt,abs_tol=1e-12);assert t['measurement']['valid']==(j%round(p['sampleIntervalSeconds']/dt)==0);counts['valid']+=t['measurement']['valid']
 counts['ticks']+=len(trace);ys=[];X=[]
 for visit in r['visits']:
  assert visit['arrivedAt'] is not None and visit['closedAt'] is not None and abs(visit['arrivedAt']-round(visit['arrivedAt']))<1e-10
  expected=[];last=-math.inf
  for t in trace[round(visit['arrivedAt']/dt):round(visit['closedAt']/dt)+1]:
   assert L*math.hypot(t['position']['x']-visit['target']['x'],t['position']['y']-visit['target']['y'])<=.001+1e-10
   if t['time']>=visit['arrivedAt']+p['inspection']['settlingSeconds'] and t['measurement']['valid'] and t['time']-last>=p['inspection']['sampleSpacingSeconds']:expected.append(t['time']);last=t['time']
  assert expected==[s['time'] for s in visit['samples']];counts['retained']+=len(expected);ys.append(med([s['value'] for s in visit['samples']]))
  x=sum(s['x'] for s in visit['samples'])/len(visit['samples']);y=sum(s['y'] for s in visit['samples'])/len(visit['samples']);X.append([1,x,y,.5*x*x,x*y,.5*y*y])
 coef=solve([[sum(row[a]*row[b] for row in X) for b in range(6)] for a in range(6)],[sum(row[a]*value for row,value in zip(X,ys)) for a in range(6)])
 for a,b in zip(coef,r['result']['coefficients']):maxfit=max(maxfit,abs(a-b));assert math.isclose(a,b,rel_tol=1e-9,abs_tol=1e-10)
comparisons=[]
for mode in ('nominal','zero'):
 fine=next(r for r in runs if r['spec']['noiseMode']==mode and r['spec']['dt']==manifest['referenceDt'])
 for coarse in [r for r in runs if r['spec']['noiseMode']==mode and r['spec']['dt']!=manifest['referenceDt']]:
  visits=[];maxpos=maxheading=0
  for j,(a,b) in enumerate(zip(coarse['visits'],fine['visits'])):
   aa={s['time'] for s in a['samples']};bb={s['time'] for s in b['samples']};assert aa==bb
   for s in a['samples']:
    ct=coarse['trace'][round(s['time']/coarse['spec']['dt'])];ft=fine['trace'][round(s['time']/fine['spec']['dt'])];maxpos=max(maxpos,coarse['config']['domainMeters']*math.hypot(ct['position']['x']-ft['position']['x'],ct['position']['y']-ft['position']['y']));maxheading=max(maxheading,abs(math.atan2(math.sin(ct['heading']-ft['heading']),math.cos(ct['heading']-ft['heading']))))
   visits.append({'visit':j,'arrivalDifference':abs(a['arrivedAt']-b['arrivedAt']),'closureDifference':abs(a['closedAt']-b['closedAt']),'medianDifference':abs(coarse['result']['medians'][j]-fine['result']['medians'][j])})
  coef=max(abs(a-b) for a,b in zip(coarse['result']['coefficients'],fine['result']['coefficients']));g={'circuit':abs(coarse['row']['completedAt']-fine['row']['completedAt'])<=2,'arrival':max(v['arrivalDifference'] for v in visits)<=2,'closure':max(v['closureDifference'] for v in visits)<=2,'count':True,'median':max(v['medianDifference'] for v in visits)<=.003,'coefficients':coef<=.006,'decision':coarse['result']['reason']==fine['result']['reason']}
  comparisons.append({'noiseMode':mode,'dt':coarse['spec']['dt'],'circuitDifference':abs(coarse['row']['completedAt']-fine['row']['completedAt']),'maximumMedianDifferenceC0':max(v['medianDifference'] for v in visits),'coefficientDifferenceC0':coef,'maximumMatchedPositionDifferenceMetres':maxpos,'maximumMatchedHeadingDifferenceRadians':maxheading,'visits':visits,'gates':g,'pass':all(g.values())})
body={'counts':counts,'maximumIndependentFitError':maxfit,'comparisons':comparisons,'passedComparisons':sum(c['pass'] for c in comparisons),'totalComparisons':len(comparisons)}
OUT.mkdir();(OUT/'audit.json').write_text(json.dumps(body,indent=2)+'\n');(OUT/'si-pulse-moving-convergence-audit.py').write_bytes(Path(__file__).read_bytes());(OUT/'complete.json').write_text(json.dumps({'complete':True,'auditSha256':sha(OUT/'audit.json'),'sourceSha256':sha(OUT/'si-pulse-moving-convergence-audit.py')})+'\n');print(json.dumps({k:v for k,v in body.items() if k!='comparisons'}))
