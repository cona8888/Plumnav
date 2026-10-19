#!/usr/bin/env python3
"""Final local-only acceptance/provenance check; never authorizes cloud execution."""
import hashlib
import json
from datetime import datetime,timezone
from pathlib import Path
from lib.processing_output_manifest import verify_output_manifest


def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def read(p):return json.loads(p.read_text())


root=Path('research/evidence/si_stage2h_v2_local_smoke_2026-09-18')
bundle_root=Path('aws/build/stage2h-20260918-v2')
bundle=read(bundle_root/'bundle.json')
base=Path('aws/build/stage2h-20260917-v1')
parent=read(base/'bundle.json')
assert bundle['parentBundleSha256']==sha(base/'bundle.json')
assert bundle['frozenSources']==parent['frozenSources'] and bundle['plan']==parent['plan']
for s in bundle['frozenSources']:
    assert sha(bundle_root/s['file'])==s['sha256']
    assert sha(Path(s['original']))==s['sha256'],s['original']
for s in bundle['additions']:
    assert sha(bundle_root/s['file'])==s['sha256'] and sha(Path(s['file']))==s['sha256']
for digest,name in [line.split('  ',1) for line in (bundle_root/'SHA256SUMS').read_text().splitlines()]:
    assert sha(bundle_root/name)==digest
transport=verify_output_manifest(root)
analysis=read(root/'analysis/analysis.json');done=read(root/'job-complete.json')
assert analysis['schemaVersion']=='stage2h-cloud-audit-v2'
assert all(analysis[k] for k in ['accepted','integrityPassed','platformCompatibilityPassed','absentControlPassed'])
assert analysis['performance'] is None and done['accepted']
assert done['analysisSha256']==sha(root/'analysis/analysis.json')
assert analysis['bundleSha256']==sha(bundle_root/'bundle.json') and len(analysis['details'])==12
comparison_path=Path('research/results/si_stage2h_v2_exact_local_history_2026-09-18.json')
comparison=read(comparison_path)
assert comparison['accepted'] and comparison['caseCount']==12
assert comparison['newOutputManifestSha256']==sha(root/'SHA256SUMS')
assert all(d['exactHistory'] for d in comparison['details'])
diagnostic=read(Path('research/results/si_reporting_fixture_old_cloud_diagnostic_2026-09-18.json'))
assert diagnostic['diagnosticOnly'] and not diagnostic['accepted']
assert sum(a['exactHistoricalObservation'] for d in diagnostic['details'] for a in d['arms'])==0
assert Path('research/results/si_stage2h_aws_smoke_audit_2026-09-18/failure.json').is_file()
assert not Path('research/results/si_stage2h_aws_smoke_audit_2026-09-18/complete.json').exists()
types=read(Path('research/results/si_stage2h_v2_typecheck_2026-09-18.json'))
assert types['projectTypecheckPassed'] and types['noNewStrictDiagnostics']
archive=bundle_root.with_suffix('.tar.gz');archive_record=read(archive.with_suffix('.sha256.json'))
assert archive_record['sha256']==sha(archive) and archive_record['bundleSha256']==sha(bundle_root/'bundle.json')
assert sha(Path('aws/build/stage2h-20260917-v1.tar.gz'))=='beb451efd527fd65f541cfef697120388d9bf2e1c2502c80f68f0b105e13c80e'
result=dict(acceptedLocal=True,cloudValidated=False,paidLaunchAuthorized=False,campaignLaunched=False,
    checkedAt=datetime.now(timezone.utc).isoformat(),archive=str(archive),archiveSha256=sha(archive),
    bundleSha256=sha(bundle_root/'bundle.json'),fixture=bundle['reportingFixture'],
    analysisSha256=sha(root/'analysis/analysis.json'),outputManifestSha256=sha(root/'SHA256SUMS'),
    exactReferenceComparisonSha256=sha(comparison_path),caseCount=12,frozenSourcesPreserved=141,
    declaredAdditions=len(bundle['additions']),transport=transport,counts=analysis['counts'],
    earlierCloudAuditFailurePreserved=True,wholeResearchGraphStrictClean=types['wholeResearchGraphStrictClean'])
with Path('research/results/si_stage2h_v2_local_closure_2026-09-18.json').open('x') as f:
    json.dump(result,f,indent=2,allow_nan=False);f.write('\n')
print(json.dumps(result,indent=2))
