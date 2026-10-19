"""Independent source/provenance and integer-interval retention audit."""
import argparse
from datetime import datetime,timezone
import hashlib
import itertools
import json
import math
from pathlib import Path
import statistics

def load(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def near(a,b):assert math.isclose(a,b,rel_tol=1e-12,abs_tol=1e-12),(a,b)
def retained(first,last,k,phase):
    return max(0,(last-phase)//k-(-((phase-first)//k))+1)
def check_phase(row,reference):
    k=row['factor'];p=row['phase'];persistence=row['persistence'];n=reference['nativeSamples']
    assert k in (1,2,5,10,20,50) and 0<=p<k and persistence in (1,2)
    counts=[retained(x['firstIndex'],x['lastIndex'],k,p) for x in reference['excursions']]
    assert row['selectedSampleCount']==(0 if p>=n else (n-1-p)//k+1)
    assert row['retainedCountsByExcursion']==counts
    numerator=sum(x>=persistence for x in counts);denominator=len(counts)
    assert row['representedExcursions']==numerator and row['referenceExcursions']==denominator
    if denominator:near(row['retentionFraction'],numerator/denominator)
    else:assert row['retentionFraction'] is None

def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    # Check the independent closed form before touching measured outputs.
    for first,last in ((0,0),(1,2),(3,9),(50,51)):
        for k in (1,2,5,10,20,50):
            for phase in range(k):assert retained(first,last,k,phase)==len([i for i in range(first,last+1) if i%k==phase])
    manifest=load(a.input/'manifest.json');done=load(a.input/'complete.json');assert done['completed']
    for r in manifest['inputs']:assert sha(Path(r['path']))==r['sha256']
    for r in done['files']:assert sha(a.input/r['file'])==r['sha256']
    extraction=load(Path(next(r['path'] for r in manifest['inputs'] if r['path'].endswith('epa_workbook_structure.json'))))
    sheet=next(s for s in extraction['sheets'] if s['name']==manifest['sourceSheet'])
    source={c['cell']:c['value'] for row in sheet['rows'] for c in row['cells']}
    segments=load(a.input/'segments.json');ledger=load(a.input/'sample_ledger.json');blocks=load(a.input/'blocks.json')
    assert len(ledger)==7*(sheet['maxRow']-2)
    unique={(r['block'],r['sourceRow']) for r in ledger};assert len(unique)==len(ledger)
    admitted={b['block']:b['numericallyAdmitted'] for b in blocks}
    by_id={s['segmentId']:s for s in segments};assert len(by_id)==len(segments)
    used=set()
    for s in segments:
        samples=s['samples'];assert samples and admitted[s['block']]
        for i,r in enumerate(samples):
            assert r['sampleIndex']==i and r['segmentId']==s['segmentId'] and r['transectId']==s['transectId'] and r['valid']
            assert r['sourceRow']==samples[0]['sourceRow']+i
            for key,value_key in (('latitude','latitude'),('longitude','longitude'),('methane','methanePpmv')):
                assert r[value_key]==source[r['sourceCells'][key]]
            if 'transectId' in r['sourceCells']:assert r['transectId']==source[r['sourceCells']['transectId']]
            identity=(r['block'],r['sourceRow']);assert identity not in used;used.add(identity)
    expected={(r['block'],r['sourceRow']) for r in ledger if r['valid'] and admitted[r['block']]};assert used==expected
    for block in admitted:
        last=None
        for row in (r for r in ledger if r['block']==block):
            assert row['blockNumericallyAdmitted']==admitted[block]
            if not row['valid'] or not admitted[block]:last=None;continue
            if last and row['sourceRow']==last['sourceRow']+1 and (type(row['transectId']),row['transectId'])==(type(last['transectId']),last['transectId']):assert row['segmentId']==last['segmentId']
            last=row
    references=load(a.input/'reference_excursions.json');ref={r['referenceId']:r for r in references}
    assert len(ref)==len(references)==len(segments)*6
    for r in references:
        samples=by_id[r['segmentId']]['samples'];values=[s['methanePpmv'] for s in samples]
        background=statistics.quantiles(values,n=20,method='inclusive')[0] if len(values)>1 else values[0]
        near(r['backgroundPpmv'],background);assert r['thresholdPpmv'] in (.01,.05,.1,.5,1.,5.) and r['nativeSamples']==len(values)
        indices=[i for i,v in enumerate(values) if v-background>=r['thresholdPpmv']]
        bounds=[]
        for _,group in itertools.groupby(enumerate(indices),lambda pair:pair[1]-pair[0]):
            points=[value for _,value in group];bounds.append((points[0],points[-1]))
        assert [(e['firstIndex'],e['lastIndex']) for e in r['excursions']]==bounds
        assert all(e['firstSourceRow']==samples[e['firstIndex']]['sourceRow'] and e['lastSourceRow']==samples[e['lastIndex']]['sourceRow'] for e in r['excursions'])
    phases=load(a.input/'phase_results.json');phase_map={}
    for row in phases:
        key=(row['referenceId'],row['factor'],row['phase'],row['persistence']);assert key not in phase_map;phase_map[key]=row
        check_phase(row,ref[row['referenceId']])
    assert len(phases)==len(ref)*sum((1,2,5,10,20,50))*2
    summary=load(a.input/'summary.json');assert len(summary)==len(ref)*6*2
    summary_keys=set()
    for row in summary:
        key=(row['referenceId'],row['factor'],row['persistence']);assert key not in summary_keys;summary_keys.add(key)
        phases_for=[phase_map[(key[0],key[1],p,key[2])] for p in range(key[1])]
        assert row['phases']==key[1] and row['referenceExcursions']==len(ref[key[0]]['excursions'])
        assert sum(x['selectedSampleCount'] for x in phases_for)==ref[key[0]]['nativeSamples']
        fractions=[x['retentionFraction'] for x in phases_for]
        if row['referenceExcursions']:
            near(row['minimumRetention'],min(fractions));near(row['meanRetention'],statistics.fmean(fractions));near(row['maximumRetention'],max(fractions))
        else:assert row['minimumRetention'] is row['meanRetention'] is row['maximumRetention'] is None
    assert done['nativeSamples']==len(used) and done['phaseRows']==len(phases) and done['summaryRows']==len(summary)
    for r in manifest['inputs']:assert sha(Path(r['path']))==r['sha256']
    result=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),scriptSha256=sha(Path(__file__)),manifestSha256=sha(a.input/'manifest.json'),completeSha256=sha(a.input/'complete.json'),admittedBlocks=sum(admitted.values()),blockedBlocks=[k for k,v in admitted.items() if not v],segments=len(segments),sourceLinkedSamples=len(used),referenceDefinitions=len(ref),phaseRowsIndependentlyRecomputed=len(phases),summaryRowsChecked=len(summary),allPhaseCoverage=True,rawWorkbookUnchanged=True,sampleIndexOnly=True,hardwareValidation=False,leakGroundTruthAvailable=False)
    with a.output.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))

if __name__=='__main__':main()
