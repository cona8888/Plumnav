"""Independent metadata allocation/count checks and negative transport fixtures."""
import argparse
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from lib.si_mechanism_registry_v1 import Registry, validate


def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p):return json.loads(p.read_text())


def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);a=p.parse_args();out=a.root
    freshpath=out/'prospective_manifest.json';devpath=out/'development_manifest.json'
    f=Registry(freshpath,sha(freshpath));d=Registry(devpath,sha(devpath));inv=load(out/'historical_identity_inventory.json')
    # Independent loops, not the manifest generator: prove role counts/pairing/allocation.
    assert len(f.worlds)==128 and len(f.cases)==2400
    assert sum(c['spec']['caseRole']=='primary' for c in f.cases.values())==1920
    prior=set(inv['identities']);used=set(prior)
    for i,w in enumerate(f.document['worlds']):
        assert w['index']==i and w['replicate']==510000+i and w['reportingReplicate']==1110000+i
        for value in [w['replicate'],w['reportingReplicate']]: assert value not in used;used.add(value)
        for role in ('worldSeed','sourceSeed','startSeed','controllerSeed'):
            counter=0
            while True:
                h=hashlib.sha256(f'plumenav-mechanism-128-v1-20260925:{i}:{role}:{counter}'.encode()).hexdigest()
                value=int(h[:8],16);extra=[value,value+3000000] if role=='worldSeed' else [value]
                if all(0<x<4294967296 and x not in used for x in extra):break
                counter+=1
                assert counter<10000
            assert w[role]==value;used.update(extra)
        cells=[c for c in f.cases.values() if c['worldKey']==w['key']]
        assert len(cells)==(45 if i%8==0 else 15)
        for arm,policy in [('RW','reference'),('GW','encounter-gated'),('RL','reference'),('GL','encounter-gated'),('NS','reference')]:
            for field in ('si-continuous','si-pulse','blank'):
                rows=[c for c in cells if c['arm']==arm and c['spec']['field']==field]
                assert {c['spec']['navDt'] for c in rows}==({1/16,1/32,1/64} if i%8==0 else {1/64})
                assert all(c['spec']['policy']==policy for c in rows)
    rejected=0
    mutations=[lambda m:m.update(purpose='campaign-approved'),lambda m:m['cases'].pop(),
               lambda m:m['cases'].append(copy.deepcopy(m['cases'][0])),lambda m:m['worlds'][0].update(worldSeed=True),
               lambda m:m['worlds'][0].update(worldSeed=2**32),lambda m:m['worlds'][0].update(reportingReplicate=1),
               lambda m:m['cases'][0]['spec'].update(sourceSeed=123),lambda m:m['cases'][0]['spec'].update(policy='encounter-gated'),
               lambda m:m['cases'][0]['spec'].update(navDt=1/128),lambda m:m['cases'][0]['spec'].update(responseScale=2),
               lambda m:m['cases'][0]['spec'].update(sourcePosition={'x':.5,'y':.5}),lambda m:m['cases'][0].update(worldKey='unknown'),
               lambda m:m['cases'][0].update(arm='UNKNOWN'),lambda m:m.update(protocolSha256='0'*64)]
    for mutate in mutations:
        bad=copy.deepcopy(f.document);mutate(bad)
        try:validate(bad)
        except ValueError:rejected+=1
        else:raise AssertionError('Invalid contract admitted')
    try:Registry(freshpath,'0'*64)
    except ValueError:rejected+=1
    else:raise AssertionError('Wrong manifest pin accepted')
    spec=importlib.util.spec_from_file_location('mechanism_service',Path(__file__).with_name('si-mechanism-bridge-v1.py'))
    mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod);service=mod.Service(str(devpath),sha(devpath))
    c=d.document['cases'][0]
    # A real verifier abstention is valid; it is not fabricated support.
    request=dict(id=0,caseId=c['id'],operation='verify',reportingReplicate=603000,visits=[],motionContract=None)
    valid=service.handle(request);assert valid['arms'][0]['decision']['status']!='supported'
    for delta in ({'caseId':'unknown'},{'reportingReplicate':603001},{'sourcePosition':{'x':.5,'y':.5}},{'id':True},{'operation':'fake'}):
        try:service.handle(dict(request,**delta))
        except ValueError:rejected+=1
        else:raise AssertionError('Invalid RPC accepted')
    assert service.handle(request)==valid
    result=dict(passed=True,independentlyCheckedWorlds=128,independentlyCheckedCases=2400,negativeChecks=rejected,
                prospectiveSeedCollisions=0,worldBlocksPaired=True,refinementTriplets=240,newMissions=0)
    with (out/'contract_acceptance.json').open('x') as file:json.dump(result,file,indent=2);file.write('\n')
    print(json.dumps(result))


if __name__=='__main__':main()
