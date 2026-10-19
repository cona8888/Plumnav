"""Freeze and cap the read-only saved-development binding admission."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
from lib.si_saved_development_binding_v1 import PARENT, PARENT_SHA, CASES, checked_path

ROOT = Path(__file__).resolve().parents[1]
PROTOCOL = 'research/protocols/si_saved_development_binding_v1_2026-09-24.md'
PROTOCOL_SHA = 'ad3630cbb5977789b667ee27898f7edfa8790e6a77960b9617e931fab840fb68'
SOURCES = (PROTOCOL, 'scripts/run-si-saved-development-binding-v1.py', 'scripts/test-si-saved-development-binding-v1.py',
           'scripts/lib/si_saved_development_binding_v1.py', 'scripts/lib/si_saved_development_check_v1.py',
           'scripts/lib/si_exact_registry_v1.py', 'scripts/lib/si_terminal_report_v1.py',
           'scripts/lib/si_release_endpoint_v1.py', 'scripts/lib/si_release_endpoint_v2.py')


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def pin(relative):
    path = checked_path(ROOT, relative)
    return dict(path=relative, sha256=sha(path))


def write(path, data):
    with path.open('x') as stream:
        json.dump(data, stream, indent=2); stream.write('\n')


def main():
    p = argparse.ArgumentParser(); p.add_argument('--output', type=Path, required=True); args = p.parse_args()
    now = datetime.now(timezone.utc); deadline = datetime.fromisoformat('2026-09-25T01:41:27+00:00')
    if (deadline-now).total_seconds() < 900:
        raise ValueError('Fewer than 15 minutes remain; do not start')
    assert sha(ROOT/PROTOCOL) == PROTOCOL_SHA and sha(ROOT/PARENT/'manifest.json') == PARENT_SHA
    out = args.output.resolve(); assert out.is_relative_to(ROOT)
    out.mkdir(exist_ok=False)
    parents = {name: pin(PARENT+'/'+file) for name, file in
               (('parent', 'manifest.json'), ('acceptance', 'acceptance.json'), ('batchComplete', 'complete.json'))}
    case_files = {}
    for case in CASES:
        case_files[case] = {name: pin(PARENT+'/'+case+'/'+file) for name, file in (
            ('childManifest', 'run/manifest.json'), ('completion', 'run/complete.json'),
            ('process', 'process_terminal.json'), ('auditProcess', 'audit_terminal.json'),
            ('audit', 'independent_audit.json'), ('history', 'run/mission.json.gz'))}
    inputs = list(parents.values()) + [row for case in case_files.values() for row in case.values()]
    manifest = dict(version='saved-development-binding-execution-v1', createdAt=now.isoformat(),
                    protocolSha256=PROTOCOL_SHA, parentManifestSha256=PARENT_SHA,
                    caseIds=list(CASES), sources=[pin(name) for name in SOURCES], inputs=inputs,
                    parentFiles=parents, caseFiles=case_files, newMissions=0, newScientificAuditsExecuted=0)
    write(out/'execution_manifest.json', manifest)
    command = [sys.executable, 'scripts/test-si-saved-development-binding-v1.py', '--manifest', str(out/'execution_manifest.json'), '--output', str(out/'checked')]
    start = time.monotonic(); timed_out = False
    with (out/'process.log').open('x') as log:
        process = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        try:
            code = process.wait(timeout=600)
        except subprocess.TimeoutExpired:
            process.kill(); process.wait(); code = process.returncode; timed_out = True
    write(out/'process_terminal.json', dict(command=command, pid=process.pid, exitCode=code,
          timedOut=timed_out, elapsedSeconds=time.monotonic()-start, capSeconds=600,
          finishedAt=datetime.now(timezone.utc).isoformat()))
    for row in inputs+manifest['sources']:
        assert sha(ROOT/row['path']) == row['sha256'], row['path']
    if timed_out or code != 0:
        print(json.dumps(dict(accepted=False, exitCode=code, timedOut=timed_out, output=str(out))))
        raise SystemExit(1)
    accepted = json.loads((out/'checked/acceptance.json').read_text())
    assert accepted['accepted'] is True and accepted['cases'] == 3
    total = sum(path.stat().st_size for path in out.rglob('*') if path.is_file())
    assert total < 10*1024**2
    write(out/'complete.json', dict(completed=True, accepted=True, acceptanceSha256=sha(out/'checked/acceptance.json'),
          executionManifestSha256=sha(out/'execution_manifest.json'), newMissions=0, newScientificAuditsExecuted=0,
          derivedBytes=total, allInputsUnchanged=True, fullPerformanceCampaignAdmitted=False))
    print(json.dumps(dict(accepted=True, checkedCases=3, negativeChecks=accepted['negativeChecksRejected'],
          elapsedSeconds=time.monotonic()-start, acceptanceSha256=sha(out/'checked/acceptance.json'),
          executionManifestSha256=sha(out/'execution_manifest.json'), newMissions=0, newScientificAuditsExecuted=0)))


if __name__ == '__main__': main()
