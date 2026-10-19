"""Reconstruct the exact terminal TAR from checksum-bound inbound parts.

Transport only: no AWS calls, source changes, audits, or simulations. Originals
are preserved. An incomplete/mismatched reconstruction remains diagnostic.
"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE_SHA = 'e5700b6a9e4f2ee5aa0a21d27a2c3d158ecf95f1d35f5689f573d5ff6aba90a7'
ARCHIVE_BYTES = 1897267200
PARTS = (
    ('resource-v2-terminal.part-aa', 943718400, '7e5bbf3aba26150d5861c5f3277a5e25924d4ddcaf58c89b45308deb8ca51b49'),
    ('resource-v2-terminal.part-ab', 943718400, 'a87574e736ad53d9ae70a1d1c8c7dece8455caa205fc588e1a7d3d29f2976be5'),
    ('resource-v2-terminal.part-ac', 9830400, '26abb4d5809c403d2b5ecfd26feab90328acac991ddf826d94289ee9ec9eec5b'),
)


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def reassemble(parts_dir, destination, parts=PARTS, archive_sha=ARCHIVE_SHA,
               archive_bytes=ARCHIVE_BYTES):
    destination = destination.resolve()
    if destination.exists():
        raise ValueError('Fresh destination required; never overwrite evidence')
    sources = []
    for name, size, expected in parts:
        path = parts_dir / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size != size or digest(path) != expected:
            raise ValueError('Inbound part size/checksum mismatch: ' + name)
        sources.append(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256()
    count = 0
    with destination.open('xb') as target:
        for source in sources:
            with source.open('rb') as stream:
                for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
                    target.write(block)
                    h.update(block)
                    count += len(block)
    if count != archive_bytes or h.hexdigest() != archive_sha:
        raise ValueError('Reconstructed archive mismatch; preserve diagnostic file')
    return dict(transportVerified=True, archive=str(destination), bytes=count,
                sha256=h.hexdigest(), parts=[str(p) for p in sources],
                scientificallyAccepted=False, awsCalls=0, newMissions=0)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--parts-directory', type=Path, required=True)
    p.add_argument('--destination', type=Path, required=True)
    a = p.parse_args()
    if not a.destination.resolve().is_relative_to(ROOT):
        raise ValueError('Destination must be in the project workspace')
    print(json.dumps(reassemble(a.parts_directory, a.destination), indent=2))


if __name__ == '__main__':
    main()
