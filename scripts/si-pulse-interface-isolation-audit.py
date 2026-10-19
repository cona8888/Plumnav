"""Independent stdlib provenance, channel-response and timestep audit."""
import gzip, hashlib, json, math
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
STUDY=ROOT/'research/evidence/si_pulse_interface_isolation_2026-09-15'
OUT=ROOT/'research/evidence/si_pulse_interface_isolation_audit_2026-09-15'

def read(path): return json.loads(path.read_bytes())
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def load(index): return json.loads(gzip.decompress((STUDY/f'run-{index}.json.gz').read_bytes()))
def median(values):
    ordered=sorted(values);return ordered[len(ordered)//2]

manifest,complete=read(STUDY/'manifest.json'),read(STUDY/'complete.json')
assert manifest['protocol']=='research/protocols/si_pulse_interface_isolation_2026-09-15.md'
assert complete['complete'] and complete['cases']==36
for entry in complete['inventory']: assert sha(STUDY/entry['file'])==entry['sha256']
for entry in manifest['sourceSnapshot']:
    assert sha(STUDY/'source-snapshot'/entry['file'])==entry['sha256']
    assert sha(ROOT/entry['file'])==entry['sha256']
assert sha(ROOT/manifest['parent']/'complete.json')==manifest['parentCompleteSha256']

def replay(run):
    p=run['config']['localInletSampling'];sat=run['config']['sensorSaturation']
    delay=(math.pi*p['tubeInnerDiameterMetres']**2*p['tubeLengthMetres']/4)/(p['flowLitresPerMinutePerChannel']*1e-3/60)
    outputs=[]
    for channel in range(4):
        queue=[];segments=[];target=state=current=0.;started=False
        def advance(end):
            nonlocal state,current
            if end<=current:return
            tau=p['riseTimeConstantSeconds'] if target>=state else p['recoveryTimeConstantSeconds']
            initial=state;state=target+(state-target)*math.exp(-(end-current)/tau)
            segments.append((current,end,initial,target,tau));current=end
        channel_outputs=[]
        for tick in run['ticks']:
            time=tick['time'];assert not started or time>previous
            started=True;previous=time;queue.append((time+delay,tick['trueInlets'][channel]))
            while queue and queue[0][0]<=time:
                due,value=queue.pop(0);advance(due);target=value
            advance(time);cutoff=time-p['averagingSeconds'];area=0.
            while segments and segments[0][1]<=cutoff:segments.pop(0)
            for start,end,initial,aim,tau in segments:
                lo=max(cutoff,start);hi=end
                if hi>lo:
                    area+=aim*(hi-lo)+(initial-aim)*tau*(math.exp(-(lo-start)/tau)-math.exp(-(hi-start)/tau))
            channel_outputs.append(min(sat,max(0.,area/p['averagingSeconds'])))
        outputs.append(channel_outputs)
    errors=[]
    for tick_index,tick in enumerate(run['ticks']):
        if 'readout' in tick:
            errors.extend(abs(tick['readout'][ch]-outputs[ch][tick_index]) for ch in range(4))
    return errors

runs=[load(i) for i in range(36)];replay_errors=[];total_ticks=total_readouts=0
for i,run in enumerate(runs):
    assert run['row']['index']==i and run['spec']==manifest['cases'][i]
    dt=run['spec']['dt'];position=run['spec']['position']
    assert len(run['ticks'])==round(manifest['durationSeconds']/dt)
    for j,tick in enumerate(run['ticks']):
        assert math.isclose(tick['time'],j*dt,rel_tol=0,abs_tol=1e-12)
        assert len(tick['trueInlets'])==4 and all(math.isfinite(x) and x>=0 for x in tick['trueInlets'])
        assert ('readout' in tick)==(j%round(run['config']['localInletSampling']['sampleIntervalSeconds']/dt)==0)
    assert run['config']['robotStartPositionOverride']==position and run['config']['physicalAtmosphere']['measurement']['noiseKgPerCubicMetre']==0 and run['config']['sensorNoise']==0
    errors=replay(run);replay_errors.extend(errors);total_ticks+=len(run['ticks']);total_readouts+=sum('readout' in t for t in run['ticks'])

comparisons=[];forcing_errors=[]
for pose in range(9):
    selected={r['spec']['dt']:r for r in runs if r['spec']['pose']==pose};fine=selected[manifest['referenceDt']]
    fine_clock={t['time']:t for t in fine['ticks'] if 'readout' in t}
    rms_by_dt={}
    for dt in (.25,.125,.0625):
        run=selected[dt];pairs=[]
        for tick in run['ticks']:
            if 'readout' not in tick or tick['time']<manifest['warmupSeconds']:continue
            reference=fine_clock[tick['time']]
            forcing_errors.extend(abs(a-b) for a,b in zip(tick['trueInlets'],reference['trueInlets']))
            pairs.append((tick['time'],sum(tick['readout'])/4,sum(reference['readout'])/4))
        differences=[a-b for _,a,b in pairs];rms=math.sqrt(sum(x*x for x in differences)/len(differences));rms_by_dt[dt]=rms
        windows=[]
        for start in manifest['windowStarts']:
            values=[(a,b) for time,a,b in pairs if start<=time<start+manifest['windowSeconds']]
            difference=abs(median([a for a,_ in values])-median([b for _,b in values]))
            windows.append({'start':start,'samples':len(values),'medianDifferenceC0':difference,'pass':difference<=manifest['tolerances']['windowMedianC0']})
        comparisons.append({'pose':pose,'dt':dt,'matchedReadouts':len(pairs),'maximumDifferenceC0':max(map(abs,differences)),'rmsDifferenceC0':rms,'windows':windows,'passedWindows':sum(w['pass'] for w in windows),'allWindowsPass':all(w['pass'] for w in windows)})
    monotonic=rms_by_dt[.25]>=rms_by_dt[.125]>=rms_by_dt[.0625]
    for c in comparisons:
        if c['pose']==pose:c['poseRmsMonotonic']=monotonic

body={'counts':{'runs':len(runs),'ticks':total_ticks,'readouts':total_readouts,'channelReadouts':len(replay_errors)},'maximumIndependentReplayErrorC0':max(replay_errors),'replayPass':max(replay_errors)<=manifest['tolerances']['engineReplayC0'],'maximumClockTimeForcingDifferenceC0':max(forcing_errors),'clockForcingPass':max(forcing_errors)<=manifest['tolerances']['clockForcingC0'],'comparisons':comparisons,'passedWindows':sum(c['passedWindows'] for c in comparisons),'totalWindows':sum(len(c['windows']) for c in comparisons),'allWindowsPass':all(c['allWindowsPass'] for c in comparisons),'monotonicPoses':sum(c['poseRmsMonotonic'] for c in comparisons if c['dt']==.25),'totalPoses':9}
OUT.mkdir();(OUT/'audit.json').write_text(json.dumps(body,indent=2)+'\n');(OUT/'si-pulse-interface-isolation-audit.py').write_bytes(Path(__file__).read_bytes());(OUT/'complete.json').write_text(json.dumps({'complete':True,'auditSha256':sha(OUT/'audit.json'),'sourceSha256':sha(OUT/'si-pulse-interface-isolation-audit.py')})+'\n')
print(json.dumps({k:v for k,v in body.items() if k!='comparisons'}))
