"""Independent provenance/arithmetic audit of the Stage 1d evaluator replay."""
import gzip,hashlib,json,math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
STUDY=ROOT/'research/evidence/si_matched_pose_response_replay_2026-09-14'
OUT=ROOT/'research/evidence/si_matched_pose_response_replay_audit_2026-09-14'
PARENT=ROOT/'research/evidence/si_clocked_arrival_2026-09-14'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p):return json.loads(p.read_bytes())
def zipread(p):return json.loads(gzip.decompress(p.read_bytes()))
def near(a,b,tol=1e-10):assert math.isclose(a,b,rel_tol=tol,abs_tol=tol),(a,b)
manifest,done,summary=read(STUDY/'manifest.json'),read(STUDY/'complete.json'),read(STUDY/'summary.json')
assert done['complete'] and done['pairs']==22 and done['replays']==8
assert sha(PARENT/'complete.json')==manifest['parentCompleteSha256']
for e in done['inventory']:assert sha(STUDY/e['file'])==e['sha256']
for e in manifest['sources']:
 assert sha(STUDY/'source-snapshot'/e['file'])==e['sha256']
 assert sha(ROOT/e['file'])==e['sha256']
parentinventory={e['file']:e['sha256'] for e in read(PARENT/'complete.json')['inventory']}
cache={}
def parent(i):
 if i not in cache:
  file=f'run-{i}.json.gz';assert sha(PARENT/file)==parentinventory[file];cache[i]=zipread(PARENT/file)
 return cache[i]
def synthetic(field,p,t,config):
 x=(p['x']-.5)*config['domainMeters'];y=(p['y']-.5)*config['domainMeters'];r=math.hypot(x,y)
 if field=='peak':return .01+math.exp(-r*r/(2*.3**2))
 if field=='offset-peak':return .01+math.exp(-((x-.03)**2+(y+.02)**2)/(2*.3**2))
 if field=='ridge':return .01+math.exp(-x*x/(2*.3**2))
 if field=='saddle':return max(0,1-(x*x+y*y)/(2*.3**2)+2*x*y/.3**2)
 if field=='plateau':return 1 if r<=.3 else .01+.99*math.exp(-((r-.3)**2)/(2*.3**2))
 if field=='uniform':return 1
 if field=='clipped-peak':return 3*math.exp(-r*r/(2*.3**2))
 return 0
def direct(field,p,heading,time,config):
 radius=config['localInletSampling']['opposingInletSpacingMetres']/(2*config['domainMeters'])
 return sum(synthetic(field,{'x':p['x']+radius*math.cos(heading+angle),'y':p['y']+radius*math.sin(heading+angle)},time,config) for angle in [0,-math.pi/2,math.pi,math.pi/2])/4
counts={'samples':0,'clean':0,'clipped':0,'syntheticDirectChecks':0,'replayReadouts':0};maxalgebra=0;maxsynthetic=0
for i,row in enumerate(summary['rows']):
 packet=zipread(STUDY/f'pair-{i}.json.gz');assert packet['row']==row
 coarse=parent(row['coarseIndex']);fine=parent(row['fineIndex']);field=row['field'];assert coarse['spec']['field']==fine['spec']['field']==field and coarse['spec']['noiseMode']==fine['spec']['noiseMode']=='zero'
 expected=[(j,a,b) for j,(cv,fv) in enumerate(zip(coarse['visits'],fine['visits'])) for a,b in zip(cv['samples'],fv['samples'])]
 assert len(expected)==len(packet['samples'])==row['samples']
 for s,(visit,a,b) in zip(packet['samples'],expected):
  assert s['visit']==visit and s['time']==a['time']==b['time']
  ct=coarse['trace'][round(a['time']/coarse['spec']['dt'])];ft=fine['trace'][round(b['time']/.0625)]
  near(s['measuredDelta'],a['value']-b['value']);near(s['directDelta'],s['coarseInstantaneous']-s['fineInstantaneous'])
  near(s['directDelta'],s['positionComponent']+s['headingComponent']);near(s['residual'],s['measuredDelta']-s['directDelta'])
  assert s['clipped']==(a['clipped'] or b['clipped'])
  if not field.startswith('si-'):
   cc=direct(field,ct['position'],ct['heading'],a['time'],coarse['config']);ff=direct(field,ft['position'],ft['heading'],a['time'],fine['config'])
   near(cc,s['coarseInstantaneous'],1e-9);near(ff,s['fineInstantaneous'],1e-9);counts['syntheticDirectChecks']+=2
  counts['samples']+=1;counts['clipped' if s['clipped'] else 'clean']+=1
 clean=[s for s in packet['samples'] if not s['clipped']]
 for key,attr in [('cleanRmsMeasured','measuredDelta'),('cleanRmsInstantaneous','directDelta'),('cleanRmsPosition','positionComponent'),('cleanRmsHeading','headingComponent'),('cleanRmsResidual','residual')]:
  expected_value=math.sqrt(sum(s[attr]**2 for s in clean)/len(clean)) if clean else None
  if expected_value is None:assert row[key] is None
  else:near(row[key],expected_value)
 assert row['cleanSamples']==len(clean) and row['clippedSamples']==len(packet['samples'])-len(clean)
