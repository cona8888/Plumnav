#!/usr/bin/env python3
"""Exact local history comparison or explicitly non-accepting old-data diagnosis."""
import argparse
import gzip
import hashlib
import json
import time
from pathlib import Path
from lib.si_reporting_fixture import ReportingFixture, transform
from lib.si_reporting_fixture_audit import transform as audit_transform
from lib.si_v4_decision_audit import check_decision


def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read_record(root,index):
    directory=root/f'worker-{index%4}'
    receipt=json.loads((directory/f'case-{index:03}.receipt.json').read_text())
    path=directory/receipt['file']
    assert sha(path)==receipt['sha256'] and path.stat().st_size==receipt['bytes']
    return json.loads(gzip.decompress(path.read_bytes())),receipt


def main():
    p=argparse.ArgumentParser();p.add_argument('--old-root',type=Path,required=True);p.add_argument('--new-root',type=Path)
    p.add_argument('--fixture',type=Path,required=True);p.add_argument('--fixture-sha',required=True);p.add_argument('--output',type=Path,required=True)
    args=p.parse_args();start=time.monotonic();f=ReportingFixture(args.fixture,args.fixture_sha)
    m=json.loads((args.old_root/'manifest.json').read_text());assert m['mode']=='smoke' and m['caseCount']==12
    details=[]
    for s in m['cases']:
        old,old_receipt=read_record(args.old_root,s['index']);arms=[]
        for arm in (old['verification'] or {}).get('arms',[]):
            radius=arm['poseRadiusMetres'];alt=dict(model='exact' if radius==0 else 'readout-jitter',amplitudeMetres=radius)
            generated=transform(old['visits'],alt,600000+s['replicate'],f)
            reconstructed=audit_transform(old['visits'],alt,600000+s['replicate'],f)
            assert generated==reconstructed
            checks=[]
            for observation in [arm['observation'],reconstructed]:
                checks.append(check_decision(observation['visits'],arm['decision']['candidate'],radius,0.))
            arms.append(dict(radius=radius,exactHistoricalObservation=generated==arm['observation'],
                             independentArithmeticExact=True,decisionChecks=checks))
        detail=dict(index=s['index'],oldRawSha256=old_receipt['sha256'],arms=arms)
        if args.new_root:
            new,receipt=read_record(args.new_root,s['index'])
            assert new.pop('reportingFixture')==f.provenance(600000+s['replicate'])
            assert set(new)==set(old)
            old['summary'].pop('rpcMilliseconds');new['summary'].pop('rpcMilliseconds')
            assert old==new,('Original local history changed',s['index'])
            assert all(a['exactHistoricalObservation'] for a in arms)
            detail.update(exactHistory=True,newRawSha256=receipt['sha256'])
        details.append(detail);print(f'Checked reference {s["index"]}',flush=True)
    report=dict(accepted=bool(args.new_root),diagnosticOnly=not bool(args.new_root),caseCount=len(details),
        oldRoot=str(args.old_root.resolve()),newRoot=str(args.new_root.resolve()) if args.new_root else None,
        newOutputManifestSha256=sha(args.new_root/'SHA256SUMS') if args.new_root else None,
        fixtureSha256=args.fixture_sha,allowedDifferences=['new reportingFixture provenance','summary.rpcMilliseconds'] if args.new_root else [],
        details=details,elapsedSeconds=time.monotonic()-start)
    with args.output.open('x') as file:json.dump(report,file,indent=2,allow_nan=False);file.write('\n')


if __name__=='__main__':main()
