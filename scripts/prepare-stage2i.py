#!/usr/bin/env python3
"""Freeze a versioned candidate without modifying any Stage 2h artifact."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
from lib.si_response_reporting_fixture import REPLICATES, VERSION, canonical, validate

PARENT_SHA='88c5cffbc5b1e48b95e3226a645cb60ef88011878b85e2e309647281b4dc1aab'
EXTRA=['scripts/lib/si-response-design.ts','scripts/lib/si-response-integration.ts',
       'scripts/lib/si-response-fixture.ts','scripts/lib/si_response_reporting_fixture.py',
       'scripts/lib/si_response_statistics.py','scripts/si-response-integration-bridge.py',
       'scripts/stage2i-runner.ts','scripts/analyze-stage2i.py','scripts/run-stage2i.py',
       'scripts/prepare-stage2i.py','scripts/test-stage2i-design.ts','scripts/test-stage2i.py',
       'research/protocols/si_response_replication_v1_2026-09-21.md',
       'research/protocols/si_response_replication_nominal_fallback_2026-09-21.md']


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--base',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    p.add_argument('--node',required=True)
    a=p.parse_args()
    assert sha(a.base/'bundle.json')==PARENT_SHA
    original=json.loads((a.base/'bundle.json').read_text())
    for row in original['frozenSources']+original['additions']:
        assert sha(Path(row['file']))==row['sha256'],row['file']
    plan=json.loads(subprocess.check_output([a.node,'outputs/stage2i-runner.mjs','--mode','plan']))
    assert [len(plan[x]['cases']) for x in ['nominal-preflight','nominal-only']]==[12,480]
    assert {600000+s['replicate'] for s in plan['nominal-only']['cases']}==set(range(600700,600732))
    a.output.mkdir(parents=True)
    for line in (a.base/'SHA256SUMS').read_text().splitlines():
        digest,name=line.split('  ',1)
        assert not Path(name).is_absolute() and '..' not in Path(name).parts
        assert sha(a.base/name)==digest,name
        if name=='bundle.json':continue
        target=a.output/name;target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(a.base/name,target)
    additions=[]
    for name in EXTRA:
        target=a.output/name
        assert not target.exists(),name
        target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(name,target)
        additions.append(dict(file=name,sha256=sha(target)))
    for name,target_name in [('outputs/stage2i-runner.mjs','scripts/stage2i-runner.mjs'),('outputs/stage2i.meta.json','scripts/stage2i.meta.json')]:
        target=a.output/target_name;shutil.copyfile(name,target)
        additions.append(dict(file=target_name,sha256=sha(target)))
    source=a.base/'scripts/lib/si_reported_pose.py'
    module_spec=importlib.util.spec_from_file_location('generator',source)
    generator=importlib.util.module_from_spec(module_spec);module_spec.loader.exec_module(generator)
    old=json.loads((a.base/original['reportingFixture']['file']).read_text())
    vectors={str(r):old['replicates'][str(r)] if str(r) in old['replicates'] else generator.unit_errors(r) for r in REPLICATES}
    fixture=dict(version=VERSION,offsetMetres=.1,amplitudesMetres=[0.,.001],replicates=vectors,
                 generator=dict(sourceSha256=sha(source),planSha256=hashlib.sha256(canonical(plan)).hexdigest(),python=sys.version,platform=platform.platform(),uniformDrawsPerReplicate=205,seedOffset=1300101))
    validate(fixture)
    assert all(fixture['replicates'][k]==v for k,v in old['replicates'].items())
    fixture_file=a.output/'stage2i-reporting-fixture.json'
    with fixture_file.open('xb') as f:f.write(canonical(fixture))
    bundle=dict(schemaVersion='stage2i-bundle-v2-nominal',parentBundleSha256=PARENT_SHA,
                frozenSources=original['frozenSources'],inheritedAdditions=original['additions'],additions=additions,
                plan=plan,reportingFixture=dict(file=fixture_file.name,sha256=sha(fixture_file)),
                oldReportingVectorsPreserved=True,cloudValidated=False,paidLaunchAuthorized=False)
    with (a.output/'bundle.json').open('xb') as f:f.write(canonical(bundle))
    with (a.output/'SHA256SUMS').open('x') as f:
        for file in sorted(a.output.rglob('*')):
            if file.is_file() and file.name!='SHA256SUMS':f.write(f'{sha(file)}  {file.relative_to(a.output)}\n')
    print(json.dumps(dict(bundle=str(a.output),bundleSha256=sha(a.output/'bundle.json'),originalSources=len(bundle['frozenSources']),additions=len(additions),reportingReplicates=len(REPLICATES))))


if __name__=='__main__':main()
