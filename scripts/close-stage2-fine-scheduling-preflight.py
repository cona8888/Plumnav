#!/usr/bin/env python3
"""Close accepted local compatibility evidence and record a planning-only estimate."""
import hashlib
import json
from pathlib import Path


def digest(path):
    with Path(path).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def read(path):return json.loads(Path(path).read_text())


def main():
    root=Path('research/evidence/si_fine_scheduling_preflight_2026-09-17')
    out=Path('research/results/si_fine_scheduling_preflight_2026-09-17')
    m=read(root/'manifest.json');done=read(root/'complete.json');a=read(out/'analysis.json');ad=read(out/'complete.json')
    assert done['complete'] and not done['failures'] and done['manifestSha256']==digest(root/'manifest.json')==a['manifestSha256']
    assert ad['complete'] and a['integrityPassed'] and a['compatibilityPassed'] and a['performance'] is None
    assert ad['analysisSha256']==digest(out/'analysis.json')
    assert len(done['workers'])==4 and all(w['status']=='fulfilled' and w['value']['code']==0 for w in done['workers'])
    for s in m['sources']:
        assert digest(s['file'])==s['sha256'],s['file']
        assert digest(root/'source-snapshot'/s['name'])==s['sha256']
    prior=Path('research/evidence/si_linear_fresh_2026-09-17/manifest.json')
    prior_analysis=Path('research/results/si_linear_fresh_2026-09-17/analysis.json')
    assert digest(prior)==m['priorManifestSha256'] and digest(prior_analysis)==m['priorAnalysisSha256']
    assert digest(prior_analysis)=='ba4955e41e20574f18f0d7a14ece9097860e541070fb565aacd7fa73f67e9c99'
    assert digest('research/results/si_turn_fresh_2026-09-17/analysis.json')=='b59a5cc5ef4ca697932719e0515a6976a355325f09e1317b14fa2c3b2298341e'
    items=[];max_rss=0
    for w in range(4):
        d=root/f'worker-{w}';wd=read(d/'complete.json');assert wd['complete'] and len(wd['inventory'])==1
        item=wd['inventory'][0];assert item['index']%4==w and digest(d/item['file'])==item['sha256']
        assert item['compatibility']['passed'] and digest(item['compatibility']['referenceFile'])==item['compatibility']['referenceSha256']
        assert item['replay']['passed'] and item['replay']['schedulingTraceMatched'] and item['replay']['privateFieldQueries']==0
        items.append(item);max_rss=max(max_rss,wd['maxRssBytes'])
    assert sorted(i['index'] for i in items)==[2,5,8,11]
    cases=m['campaignCases'];assert len(cases)==288 and [s['index'] for s in cases]==list(range(288))
    assert sum(s['caseRole']=='primary' for s in cases)==192
    assert all(s['navDt']==1/64 for s in cases if s['caseRole']=='primary')
    assert all(s['worldIndex'] in [0,5,10,15] for s in cases if s['caseRole']=='resolution-witness')
    assert not Path('research/evidence/si_fine_scheduling_campaign_2026-09-17').exists()
    old=read(prior_analysis);rows=[r for r in old['runs'] if r['spec']['navDt']==1/64]
    mean_duration=sum(r['summary']['completedAt'] for r in rows)/len(rows)
    simulation_rate=max(i['simulationSeconds']/i['summary']['completedAt'] for i in items)
    overhead=max(i['elapsedSeconds']-i['simulationSeconds'] for i in items)
    benchmark_duration=sum(i['summary']['completedAt'] for i in items)/4
    fine_equivalent=192+48*.5+48*.25
    estimates=[]
    for label,duration in [('previous-four-world-duration-proxy',mean_duration),('all-missions-at-1200-seconds-scenario',1200.)]:
        sim=simulation_rate*duration*fine_equivalent/4+overhead*288/4
        audit=a['elapsedSeconds']/benchmark_duration*duration*fine_equivalent/4
        raw=max(i['bytes']/i['summary']['completedAt'] for i in items)*duration*fine_equivalent
        estimates.append(dict(label=label,simulatedMissionSeconds=duration,simulationMinutes=sim/60,auditMinutes=audit/60,totalMinutes=(sim+audit)/60,with25PercentHeadroomMinutes=(sim+audit)*1.25/60,with50PercentHeadroomMinutes=(sim+audit)*1.5/60,projectedRawBytes=raw))
    result=dict(schemaVersion='si-fine-scheduling-local-preflight-closure-v1',provenancePassed=True,compatibilityPassed=True,integrityPassed=True,sourceCount=len(m['sources']),cases=4,frozenCampaignCases=288,primaryCampaignCases=192,witnessTriplets=48,campaignLaunched=False,awsLaunched=False,
                manifestSha256=digest(root/'manifest.json'),analysisSha256=digest(out/'analysis.json'),scriptSha256=digest(__file__),concurrencyWitnessSha256=digest(root/'concurrency-witness.md'),
                simulationWallSeconds=done['elapsedSeconds'],auditWallSeconds=a['elapsedSeconds'],maxSampledWorkerRssBytes=max_rss,rawBytes=sum(i['bytes'] for i in items),counts=a['counts'],
                simulationSecondsByCase={i['index']:i['simulationSeconds'] for i in items},runtimePlanning=dict(fineEquivalentMissions=fine_equivalent,maximumSimulationSecondsPerSimulatedSecond=simulation_rate,maximumPostSimulationSecondsPerCase=overhead,estimates=estimates,
                limitations='Planning heuristic, not measured scaling or a guaranteed bound. Uses linear mesh-cost weights 1, 0.5, 0.25; fixed controller costs and different paths can invalidate scaling. Retains all observed post-simulation overhead, including compatibility-only comparison work, as conservative allowance. Previous four-world durations are a proxy, not new-case outcomes. Long-mission scenario is not a rigorous worst-case bound. AWS throughput must be measured separately.'),decision='Pause before campaign launch; recommend durable managed AWS execution after packaging, same-environment smoke, current pricing and authorization.',performance=None)
    path=Path('research/results/si_fine_scheduling_preflight_closure_2026-09-17.json')
    with path.open('x') as f:json.dump(result,f,indent=2,allow_nan=False);f.write('\n')
    print(json.dumps(result,indent=2))


if __name__=='__main__':main()
