"""V2 independent fixture objects; the endpoint implementation remains frozen."""
import argparse
import copy
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
from lib.si_release_endpoint_v1 import endpoint,refinement_check

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    old=Path('research/results/si_release_endpoint_stability_v1_attempt01_2026-09-24')
    sources=[Path(__file__),Path('scripts/test-si-release-endpoint-v1.py'),Path('scripts/lib/si_release_endpoint_v1.py'),Path('research/protocols/si_release_endpoint_stability_v1_2026-09-24.md'),Path('research/protocols/si_release_endpoint_fixture_v2_2026-09-24.md'),old/'manifest.json',old/'failure.json']
    assert sha(sources[2])=='fe5f8dd86f1bb9ab78b793603ad9d6abce3b60312380f04ada386e5e939f9ecf'
    original=json.loads((old/'manifest.json').read_text())
    for row in original['sources']:assert sha(Path(row['path']))==row['sha256']
    assert not (old/'acceptance.json').exists()
    pins=[dict(path=str(p),sha256=sha(p)) for p in sources];a.output.mkdir(parents=True,exist_ok=False)
    def write(name,r):
        with (a.output/name).open('x') as f:json.dump(r,f,indent=2);f.write('\n')
    write('manifest.json',dict(version='release-endpoint-synthetic-v2',createdAt=datetime.now(timezone.utc).isoformat(),sources=pins,syntheticOnly=True,newMissions=0))
    counts={'validEndpoints':0,'invalidEndpointsRejected':0,'validWitnessChecks':0,'invalidWitnessesRejected':0}
    try:
        base=dict(auditPassed=True,field='si-continuous',stage='inspection-complete',nominationPresent=True,nominalStatus='supported',reportedPointPresent=True,sourceErrorMetres=.10)
        def valid(meta,wanted):
            assert endpoint(meta)==wanted;counts['validEndpoints']+=1
        def invalid(meta):
            try:endpoint(meta)
            except (ValueError,TypeError):counts['invalidEndpointsRejected']+=1;return
            raise AssertionError('Invalid endpoint accepted')
        for error,success in [(0.,True),(.099,True),(.1,True),(.101,False),(.2,False)]:
            valid({**base,'sourceErrorMetres':error},dict(applicable=True,success=success,category='within-tolerance-report' if success else 'out-of-tolerance-report'))
        abstained={**base,'nominalStatus':'abstained','reportedPointPresent':False,'sourceErrorMetres':None}
        incomplete={**abstained,'stage':'mission-budget-exhausted','nominalStatus':None}
        no_nom={**incomplete,'stage':'no-eligible-nomination','nominationPresent':False}
        for meta,category in [(abstained,'verifier-abstained'),(incomplete,'inspection-incomplete'),(no_nom,'no-nomination')]:valid(meta,dict(applicable=True,success=False,category=category))
        blank={**no_nom,'field':'blank'};valid(blank,dict(applicable=False,success=None,category='blank-not-applicable'))
        for change in [dict(auditPassed=False),dict(auditPassed=1),dict(field='urban'),dict(stage='failed'),dict(nominationPresent=1),dict(reportedPointPresent=1),dict(nominalStatus=None),dict(nominalStatus='rejected'),dict(sourceErrorMetres=None),dict(sourceErrorMetres=-1),dict(sourceErrorMetres=float('nan')),dict(sourceErrorMetres=float('inf')),dict(sourceErrorMetres=True),dict(nominalStatus='abstained'),dict(reportedPointPresent=False),dict(stage='mission-budget-exhausted'),dict(stage='no-eligible-nomination'),dict(field='blank')]:invalid({**base,**change})
        missing=dict(base);missing.pop('auditPassed');invalid(missing);invalid({**base,'unexpected':0})
        def witness(metas,parent=True):
            rows=[dict(worldKey='artificial-world',arm='GL',navDt=dt,endpoint=copy.deepcopy(m)) for dt,m in zip(['1/16','1/32','1/64'],metas)]
            assert len({id(r['endpoint']) for r in rows})==3
            return dict(parentNumericalPassed=parent,resolutions=rows)
        shared=copy.deepcopy([base]*3);assert shared[0] is shared[1] is shared[2]
        isolated=witness([base]*3);isolated['resolutions'][1]['endpoint']['field']='si-pulse'
        assert [r['endpoint']['field'] for r in isolated['resolutions']]==['si-continuous','si-pulse','si-continuous']
        fixtures=[]
        for name,metas,parent,expected in [
          ('stable-success',[base]*3,True,True),('stable-failure',[abstained]*3,True,True),
          ('threshold-crossing',[{**base,'sourceErrorMetres':x} for x in [.098,.099,.101]],True,False),
          ('failed-parent',[base]*3,False,False),('blank-not-localisation',[blank]*3,True,True)]:
            result=refinement_check(witness(metas,parent));assert result['passed']==expected
            if name=='threshold-crossing':assert not result['endpointStable'] and result['parentNumericalPassed']
            if name=='blank-not-localisation':assert not result['localisationApplicable'] and all(s['success'] is None for s in result['states'])
            fixtures.append(dict(name=name,result=result));counts['validWitnessChecks']+=1
        def reject(change):
            w=witness([base]*3);change(w)
            try:refinement_check(w)
            except (ValueError,TypeError):counts['invalidWitnessesRejected']+=1;return
            raise AssertionError('Invalid witness accepted')
        reject(lambda w:w.update(parentNumericalPassed=1));reject(lambda w:w.update(unexpected=1))
        reject(lambda w:w['resolutions'].pop());reject(lambda w:w['resolutions'].reverse())
        reject(lambda w:w['resolutions'][1].update(worldKey='different'));reject(lambda w:w['resolutions'][1].update(arm='NS'))
        reject(lambda w:w['resolutions'][1]['endpoint'].update(field='si-pulse'));reject(lambda w:w['resolutions'][1].pop('worldKey'))
        assert counts==dict(validEndpoints=9,invalidEndpointsRejected=20,validWitnessChecks=5,invalidWitnessesRejected=8)
        for row in pins:assert sha(Path(row['path']))==row['sha256']
        write('fixtures.json',fixtures)
        receipt=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),counts=counts,aliasRegressionPassed=True,manifestSha256=sha(a.output/'manifest.json'),fixturesSha256=sha(a.output/'fixtures.json'),syntheticOnly=True,realHistoriesRead=0,newMissions=0,legacyAcceptanceChanged=False,v1FailurePreserved=True,endpointImplementationUnchanged=True,freshCampaignAdmitted=False,remaining='Future runner must bind compact metadata to independently audited histories and source/receipt hashes')
        write('acceptance.json',receipt);print(json.dumps(receipt))
    except BaseException as error:
        write('failure.json',dict(passed=False,error=repr(error),createdAt=datetime.now(timezone.utc).isoformat(),counts=counts,newMissions=0));raise

if __name__=='__main__':main()
