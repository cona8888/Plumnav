#!/usr/bin/env python3
"""Independent development admission for continuous extended prescribed surveys."""
import argparse
from datetime import datetime, timezone
import gzip
import importlib.util
import json
from pathlib import Path
import time
import numpy as np

spec = importlib.util.spec_from_file_location('holdout', Path(__file__).with_name('audit-outdoor-holdout.py'))
holdout = importlib.util.module_from_spec(spec); spec.loader.exec_module(holdout)
pilot = holdout.pilot
require, read, sha = pilot.require, pilot.read, pilot.sha
VERSION = 'outdoor-mission-budget-development-v1'
BUDGET = dict(version=VERSION, pilotWorlds=[200,201,202,203], reservedWorldRange=[2000,2127],
    reservedWitnessWorlds=[2000,2042,2085,2127], shortSeconds=600, ratesKgPerSecond=[0,1e-4],
    noisePpm=.2, k=5, backgroundDriftDenominatorSeconds=600, workers=4,
    maxRuntimeSeconds=1800, campaignEnabled=False, paidLaunchAuthorized=False)


def expected_specs():
    return [dict(world=w,wind=u,speed=v,resolution=r) for w in range(200,204)
            for u in [.5,2] for v in [.5,1] for r in ([0,1,2] if w==200 else [0])]


def duration(speed):
    require(speed in [.5,1], 'Unknown speed')
    return int(990/speed + 36)


def check_outcomes(measurement, computed, speed):
    expected=[]
    for budget in [600,duration(speed)]:
        at=pilot.alarm(computed[:budget],3.)
        _,dist=pilot.route_at(np.array([budget],dtype=float),speed)
        expected.append(dict(budgetSeconds=budget,alarmSeconds=at,
            restrictedTimeSeconds=budget if at is None else at,distanceMetres=float(dist[0])))
    require(measurement['outcomes']==expected,'Budget alarm/time/distance mismatch')
    require(expected[0]['alarmSeconds'] is None or expected[1]['alarmSeconds']==expected[0]['alarmSeconds'],'Non-monotone prefix decision')


