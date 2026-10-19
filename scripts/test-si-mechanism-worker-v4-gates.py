"""Bounded zero-mission admission of separately versioned worker gates."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from lib.si_mechanism_registry_v3 import Registry

ROOT = Path(__file__).resolve().parents[1]
FRESH = ROOT / 'research/results/si_mechanism_all_arm_v2_attempt01_2026-09-25/prospective_manifest_v2.json'
FRESH_SHA = '0f68a87ea6a902848948338d1c5d076bef214bb7f5e59708203df77c2cb6d6cd'
DEV = ROOT / 'research/results/si_mechanism_all_arm_v2_attempt01_2026-09-25/development_manifest.json'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--node', required=True)
    a = p.parse_args()
    out = a.output.resolve()
    assert out.is_relative_to(ROOT) and not out.exists()
    out.mkdir()
    registry = Registry(FRESH, FRESH_SHA)
    worker, meta = out / 'worker.mjs', out / 'worker.meta.json'
    env = dict(os.environ, PYTHON=sys.executable, PYTHONDONTWRITEBYTECODE='1',
               PYTHONNOUSERSITE='1', OPENBLAS_NUM_THREADS='1', OMP_NUM_THREADS='1', MKL_NUM_THREADS='1')
    env.pop('PYTHONPATH', None)
    receipts = []

    def child(name, command, passed):
        with (out / (name + '.log')).open('x') as log:
            value = subprocess.run(command, cwd=ROOT, env=env, stdout=log,
                stderr=subprocess.STDOUT, timeout=120)
        assert (value.returncode == 0) == passed, name
        receipts.append(dict(name=name, command=command, exitCode=value.returncode,
                             expectedSuccess=passed))

    child('build', [a.node, 'node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild',
        'scripts/run-si-mechanism-case-v4.ts', '--bundle', '--platform=node', '--format=esm',
        '--outfile=' + str(worker), '--metafile=' + str(meta)], True)
    cdev = 'mechanism-development-3000-RW-si-continuous-n64'
    cfresh = 'mechanism-fresh-000-RW-si-continuous-n64'
    dest = out / 'MUST_NOT_EXIST'

    def cmd(manifest, digest, mode, cid, extra=()):
        return [a.node, str(worker), '--manifest', str(manifest), '--sha256', digest,
            '--mode', mode, '--case', cid, '--output', str(dest), *extra]

    child('inspect-development', cmd(DEV, sha(DEV), 'development', cdev, ['--dry-run']), True)
    child('inspect-fresh-no-execution', cmd(FRESH, FRESH_SHA, 'campaign', cfresh, ['--dry-run']), True)
    child('wrong-manifest-hash', cmd(DEV, '0'*64, 'development', cdev), False)
    child('reserved-in-development', cmd(FRESH, FRESH_SHA, 'development', cfresh), False)
    child('development-in-campaign', cmd(DEV, sha(DEV), 'campaign', cdev), False)
    child('unadmitted-campaign', cmd(FRESH, FRESH_SHA, 'campaign', cfresh,
        ['--release', str(out/'absent-release.json'), '--release-sha256', '0'*64]), False)
    child('unknown-development-case', cmd(DEV, sha(DEV), 'development', 'unknown-case'), False)
    child('unknown-mode', cmd(DEV, sha(DEV), 'unsafe', cdev), False)
    assert not dest.exists()
    # All imported scientific/bridge source bytes must remain the frozen v3 bytes.
    pins = {row['path']: row['sha256'] for row in registry.document['sources']}
    imported = json.loads(meta.read_text())['inputs']
    for name in imported:
        if name == 'scripts/run-si-mechanism-case-v4.ts':
            continue
        assert name in pins and sha(ROOT/name) == pins[name], name
    registry.protect()
    result = dict(passed=True, createdAt=datetime.now(timezone.utc).isoformat(),
        acceptedFor='zero-mission execution gates and unchanged scientific imports only',
        workerSha256=sha(worker), sourceSha256=sha(ROOT/'scripts/run-si-mechanism-case-v4.ts'),
        manifestSha256=FRESH_SHA, scientificImportsVerified=len(imported)-1,
        sourcePinsReverified=len(pins), commands=receipts, newMissions=0, awsCalls=0,
        numericalEquivalenceAdmitted=False, productionAdmitted=False,
        remaining='Same-image x86 development witness, measured resource/concurrency admission, frozen production release checker and complete independent audit pipeline.')
    with (out/'acceptance.json').open('x') as stream:
        json.dump(result, stream, indent=2); stream.write('\n')
    print(json.dumps({k:result[k] for k in ('passed','scientificImportsVerified','sourcePinsReverified','newMissions','productionAdmitted')}))


if __name__ == '__main__':
    main()