for i,row in enumerate(summary['replays']):
 packet=zipread(STUDY/f'replay-{i}.json.gz');assert packet['row']==row
 run=parent(row['index']);cfg=run['config'];p=cfg['localInletSampling'];dt=row['dt'];end=round(run['row']['completedAt']/dt)
 expected_delay=math.pi*(p['tubeInnerDiameterMetres']/2)**2*p['tubeLengthMetres']/(p['flowLitresPerMinutePerChannel']*1e-3/60)
 near(packet['settings']['delay'],expected_delay);near(packet['settings']['rise'],p['riseTimeConstantSeconds']);near(packet['settings']['recovery'],p['recoveryTimeConstantSeconds']);near(packet['settings']['average'],p['averagingSeconds'])
 assert len(packet['inputs'])==len(packet['predictions'])==4
 errors=[];clipped=[]
 for channel in range(4):
  values=packet['inputs'][channel];prediction=packet['predictions'][channel];assert len(values)==len(prediction)==end+1
  for j,v in enumerate(values):
   near(v['time'],j*dt);assert math.isfinite(v['value']) and v['value']>=0
   if row['field']=='offset-peak':
    tick=run['trace'][j];radius=p['opposingInletSpacingMetres']/(2*cfg['domainMeters']);angle=tick['heading']+[0,-math.pi/2,math.pi,math.pi/2][channel]
    location={'x':tick['position']['x']+radius*math.cos(angle),'y':tick['position']['y']+radius*math.sin(angle)}
    near(v['value'],synthetic('offset-peak',location,v['time'],cfg),1e-9);counts['syntheticDirectChecks']+=1
   tick=run['trace'][j]
   if not tick['measurement']['valid']:continue
   output=min(cfg['sensorSaturation'],max(0,prediction[j]));actual=tick['measurement']['localInletReadings'][channel]['concentration'];error=abs(output-actual)
   (clipped if tick['measurement']['localInletReadings'][channel]['saturated'] else errors).append(error)
 assert row['readouts']==len(errors)+len(clipped) and row['unclippedReadouts']==len(errors) and row['clippedReadouts']==len(clipped)
 near(row['maxUnclippedError'],max([0,*errors]));near(row['maxClippedError'],max([0,*clipped]))
 assert row['withinTolerance']==(max([0,*errors,*clipped])<=manifest['channelToleranceC0'])
 counts['replayReadouts']+=row['readouts']
OUT.mkdir();body={'counts':counts,'parentCompleteSha256':manifest['parentCompleteSha256'],'pairCount':len(summary['rows']),'replayCount':len(summary['replays']),'replaysWithinTolerance':sum(r['withinTolerance'] for r in summary['replays'])}
(OUT/'audit.json').write_text(json.dumps(body,indent=2)+'\n');(OUT/'si-matched-pose-response-audit.py').write_bytes(Path(__file__).read_bytes());(OUT/'complete.json').write_text(json.dumps({'complete':True,'auditSha256':sha(OUT/'audit.json'),'sourceSha256':sha(OUT/'si-matched-pose-response-audit.py')})+'\n');print(json.dumps(body))
