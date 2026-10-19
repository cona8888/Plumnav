"""Hash-pinned artificial registry prototype; not a fresh-world seed allocator."""
import hashlib
import json
import math
from pathlib import Path
import re

VERSION = 'si-exact-registry-v1'
MAX_SAFE_INTEGER = 2**53 - 1
SOURCES = ('scripts/lib/si_stationary_head_contract.py',
           'scripts/lib/si_bounded_pose_v4.py', 'scripts/lib/si_bounded_pose.py')


def safe_integer(value):
    return type(value) is int and 0 <= value <= MAX_SAFE_INTEGER


def strict_json(raw):
    def pairs(items):
        out = {}
        for key, value in items:
            if key in out:
                raise ValueError('Duplicate JSON key')
            out[key] = value
        return out
    def constant(value):
        raise ValueError('Non-finite JSON constant: ' + value)
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    finite_json(value)
    return value


def finite_json(value):
    if value is None or type(value) in (str, bool, int):
        return
    if type(value) is float and math.isfinite(value):
        return
    if type(value) is list:
        for item in value:
            finite_json(item)
        return
    if type(value) is dict and all(type(k) is str for k in value):
        for item in value.values():
            finite_json(item)
        return
    raise ValueError('Not finite JSON data')


def validate(data):
    if type(data) is not dict or set(data) != {'version', 'purpose', 'worlds', 'excludedReportingReplicates', 'verifierSources'}:
        raise ValueError('Registry keys')
    if data['version'] != VERSION or data['purpose'] != 'synthetic-interface-admission':
        raise ValueError('Registry version or scope not admitted')
    excluded = data['excludedReportingReplicates']
    if type(excluded) is not list or not all(safe_integer(x) for x in excluded) or len(excluded) != len(set(excluded)):
        raise ValueError('Excluded identities')
    worlds = data['worlds']
    if type(worlds) is not list or not worlds:
        raise ValueError('Missing worlds')
    keys, identities = set(), set()
    for row in worlds:
        if type(row) is not dict or set(row) != {'worldKey', 'reportingReplicate'}:
            raise ValueError('World keys')
        key, identity = row['worldKey'], row['reportingReplicate']
        if type(key) is not str or not re.fullmatch(r'synthetic-[A-Za-z0-9-]+', key) or key in keys:
            raise ValueError('World key invalid or duplicate')
        if not safe_integer(identity) or identity in identities or identity in excluded:
            raise ValueError('Identity invalid, duplicate or excluded')
        keys.add(key); identities.add(identity)
    sources = data['verifierSources']
    if type(sources) is not dict or set(sources) != set(SOURCES):
        raise ValueError('Verifier source set')
    if any(type(value) is not str or not re.fullmatch('[0-9a-f]{64}', value) for value in sources.values()):
        raise ValueError('Invalid source digest')


class ExactRegistry:
    def __init__(self, path, expected_sha256):
        raw = Path(path).read_bytes()
        self.sha256 = hashlib.sha256(raw).hexdigest()
        if self.sha256 != expected_sha256:
            raise ValueError('Registry hash mismatch')
        data = strict_json(raw)
        validate(data)
        root = Path(__file__).resolve().parents[2]
        for name, expected in data['verifierSources'].items():
            if hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
                raise ValueError('Verifier source hash mismatch: ' + name)
        self._identities = {row['worldKey']: row['reportingReplicate'] for row in data['worlds']}

    def check(self, world_key, identity):
        if type(world_key) is not str or not safe_integer(identity) or self._identities.get(world_key) != identity:
            raise ValueError('Undeclared world/reporting identity pair')
