#!/usr/bin/env python3
"""All-history independent acceptance for same-source smoke/fresh budget campaign."""
import argparse
from datetime import datetime,timezone
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import time
from lib.outdoor_budget_quadrature_v2 import independent_concentration
from lib.outdoor_budget_statistics import summarise

spec=importlib.util.spec_from_file_location('development',Path(__file__).with_name('audit-outdoor-budget.py'))
development=importlib.util.module_from_spec(spec);spec.loader.exec_module(development)
read,sha,require=development.read,development.sha,development.require
VERSION='outdoor-mission-budget-campaign-v1'
CAMPAIGN=dict(version=VERSION,worlds=[2000,2127],witnessWorlds=[2000,2042,2085,2127],
    primaryHistories=512,totalHistories=544,primaryOutcomes=4096,independentWorlds=128,workers=4,maxRuntimeSeconds=3600,
    primary=dict(wind=.5,speed=1,sensor='generic-sigma0.2-tau0.5',rateKgPerSecond=1e-4,
        endpoints=['additional-detection','additional-blank-alarm'],direction='full-minus-600s',
        interval='Clopper-Pearson-97.5-percent-per-endpoint',familyCoverage=.95),
    paidLaunchAuthorized=False,physicalValidation=False)


def expected_specs(mode):
    require(mode in ['smoke','campaign'],'Unknown mode')
    return [dict(world=w,wind=u,speed=v,resolution=r) for w in ([200] if mode=='smoke' else range(2000,2128))
            for u in [.5,2] for v in [.5,1] for r in ([0,1,2] if mode=='campaign' and w in CAMPAIGN['witnessWorlds'] else [0])]


def guards(root,m):
    for r in m['sourceHashes']:
        require(sha(r['file'])==r['sha256']==sha(root/'source-snapshot'/r['file']),'Frozen source changed')
    link=m['development'];raw=Path(link['rawDirectory']);review=Path(link['reviewDirectory'])
    c=read(review/'closure.json')
    require(c['accepted'] and c['auditSha256']=='6851cf735de73586d03d9313a6975684ad6730c4b4703b151a0ba762bd028672','Development acceptance')
    require(sha(review/'closure.json')==link['reviewClosureSha256'] and sha(review/'audit.json')==c['auditSha256'],'Development review integrity')
    require(sha(review/'manifest.json')==c['manifestSha256'],'Development review manifest')
    require(sha(raw/'manifest.json')==link['rawManifestSha256']==c['inputManifestSha256'],'Development raw manifest')
    require(sha(raw/'execution-complete.json')==link['rawExecutionSha256']==c['inputExecutionSha256'],'Development receipts')
    require(sha(raw/'audit.failed.json')==c['preservedFailedAuditSha256'],'Prior failure changed')
    development.verify_frozen(read(raw/'manifest.json'),raw)
    for r in read(raw/'execution-complete.json')['files']:
        require(sha(raw/r['file'])==r['sha256'],'Development raw history changed')
        if r['reference']:require(sha(raw/r['reference']['file'])==r['reference']['sha256'],'Development legacy reference changed')
    if m['mode']=='campaign':
        s=m['smokeEvidence'];smoke=Path(s['directory']);c=read(smoke/'closure.json');a=read(smoke/'audit.json')
        require(c['accepted'] and sha(smoke/'closure.json')==s['closureSha256'],'Smoke closure')
        require(sha(smoke/'audit.json')==s['auditSha256']==c['auditSha256'],'Smoke audit hash')
        require(a['accepted'] and a['mode']=='smoke' and a['compatibilityPassed'] and a['maxConcurrentWorkers']==4,'Smoke admissions')
        require(sha(smoke/'manifest.json')==a['manifestSha256']==c['manifestSha256'],'Smoke manifest hash')
        require(read(smoke/'manifest.json')['sourceHashes']==m['sourceHashes'],'Not same-source smoke')
        require(sha(smoke/'execution-complete.json')==a['executionReceiptSha256'],'Smoke execution integrity')
        for r in read(smoke/'execution-complete.json')['files']:require(sha(smoke/r['file'])==r['sha256'],'Smoke history changed')
    else:require(m['smokeEvidence'] is None,'Unexpected smoke link')


