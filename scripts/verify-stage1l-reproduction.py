#!/usr/bin/env python3
"""Verify exact-seed repeat records without counting them as fresh replicates."""
import argparse
import hashlib
import json
from pathlib import Path


def sha(data):return hashlib.sha256(data).hexdigest()


def inventory(directory):
    top=json.loads((directory/'complete.json').read_text());manifest=(directory/'manifest.json').read_bytes()
    assert top['complete'] and not top['failures'] and top['manifestSha256']==sha(manifest)
    records={}
    for worker in sorted(directory.glob('worker-*')):
        marker=json.loads((worker/'complete.json').read_text());assert marker['complete']
        for item in marker['inventory']:
            raw=(worker/item['file']).read_bytes()
            assert sha(raw)==item['sha256'] and len(raw)==item['bytes'] and item['index'] not in records
            records[item['index']]=sha(raw)
    assert set(records)==set(range(96))
    return records,sha(manifest),top['elapsedSeconds']


def main():
    if not __debug__:raise RuntimeError('Assertions required')
    p=argparse.ArgumentParser();p.add_argument('--original',type=Path,required=True);p.add_argument('--repeat',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    a=p.parse_args();original,oh,ot=inventory(a.original);repeat,rh,rt=inventory(a.repeat)
    assert original==repeat
    report={'accepted':True,'byteIdenticalCompressedRecords':96,'independentPhysicalCases':96,'totalPhysicalExecutions':192,
            'originalManifestSha256':oh,'repeatManifestSha256':rh,'originalWallSeconds':ot,'repeatWallSeconds':rt,
            'verifierSha256':sha(Path(__file__).read_bytes()),'caution':'The repeat is a reproducibility check, not additional independent statistical evidence.'}
    with a.output.open('x') as handle:handle.write(json.dumps(report,sort_keys=True,indent=2)+'\n')
    print(json.dumps(report,indent=2))


if __name__=='__main__':main()