def check_trace(trace, setting):
    require(trace['schemaVersion']==VERSION and trace['spec']==setting,'Trace identity')
    w=pilot.expected_world(setting['world']); require(trace['world']==w,'World/seed')
    res=pilot.EXPECTED_DESIGN['resolutions'][setting['resolution']]
    require(trace['resolution']==res,'Resolution'); dt=res['dt']; end=duration(setting['speed'])
    require(trace['durationSeconds']==end,'Mission duration')
    field=dict(source=w['source'],wind=dict(x=setting['wind'],y=0),diffusivity=.2,sigma=.25,
        rateKgPerSecond=1e-5,panelSeconds=res['panel'])
    require(trace['fieldSettings']==field,'Field settings')
    require(abs(trace['ppmPerKgM3']-1e6*8.314462618*298.15/(101325*.01604))<1e-8,'PPM conversion')
    rows=trace['inlet']; require(len(rows)==round(end/dt),'Inlet count')
    values=np.array([[r[k] for k in ['t','x','y','z','referenceExcessPpm','backgroundPpm']] for r in rows])
    require(np.isfinite(values).all() and (values[:,4:]>=0).all(),'Nonfinite/negative field')
    times=(np.arange(len(rows))+.5)*dt
    np.testing.assert_array_equal(values[:,0],times)
    positions,_=pilot.route_at(times,setting['speed'])
    np.testing.assert_allclose(values[:,1:4],positions,atol=1e-12,rtol=0)
    require(trace['distanceMetres']==990 and trace['routeLengthMetres']==990,'Route length')
    require(trace['endpoint']==dict(x=5,y=95,z=.05),'Route endpoint')
    background=2+w['backgroundOffsetPpm']+w['backgroundDriftPpm']*times/600
    np.testing.assert_allclose(values[:,5],background,atol=1e-14,rtol=0)
    noise=pilot.expected_noise(setting['world'],end)
    np.testing.assert_allclose(trace['noise'],noise,atol=1e-13,rtol=1e-13)
    peak=int(np.argmax(values[:,4])); prefix_peak=int(np.argmax(values[:round(600/dt),4]))
    indices=sorted({0,round(600/dt)-1,round(600/dt),len(rows)//2,len(rows)-1,
                    peak,max(0,peak-1),min(len(rows)-1,peak+1),prefix_peak})
    errors=[]
    for index in indices:
        reference=pilot.independent_concentration(rows[index],field,600+rows[index]['t'])
        error=abs(reference-rows[index]['referenceExcessPpm'])
        require(error<=1e-6+.001*abs(reference),f'Field quadrature {setting}/{index}: {error}')
        errors.append(error)
    probes=[(t,dx,dy) for t in [.125,600.125,end+.125] for dx,dy in [(0,0),(.25,0),(1,0),(0,.25)]]
    require(len(trace['sourceProbes'])==12,'Source probe count')
    for row,(t,dx,dy) in zip(trace['sourceProbes'],probes):
        require(row['t']==t and row['x']==w['source']['x']+dx and row['y']==w['source']['y']+dy and row['z']==.05,'Probe pose/time')
        reference=pilot.independent_concentration(row,field,600+t)
        error=abs(reference-row['referenceExcessPpm'])
        require(error<=1e-6+.001*abs(reference),'Source-proximal quadrature')
        errors.append(error)
    expected=[(q,s) for q in [0,1e-4] for s in pilot.models() if s['noisePpm']==.2]
    require(len(trace['measurements'])==4,'Measurement count')
    for m,(q,s) in zip(trace['measurements'],expected):
        require(m['sensor']==s and m['rateKgPerSecond']==q,'Sensor/rate changed')
        computed=pilot.replay(background+values[:,4]*(q/1e-5),dt,s,noise)
        np.testing.assert_allclose(m['readings'],computed,atol=2e-10,rtol=2e-12)
        check_outcomes(m,computed,setting['speed'])
    return dict(spec=setting,passed=True,independentFieldPoints=len(errors),maxFieldErrorPpm=max(errors))


def compatibility(trace, legacy):
    pilot.check_trace(legacy,trace['spec'])
    require(trace['inlet'][:round(600/trace['resolution']['dt'])]==legacy['inlet'],'Full inlet prefix differs')
    require(trace['noise'][:600]==legacy['noise'],'Noise prefix differs')
    require(trace['world']==legacy['world'] and trace['fieldSettings']==legacy['fieldSettings'],'Reference metadata')
    for m in trace['measurements']:
        old=next(x for x in legacy['measurements'] if x['rateKgPerSecond']==m['rateKgPerSecond'] and x['sensor']==m['sensor'])
        require(m['readings'][:600]==old['readings'],'Measurement prefix differs')
        require(m['outcomes'][0]['alarmSeconds']==next(x for x in old['outcomes'] if x['k']==5)['alarmSeconds'],'Legacy alarm changed')


def resolution_checks(traces):
    result=[]
    for wind in [.5,2]:
        for speed in [.5,1]:
            triple=[next(t for t in traces if t['spec']==dict(world=200,wind=wind,speed=speed,resolution=r)) for r in range(3)]
            worst=0.
            for coarse,fine,finest in zip(*(t['measurements'] for t in triple)):
                b,c=np.array(fine['readings']),np.array(finest['readings'])
                tolerance=max(.005*np.max(np.abs(c-2)),.01*finest['sensor']['noisePpm'])
                error=float(np.max(np.abs(b-c))); require(error<=tolerance,'Sensor convergence failed')
                worst=max(worst,error/tolerance)
                for candidate in [coarse,fine]:
                    for x,y in zip(candidate['outcomes'],finest['outcomes']):
                        tx,ty=x['alarmSeconds'],y['alarmSeconds']
                        require((tx is None)==(ty is None),'Budget decision changes under refinement')
                        require(tx is None or abs(tx-ty)<=1,'Budget alarm time unresolved')
            result.append(dict(wind=wind,speed=speed,passed=True,worstFineErrorToTolerance=worst))
    return result


