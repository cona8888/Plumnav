#!/usr/bin/env python3
"""Generate nuisance inputs from the frozen generator, never cloud observations."""
import argparse
import hashlib
import importlib.util
import json
import platform
import sys
from pathlib import Path
from lib.si_reporting_fixture import VERSION, REPLICATES, canonical, validate


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--base', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    bundle = json.loads((a.base/'bundle.json').read_text())
    source = a.base/'scripts/lib/si_reported_pose.py'
    source_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    assert source_sha == next(s['sha256'] for s in bundle['frozenSources'] if s['file'] == 'scripts/lib/si_reported_pose.py')
    replicates = sorted({600000+s['replicate'] for mode in ['smoke', 'campaign'] for s in bundle['plan'][mode]['cases']})
    assert replicates == REPLICATES
    spec = importlib.util.spec_from_file_location('frozen_reporting_generator', source)
    old = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(old)
    data = dict(version=VERSION, offsetMetres=.1, amplitudesMetres=[0., .001],
        replicates={str(r): old.unit_errors(r) for r in replicates},
        generator=dict(sourceSha256=source_sha, planSha256=hashlib.sha256(canonical(bundle['plan'])).hexdigest(),
            python=sys.version, platform=platform.platform(), uniformDrawsPerReplicate=205, seedOffset=1300101))
    validate(data)
    body = canonical(data)
    with a.output.open('xb') as f: f.write(body)
    print(json.dumps(dict(path=str(a.output), sha256=hashlib.sha256(body).hexdigest(),
                         bytes=len(body), reportingReplicates=replicates), indent=2))


if __name__ == '__main__': main()
