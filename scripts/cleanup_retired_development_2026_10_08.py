"""Bounded, recoverable artifact cleanup explicitly requested on 8 October 2026.

No source, instruction, publication history, AWS object or Git object is removed.
The only candidates are listed below. Duplicate archives must match every
retained extracted body. Pilot worker folders may contain only raw compressed
histories and completion receipts. This script does not run scientific code.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

ROOT = Path('/Users/w.cha@bham.ac.uk/Documents/Gas source localization App')
RETIRED = ROOT / 'PlumeNav_retired_artifacts_2026-10-08_1412UTC'
ARCHIVES = ROOT / 'research/evidence/si_stage2i_campaign_archives_2026-09-22'
RETAINED = ROOT / 'research/evidence/si_stage2i_campaign_download_2026-09-22'
PILOTS = (
    'si_encounter_scheduling_2026-09-17',
    'si_linear_fresh_2026-09-17',
    'si_linear_diagnostic_2026-09-17',
    'si_turn_fresh_2026-09-17',
    'si_turn_diagnostic_2026-09-17',
    'si_scale_memory_pilot_2026-09-16',
    'si_fine_resolution_pilot_2026-09-16',
    'si_event_old_worlds_2026-09-16',
)
TARGETS = (ARCHIVES,) + tuple(
    ROOT / 'research/evidence' / pilot / ('worker-' + str(worker))
    for pilot in PILOTS for worker in range(4)
)


def need(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest_stream(stream):
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(2 * 1024 * 1024), b''):
        digest.update(chunk)
    return digest.hexdigest()


def inspect():
    need(Path.cwd().resolve() == ROOT, 'Run only in the explicitly scoped project')
    need(not RETIRED.exists(), 'Never reuse or overwrite a retirement folder')
    rows = []
    for target in TARGETS:
        need(target.is_dir() and not target.is_symlink(), 'Missing or symlink target: ' + str(target))
        need(target.resolve() == target, 'Unexpected symlink ancestor')
        tracked = subprocess.run(
            ['git', 'ls-files', '--', str(target.relative_to(ROOT))],
            cwd=ROOT, check=True, capture_output=True, text=True).stdout
        need(not tracked.strip(), 'Tracked paths are excluded')
        files = list(target.iterdir())
        need(files and all(p.is_file() and not p.is_symlink() for p in files),
             'Only flat regular data files can be retired')
        if target != ARCHIVES:
            need(all(p.name == 'complete.json' or re.fullmatch(
                r'(?:case|base|run)-\d+(?:-dt-0\.\d+)?\.json\.gz', p.name)
                for p in files), 'Source, instruction or unexpected worker file found')
            parent_manifest = target.parent / 'manifest.json'
            need(parent_manifest.is_file() and (target.parent / 'source-snapshot').is_dir(),
                 'Keep each pilot manifest and source snapshot')
        rows.append(dict(path=str(target.relative_to(ROOT)), fileCount=len(files),
                         bytes=sum(p.stat().st_size for p in files),
                         directoryDevice=target.stat().st_dev,
                         directoryInode=target.stat().st_ino))
    index_path = ROOT / 'research/results/si_stage2i_campaign_transfer_index_2026-09-22.json'
    index = json.loads(index_path.read_text())
    need({p.name for p in ARCHIVES.iterdir()} == {a['file'] for a in index['archives']},
         'Exact five duplicate archive names')
    members_seen = set()
    for archive in index['archives']:
        path = ARCHIVES / archive['file']
        need(path.stat().st_size == archive['bytes'], 'Original archive size')
        with path.open('rb') as stream:
            need(digest_stream(stream) == archive['sha256'], 'Original archive hash')
        count = 0
        output_count = 0
        with tarfile.open(path, 'r:') as tar:
            for member in tar:
                name = PurePosixPath(member.name)
                need(member.isfile() and not name.is_absolute() and '..' not in name.parts,
                     'Only relative regular archive bodies')
                need(str(name) not in members_seen, 'Duplicate archive member')
                kept = RETAINED.joinpath(*name.parts)
                need(kept.is_file() and not kept.is_symlink()
                     and kept.resolve().is_relative_to(RETAINED)
                     and kept.stat().st_size == member.size, 'Retained counterpart missing')
                with tar.extractfile(member) as original, kept.open('rb') as existing:
                    need(digest_stream(original) == digest_stream(existing),
                         'Retained counterpart full-body hash mismatch')
                members_seen.add(str(name))
                count += 1
                if name.parts[0] == 'output':
                    output_count += 1
                else:
                    need(archive['file'] == 'stage2i-campaign-part-0.tar'
                         and str(name) in {
                             'provenance/describe-processing-job.json',
                             'provenance/launch.json', 'provenance/s3-index.json',
                             'provenance/cloudwatch.json'}, 'Only four original transfer provenance bodies')
        need(output_count == archive['objects'], 'Original output object count')
        print(json.dumps(dict(archiveVerified=archive['file'], exactRetainedBodies=count)), flush=True)
    output_names = {n[7:] for n in members_seen if n.startswith('output/')}
    s3_index = json.loads((RETAINED / 'provenance/s3-index.json').read_text())
    need(output_names == {row['relative'] for row in s3_index['objects']}
         and len(output_names) == index['objectCount'] == 981
         and len(members_seen) == 985, 'All 981 outputs and four provenance bodies retained')
    return dict(version='recoverable-development-artifact-cleanup-v1',
                publicationDataUnchanged=True, sourceAndInstructionsUnchanged=True,
                gitUnchanged=True, awsUntouched=True, numericalWorkExecuted=False,
                exactDuplicateArchiveBodiesVerified=985,
                retirementFolder=str(RETIRED), targets=rows,
                totalFiles=sum(row['fileCount'] for row in rows),
                totalBytes=sum(row['bytes'] for row in rows))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--execute', action='store_true')
    args = parser.parse_args()
    plan = inspect()
    if not args.execute:
        print(json.dumps(dict(plan, status='VERIFIED_DRY_RUN_NO_MOVES'), indent=2), flush=True)
        return
    RETIRED.mkdir(mode=0o700)
    moved = []
    try:
        for target, row in zip(TARGETS, plan['targets']):
            stat = target.stat()
            need(stat.st_dev == row['directoryDevice'] and stat.st_ino == row['directoryInode'],
                 'Target directory changed since inspection')
            destination = RETIRED / target.relative_to(ROOT)
            destination.parent.mkdir(parents=True, exist_ok=True)
            need(not destination.exists(), 'No overwrite')
            os.rename(target, destination)
            moved.append(row['path'])
        result = subprocess.run(['/usr/bin/trash', '--stopOnError', '--verbose', str(RETIRED)],
                                capture_output=True, text=True)
        need(result.returncode == 0 and not RETIRED.exists(),
             'Trash did not complete; retained local retirement folder: ' + result.stderr)
        print(json.dumps(dict(plan, status='MOVED_TO_MACOS_TRASH_RECOVERABLE',
                              moved=moved, trashOutput=result.stdout,
                              permanentlyDeleted=False, diskSpaceReclaimed=False), indent=2), flush=True)
    except BaseException as error:
        print(json.dumps(dict(status='PARTIAL_RECOVERABLE_MOVE_NO_DELETION',
                              retirementFolder=str(RETIRED), moved=moved,
                              error=repr(error)), indent=2), flush=True)
        raise


if __name__ == '__main__':
    main()