def verify_frozen(manifest,root):
    for r in manifest['sourceHashes']:
        require(sha(r['file'])==r['sha256']==sha(root/'source-snapshot'/r['file']),'Source changed')
    for item in manifest['frozen']['roots']:
        base=Path(item['directory']); require(sha(base/'closure.json')==item['closureSha256'],'Prior closure changed')
        c=read(base/'closure.json'); require(c['accepted'],'Prior input unaccepted')
        for k,name in [('manifest','manifest.json'),('audit','audit.json'),('report','report.md')]:
            require(sha(base/name)==c[k+'Sha256'],'Prior closed artifact changed')
        if 'diagnosticsSha256' in c:
            require(sha(base/'diagnostics.json.gz')==c['diagnosticsSha256'] and sha(base/'summary.json')==c['summarySha256'],'Diagnostic changed')
        else:
            complete=read(base/'execution-complete.json')
            require(sha(base/'execution-complete.json')==read(base/'audit.json')['executionReceiptSha256'],'Prior receipt')
            for r in complete['files']:
                require(sha(base/r['file'])==r['sha256'],'Prior history changed')
    frozen=manifest['frozen']['stage2i']
    require(len(frozen['hashes'])==141 and sha(frozen['bundle'])==frozen['bundleSha256'],'Stage2i inventory')
    for r in frozen['hashes']:
        require(sha(r['file'])==r['sha256'],'Stage2i source changed')


