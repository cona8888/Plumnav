#!/usr/bin/env python3
"""Import only a checksummed terminal smoke archive; preserve original evidence."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tarfile
from lib.processing_output_manifest import verify_output_manifest

JOB='plumenav-stage2i-smoke-20260922-013224'


def sha(p):
    with p.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--archive',type=Path,required=True)
    p.add_argument('--sha256',required=True)
    p.add_argument('--destination',type=Path,required=True)
    a=p.parse_args();assert sha(a.archive)==a.sha256
    a.destination.mkdir(parents=True)
    names=set()
    with tarfile.open(a.archive) as t:
        for member in t:
            n=Path(member.name)
            assert member.isfile() and not n.is_absolute() and '..' not in n.parts
            assert n.parts[0] in ['output','provenance'] and member.name not in names
            names.add(member.name);target=a.destination/n;target.parent.mkdir(parents=True,exist_ok=True)
            with t.extractfile(member) as src,target.open('xb') as dst:shutil.copyfileobj(src,dst)
    index=json.loads((a.destination/'provenance/s3-index.json').read_text())
    assert index['job']==JOB
    root=a.destination/'output';files={str(p.relative_to(root)):p for p in root.rglob('*') if p.is_file()}
    assert set(files)=={x['relative'] for x in index['objects']}
    for item in index['objects']:assert files[item['relative']].stat().st_size==item['bytes']
    verified=verify_output_manifest(root,allow_empty_upload_markers=True)
    record=dict(archiveSha256=a.sha256,job=JOB,objectCount=len(files),totalBytes=sum(x.stat().st_size for x in files.values()),transport=verified)
    with (a.destination/'provenance/transfer-verification.json').open('x') as f:json.dump(record,f,indent=2);f.write('\n')
    print(json.dumps(record,indent=2))


if __name__=='__main__':main()
