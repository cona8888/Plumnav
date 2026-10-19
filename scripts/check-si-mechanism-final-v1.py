"""Post-admission preservation, typecheck and fresh-execution lock check."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from lib.si_mechanism_registry_v1 import Registry

ROOT=Path(__file__).resolve().parents[1]
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p):return json.loads(p.read_text())


def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--node',required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    out=a.root.resolve();accept=load(out/'acceptance.json');assert accept['accepted'] is True and accept['newFreshMissions']==0
    manifest=out/'prospective_manifest.json';r=Registry(manifest,accept['prospectiveManifestSha256'])
    Registry(out/'development_manifest.json',accept['developmentManifestSha256'])
    inventory=load(out/'historical_identity_inventory.json')
    for row in inventory['files']:assert sha(ROOT/row['path'])==row['sha256']
    protected=load(ROOT/'research/results/si_interface_analysis_closeout_2026-09-24.json')['unchangedDrafts']
    for name,expected in protected.items():assert sha(ROOT/'research/publication_closeout_2026-09-22/draft_v3'/name)==expected
    typepath=ROOT/'research/results/si_mechanism_worker_typecheck_2026-09-25.json';assert load(typepath)['noNewDiagnostics'] is True
    forbidden=out/'forbidden-fresh-execution';assert not forbidden.exists()
    command=[a.node,str(out/'worker.mjs'),'--manifest',str(manifest),'--sha256',sha(manifest),'--case',r.document['cases'][0]['id'],'--output',str(forbidden)]
    env=dict(os.environ,PYTHON=sys.executable,PYTHONDONTWRITEBYTECODE='1',OPENBLAS_NUM_THREADS='1',OMP_NUM_THREADS='1',MKL_NUM_THREADS='1')
    result=subprocess.run(command,cwd=ROOT,env=env,text=True,capture_output=True,timeout=30)
    assert result.returncode!=0 and 'Fresh campaign execution is not authorised/admitted' in result.stderr and not forbidden.exists()
    receipt=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),acceptanceSha256=sha(out/'acceptance.json'),
                 protectedSourceCount=len(r.document['sources']),unchangedHistoricalMetadata=len(inventory['files']),draftsUnchanged=protected,
                 typecheckSha256=sha(typepath),freshExecutionBlocked=True,newFreshMissions=0,
                 lockCheck=dict(command=command,exitCode=result.returncode,stdout=result.stdout,stderr=result.stderr),scriptSha256=sha(Path(__file__)))
    with a.output.open('x') as f:json.dump(receipt,f,indent=2);f.write('\n')
    print(json.dumps({k:v for k,v in receipt.items() if k not in ('lockCheck','draftsUnchanged')}))


if __name__=='__main__':main()
