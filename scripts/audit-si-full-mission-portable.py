"""Package-relative driver for unchanged independent scientific audits."""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import time
from lib.si_scan_disabled_audit import audit, self_test

def sha(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);a=p.parse_args()
    root=Path(__file__).resolve().parents[1];start=time.monotonic()
    m=json.loads((root/'package-manifest.json').read_text())
    for row in m['files']:assert sha(root/row['path'])==row['sha256']
    result=json.loads((a.output/'reproduction.json').read_text())
    assert result['passed'] and result['fullRecordMatched']
    assert result['packageManifestSha256']==sha(root/'package-manifest.json')
    path=a.output/'mission.json.gz';assert sha(path)==result['historySha256']
    r=json.loads(gzip.decompress(path.read_bytes()))
    assert r['summary']['stage']=='inspection-complete' and len(r['visits'])==17
    details=audit(r);fixtures=self_test()
    assert details['scanDisabled']['inspectionPathExercised'] and fixtures['passed']
    for row in m['files']:assert sha(root/row['path'])==row['sha256']
    receipt=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,historySha256=sha(path),packageManifestSha256=sha(root/'package-manifest.json'),details=details,contractFixtures=fixtures,physicalValidation=False)
    with (a.output/'independent_audit.json').open('x') as f:json.dump(receipt,f,indent=2);f.write('\n')
    print(json.dumps(dict(passed=True,elapsedSeconds=receipt['elapsedSeconds'],historySha256=receipt['historySha256'],inspectionPathExercised=True)))

if __name__=='__main__':main()
