"""Read-only preservation and focused TypeScript check after synthetic admission."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import subprocess
import time

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);p.add_argument('--node',required=True);p.add_argument('--type-roots',required=True);a=p.parse_args()
    assert not a.output.exists()
    start=time.monotonic();checked=[]
    manifests=[
        'research/results/si_scan_disabled_mission_admission_v1_attempt01_2026-09-24/manifest.json',
        'research/results/si_paired_statistics_synthetic_v1_attempt01_2026-09-24/execution_manifest.json',
        'research/results/si_registry_synthetic_v1_attempt01_2026-09-24/execution_manifest.json']
    for path in manifests:
        m=json.loads(Path(path).read_text())
        for row in m['sources']:assert sha(row['path'])==row['sha256'],row['path']
        checked.append(dict(path=path,sha256=sha(path),unchangedSources=len(m['sources'])))
    drafts={'manuscript_v3.md':'8a0146557f5d7fc376ddc86cf1ce5107ff88abe14933b04d14b34431d51d899b','methods_appendix.md':'848486e347cf5e4b9fddd8d14f0c86b3296a3c7670ea45a05280cec8d1d402ed','updated_plan.md':'f3613fa575721952e1b13aacafe983ee9f531c4ee2dd4837db55e717fa582118'}
    for name,digest in drafts.items():assert sha(Path('research/publication_closeout_2026-09-22/draft_v3')/name)==digest
    admissions=[]
    for folder,key in [('si_paired_statistics_synthetic_v1_attempt01_2026-09-24','auditSha256'),('si_registry_synthetic_v1_attempt01_2026-09-24','pythonReceiptSha256')]:
        root=Path('research/results')/folder;receipt=json.loads((root/'acceptance.json').read_text());assert receipt['accepted'] is True and receipt['newMissions']==0
        assert receipt['executionManifestSha256']==sha(root/'execution_manifest.json')
        if key=='auditSha256':assert receipt[key]==sha(root/'independent_arithmetic_audit.json')
        else:
            assert receipt[key]==sha(root/'generated/complete.json')
            assert receipt['typescriptReceiptSha256']==sha(root/'typescript_receipt.json')
            assert receipt['bundleSha256']==sha(root/'registry-client-test.mjs')
        admissions.append(dict(path=str(root/'acceptance.json'),sha256=sha(root/'acceptance.json')))
    command=[a.node,'node_modules/typescript/bin/tsc','--noEmit','--strict','--skipLibCheck','--target','ES2022','--module','ESNext','--moduleResolution','Bundler','--types','node','--typeRoots',a.type_roots,'scripts/test-si-registry-client-v1.ts']
    result=subprocess.run(command,text=True,capture_output=True,timeout=60)
    out=dict(passed=result.returncode==0,createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,manifests=checked,unchangedDrafts=drafts,admissions=admissions,typeCheck=dict(command=command,exitCode=result.returncode,stdout=result.stdout,stderr=result.stderr),newMissions=0,scriptSha256=sha(__file__))
    with a.output.open('x') as f:json.dump(out,f,indent=2);f.write('\n')
    print(json.dumps(out));assert result.returncode==0

if __name__=='__main__':main()