def witness_checks(traces):
    results=[]
    for w in CAMPAIGN['witnessWorlds']:
        # Normalise the lookup index only for the frozen development triplet
        # routine. Actual worlds, fields, histories and decisions stay unchanged.
        indexed=[dict(t,spec=dict(t['spec'],world=200)) for t in traces if t['spec']['world']==w]
        results.extend(dict(r,world=w) for r in development.resolution_checks(indexed))
    require(len(results)==16,'Witness count')
    return results


def digest(value):
    return hashlib.sha256(json.dumps(value,separators=(',',':')).encode()).hexdigest()


def audit(root):
    m,complete=read(root/'manifest.json'),read(root/'execution-complete.json');mode=m['mode']
    expected=expected_specs(mode);count=len(expected)
    require(m['schemaVersion']==VERSION and m['campaign']==CAMPAIGN,'Campaign design changed')
    require(m['baseDesign']==development.pilot.EXPECTED_DESIGN and m['developmentDesign']==development.BUDGET,'Physical contract changed')
    require(m['specs']==expected,'Cases changed')
    require(complete['executionComplete'] and not complete['independentlyAccepted'] and not (root/'failure.json').exists(),'Incomplete/failed execution')
    require(complete['manifestSha256']==sha(root/'manifest.json') and complete['eventLogSha256']==sha(root/'execution-events.jsonl'),'Execution integrity')
    guards(root,m)
    require(len(complete['files'])==count and sorted(p.name for p in root.glob('trace-*.json.gz'))==[f'trace-{i:03d}.json.gz' for i in range(count)],'Output inventory')
    require(len(complete['exits'])==4 and all(x['code']==0 for x in complete['exits']) and len({x['pid'] for x in complete['exits']})==4,'Worker exits')
    checks=[];compact=[];witnesses=[];blanks={};prefixes={}
    previous=development.pilot.independent_concentration
    development.pilot.independent_concentration=independent_concentration
    try:
        for i,(receipt,setting) in enumerate(zip(complete['files'],expected)):
            require(receipt['index']==i and receipt['file']==f'trace-{i:03d}.json.gz','Receipt index')
            file=root/receipt['file']
            require(sha(file)==receipt['sha256'] and file.stat().st_size==receipt['bytes'],'History hash/bytes')
            require(read(root/f'trace-{i:03d}.receipt.json')==receipt,'Receipt copy')
            require(receipt['pid'] in {r['pid'] for r in complete['exits']} and receipt['endedMs']>receipt['startedMs'] and receipt['userCpuMicroseconds']>100000,'Worker CPU/time')
            require(receipt['compatibilityPassed']==(mode=='smoke'),'Compatibility receipt')
            t=json.loads(gzip.decompress(file.read_bytes()))
            require(t['schemaVersion']==VERSION and t['spec']==setting,'Trace identity')
            normalised=dict(t,schemaVersion=development.VERSION)
            checks.append(development.check_trace(normalised,setting))
            if mode=='smoke':
                index=[0,3,6,9][i]
                old=json.loads(gzip.decompress((Path(m['development']['rawDirectory'])/f'trace-{index:03d}.json.gz').read_bytes()))
                require(normalised==old,'Full-history development compatibility')
            if setting['world'] in CAMPAIGN['witnessWorlds']:witnesses.append(normalised)
            compact.append(dict(spec=t['spec'],measurements=[{k:v for k,v in x.items() if k!='readings'} for x in t['measurements']]))
            bk=(setting['world'],setting['speed'],setting['resolution']);bh=digest(t['measurements'][:2])
            require(bk not in blanks or blanks[bk]==bh,'Blank depends on wind');blanks[bk]=bh
            pk=(setting['world'],setting['resolution']);ph=digest([x['readings'][:600] for x in t['measurements'][:2]])
            require(pk not in prefixes or prefixes[pk]==ph,'Blank prefix depends on route');prefixes[pk]=ph
            if (i+1)%16==0 or i+1==count:print(f'audited {i+1}/{count}',flush=True)
        triplets=witness_checks(witnesses) if mode=='campaign' else []
    finally:development.pilot.independent_concentration=previous
    overlap=development.holdout.max_overlap(complete['files']);require(overlap==4,'Four-worker overlap absent')
    guards(root,m)
    result=dict(schemaVersion='outdoor-budget-campaign-audit-v1',mode=mode,accepted=True,
        checkedAt=datetime.now(timezone.utc).isoformat(),manifestSha256=sha(root/'manifest.json'),
        executionReceiptSha256=sha(root/'execution-complete.json'),rawHistories=count,
        primaryHistories=sum(x['resolution']==0 for x in expected),independentWorldsPerSetting=1 if mode=='smoke' else 128,
        maxConcurrentWorkers=overlap,compatibilityPassed=mode=='smoke',checks=checks,resolutionTriplets=triplets,
        originalScientificFilesUnchanged=141,previousOutdoorSourceRecordsUnchanged=38,
        executionSeconds=complete['seconds'],physicalValidation=False,awsLaunched=False)
    if mode=='campaign':result['statistics']=summarise(compact)
    return result


