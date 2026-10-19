"""Verify downloaded smoke artifacts and re-audit separately; no simulation or AWS."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT/'aws/build/si-mechanism-preflight-candidate-20260925-v3'
JOB = 'plumenav-mech-smoke-20260926-214445'
PREFIX = 's3://sagemaker-us-east-1-380061838272/plumenav/mechanism/20260926-v2-589b28225057/jobs/'+JOB+'/output/'
ARCHIVE_SHA = '589b28225057adb09790421f29dc66643bc374fcb757c080184686de0c304235'

def sha(path):
    with path.open('rb') as f: return hashlib.file_digest(f,'sha256').hexdigest()
def load(path): return json.loads(path.read_text())
def checksums(folder, filename):
    expected={}
    for line in (folder/filename).read_text().splitlines():
        digest,name=line.split('  ',1); p=PurePosixPath(name)
        assert name not in expected and str(p)==name and not p.is_absolute() and '..' not in p.parts
        assert (folder/name).is_file() and not (folder/name).is_symlink()
        assert sha(folder/name)==digest, name
        expected[name]=digest
    actual={p.relative_to(folder).as_posix() for p in folder.rglob('*') if p.is_file() and p!=folder/filename}
    assert set(expected)==actual, 'Incomplete checksum coverage'
    return expected

def main():
    p=argparse.ArgumentParser(); p.add_argument('--download',type=Path,required=True); p.add_argument('--derived',type=Path,required=True)
    a=p.parse_args(); raw=a.download.resolve(); derived=a.derived.resolve()
    assert raw.is_dir() and not derived.exists() and not derived.is_relative_to(raw), 'Use separate fresh derived directory'
    derived.mkdir(); out=raw/'output'; prov=raw/'provenance'
    result=dict(checkedAt=datetime.now(timezone.utc).isoformat(),job=JOB,accepted=False,realAwsCalls=0,newMissions=0,
                physicalValidation=False,productionAdmitted=False,concurrencyAdmitted=False)
    try:
        job=load(prov/'describe-processing-job.json'); launch=load(prov/'launch.json')
        assert job['ProcessingJobName']==JOB and launch['spec']['ProcessingJobName']==JOB
        result['jobStatus']=job['ProcessingJobStatus']; result['failureReason']=job.get('FailureReason')
        assert launch['validation']['archiveSha256']==ARCHIVE_SHA
        for key in ('RoleArn','AppSpecification','ProcessingResources','StoppingCondition','Environment'):
            assert job[key]==launch['spec'][key], key
        assert job['ProcessingOutputConfig']['Outputs'][0]['S3Output']['S3Uri']==PREFIX
        assert job['ProcessingResources']['ClusterConfig']==dict(InstanceCount=1,InstanceType='ml.m5.xlarge',VolumeSizeInGB=20)
        assert job['StoppingCondition']['MaxRuntimeInSeconds']==3600
        index=load(prov/'s3-index.json')['objects']
        assert {r['relative'] for r in index}=={p.relative_to(out).as_posix() for p in out.rglob('*') if p.is_file()}
        assert all((out/r['relative']).stat().st_size==r['bytes'] for r in index)
        result['outerChecksumCount']=len(checksums(out,'OUTPUT_SHA256SUMS'))
        result['downloadIntegrityPassed']=True
        assert job['ProcessingJobStatus']=='Completed' and not job.get('FailureReason'), 'AWS job did not complete successfully'
        assert not (out/'bootstrap-failed.json').exists() and not (out/'smoke/failed.json').exists()
        result['innerChecksumCount']=len(checksums(out/'smoke','SHA256SUMS'))
        result['packagedChecksumCount']=len(checksums(PACKAGE,'SHA256SUMS'))
        delivery=load(PACKAGE/'delivery.json'); cases=[r['caseId'] for r in delivery['smokeCases']]
        assert sha(out/'smoke/delivery.json')==sha(PACKAGE/'delivery.json')
        done=load(out/'smoke/complete.json'); bootstrap=load(out/'bootstrap-complete.json')
        assert done['accepted'] is True and done['completed'] is True and done['caseIds']==cases
        assert bootstrap['completed'] and bootstrap['smokeCompleteSha256']==sha(out/'smoke/complete.json')
        runtime=load(out/'smoke/runtime.json')
        assert all(runtime[k]==v for k,v in delivery['historicallyVerifiedRuntime'].items())
        result['runtime']=runtime
        # Preserve downloaded evidence; only the fresh derived folder receives audit files.
        for directory in ('cases','terminals'): (derived/directory).symlink_to(out/'smoke'/directory,target_is_directory=True)
        (derived/'audits').mkdir(); (derived/'local-logs').mkdir()
        env=dict(os.environ,PYTHONDONTWRITEBYTECODE='1',PYTHONNOUSERSITE='1',OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1',MKL_NUM_THREADS='1')
        env.pop('PYTHONPATH',None)
        result['independentAudits']=[]
        for cid in cases:
            cmd=[sys.executable,'-B',str(PACKAGE/'aws/mechanism-preflight-v3/audit.py'),'--output',str(derived),'--case',cid]
            with (derived/'local-logs'/(cid+'.log')).open('x') as log:
                audit=subprocess.run(cmd,cwd=PACKAGE,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=300)
            assert audit.returncode==0, 'Independent full audit failed: '+cid
            receipt=load(derived/'audits'/(cid+'.json'))
            assert receipt['passed'] and receipt['wholeReferenceMatched']
            cloud=load(out/'smoke/audits'/(cid+'.json'))
            assert all(receipt[k]==cloud[k] for k in ('details','extracted','guard','historySha256','referenceSha256','manifestSha256'))
            result['independentAudits'].append(dict(caseId=cid,passed=True,receiptSha256=sha(derived/'audits'/(cid+'.json'))))
        # Confirm no downloaded data changed while the independent audits ran.
        checksums(out,'OUTPUT_SHA256SUMS'); checksums(out/'smoke','SHA256SUMS')
        result.update(accepted=True,acceptedFor='three fixed development smoke cases only',caseIds=cases)
    except Exception as error:
        result['error']=type(error).__name__+': '+str(error)
        raise
    finally:
        result['scriptSha256']=sha(Path(__file__))
        with (derived/'verification.json').open('x') as f: json.dump(result,f,indent=2); f.write('\n')
        print(json.dumps(result,indent=2),flush=True)

if __name__=='__main__': main()