def audit(root):
    manifest,complete=read(root/'manifest.json'),read(root/'execution-complete.json')
    require(manifest['schemaVersion']==VERSION and manifest['budget']==BUDGET and manifest['mode']=='development','Mode/settings')
    require(manifest['baseDesign']==pilot.EXPECTED_DESIGN and manifest['specs']==expected_specs(),'Base settings/cases')
    require(complete['executionComplete'] and not complete['independentlyAccepted'] and not (root/'failure.json').exists(),'Failed/incomplete execution')
    require(complete['manifestSha256']==sha(root/'manifest.json') and complete['eventLogSha256']==sha(root/'execution-events.jsonl'),'Execution integrity')
    verify_frozen(manifest,root)
    require(len(complete['files'])==24,'History count')
    require(sorted(p.name for p in root.glob('trace-*.json.gz'))==[f'trace-{i:03d}.json.gz' for i in range(24)],'History inventory')
    require(len(complete['exits'])==4 and all(r['code']==0 for r in complete['exits']) and len({r['pid'] for r in complete['exits']})==4,'Worker exits')
    traces=[]; checks=[]; refnames=[]
    for i,(receipt,setting) in enumerate(zip(complete['files'],expected_specs())):
        require(receipt['index']==i and receipt['file']==f'trace-{i:03d}.json.gz','Receipt index')
        require(sha(root/receipt['file'])==receipt['sha256'] and (root/receipt['file']).stat().st_size==receipt['bytes'],'History hash/bytes')
        require(read(root/f'trace-{i:03d}.receipt.json')==receipt,'Receipt copy')
        require(receipt['endedMs']>receipt['startedMs'] and receipt['userCpuMicroseconds']>100000 and receipt['pid'] in {r['pid'] for r in complete['exits']},'Actual worker CPU/time')
        trace=json.loads(gzip.decompress((root/receipt['file']).read_bytes()));checks.append(check_trace(trace,setting));traces.append(trace)
        if setting['resolution']==0:
            r=receipt['reference']; require(r and receipt['compatibilityPassed'],'Missing prefix compatibility')
            require(r['file']==f'reference-{i:03d}.json.gz' and sha(root/r['file'])==r['sha256'] and (root/r['file']).stat().st_size==r['bytes'],'Reference hash')
            compatibility(trace,json.loads(gzip.decompress((root/r['file']).read_bytes())));refnames.append(r['file'])
        else:
            require(receipt['reference'] is None and not receipt['compatibilityPassed'],'Unexpected legacy reference')
        print(f'audited extended {i+1}/24',flush=True)
    require(sorted(p.name for p in root.glob('reference-*.json.gz'))==sorted(refnames) and len(refnames)==16,'Reference inventory')
    overlap=holdout.max_overlap(complete['files']); require(overlap==4,'No four-worker overlap')
    for world in range(200,204):
        for speed in [.5,1]:
            pair=[t for t in traces if t['spec']['world']==world and t['spec']['speed']==speed and t['spec']['resolution']==0]
            require(pair[0]['measurements'][:2]==pair[1]['measurements'][:2],'Blank depends on wind')
        rows=[t for t in traces if t['spec']['world']==world and t['spec']['resolution']==0]
        for channel in [0,1]:
            require(all(t['measurements'][channel]['readings'][:600]==rows[0]['measurements'][channel]['readings'][:600] for t in rows),'Blank prefix pairing')
    triples=resolution_checks(traces)
    primary_means=[]
    for wind in [.5,2]:
        for speed in [.5,1]:
            values=[r['extendedSeconds'] for r,s in zip(complete['files'],expected_specs()) if s['resolution']==0 and s['wind']==wind and s['speed']==speed]
            primary_means.append(dict(wind=wind,speed=speed,meanSeconds=float(np.mean(values)),maxSeconds=max(values)))
    # Conservative maximum observed primary throughput per cell; witness times are
    # measured for one world and multiplied by the four prospectively reserved ones.
    primary_work=sum(r['maxSeconds']*128 for r in primary_means)
    witness_work=sum(r['extendedSeconds'] for r,s in zip(complete['files'],expected_specs()) if s['resolution']>0)*4
    projected_compute=(primary_work+witness_work)/4
    verify_frozen(manifest,root)
    return dict(schemaVersion='outdoor-budget-development-audit-v1',accepted=True,developmentOnly=True,
        checkedAt=datetime.now(timezone.utc).isoformat(),rawExtendedHistories=24,legacyReferenceHistories=16,
        primaryHistories=16,primaryOutcomes=128,independentDevelopmentWorlds=4,reservedEvaluationWorldsUsed=0,
        compatibilityPassed=True,maxConcurrentWorkers=overlap,resolutionTriplets=triples,checks=checks,
        originalScientificFilesUnchanged=141,priorOutdoorSourcesUnchanged=23,
        executionSeconds=complete['seconds'],primaryTimingCells=primary_means,
        projectedCampaignComputeSeconds=projected_compute,
        projectionBoundary='Four-worker measured maximum primary-cell time plus four times pilot refinement work; new-world complexity/scheduling remains uncertain.',
        manifestSha256=sha(root/'manifest.json'),executionReceiptSha256=sha(root/'execution-complete.json'),
        physicalValidation=False,paidLaunchAuthorized=False,campaignEnabled=False)


def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);args=p.parse_args();root=args.input
    require(not (root/'audit.json').exists(),'Audit already exists');start=time.perf_counter()
    try:
        result=audit(root)
    except Exception as error:
        with (root/'audit.failed.json').open('x') as out:json.dump(dict(accepted=False,diagnosticOnly=True,error=str(error)),out,indent=2)
        raise
    result['auditSeconds']=time.perf_counter()-start
    result['projectedCampaignAuditSeconds']=result['auditSeconds']*544/24
    result['projectedEndToEndWith25PercentHeadroomSeconds']=1.25*(result['projectedCampaignComputeSeconds']+result['projectedCampaignAuditSeconds'])
    with (root/'audit.json').open('x') as out:json.dump(result,out,indent=2,allow_nan=False);out.write('\n')
    with (root/'closure.json').open('x') as out:
        json.dump(dict(accepted=True,developmentOnly=True,manifestSha256=sha(root/'manifest.json'),
            auditSha256=sha(root/'audit.json'),executionReceiptSha256=sha(root/'execution-complete.json'),
            campaignEnabled=False,reservedEvaluationWorldsUsed=0,awsLaunched=False),out,indent=2)
    print(json.dumps({k:v for k,v in result.items() if k not in ['checks','resolutionTriplets','primaryTimingCells']}))


if __name__=='__main__':main()
