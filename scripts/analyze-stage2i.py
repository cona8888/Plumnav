#!/usr/bin/env python3
"""Independent full-history preflight/replication audit; no relaxed gates."""
import argparse
from concurrent.futures import ProcessPoolExecutor
import gzip
import hashlib
import json
from pathlib import Path
import time
import numpy as np
from lib.si_response_reporting_fixture import ReportingFixture
from lib.si_fixture_audit import audit, compact
from lib.si_linear_audit import compare
from lib.si_response_statistics import summarize


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, data):
    with path.open('x') as f:
        json.dump(data, f, indent=2, allow_nan=False)
        f.write('\n')


def inspect(job):
    path, receipt, spec, config, fixture_path, fixture_sha, reference = job
    assert sha(path) == receipt['sha256'] and path.stat().st_size == receipt['bytes']
    record = json.loads(gzip.decompress(path.read_bytes()))
    assert record['spec'] == spec and record['config'] == config and record['development'] is None
    assert receipt['replay']['passed'] and receipt['replay']['schedulingTraceMatched'] and receipt['replay']['privateFieldQueries'] == 0
    checked = audit(record, ReportingFixture(fixture_path, fixture_sha))
    if spec['caseRole'] == 'compatibility':
        i = spec['referenceIndex']
        rr = Path(reference) / f'worker-{i%4}'
        old_receipt = json.loads((rr/f'case-{i:03}.receipt.json').read_text())
        assert receipt['compatibility']['referenceSha256'] == old_receipt['sha256'] == sha(rr/old_receipt['file'])
        cloud = json.loads(gzip.decompress((rr/old_receipt['file']).read_bytes()))
        reference_file=path.parent/receipt['compatibility']['referenceFile']
        assert sha(reference_file)==receipt['compatibility']['samePlatformReferenceSha256']
        old=json.loads(gzip.decompress(reference_file.read_bytes()))
        assert old['spec']==cloud['spec'] and old['config']==cloud['config']
        reference_checked=audit(old,ReportingFixture(fixture_path,fixture_sha))
        assert reference_checked['passed'] and receipt['compatibility']['referenceReplay']['passed']
        new = {**record, 'spec':old['spec'], 'reportingFixture':old['reportingFixture'], 'summary':{**record['summary'], 'rpcMilliseconds':0}}
        old['summary']['rpcMilliseconds'] = 0
        assert new == old, 'Independent whole-history same-platform reference mismatch'
        old_compact=compact(cloud);old_compact['schedule']=dict(firstEligibleControlTime=next((t['firstEligibleTime'] for t in cloud['schedulingTrace'] if t['latched']),None))
        new_compact=compact(record);new_compact['schedule']=checked['schedule']
        platform=compare([old_compact,old_compact,new_compact])
        assert platform['passed'],'Unchanged Stage 2h cross-platform gates failed'
        checked['samePlatformReferenceAudited']=True
        checked['cloudPlatformCompatibility']=platform
    else:
        assert receipt['compatibility'] is None
    data = compact(record)
    data['schedule'] = checked['schedule']
    if spec['caseRole'] == 'compatibility' or (spec['caseRole'] == 'primary' and spec['worldIndex'] not in [0,10,20,31]):
        for k in ['positions','scalar','directional','phaseLabels']:
            data.pop(k)
    return dict(index=spec['index'], passed=True, audit=checked, compatibility=receipt['compatibility']), data


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--bundle', type=Path, required=True)
    p.add_argument('--root', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--reference-root', type=Path)
    a = p.parse_args()
    start = time.monotonic()
    a.output.mkdir()
    details = []
    try:
        bundle = json.loads((a.bundle/'bundle.json').read_text())
        for line in (a.bundle/'SHA256SUMS').read_text().splitlines():
            digest, name = line.split('  ',1)
            assert sha(a.bundle/name) == digest, name
        m = json.loads((a.root/'manifest.json').read_text())
        done = json.loads((a.root/'complete.json').read_text())
        assert done['complete'] and not done['failures'] and done['manifestSha256'] == sha(a.root/'manifest.json')
        assert m['bundleSha256'] == sha(a.bundle/'bundle.json')
        plan = bundle['plan'][m['mode']]
        assert m['cases'] == plan['cases'] and m['configs'] == plan['configs']
        lookup = {s['index']:(s,c) for s,c in zip(m['cases'],m['configs'])}
        fixture = bundle['reportingFixture']
        jobs = []
        for w in range(4):
            folder = a.root/f'worker-{w}'
            info = json.loads((folder/'complete.json').read_text())
            assert info['complete'] and info['worker'] == w
            assert {f.name for f in folder.glob('*.json.gz')} == {r['file'] for r in info['inventory']}
            for r in info['inventory']:
                s,c = lookup[r['index']]
                assert s['index']%4 == w
                assert r == json.loads((folder/f"case-{s['index']:03}.receipt.json").read_text())
                jobs.append((folder/r['file'],r,s,c,a.bundle/fixture['file'],fixture['sha256'],a.reference_root))
        assert sorted(j[2]['index'] for j in jobs) == sorted(lookup)
        records = []
        with ProcessPoolExecutor(max_workers=4) as pool:
            for detail, data in pool.map(inspect,jobs):
                details.append(detail);records.append(data)
                print(f'audited {len(details)}/{len(jobs)}',flush=True)
        groups = {}
        for r in records:
            if 'directional' not in r:
                continue
            s = r['spec'];key=(s['worldIndex'],s['field'],s['method'],s['policy'],s['responseScale'])
            groups.setdefault(key,[]).append(r)
        triples = [];blank_identical=True
        for key, group in sorted(groups.items()):
            group.sort(key=lambda r:-r['spec']['navDt'])
            assert [r['spec']['navDt'] for r in group] == [1/16,1/32,1/64]
            result = compare(group);result['responseScale']=key[-1];triples.append(result)
            if key[1] == 'blank':
                blank_identical &= all(np.array_equal(group[0][k],r[k]) for r in group for k in ['positions','scalar','directional'])
        expected = {'nominal-preflight':0,'nominal-only':48}[m['mode']]
        assert len(triples) == expected
        absent = all(r['nomination'] is None and not r['decisions'] and not r['metrics']['encounter'] and (r['spec']['policy']!='encounter-gated' or r['schedule']['requestedScans']==0) for r in records if r['spec']['field']=='blank')
        accepted = bool(absent and blank_identical and all(t['passed'] for t in triples))
        performance = summarize(records,[1]) if accepted and m['mode']=='nominal-only' else None
        clean = [{k:v for k,v in r.items() if k not in ['positions','scalar','directional','phaseLabels']} for r in sorted(records,key=lambda r:r['spec']['index'])]
        result = dict(schemaVersion='stage2i-audit-v2-nominal',mode=m['mode'],accepted=accepted,integrityPassed=True,absentControlPassed=absent,absentBitIdentical=bool(blank_identical) if triples else None,coupledResolutionPassed=all(t['passed'] for t in triples) if triples else None,
                      compatibilityCount=sum(d['compatibility'] is not None for d in details),bundleSha256=sha(a.bundle/'bundle.json'),manifestSha256=sha(a.root/'manifest.json'),details=details,triples=triples,runs=clean,performance=performance,elapsedSeconds=time.monotonic()-start)
        write(a.output/'analysis.json',result)
        write(a.output/'complete.json',dict(complete=True,accepted=accepted,analysisSha256=sha(a.output/'analysis.json')))
        print(json.dumps(dict(accepted=accepted,caseCount=len(records),triplets=len(triples),auditSeconds=result['elapsedSeconds'])))
        return 0 if accepted else 2
    except BaseException as e:
        write(a.output/'failure.json',dict(error=f'{type(e).__name__}: {e}',completedCases=[d['index'] for d in details]))
        raise


if __name__ == '__main__':
    raise SystemExit(main())
