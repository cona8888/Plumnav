"""Read-only receipt/preservation inventory; does not rerun scientific audits."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
RESULTS = 'research/results/'
SCAFFOLD = 'research/reproducibility_scaffold_2026-09-24/'
DESIGN = 'research/analysis/si_availability_planning_v1_2026-09-24/'

RECEIPTS = [
    ('continuous-development', RESULTS+'si_readout_four_arm_refinement_v1_attempt01_2026-09-24/acceptance.json', 'accepted', None),
    ('pulse-absent-development', RESULTS+'si_readout_source_admission_v1_attempt01_2026-09-24/acceptance.json', 'accepted', '1252c97d946153859c709a3541aafcf040bc3d28afd7b8ef7d2e0f47ab008780'),
    ('scan-disabled-development', RESULTS+'si_scan_disabled_mission_admission_v1_attempt01_2026-09-24/acceptance.json', 'accepted', None),
    ('epa-sample-index-only', 'research/analysis/epa_sample_index_retention_v2_attempt01_2026-09-24/independent_audit.json', 'passed', 'f7455970e26c13cb2a589a7b783af90a17d151d49ea4491546f20752f90cf5c4'),
    ('synthetic-paired-statistics', RESULTS+'si_paired_statistics_synthetic_v1_attempt01_2026-09-24/acceptance.json', 'accepted', '71db351d7b21b7f2c911ca8512574cae19ac35fa11458bfa352c5051361411a0'),
    ('synthetic-registry', RESULTS+'si_registry_synthetic_v1_attempt01_2026-09-24/acceptance.json', 'accepted', '8c18282bd50aab1468d91939fceda74b7465ca12b391915f91ec8b41ec22ba96'),
    ('synthetic-blank-controls', RESULTS+'si_blank_controls_synthetic_v2_attempt01_2026-09-24/acceptance.json', 'accepted', '2eaf8caa2598fa43d362bc1c94e60f0904a20c90c186dbba9cef2a323652d073'),
    ('synthetic-terminal-binding', RESULTS+'si_terminal_binding_synthetic_v1_attempt01_2026-09-24/acceptance.json', 'accepted', 'b451a82196fafee3c5348533ad403637a9c25a692d2fed14fb084b38bedd0a90'),
    ('same-host-relocation', SCAFFOLD+'full_mission_relocation_path_v2_attempt01/acceptance.json', 'passed', 'c1564f300ccaaf44d152123d62c854cd7d3c75cc53a895c6b438bb9878719487'),
    ('same-host-source-build', SCAFFOLD+'source_rebuild_v1_attempt01/acceptance.json', 'accepted', 'c162f9ff306b3cab68eaf15131bcf613ee9351041a52c14076f7b539ef755560'),
    ('planning-arithmetic-only', DESIGN+'arithmetic_audit.json', 'passed', None),
]
MANIFESTS = [
    (RESULTS+'si_scan_disabled_mission_admission_v1_attempt01_2026-09-24/manifest.json', 'fd074f85c1c7f88ce883180b7610a9a9c59e2f130f6288e37d188fdb2ed520d1'),
    (RESULTS+'si_paired_statistics_synthetic_v1_attempt01_2026-09-24/execution_manifest.json', '9946c691e33c45492a3863f441177ca275b76020fdb67b821a20a106f6444eb9'),
    (RESULTS+'si_registry_synthetic_v1_attempt01_2026-09-24/execution_manifest.json', '13dca54ca1319b670f2616919d127c2d2d3e639fbb21501f50fe96dc33002b2b'),
    (RESULTS+'si_blank_controls_synthetic_v2_attempt01_2026-09-24/execution_manifest.json', 'a249c006a99366fc91be773fa5376f98ede7e93039cc3e608b94345a6a68f644'),
    (RESULTS+'si_terminal_binding_synthetic_v1_attempt01_2026-09-24/execution_manifest.json', '3f488e295efa6eb9bfb05dc70a1664d8612dbcf2fe0cdfcb198ddd09251bebdb'),
    (SCAFFOLD+'source_rebuild_v1_attempt01/execution_manifest.json', 'b73465da3fbb40e6093730c9c896d983c71dde13eb87f83780f0d2a9db3a91b0'),
]
DRAFTS = {
    'manuscript_v3.md': '8a0146557f5d7fc376ddc86cf1ce5107ff88abe14933b04d14b34431d51d899b',
    'methods_appendix.md': '848486e347cf5e4b9fddd8d14f0c86b3296a3c7670ea45a05280cec8d1d402ed',
    'updated_plan.md': 'f3613fa575721952e1b13aacafe983ee9f531c4ee2dd4837db55e717fa582118',
}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pinned(path, expected=None):
    full = (ROOT / path).resolve()
    if not full.is_relative_to(ROOT) or not full.is_file():
        raise ValueError(f'Missing or out-of-workspace input: {path}')
    actual = sha(full)
    if expected is not None and actual != expected:
        raise ValueError(f'Hash mismatch: {path}')
    return {'path': str(full.relative_to(ROOT)), 'sha256': actual}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise ValueError('Output exists; do not replace an inventory')
    rows = []
    for scope, path, flag, expected in RECEIPTS:
        row = pinned(path, expected)
        receipt = json.loads((ROOT/path).read_text())
        if receipt.get(flag) is not True:
            raise ValueError(f'Not accepted in its stated scope: {path}')
        rows.append(dict(scope=scope, **row, acceptanceFlag=flag,
                         acceptedFor=receipt.get('acceptedFor', scope)))
    preservation = []
    for path, expected in MANIFESTS:
        mrow = pinned(path, expected)
        source_rows = json.loads((ROOT/path).read_text())['sources']
        checked = [pinned(item['path'], item['sha256']) for item in source_rows]
        preservation.append(dict(**mrow, sourceEntries=len(checked), sources=checked))
    drafts = [pinned('research/publication_closeout_2026-09-22/draft_v3/'+name, h)
              for name, h in DRAFTS.items()]
    note = args.output.parent/'evidence_update.md'
    note_pin = pinned(note)
    links = []
    for target in re.findall(r'\]\(([^)]+)\)', note.read_text()):
        if '://' in target:
            continue
        dest = (note.parent/target).resolve()
        if dest == args.output.resolve():
            continue
        links.append(pinned(dest))
    script = pinned(Path(__file__).resolve())
    result = dict(version='review-followthrough-evidence-index-v1',
                  createdAt=datetime.now(timezone.utc).isoformat(),
                  receiptInventoryPassed=True, scientificAuditsRerun=0,
                  newMissions=0, performanceCampaignAdmitted=False,
                  physicalValidation=False, evidence=rows,
                  sourcePreservation=preservation, preservedDrafts=drafts,
                  note=note_pin, checkedLocalLinks=links, generator=script,
                  scope='Existing receipt/byte-identity inventory only; not a new scientific audit')
    # Recheck all pinned index inputs before publishing the new derived index.
    all_rows = rows + drafts + links + [note_pin, script]
    for entry in preservation:
        all_rows.extend([entry, *entry['sources']])
    for row in all_rows:
        pinned(row['path'], row['sha256'])
    with args.output.open('x') as stream:
        json.dump(result, stream, indent=2)
        stream.write('\n')
    print(json.dumps(dict(receipts=len(rows), sourceEntries=sum(x['sourceEntries'] for x in preservation),
                          preservedDrafts=len(drafts), checkedLocalLinks=len(links),
                          output=str(args.output), sha256=sha(args.output), newMissions=0)))


if __name__ == '__main__':
    main()
