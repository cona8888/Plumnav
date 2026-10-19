"""Freeze the separate status-map supplement and cap its saved-record checks."""
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
SUPPLEMENT = 'research/protocols/si_saved_development_binding_v2_status_mapping_2026-09-24.md'
SOURCES = (PROTOCOL, SUPPLEMENT, 'scripts/run-si-saved-development-binding-v2.py',
           'scripts/test-si-saved-development-binding-v1.py', 'scripts/test-si-saved-development-binding-v2.py',
           'scripts/lib/si_saved_development_binding_v1.py', 'scripts/lib/si_saved_development_binding_v2.py',
           'scripts/lib/si_saved_development_check_v1.py', 'scripts/lib/si_exact_registry_v1.py',
           'scripts/lib/si_terminal_report_v1.py', 'scripts/lib/si_release_endpoint_v1.py', 'scripts/lib/si_release_endpoint_v2.py')


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def pin(relative): return dict(path=relative, sha256=sha(checked_path(ROOT, relative)))


def write(path, data):
    with path.open('x') as stream:
        json.dump(data, stream, indent=2); stream.write('\n')


def main():
    p = argparse.ArgumentParser(); p.add_argument('--output', type=Path, required=True); args = p.parse_args()
    now = datetime.now(timezone.utc)
    if (datetime.fromisoformat('2026-09-25T01:41:27+00:00')-now).total_seconds() < 900:
        raise ValueError('Fewer than 15 minutes remain')
    assert sha(ROOT/PROTOCOL) == 'ad3630cbb5977789b667ee27898f7edfa8790e6a77960b9617e931fab840fb68'
    assert sha(ROOT/PARENT/'manifest.json') == PARENT_SHA
    # Preserve the exact inputs and outcome of v1, not only its failure note.
    previous = ROOT/'research/results/si_saved_development_binding_v1_attempt01_2026-09-24'
    old = json.loads((previous/'execution_manifest.json').read_text())
    for row in old['sources'] + old['inputs']:
        assert sha(ROOT/row['path']) == row['sha256']
    assert json.loads((previous/'checked/failed.json').read_text())['accepted'] is False
    out = args.output.resolve(); assert out.is_relative_to(ROOT); out.mkdir(exist_ok=False)
    parents = {name: pin(PARENT+'/'+file) for name, file in (('parent', 'manifest.json'), ('acceptance', 'acceptance.json'), ('batchComplete', 'complete.json'))}
    case_files = {case: {name: pin(PARENT+'/'+case+'/'+file) for name, file in (
        ('childManifest', 'run/manifest.json'), ('completion', 'run/complete.json'), ('process', 'process_terminal.json'),
        ('auditProcess', 'audit_terminal.json'), ('audit', 'independent_audit.json'), ('history', 'run/mission.json.gz'))} for case in CASES}
    inputs = list(parents.values()) + [row for case in case_files.values() for row in case.values()]
    sources = [pin(name) for name in SOURCES]
    manifest = dict(version='saved-development-binding-execution-v2', createdAt=now.isoformat(),
          protocolSha256=sha(ROOT/PROTOCOL), supplementSha256=sha(ROOT/SUPPLEMENT), parentManifestSha256=PARENT_SHA,
          preservedV1ManifestSha256=sha(previous/'execution_manifest.json'), preservedV1FailureSha256=sha(previous/'checked/failed.json'),
          caseIds=list(CASES), sources=sources, inputs=inputs, parentFiles=parents, caseFiles=case_files, newMissions=0, newScientificAuditsExecuted=0)
    write(out/'execution_manifest.json', manifest)
    command = [sys.executable, 'scripts/test-si-saved-development-binding-v2.py', '--manifest', str(out/'execution_manifest.json'), '--output', str(out/'checked')]
    start = time.monotonic(); timed_out = False
    with (out/'process.log').open('x') as log:
        proc = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT)
        try: code = proc.wait(timeout=600)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.wait(); code = proc.returncode; timed_out = True
    write(out/'process_terminal.json', dict(command=command, pid=proc.pid, exitCode=code, timedOut=timed_out,
          elapsedSeconds=time.monotonic()-start, capSeconds=600, finishedAt=datetime.now(timezone.utc).isoformat()))
    for row in inputs+sources+old['sources']:
        assert sha(ROOT/row['path']) == row['sha256']
    if timed_out or code != 0:
        print(json.dumps(dict(accepted=False, exitCode=code, timedOut=timed_out, output=str(out))))
        raise SystemExit(1)
    accepted = json.loads((out/'checked/acceptance.json').read_text()); assert accepted['accepted'] is True and accepted['cases'] == 3
    total = sum(path.stat().st_size for path in out.rglob('*') if path.is_file()); assert total < 10*1024**2
    write(out/'complete.json', dict(completed=True, accepted=True, acceptanceSha256=sha(out/'checked/acceptance.json'),
          executionManifestSha256=sha(out/'execution_manifest.json'), newMissions=0, newScientificAuditsExecuted=0,
          mappingValidChecks=3, mappingInvalidChecks=6, derivedBytes=total, allInputsUnchanged=True, v1FailurePreserved=True,
          actualSupportedBlankAuditBranchAdmitted=False, fullPerformanceCampaignAdmitted=False))
    print(json.dumps(dict(accepted=True, checkedCases=3, negativeChecks=accepted['negativeChecksRejected'],
          elapsedSeconds=time.monotonic()-start, acceptanceSha256=sha(out/'checked/acceptance.json'),
          executionManifestSha256=sha(out/'execution_manifest.json'), newMissions=0, newScientificAuditsExecuted=0)))


if __name__ == '__main__': main()
