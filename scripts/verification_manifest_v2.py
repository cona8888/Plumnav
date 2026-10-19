"""V2 local upload-marker handling; the V1 payload ledger format is unchanged.

Only for NEW outputs whose producers have closed. This does not repair an old
manifest or relax remote acceptance. Managed markers must be empty regular files
for exact declared companions. Their concurrent disappearance is harmless; any
payload disappearance or mutation fails. No files are deleted or modified here.
"""
import hashlib
from pathlib import Path, PurePosixPath
import re
import stat

MARKERS = ('.sagemaker-uploaded', '.sagemaker-uploading')
MANIFEST = 'PAYLOAD_SHA256SUMS_V1'


def need(ok, why):
    if not ok:
        raise ValueError(why)


def safe(name):
    need(type(name) is str, 'Unsafe payload path')
    p = PurePosixPath(name)
    need(str(p) == name and not p.is_absolute() and p.parts
         and '..' not in p.parts and '\\' not in name
         and not any(ord(c) < 32 for c in name), 'Unsafe payload path')
    return name


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def companion(name):
    return next((name[:-len(s)] for s in MARKERS if name.endswith(s)), None)


def inventory(root, expected, allow_markers, manifest_present):
    root = Path(root)
    need(root.is_dir() and not root.is_symlink(), 'Invalid output root')
    expected = list(expected)
    need(len(expected) == len(set(expected)) and expected, 'Empty/duplicate inventory')
    for name in expected:
        safe(name)
        need(name != MANIFEST and companion(name) is None, 'Reserved payload name')
    expected = set(expected)
    files, markers = {}, []
    for path in sorted(root.rglob('*')):
        name = safe(path.relative_to(root).as_posix())
        base = companion(name)
        marker_allowed = (allow_markers and base is not None
                          and (base in expected or (manifest_present and base == MANIFEST)))
        try:
            info = path.lstat()
        except FileNotFoundError:
            # Only enumerated, known managed metadata may vanish during upload.
            # Never suppress disappearance of a payload or unknown object.
            need(marker_allowed, 'Missing file during inventory: ' + name)
            continue
        need(not stat.S_ISLNK(info.st_mode), 'Symlink: ' + name)
        if stat.S_ISDIR(info.st_mode):
            need(base is None and any(n.startswith(name + '/') for n in expected),
                 'Unknown directory: ' + name)
            continue
        need(stat.S_ISREG(info.st_mode), 'Non-regular file: ' + name)
        if name == MANIFEST:
            need(manifest_present, 'Manifest already exists')
            continue
        if base is not None:
            need(marker_allowed and info.st_size == 0, 'Invalid upload marker: ' + name)
            markers.append(name)
            continue
        need(name in expected, 'Unexpected payload: ' + name)
        files[name] = sha(path)
    need(files.keys() == expected, 'Missing payloads: ' + repr(sorted(expected - files.keys())))
    return files, markers


def write_manifest(root, expected):
    """Hash all declared closed payloads twice; ignore only safe local metadata."""
    root, expected = Path(root), list(expected)
    hashes, markers = inventory(root, expected, True, False)
    again, _ = inventory(root, expected, True, False)
    need(hashes == again, 'Output changed during manifest generation')
    with (root / MANIFEST).open('x') as stream:
        for name, digest in sorted(hashes.items()):
            stream.write(f'{digest}  {name}\n')
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
