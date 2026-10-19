"""Bounded offline candidate verification on existing development histories.

No AWS client or simulation worker. Every input is preserved. Passing here is
local development evidence, never retrospective smoke/campaign acceptance.
"""
import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import time

import mechanism_portability_aws_first_v2 as policy

ROOT=Path(__file__).resolve().parents[1]
SCIENCE=ROOT/'aws/build/si-mechanism-preflight-candidate-20260925-v3'
OVERLAY=ROOT/'aws/build/PlumeNav_mechanism_smoke_20260927_v3_attempt02/overlay'
RAW=ROOT/'research/results/si_mechanism_smoke_v3_diagnostic_attempt01_2026-09-28/download'
SOURCES=[Path(__file__),ROOT/'scripts/mechanism_portability_aws_first_v2.py',
         ROOT/'scripts/test-mechanism-aws-first-v2.py',
         ROOT/'research/protocols/si_mechanism_aws_first_candidate_v2_2026-09-28.md']


def sha(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();out=args.output.absolute()
    if out.parent.resolve()!=ROOT/'research/results' or out.exists():
        raise ValueError('Fresh direct results child required')
    out.mkdir()
    sys.path.insert(0,str(OVERLAY))
    import common
    from verification_manifest_v1 import verify_manifest,write_manifest
    science,delivery,registry=common.context(SCIENCE)
    from lib.si_mechanism_history_v1 import history,full_audit,canonical,terminal,pinned
    import numpy
    preserved=[p for d in (SCIENCE,OVERLAY,RAW,
       ROOT/'research/results/si_mechanism_smoke_v2_cloud_2026-09-26') for p in d.rglob('*') if p.is_file()]
    preserved += [SCIENCE.with_suffix('.tar.gz'),ROOT/'scripts/mechanism_portability_candidate_v1.py']
    before={str(p.relative_to(ROOT)):sha(p) for p in preserved}
    common.write(out/'preserved-before.json',before)
    snapshot=out/'source-snapshot';snapshot.mkdir()
    for p in SOURCES:shutil.copyfile(p,snapshot/p.name)
    begin=time.monotonic()
    result=dict(version=policy.VERSION,createdAt=datetime.now(timezone.utc).isoformat(),
       newMissions=0,realAwsCalls=0,accepted=False,campaignAllowed=False,
       awsSmokeRequired=True,awsRepeatabilityTested=False,cases=[],corruptions=[],
       runtime=dict(python=platform.python_version(),numpy=numpy.__version__,architecture=platform.machine()),
       sources={str(p.relative_to(ROOT)):sha(p) for p in SOURCES})
    try:
        assert sha(SCIENCE.with_suffix('.tar.gz'))==common.SCIENCE_SHA
        assert sha(RAW.parent/'terminal.tar')=='e72bac2577a8637a7b6601cf087e03b269adaf056e83c045721c8a6977d929d4'
        expected=common.load(RAW/'output/payload-index.json')['payloads']
        assert set(expected)<=common.allowed_payloads()
        verify_manifest(RAW/'output',expected)
        unit=subprocess.run([sys.executable,'-B',str(ROOT/'scripts/test-mechanism-aws-first-v2.py')],
                            capture_output=True,text=True,timeout=60)
        common.write(out/'unit-tests.json',dict(exitCode=unit.returncode,stdout=unit.stdout,stderr=unit.stderr))
        assert unit.returncode==0
        for entry in delivery['smokeCases']:
            cid=entry['caseId'];case=registry.cases[cid]
            bound=common.load(pinned(entry['boundReceipt']))
            ref=history(pinned(entry['referenceHistory']))
            details,guard=full_audit(ref,case['arm'])
            endpoint=terminal(ref)
            bounds=common.audit_bounds(SCIENCE,case['spec']['field'])
            inherited=common.load(OVERLAY/'inherited-ns-audit.json') if bound['guard'] is None else None
            guardcheck=policy.v1.compare_reference_guard(bound,guard,inherited)
            canonical(ref)
            check=policy.comparison_gate(ref,ref,bound['details'],details,bounds,bound['extracted'],endpoint)
            common.write(out/(cid+'-reference.json'),dict(details=details,guard=guard,
                 referenceGuardCheck=guardcheck,comparison=check))
            assert guardcheck['passed'] and check['candidateChecksPassed'], cid+' reference failed'
            result['cases'].append(dict(caseId=cid,role='local-reference',fullAuditPassed=True,
                candidateChecksPassed=True,historySha256=entry['referenceHistory']['sha256']))
            print('REFERENCE_AUDITED '+cid,flush=True)
            path=RAW/'output/cases'/cid/'mission.json.gz'
            if not path.exists():
                assert cid==common.CASES[2]
                result['missingCloudCase']=cid
                continue
            done=common.load(path.parent/'complete.json')
            proc=common.load(RAW/'output/terminals'/(cid+'-mission.json'))
            manifest=common.load(path.parent/'manifest.json')
            assert done['completed'] is True and done['historySha256']==sha(path)
            assert done['case']==manifest['case']==case
            assert done['parentManifestSha256']==manifest['parentManifestSha256']==common.SCIENCE_MANIFEST_SHA
            assert proc['exitCode']==0 and proc['timedOut'] is False
            assert done['replay']['passed'] and done['replay']['privateFieldQueries']==0
            cloud=history(path)
            assert cloud['spec']==case['spec'] and cloud['development'] is None
            actual,actual_guard=full_audit(cloud,case['arm'])
            extracted=terminal(cloud)
            assert policy.v1.compare(guard,actual_guard)['passed']
            canonical(cloud)
            check=policy.comparison_gate(ref,cloud,details,actual,bounds,endpoint,extracted)
            common.write(out/(cid+'-cloud-candidate.json'),dict(details=actual,guard=actual_guard,comparison=check))
            old=policy.v1.compare(ref,cloud,policy.v1.VERSION)
            result['cases'].append(dict(caseId=cid,role='failed-aws-history-development-only',
                fullAuditPassed=True,candidateChecksPassed=check['candidateChecksPassed'],
                frozenV1HistoryPassed=old['passed'],v1RejectedDifferences=old['rejectedDifferences'],
                candidateAllowedDifferences=check['history']['allowedDifferences'],
                referenceMarginChecks=len(check['decisionMargins'][0]['checks']),
                cloudMarginChecks=len(check['decisionMargins'][1]['checks']),
                historySha256=sha(path),awsJobRemains='Failed',accepted=False))
            assert check['candidateChecksPassed'], cid+' candidate rejected'
            print('FAILED_AWS_HISTORY_DIAGNOSTIC '+cid,flush=True)
            mutations=[]
            if case['arm']=='RW':
                for label,col,delta in [('body-position',1,.001),('physical-input',12,.1),('sensor-readout',20,.001)]:
                    changed=dict(cloud,trace=list(cloud['trace']))
                    changed['trace'][0]=list(cloud['trace'][0]);changed['trace'][0][col]+=delta
                    mutations.append((label,changed))
            if case['arm']=='GL':
                changed=dict(cloud,verification=copy.deepcopy(cloud['verification']))
                changed['verification']['arms'][0]['decision']['candidate']['geometry']['basisTransform'][0][0]+=.001
                mutations.append(('whitening-matrix',changed))
            for label,changed in mutations:
                numerical=policy.compare_history(cloud,changed)
                error=None
                try:full_audit(changed,case['arm'])
                except (AssertionError,ValueError) as e:error=type(e).__name__+': '+str(e)
                receipt=dict(caseId=cid,mutation=label,numericRejected=not numerical['passed'],
                             fullAuditRejected=error is not None,error=error)
                result['corruptions'].append(receipt)
                common.write(out/(cid+'-corruption-'+label+'.json'),receipt)
                assert receipt['numericRejected'] and receipt['fullAuditRejected']
            del mutations,ref,cloud
        registry.protect()
        result['completedDevelopmentChecks']=True
    except BaseException as error:
        result.update(completedDevelopmentChecks=False,error=type(error).__name__+': '+str(error))
        raise
    finally:
        result['preservedHashesUnchanged']=before=={str(p.relative_to(ROOT)):sha(p) for p in preserved}
        result['preservedFiles']=len(before)
        result['elapsedSeconds']=time.monotonic()-begin
        common.write(out/'verification.json',result)
        members=sorted(p.relative_to(out).as_posix() for p in out.rglob('*') if p.is_file())
        write_manifest(out,members);verify_manifest(out,members)
        print('VERIFICATION_RECEIPT '+str(out/'verification.json'),flush=True)
        assert result['preservedHashesUnchanged']


if __name__=='__main__':main()
