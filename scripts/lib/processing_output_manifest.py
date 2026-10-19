"""Verify downloaded payloads without inventing missing cloud bookkeeping files.

The opt-in exception is restricted to empty SageMaker upload-complete markers
whose actual payload is present and independently hash-verified. No scientific
file or numerical gate is exempted. The original manifest remains unchanged.
"""
import hashlib
import re
from pathlib import Path

MARKER_SUFFIX = '.sagemaker-uploaded'
EMPTY_SHA256 = hashlib.sha256(b'').hexdigest()


def verify_output_manifest(root, *, allow_empty_upload_markers=False):
    root = Path(root).resolve()
    rows = {}
    for row in (root / 'SHA256SUMS').read_text().splitlines():
        digest, name = row.split('  ', 1)
        path = Path(name)
        if (not re.fullmatch(r'[0-9a-f]{64}', digest) or not name
                or path.is_absolute() or '..' in path.parts
                or path.as_posix() != name or name == 'SHA256SUMS'
                or name in rows):
            raise ValueError(f'Invalid or duplicate manifest entry: {name!r}')
        rows[name] = digest
    if not rows:
        raise ValueError('Empty output manifest')
    paths = list(root.rglob('*'))
    if any(p.is_symlink() for p in paths):
        raise ValueError('Output symlinks are not permitted')
    actual = {p.relative_to(root).as_posix() for p in paths
              if p.is_file() and p != root / 'SHA256SUMS'}
    extra = actual - rows.keys()
    if extra:
        raise ValueError(f'Unmanifested output files: {sorted(extra)}')
    missing = rows.keys() - actual
    omitted = []
    for name in sorted(missing):
        payload = name[:-len(MARKER_SUFFIX)] if name.endswith(MARKER_SUFFIX) else ''
        if (not allow_empty_upload_markers or not payload
                or payload.endswith(MARKER_SUFFIX)
                or rows[name] != EMPTY_SHA256 or payload not in actual):
            raise ValueError(f'Missing required output: {name}')
        omitted.append(dict(file=name, sha256=rows[name], payload=payload,
                            reason='Empty upload-complete bookkeeping marker; absent from S3 download'))
    for name in sorted(actual):
        digest = hashlib.sha256((root / name).read_bytes()).hexdigest()
        if digest != rows[name]:
            raise ValueError(f'Output checksum mismatch: {name}')
    return dict(policy='processing-output-manifest-v2',
                allowEmptyUploadMarkers=allow_empty_upload_markers,
                originalManifestEntries=len(rows), checkedFiles=len(actual),
                checkedPayloadFiles=sum(not n.endswith(MARKER_SUFFIX) for n in actual),
                omittedEmptyUploadMarkers=omitted,
                originalManifestSha256=hashlib.sha256((root / 'SHA256SUMS').read_bytes()).hexdigest())