def report(a):
    if a['mode']=='smoke':return '# Campaign-wrapper smoke\n\nFour complete histories match the accepted development traces exactly after schema-only normalisation. All independent physical/measurement checks and four-worker CPU/time overlap pass. No evaluation world used.\n'
    s=a['statistics'];lines=['# Fresh-world mission-budget comparison','',
        '**128 independent paired worlds; 512 primary histories; 16 resolution triplets; 544 audited histories.**',
        '4096 primary outcomes are paired sensor/budget variants, not independent replicates.','',
        '## Prespecified primary contrasts','',
        'Wind 0.5 m/s, speed 1 m/s, noise SD 0.2 ppm, rise tau 0.5 s, k=5; 600 s versus full-route 1026 s.','']
    for p in s['primary']:
        lines.append(f'- {p["endpoint"]}: {p["lateAlarms"]}/128 late-only alarms; full-minus-short {100*p["difference"]:.3f} percentage points; exact 97.5% interval {100*p["interval975"][0]:.3f} to {100*p["interval975"][1]:.3f} pp.')
    lines+=['',s['intervalMethod'],'','## All factor cells','',
        'Emission is 0.1 g/s; blank is zero emission. Counts /128. Other cells are descriptive.','',
        '| Wind m/s | Speed m/s | Rise tau s | 600 s alarms | Full-route alarms | 600 s blank | Full-route blank | Full budget s |',
        '|---|---|---|---|---|---|---|---|']
    for r in s['groups']:
        if not r['rateKgPerSecond']:continue
        blank=next(x for x in s['groups'] if x['wind']==r['wind'] and x['speed']==r['speed'] and x['sensor']==r['sensor'] and x['rateKgPerSecond']==0)
        lines.append(f'| {r["wind"]:g} | {r["speed"]:g} | {r["sensor"].split("tau")[1]} | '+
            ' | '.join(str(x['alarms']) for x in r['budgets']+blank['budgets'])+f' | {r["budgets"][1]["budgetSeconds"]} |')
    lines+=['','## Interpretation boundary','',
        'Longer observation cannot remove an alarm in an identical prefix; the question is how many additional events and blank alarms accrue. Equal full-route distance does not equalise time, source age or sample count. No threshold was tuned on these worlds.',
        'Restricted means and all pointwise intervals/world memberships are in audit.json. Unequal-cap means are not an unqualified efficiency metric. No universal minimum emission rate, source localisation, physical device validation, urban/UAV behaviour or coupled soil-to-air claim.',
        'The prior reference-integrator correction is preserved and disclosed in the development admission. No simulator, physical parameter or acceptance tolerance changed for this evaluation.',
        f'Execution {a["executionSeconds"]:.1f} s; audit {a["auditSeconds"]:.1f} s. Four local worker processes. No AWS action.']
    return '\n'.join(lines)+'\n'


def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);args=p.parse_args();root=args.input
    require(not (root/'audit.json').exists(),'Audit already exists');start=time.perf_counter()
    try:result=audit(root)
    except Exception as error:
        with (root/'audit.failed.json').open('x') as f:json.dump(dict(accepted=False,diagnosticOnly=True,error=str(error)),f,indent=2)
        raise
    result['auditSeconds']=time.perf_counter()-start
    with (root/'audit.json').open('x') as f:json.dump(result,f,indent=2,allow_nan=False);f.write('\n')
    with (root/'report.md').open('x') as f:f.write(report(result))
    with (root/'closure.json').open('x') as f:json.dump(dict(accepted=True,mode=result['mode'],
        manifestSha256=sha(root/'manifest.json'),auditSha256=sha(root/'audit.json'),reportSha256=sha(root/'report.md'),
        executionReceiptSha256=sha(root/'execution-complete.json'),physicalValidation=False,awsLaunched=False),f,indent=2)
    print(json.dumps({k:v for k,v in result.items() if k not in ['checks','resolutionTriplets','statistics']}))


if __name__=='__main__':main()
