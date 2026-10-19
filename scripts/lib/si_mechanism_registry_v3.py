"""Case-bound metadata validation; never generates a field or changes a verifier."""
import hashlib
from pathlib import Path
from lib.si_exact_registry_v1 import strict_json, safe_integer

ROOT = Path(__file__).resolve().parents[2]
VERSION = 'si-mechanism-cases-v2'
ARMS = {'RW': ('reference', 'original-withheld'), 'GW': ('encounter-gated', 'original-withheld'),
        'RL': ('reference', 'live-passive'), 'GL': ('encounter-gated', 'live-passive'),
        'NS': ('reference', 'live-passive')}
FIELDS = ('si-continuous', 'si-pulse', 'blank')
ROLES = ('worldSeed', 'sourceSeed', 'startSeed', 'controllerSeed')
VERIFIER_SOURCES = ('scripts/lib/si_stationary_head_contract.py',
                    'scripts/lib/si_bounded_pose_v4.py', 'scripts/lib/si_bounded_pose.py')


def check(condition, message):
    if not condition:
        raise ValueError(message)


def validate(m):
    check(type(m) is dict and set(m) == {'version', 'purpose', 'worlds', 'cases', 'sources', 'protocolSha256'}, 'Manifest keys')
    check(m['version'] == VERSION, 'Manifest version')
    check(m['purpose'] in ('full-development-worker-admission', 'prospective-128-not-authorised-to-run'), 'Manifest purpose')
    check(type(m['worlds']) is list and type(m['cases']) is list, 'World/case arrays')
    worlds, identities, seeds = {}, set(), set()
    for w in m['worlds']:
        check(type(w) is dict and set(w) == {'key', 'index', 'replicate', 'reportingReplicate', *ROLES}, 'World keys')
        check(type(w['key']) is str and w['key'] not in worlds and w['key'].startswith('mechanism-'), 'World identity')
        check(all(safe_integer(w[k]) for k in ('index', 'replicate', 'reportingReplicate', *ROLES)), 'Integer world metadata')
        check(w['reportingReplicate'] == 600000 + w['replicate'] and w['replicate'] not in identities, 'Reporting identity')
        values = [w[k] for k in ROLES] + [w['worldSeed'] + 3000000]
        check(all(0 < x < 2**32 for x in values) and len(set(values)) == 5 and not (seeds & set(values)), 'Seed alias/overflow')
        seeds.update(values); identities.add(w['replicate']); worlds[w['key']] = w
    cases, combinations = {}, set()
    for c in m['cases']:
        check(type(c) is dict and set(c) == {'id', 'worldKey', 'arm', 'spec'}, 'Case keys')
        check(type(c['id']) is str and c['id'] and c['id'].replace('-', '').isalnum() and c['id'] not in cases, 'Case identity')
        check(c['worldKey'] in worlds and c['arm'] in ARMS, 'Case world/arm')
        s, w = c['spec'], worlds[c['worldKey']]
        check(type(s) is dict and set(s) == {'index', 'panel', 'studyId', 'caseRole', 'responseScale', 'worldIndex', 'replicate', 'field', 'method', 'policy', 'navDt', *ROLES}, 'Spec keys')
        expected_index = 0 if m['purpose'] == 'full-development-worker-admission' else len(cases)
        check(safe_integer(s['index']) and s['index'] == expected_index, 'Case index')
        check(s['panel'] == 'linear-fresh' and s['studyId'] == 'scheduling-response-replication-v1', 'Inherited type carrier')
        check(type(s['responseScale']) is int and s['responseScale'] == 1 and s['method'] == 'quad-sniff-refine', 'Response/method')
        check(s['field'] in FIELDS and s['policy'] == ARMS[c['arm']][0], 'Arm routing')
        check(type(s['navDt']) in (int, float) and s['navDt'] in (1/16, 1/32, 1/64), 'Navigation clock')
        check(all(type(s[k]) is int and s[k] == w[k] for k in ('replicate', *ROLES)) and type(s['worldIndex']) is int and s['worldIndex'] == w['index'], 'Spec/world binding')
        role = 'diagnostic' if m['purpose'] == 'full-development-worker-admission' else ('primary' if s['navDt'] == 1/64 else 'resolution-witness')
        check(s['caseRole'] == role, 'Case role')
        combination = (c['worldKey'], c['arm'], s['field'], s['navDt'])
        check(combination not in combinations, 'Duplicate case combination')
        combinations.add(combination); cases[c['id']] = c
    if m['purpose'] == 'full-development-worker-admission':
        check(len(worlds) == 1 and len(cases) == 45, 'Development admission count')
        w = next(iter(worlds.values()))
        check(w == dict(key='mechanism-development-3000', index=0, replicate=3000, reportingReplicate=603000,
                        worldSeed=281301, sourceSeed=281501, startSeed=281701, controllerSeed=281901), 'Development world restriction')
        check(combinations == {(w['key'], arm, field, dt) for arm in ARMS for field in FIELDS for dt in (1/16, 1/32, 1/64)}, 'Development case restriction')
    else:
        check(len(worlds) == 128 and {w['index'] for w in worlds.values()} == set(range(128)), '128 world indices')
        expected = {(w['key'], arm, field, dt) for w in worlds.values() for arm in ARMS for field in FIELDS
                    for dt in ((1/64, 1/16, 1/32) if w['index'] % 8 == 0 else (1/64,))}
        check(len(cases) == 2400 and combinations == expected, 'Complete 2400-case factorial/witness allocation')
    check(type(m['sources']) is list and len(m['sources']) > 0, 'Source inventory')
    names = set()
    for row in m['sources']:
        check(type(row) is dict and set(row) == {'path', 'sha256'}, 'Source entry')
        check(type(row['path']) is str and row['path'] not in names, 'Duplicate source')
        check(type(row['sha256']) is str and len(row['sha256']) == 64 and all(x in '0123456789abcdef' for x in row['sha256']), 'Source digest')
        names.add(row['path'])
    check(set(VERIFIER_SOURCES) <= names, 'Missing verifier sources')
    protocol = 'research/protocols/si_readout_mechanism_128_v1_2026-09-25.md'
    check(any(r['path'] == protocol and r['sha256'] == m['protocolSha256'] for r in m['sources']), 'Protocol pin')
    return worlds, cases


class Registry:
    def __init__(self, path, expected_sha):
        raw = Path(path).read_bytes(); self.sha256 = hashlib.sha256(raw).hexdigest()
        check(self.sha256 == expected_sha, 'Manifest hash mismatch')
        self.document = strict_json(raw)
        self.worlds, self.cases = validate(self.document)
        self.protect()

    def protect(self):
        for row in self.document['sources']:
            path = (ROOT / row['path']).resolve()
            check(path.is_relative_to(ROOT) and path.is_file(), 'Source outside workspace/missing')
            check(hashlib.sha256(path.read_bytes()).hexdigest() == row['sha256'], 'Source hash mismatch: ' + row['path'])
