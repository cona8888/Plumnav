"""Artificial registry and old/new verifier equivalence; no forward-model runs."""
import argparse
import copy
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import time
from lib.si_exact_registry_v1 import SOURCES, ExactRegistry, strict_json, validate


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def artificial_observation():
    visits, windows = [], []
    for i in range(17):
        angle = (i // 2) * math.pi / 4
        x, y = (0., 0.) if i % 2 == 0 else (math.cos(angle), math.sin(angle))
        visits.append(dict(target=dict(x=x, y=y), arrivedAt=20*i, closedAt=20*i+12,
                           samples=[dict(time=20*i+8+j, x=x, y=y, value=.9-.1*x*x-.1*y*y,
                                         hit=True, clipped=False, telemetryComplete=True) for j in range(5)]))
        windows.append(dict(visit=i, start=20*i, end=20*i+12, translationDiameterMetres=0., orientationSpanRadians=0.))
    return dict(visits=visits, motionContract=dict(version='continuous-stationary-head-v1', basis='prescribed-numerical-constraint', scope='continuous-head-centre-and-orientation', windows=windows))


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True,type=Path);args=parser.parse_args()
    args.output.mkdir(parents=True,exist_ok=False);start=time.monotonic()
    def write(name,data):
        with (args.output/name).open('x') as f:json.dump(data,f,indent=2,allow_nan=False);f.write('\n')
    registry=dict(version='si-exact-registry-v1',purpose='synthetic-interface-admission',
                  worlds=[dict(worldKey='synthetic-legacy-exact',reportingReplicate=603000),dict(worldKey='synthetic-second-exact',reportingReplicate=1600001)],
                  excludedReportingReplicates=[777777],verifierSources={name:sha(name) for name in SOURCES})
    write('registry.json',registry);registry_path=args.output/'registry.json';registry_sha=sha(registry_path)
    write('manifest.json',dict(createdAt=datetime.now(timezone.utc).isoformat(),registrySha256=registry_sha,syntheticOnly=True,newMissions=0))
    rejected=[]
    def reject(name,function):
        try:function()
        except (ValueError,TypeError,KeyError):rejected.append(name)
        else:raise AssertionError('Unexpected acceptance: '+name)
    try:
        for name,mutation in [
            ('missing-key',lambda d:d.pop('purpose')),('extra-key',lambda d:d.update(extra=True)),
            ('version',lambda d:d.update(version='other')),('campaign-purpose',lambda d:d.update(purpose='fresh-campaign')),
            ('empty-worlds',lambda d:d.update(worlds=[])),('not-world-list',lambda d:d.update(worlds={})),
            ('duplicate-world',lambda d:d['worlds'][1].update(worldKey=d['worlds'][0]['worldKey'])),
            ('duplicate-identity',lambda d:d['worlds'][1].update(reportingReplicate=603000)),
            ('excluded-identity',lambda d:d['worlds'][1].update(reportingReplicate=777777)),
            ('bool-identity',lambda d:d['worlds'][0].update(reportingReplicate=True)),
            ('float-identity',lambda d:d['worlds'][0].update(reportingReplicate=603000.)),
            ('negative-identity',lambda d:d['worlds'][0].update(reportingReplicate=-1)),
            ('unsafe-identity',lambda d:d['worlds'][0].update(reportingReplicate=2**53)),
            ('non-synthetic-world',lambda d:d['worlds'][0].update(worldKey='real-world')),
            ('world-extra-key',lambda d:d['worlds'][0].update(seed=1)),
            ('duplicate-exclusion',lambda d:d.update(excludedReportingReplicates=[1,1])),
            ('bool-exclusion',lambda d:d.update(excludedReportingReplicates=[True])),
            ('unknown-source',lambda d:d['verifierSources'].update(other='0'*64)),
            ('malformed-source-hash',lambda d:d['verifierSources'].update({SOURCES[0]:'bad'})),
        ]:
            bad=copy.deepcopy(registry);mutation(bad);reject('registry:'+name,lambda:validate(bad))
        for name,raw in [('duplicate-json','{"a":1,"a":2}'),('nan-json','{"a":NaN}'),('infinity-json','{"a":1e999}')]:
            reject(name,lambda:strict_json(raw))
        reject('wrong-registry-hash',lambda:ExactRegistry(registry_path,'0'*64))
        changed=copy.deepcopy(registry);changed['verifierSources'][SOURCES[0]]='0'*64
        write('deliberate_wrong_source_registry.json',changed)
        badpath=args.output/'deliberate_wrong_source_registry.json'
        reject('wrong-verifier-source-hash',lambda:ExactRegistry(badpath,sha(badpath)))
        module=load('registry_bridge','scripts/si-registry-exact-bridge-v1.py')
        old=load('legacy_exact_bridge','scripts/si-readout-exact-bridge.py')
        service=module.Service(registry_path,registry_sha)
        positive=artificial_observation();low=copy.deepcopy(positive)
        for visit in low['visits']:
            for sample in visit['samples']:sample['value']=.05;sample['hit']=False
        incomplete=copy.deepcopy(positive);incomplete['visits'][0]['samples'].pop()
        missing_motion=copy.deepcopy(positive);missing_motion['motionContract']=None
        fixtures=[];comparisons=0
        for name,observation,status in [('supported-quadratic',positive,'supported'),('low-signal',low,'abstained'),('incomplete-samples',incomplete,'abstained'),('missing-motion',missing_motion,'abstained')]:
            old_request=dict(id=0,operation='verify',reportingReplicate=603000,**copy.deepcopy(observation))
            expected=old.handle(old_request)
            assert expected['arms'][0]['decision']['status']==status
            fixtures.append(dict(name=name,observation=observation,expectedArms=expected['arms']))
            for row in registry['worlds']:
                for arm in module.ARMS:
                    for field in module.FIELDS:
                        request=dict(id=0,operation='verify',arm=arm,field=field,**row,**copy.deepcopy(observation))
                        before=copy.deepcopy(request);result=service.handle(request)
                        assert result['arms']==expected['arms'] and request==before
                        assert result['registrySha256']==registry_sha and result['context']==dict(arm=arm,field=field,**row)
                        result['arms'][0]['observation']['visits'][0]['samples'][0]['value']=999
                        assert service.handle(request)['arms']==expected['arms']
                        comparisons+=1
        base=dict(id=0,operation='verify',arm='GL',field='si-continuous',**registry['worlds'][0],**copy.deepcopy(positive))
        for name,mutation in [
            ('missing-motion',lambda d:d.pop('motionContract')),('extra-key',lambda d:d.update(extra=1)),
            ('unknown-world',lambda d:d.update(worldKey='synthetic-unknown')),('mismatched-identity',lambda d:d.update(reportingReplicate=1600001)),
            ('bool-identity',lambda d:d.update(reportingReplicate=True)),('bool-id',lambda d:d.update(id=True)),
            ('unsafe-id',lambda d:d.update(id=2**53)),('wrong-arm',lambda d:d.update(arm='OTHER')),
            ('wrong-field',lambda d:d.update(field='urban')),('wrong-operation',lambda d:d.update(operation='simulate')),
            ('non-list-visits',lambda d:d.update(visits={})),('non-object-visit',lambda d:d.update(visits=[1])),
            ('nonfinite-observation',lambda d:d['visits'][0]['samples'][0].update(value=float('nan'))),
        ]:
            bad=copy.deepcopy(base);mutation(bad);reject('request:'+name,lambda:service.handle(bad))
        # Real line RPC: reject malformed data, retain a live service, then return an unchanged valid result.
        command=[sys.executable,'scripts/si-registry-exact-bridge-v1.py','--registry',str(registry_path),'--registry-sha256',registry_sha]
        badrequest=copy.deepcopy(base);badrequest.update(id=1,reportingReplicate=1600001)
        valid=copy.deepcopy(base);valid['id']=2
        raw='{"id":0,"id":1}\n'+json.dumps(badrequest)+'\n'+json.dumps(valid)+'\n'
        result=subprocess.run(command,input=raw,text=True,capture_output=True,timeout=30,check=True)
        responses=[json.loads(line) for line in result.stdout.splitlines()]
        assert len(responses)==3 and [row['ok'] for row in responses]==[False,False,True]
        assert responses[2]['result']==service.handle(valid)
        write('rpc_transcript.json',dict(command=command,requests=[{'rawDuplicateKey':True},badrequest,valid],responses=responses,stderr=result.stderr))
        wrong=subprocess.run(command[:-1]+['0'*64],input=json.dumps(valid)+'\n',text=True,capture_output=True,timeout=30)
        assert wrong.returncode!=0 and not wrong.stdout
        write('wrong_pin_startup.json',dict(exitCode=wrong.returncode,stderr=wrong.stderr))
        write('fixtures.json',dict(registryPath=str(registry_path),registrySha256=registry_sha,worlds=registry['worlds'],fixtures=fixtures))
        complete=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,
                      fullDecisionEquivalenceComparisons=comparisons,negativeChecks=rejected,negativeCheckCount=len(rejected),
                      jsonLineRecoveryPassed=True,wrongPinStartupRejected=True,registrySha256=registry_sha,
                      fixturesSha256=sha(args.output/'fixtures.json'),newMissions=0,scope='synthetic identity and transport equivalence only')
        write('complete.json',complete);print(json.dumps(complete))
    except BaseException as error:
        write('failure.json',dict(passed=False,error=repr(error),negativeChecks=rejected));raise


if __name__=='__main__':main()
