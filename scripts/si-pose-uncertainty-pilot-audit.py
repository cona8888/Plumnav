"""Independent stdlib audit and stratified outcome summary for Stage 1h."""
import gzip,hashlib,json,math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];STUDY=ROOT/'research/evidence/si_pose_uncertainty_pilot_2026-09-15';OUT=ROOT/'research/evidence/si_pose_uncertainty_pilot_audit_2026-09-15'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p):return json.loads(p.read_bytes())
def load(i):return json.loads(gzip.decompress((STUDY/f'run-{i}.json.gz').read_bytes()))
def med(a):return sorted(a)[len(a)//2]
def close(a,b,tol=1e-10):assert math.isclose(a,b,rel_tol=1e-9,abs_tol=tol),(a,b)
def solve(a,b):
 m=[r[:]+[v] for r,v in zip(a,b)]
 for k in range(len(b)):
  p=max(range(k,len(b)),key=lambda i:abs(m[i][k]));m[k],m[p]=m[p],m[k];assert abs(m[k][k])>1e-12
  d=m[k][k];m[k]=[v/d for v in m[k]]
  for i in range(len(b)):
   if i!=k:
    f=m[i][k];m[i]=[x-f*y for x,y in zip(m[i],m[k])]
 return [r[-1] for r in m]
manifest,complete=read(STUDY/'manifest.json'),read(STUDY/'complete.json');assert complete['complete'] and complete['cases']==manifest['caseCount']==68
for e in complete['inventory']:assert sha(STUDY/e['file'])==e['sha256']
for e in manifest['sources']:assert sha(STUDY/'source-snapshot'/e['file'])==e['sha256'] and sha(ROOT/e['file'])==e['sha256']
assert manifest['protocol']=='research/protocols/si_pose_uncertainty_pilot_2026-09-15.md' and manifest['acceptedDt']==.0625
runs=[load(i) for i in range(68)];counts={'ticks':0,'valid':0,'retained':0,'clipped':0};maxfit=maxarrival=maxheading=0
for i,r in enumerate(runs):
 assert r['spec']==manifest['configurations'][i]['spec'] and r['config']==manifest['configurations'][i]['config'];c=r['config'];dt=c['fixedDt'];L=c['domainMeters'];p=c['localInletSampling'];u=r['spec']['uncertainty'];trace=r['trace'];assert dt==.0625 and len(trace)==round(330/dt) and len(r['visits'])==17 and r['row']['status']!='incomplete'
 assert len(r['nominalTargets'])==len(r['actualTargets'])==len(r['positionOffsetsMetres'])==len(r['headingOffsetsRadians'])==17
 for j,(nominal,actual,offset,angle) in enumerate(zip(r['nominalTargets'],r['actualTargets'],r['positionOffsetsMetres'],r['headingOffsetsRadians'])):
  close(actual['x'],nominal['x']+offset['x']/L);close(actual['y'],nominal['y']+offset['y']/L);assert math.hypot(offset['x'],offset['y'])<=u['positionRadiusMetres']+1e-12 and abs(angle)<=u['headingBoundRadians']+1e-12
 for j,t in enumerate(trace):assert math.isclose(t['time'],j*dt,abs_tol=1e-12);counts['valid']+=t['measurement']['valid']
 counts['ticks']+=len(trace);ys=[];X=[];candidate=c['robotStartPositionOverride'];h=p['inspection']['offsetNormalized']
 for j,visit in enumerate(r['visits']):
  assert visit['arrivedAt'] is not None and visit['closedAt'] is not None;actual=r['actualTargets'][j];nominal=r['nominalTargets'][j];desired=r['desiredHeadings'][j]
  for s in visit['samples']:
   t=trace[round(s['time']/dt)];arrival=L*math.hypot(t['position']['x']-actual['x'],t['position']['y']-actual['y']);heading=abs(math.atan2(math.sin(t['heading']-desired),math.cos(t['heading']-desired)));maxarrival=max(maxarrival,arrival);maxheading=max(maxheading,heading);assert arrival<=.001+1e-10 and heading<=1e-10
   expected=nominal if u['registration']=='commanded' else t['position'];close(s['x'],(expected['x']-candidate['x'])/h);close(s['y'],(expected['y']-candidate['y'])/h);counts['retained']+=1;counts['clipped']+=s['clipped']
  ys.append(med([s['value'] for s in visit['samples']]));x=sum(s['x'] for s in visit['samples'])/len(visit['samples']);y=sum(s['y'] for s in visit['samples'])/len(visit['samples']);X.append([1,x,y,.5*x*x,x*y,.5*y*y])
 coef=solve([[sum(row[a]*row[b] for row in X) for b in range(6)] for a in range(6)],[sum(row[a]*value for row,value in zip(X,ys)) for a in range(6)])
 for a,b in zip(coef,r['result']['coefficients']):maxfit=max(maxfit,abs(a-b));close(a,b)
 rmse=math.sqrt(sum((sum(a*b for a,b in zip(row,coef))-value)**2 for row,value in zip(X,ys))/17);xx,xy,yy=coef[3],coef[4],coef[5];ev=(xx+yy+math.hypot(xx-yy,2*xy))/2;det=xx*yy-xy*xy;peak=((xy*coef[2]-yy*coef[1])/det,(xy*coef[1]-xx*coef[2])/det) if abs(det)>1e-12 else None;margin=.003
 core=all(ys[j]>=.16 and sum(s['hit'] for s in r['visits'][j]['samples'])>=2 for j in range(0,17,2));stable=all(abs(ys[j-1]-ys[j+1])<=max(margin,.05*min(ys[j-1],ys[j+1])) for j in range(1,16,2));clipped=any(s['clipped'] for v in r['visits'] for s in v['samples'])
 reason='clipped-required-measurement' if clipped else 'insufficient-signal' if not core else 'temporal-inconsistency' if not stable else 'spatial-model-mismatch' if rmse>margin else 'not-negative-definite' if ev>=-2*margin else 'maximum-outside-probed-region' if peak is None or math.hypot(*peak)>1 else 'local-quadratic-supported'
 assert reason==r['result']['reason'] and r['result']['status']==('supported' if reason=='local-quadratic-supported' else 'abstained')
baselines={r['spec']['field']:r for r in runs if r['spec']['kind']=='baseline'};outcomes=[]
for r in runs:
 b=baselines[r['spec']['field']];positive=r['spec']['field'] in ('offset-peak','si-continuous');peakshift=None
 if r['result']['peak'] and b['result']['peak']:peakshift=.1*math.hypot(r['result']['peak']['x']-b['result']['peak']['x'],r['result']['peak']['y']-b['result']['peak']['y'])
 outcomes.append({'index':r['row']['index'],'field':r['spec']['field'],'kind':r['spec']['kind'],**r['spec']['uncertainty'],'status':r['result']['status'],'reason':r['result']['reason'],'baselineStatus':b['result']['status'],'baselineReason':b['result']['reason'],'reasonStable':r['result']['reason']==b['result']['reason'],'lostSupport':positive and b['result']['status']=='supported' and r['result']['status']!='supported','falseSupport':not positive and r['result']['status']=='supported','peakShiftFromBaselineMetres':peakshift,'completedAt':r['row']['completedAt'],'maximumTargetOffsetMetres':r['row']['maximumTargetOffsetMetres']})
strata=[]
keys=sorted(set((o['kind'],o['positionRadiusMetres'],o['headingBoundRadians'],o['registration']) for o in outcomes))
for key in keys:
 selected=[o for o in outcomes if (o['kind'],o['positionRadiusMetres'],o['headingBoundRadians'],o['registration'])==key];strata.append({'kind':key[0],'positionRadiusMetres':key[1],'headingBoundRadians':key[2],'registration':key[3],'runs':len(selected),'reasonStable':sum(o['reasonStable'] for o in selected),'lostSupport':sum(o['lostSupport'] for o in selected),'falseSupport':sum(o['falseSupport'] for o in selected),'maximumPeakShiftMetres':max((o['peakShiftFromBaselineMetres'] or 0) for o in selected)})
body={'counts':counts,'maximumIndependentFitError':maxfit,'maximumRetainedArrivalErrorMetres':maxarrival,'maximumRetainedHeadingErrorRadians':maxheading,'baselines':{k:{'status':v['result']['status'],'reason':v['result']['reason']} for k,v in baselines.items()},'strata':strata,'outcomes':outcomes,'totalLostSupport':sum(o['lostSupport'] for o in outcomes),'totalFalseSupport':sum(o['falseSupport'] for o in outcomes)}
OUT.mkdir();(OUT/'audit.json').write_text(json.dumps(body,indent=2)+'\n');(OUT/'si-pose-uncertainty-pilot-audit.py').write_bytes(Path(__file__).read_bytes());(OUT/'complete.json').write_text(json.dumps({'complete':True,'auditSha256':sha(OUT/'audit.json'),'sourceSha256':sha(OUT/'si-pose-uncertainty-pilot-audit.py')})+'\n');print(json.dumps({k:v for k,v in body.items() if k not in ('outcomes','strata')}))
