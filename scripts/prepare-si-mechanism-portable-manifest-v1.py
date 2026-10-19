"""Derived portable metadata only; no engines, outcome reads or AWS calls.

Keep the original prospective manifest unchanged. Remove only its duplicate
absolute auditor alias after proving it pins the same relative file. The exact
worlds, cases, protocol and remaining source entries must match the original.
This is not production admission.
"""
import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

from lib.si_mechanism_registry_v3 import Registry, validate

ROOT = Path(__file__).resolve().parents[1]
ORIGINAL = ROOT/'research/results/si_mechanism_all_arm_v2_attempt01_2026-09-25/prospective_manifest_v2.json'
ORIGINAL_SHA = '0f68a87ea6a902848948338d1c5d076bef214bb7f5e59708203df77c2cb6d6cd'
ALIAS = '/Users/w.cha@bham.ac.uk/Documents/Gas source localization App/scripts/audit-si-readout-full-history.py'
RELATIVE = 'scripts/audit-si-readout-full-history.py'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def portable(original):
    validate(original)
    pins = {r['path']: r['sha256'] for r in original['sources']}
    if ALIAS not in pins or RELATIVE not in pins or pins[ALIAS] != pins[RELATIVE]:
        raise ValueError('Only a verified identical duplicate auditor alias may be removed')
    result = copy.deepcopy(original)
    result['sources'] = [r for r in result['sources'] if r['path'] != ALIAS]
    for row in result['sources']:
        path = Path(row['path'])
        if path.is_absolute() or '..' in path.parts:
            raise ValueError('Unexpected non-portable source')
    validate(result)
    check = copy.deepcopy(result)
    check['sources'] = original['sources']
    if check != original:
        raise ValueError('Scientific allocation or protocol changed')
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    if not out.is_relative_to(ROOT) or out.exists():
        raise ValueError('Fresh workspace output directory required')
    raw = ORIGINAL.read_bytes()
    registry = Registry(ORIGINAL, ORIGINAL_SHA)
    document = portable(registry.document)
    encoded = (json.dumps(document, indent=2)+'\n').encode()
    out.mkdir()
    target = out/'prospective_manifest_portable_v1.json'
    target.write_bytes(encoded)
    derived = Registry(target, sha(encoded))
    registry.protect()
    if ORIGINAL.read_bytes() != raw:
        raise ValueError('Original manifest changed')
    receipt = dict(version='mechanism-portable-metadata-v1',
        createdAt=datetime.now(timezone.utc).isoformat(),
        originalPath=str(ORIGINAL.relative_to(ROOT)), originalSha256=ORIGINAL_SHA,
        derivedSha256=derived.sha256, originalSourcePins=len(registry.document['sources']),
        derivedSourcePins=len(document['sources']), worlds=len(derived.worlds),
        histories=len(derived.cases), refinementTriplets=240,
        removedDuplicateAlias=dict(path=ALIAS, equivalent=RELATIVE,
            sha256=next(r['sha256'] for r in document['sources'] if r['path']==RELATIVE)),
        unchanged=['worlds','cases','protocolSha256','version','purpose','all remaining source bytes'],
        originalPreserved=True, newMissions=0, awsCalls=0,
        sourcePinsVerified=True, productionAdmitted=False,
        required='Independent resource-witness acceptance, frozen execution release and budget approval')
    (out/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
