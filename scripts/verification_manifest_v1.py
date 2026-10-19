"""Explicit payload manifests; empty managed upload markers are local metadata.

Only for new, quiescent outputs. Never repair or reinterpret an old manifest.
Unknown payloads, links, special files and malformed/orphan markers fail closed.
"""
import hashlib
from pathlib import Path, PurePosixPath
import re
import stat

MARKER = '.sagemaker-uploaded'
MANIFEST = 'PAYLOAD_SHA256SUMS_V1'


def need(ok, why):
    if not ok:
        raise ValueError(why)


def safe(name):
    p = PurePosixPath(name)
    need(type(name) is str and str(p) == name and not p.is_absolute()
         and p.parts and '..' not in p.parts and '\\' not in name
         and not any(ord(c) < 32 for c in name), 'Unsafe payload path')
    return name


def sha(path):
    with path.open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def inventory(root, expected, allow_markers, manifest_present):
    root = Path(root)
    need(root.is_dir() and not root.is_symlink(), 'Invalid output root')
    expected = list(expected)
    need(len(expected) == len(set(expected)) and expected, 'Empty/duplicate inventory')
    for n in expected:
        safe(n)
        need(n != MANIFEST and not n.endswith(MARKER), 'Reserved payload name')
    expected = set(expected)
    files, markers = {}, []
    for p in sorted(root.rglob('*')):
        name = safe(p.relative_to(root).as_posix())
        kind = p.lstat().st_mode
        need(not stat.S_ISLNK(kind), 'Symlink: ' + name)
        if stat.S_ISDIR(kind):
            need(any(n.startswith(name + '/') for n in expected), 'Unknown directory: ' + name)
            continue
        need(stat.S_ISREG(kind), 'Non-regular file: ' + name)
        if name == MANIFEST:
            need(manifest_present, 'Manifest already exists')
            continue
        if name.endswith(MARKER):
            companion = name[:-len(MARKER)]
            need(allow_markers and p.stat().st_size == 0 and
                 (companion in expected or (manifest_present and companion == MANIFEST)),
                 'Invalid upload marker: ' + name)
            markers.append(name)
            continue
        need(name in expected, 'Unexpected payload: ' + name)
        files[name] = sha(p)
    need(files.keys() == expected, 'Missing payloads: ' + repr(sorted(expected - files.keys())))
    return files, markers


def write_manifest(root, expected):
    """Caller supplies known payload membership after every producer is closed."""
    root = Path(root)
    expected = list(expected)
    hashes, markers = inventory(root, expected, True, False)
    # Recheck content and membership before writing. Concurrent writers are not
    # supported; this also detects typical accidental changes during finalisation.
    again, _ = inventory(root, expected, True, False)
    need(hashes == again, 'Output changed during manifest generation')
    with (root / MANIFEST).open('x') as f:
        for name, digest in sorted(hashes.items()):
            f.write(f'{digest}  {name}\n')
    return dict(payloads=len(hashes), ignoredLocalMarkers=markers,
                manifestSha256=sha(root / MANIFEST))


def verify_manifest(root, expected, allow_local_markers=False):
    root = Path(root)
    path = root / MANIFEST
    need(path.is_file() and not path.is_symlink(), 'Missing/unsafe manifest')
    declared = {}
    for line in path.read_text().splitlines():
        parts = line.split('  ', 1)
        need(len(parts) == 2, 'Malformed checksum row')
        digest, name = parts
        safe(name)
        need(re.fullmatch('[a-f0-9]{64}', digest) is not None and name not in declared,
             'Invalid/duplicate checksum row')
        declared[name] = digest
    actual, markers = inventory(root, expected, allow_local_markers, True)
    need(declared == actual, 'Manifest membership or content mismatch')
    return dict(passed=True, payloads=len(actual), ignoredLocalMarkers=markers)
