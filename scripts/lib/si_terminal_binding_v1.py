"""Artificial file-chain binding; deliberately not a real audit certificate."""
import hashlib
from pathlib import Path
import re
from lib.si_exact_registry_v1 import strict_json
from lib.si_terminal_report_v1 import exact_keys, terminal_metadata
from lib.si_release_endpoint_v2 import endpoint

VERSION = 'synthetic-terminal-binding-v1'
ROLES = ('history', 'completion', 'process', 'audit')


def digest(raw): return hashlib.sha256(raw).hexdigest()


def identity(value):
    exact_keys(value, ('worldKey', 'arm', 'field', 'navDt'))
    if type(value['worldKey']) is not str or not re.fullmatch(r'synthetic-[A-Za-z0-9-]+', value['worldKey']):
        raise ValueError('Synthetic world identity required')
    if value['arm'] not in ('RW', 'GW', 'RL', 'GL', 'NS') or value['field'] not in ('si-continuous', 'si-pulse', 'blank') or value['navDt'] not in ('1/16', '1/32', '1/64'):
        raise ValueError('Unknown case identity')


def checked_file(root, name, expected):
    if type(name) is not str or '\\' in name or any(p in ('', '.', '..') for p in name.split('/')) or name.startswith('/'):
        raise ValueError('Unsafe relative artifact path')
    if type(expected) is not str or not re.fullmatch('[0-9a-f]{64}', expected):
        raise ValueError('Invalid artifact hash')
    current = root
    for part in name.split('/'):
        current = current / part
        if current.is_symlink():
            raise ValueError('Symlink artifact not admitted')
    if not current.is_file() or not current.resolve().is_relative_to(root):
        raise ValueError('Missing or escaping artifact')
    raw = current.read_bytes()
    if len(raw) > 2_000_000 or digest(raw) != expected:
        raise ValueError('Artifact size/hash mismatch')
    return strict_json(raw)


def bind_fixture(directory, expected_manifest_sha256):
    root = Path(directory)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Regular fixture directory required')
    root = root.resolve()
    manifest = checked_file(root, 'manifest.json', expected_manifest_sha256)
    exact_keys(manifest, ('version', 'purpose', 'syntheticOnly', 'identity', 'artifacts'))
    if manifest['version'] != 'synthetic-terminal-manifest-v1' or manifest['purpose'] != 'synthetic-terminal-binding-only' or manifest['syntheticOnly'] is not True:
        raise ValueError('Unadmitted manifest scope/version')
    case = manifest['identity']; identity(case)
    exact_keys(manifest['artifacts'], ROLES)
    paths = set(); files = {}
    for role in ROLES:
        item = manifest['artifacts'][role]; exact_keys(item, ('path', 'sha256'))
        if type(item['path']) is not str or item['path'] in paths or item['path'] == 'manifest.json':
            raise ValueError('Colliding artifact paths')
        paths.add(item['path']); files[role] = checked_file(root, item['path'], item['sha256'])
    for role, data in files.items():
        extras = {'history': ('config', 'nomination', 'verification', 'summary'),
                  'completion': ('completed', 'historySha256'), 'process': ('exitCode', 'timedOut'),
                  'audit': ('passed', 'historySha256', 'realAuditExecuted')}[role]
        exact_keys(data, ('version', 'syntheticOnly', 'identity', *extras))
        if data['version'] != f'synthetic-terminal-{role}-v1' or data['syntheticOnly'] is not True or data['identity'] != case:
            raise ValueError('Artifact scope/version/identity mismatch')
        identity(data['identity'])
    h = manifest['artifacts']['history']['sha256']
    if files['completion']['completed'] is not True or files['completion']['historySha256'] != h:
        raise ValueError('Stale or incomplete completion receipt')
    terminal = files['process']
    if type(terminal['exitCode']) is not int or terminal['exitCode'] != 0 or terminal['timedOut'] is not False:
        raise ValueError('Process did not complete successfully')
    audit = files['audit']
    if audit['passed'] is not True or audit['historySha256'] != h or audit['realAuditExecuted'] is not False:
        raise ValueError('Stale, failed or non-synthetic audit receipt')
    r = files['history']
    meta = dict(auditPassed=True, **terminal_metadata(case['field'], r['config'], r['nomination'], r['verification'], r['summary']))
    return dict(version=VERSION, identity=dict(case), metadata=meta, endpoint=endpoint(meta),
                provenance=dict(manifestSha256=expected_manifest_sha256, artifacts=manifest['artifacts']),
                scope=dict(syntheticOnly=True, realAuditExecuted=False, realHistoryBindingVerified=False,
                           physicalValidation=False, realCampaignAdmitted=False))


def bind_fixtures(entries):
    if type(entries) is not list or not entries:
        raise ValueError('Nonempty fixture list required')
    results = []; seen = set()
    for entry in entries:
        exact_keys(entry, ('directory', 'manifestSha256'))
        result = bind_fixture(entry['directory'], entry['manifestSha256'])
        key = tuple(result['identity'][name] for name in ('worldKey', 'arm', 'field', 'navDt'))
        if key in seen:
            raise ValueError('Duplicate case identity')
        seen.add(key); results.append(result)
    return results
