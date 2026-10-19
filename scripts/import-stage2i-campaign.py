#!/usr/bin/env python3
"""Safely import the complete, hash-pinned Stage 2i campaign transfer."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
from lib.processing_output_manifest import verify_output_manifest

JOB = 'plumenav-stage2i-campaign-20260922-063830'


def sha(path):
    with path.open('rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()


def safe_name(name):
    p = PurePosixPath(name)
    assert name and p.as_posix() == name and not p.is_absolute() and '..' not in p.parts
    assert p.parts[0] in ('output', 'provenance') and len(p.parts) > 1
    return p


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--index', type=Path, required=True)
    parser.add_argument('--archives', type=Path, required=True)
    parser.add_argument('--destination', type=Path, required=True)
    a = parser.parse_args()
    index = json.loads(a.index.read_text())
    assert index['job'] == JOB and index['objectCount'] == 981 and index['totalBytes'] == 10198442764
    assert len(index['archives']) == 5
    assert sum(item['objects'] for item in index['archives']) == 981
    paths = []
    for w, item in enumerate(index['archives']):
        assert Path(item['file']).name == f'stage2i-campaign-part-{w}.tar'
        path = a.archives/Path(item['file']).name
        assert path.stat().st_size == item['bytes'] and sha(path) == item['sha256']
        paths.append(path); print('verified '+path.name, flush=True)
    names = set()
    # Validate all headers before creating any extracted evidence.
    for path in paths:
        with tarfile.open(path) as archive:
            for entry in archive:
                safe_name(entry.name)
                assert entry.isfile() and entry.name not in names
                names.add(entry.name)
    a.destination.mkdir(parents=True, exist_ok=False)
    for path in paths:
        with tarfile.open(path) as archive:
            for entry in archive:
                target = a.destination/entry.name
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(entry) as src, target.open('xb') as dst: shutil.copyfileobj(src, dst)
        print('imported '+path.name, flush=True)
    source = json.loads((a.destination/'provenance/s3-index.json').read_text())
    assert source['job'] == JOB and source['bucket'] == 'sagemaker-us-east-1-380061838272'
    assert source['prefix'] == 'plumenav/stage2i/20260921-v1-ed1c412ced1c/jobs/'+JOB+'/output/'
    output = a.destination/'output'
    files = {p.relative_to(output).as_posix(): p for p in output.rglob('*') if p.is_file()}
    assert len(source['objects']) == len({x['relative'] for x in source['objects']}) == 981
    assert set(files) == {x['relative'] for x in source['objects']}
    for x in source['objects']: assert files[x['relative']].stat().st_size == x['bytes']
    assert sum(p.stat().st_size for p in files.values()) == index['totalBytes']
    checked = verify_output_manifest(output, allow_empty_upload_markers=True)
    shutil.copyfile(a.index, a.destination/'provenance/transfer-index.json')
    result = dict(verified=True, job=JOB, objectCount=len(files), totalBytes=index['totalBytes'], archives=index['archives'], transport=checked)
    with (a.destination/'provenance/transfer-verification.json').open('x') as f: json.dump(result, f, indent=2); f.write('\n')
    print(json.dumps({k:v for k,v in checked.items() if k != 'omittedEmptyUploadMarkers'}, indent=2))


if __name__ == '__main__': main()
