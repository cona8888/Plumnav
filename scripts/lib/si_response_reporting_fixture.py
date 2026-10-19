"""Versioned terminal reporting from pre-generated, hash-verified binary64 inputs."""
import copy
import hashlib
import json
import math
from pathlib import Path

VERSION = 'fixed-reporting-fixture-v1'
REPLICATES = [600300, *range(600400, 600416), *range(600700, 600732)]
OFFSET_METRES = .1


def canonical(data):
    return (json.dumps(data, sort_keys=True, separators=(',', ':'), allow_nan=False)+'\n').encode()


def finite(value):
    return type(value) in (float, int) and math.isfinite(value)


def validate(data):
    if set(data) != {'version', 'offsetMetres', 'amplitudesMetres', 'replicates', 'generator'}:
        raise ValueError('Invalid fixture schema')
    if data['version'] != VERSION or data['offsetMetres'] != .1 or data['amplitudesMetres'] != [0., .001]:
        raise ValueError('Unsupported reporting contract')
    if set(data['replicates']) != {str(r) for r in REPLICATES}:
        raise ValueError('Fixture seed inventory differs from frozen design')
    generator = data['generator']
    if set(generator) != {'sourceSha256', 'planSha256', 'python', 'platform', 'uniformDrawsPerReplicate', 'seedOffset'}:
        raise ValueError('Missing generation provenance')
    if generator['uniformDrawsPerReplicate'] != 205 or generator['seedOffset'] != 1300101:
        raise ValueError('Random-call contract mismatch')
    for key in ['sourceSha256', 'planSha256']:
        digest = generator[key]
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise ValueError('Invalid generation hash')
    def vector(v, unit=False):
        if not isinstance(v, list) or len(v) != 2 or not all(finite(x) and -1 <= x <= 1 for x in v):
            raise ValueError('Invalid finite vector')
        norm2 = sum(x*x for x in v)
        allowance = 8*math.ulp(1.)
        if norm2 > 1+allowance or (unit and abs(norm2-1) > allowance):
            raise ValueError('Invalid disk/unit vector')
    for vectors in data['replicates'].values():
        if set(vectors) != {'direction', 'visits', 'samples'}:
            raise ValueError('Invalid vector inventory')
        vector(vectors['direction'], True)
        if len(vectors['visits']) != 17 or len(vectors['samples']) != 17:
            raise ValueError('Expected 17 ordered windows')
        for v in vectors['visits']: vector(v)
        for row in vectors['samples']:
            if len(row) != 5: raise ValueError('Expected five ordered readouts')
            for v in row: vector(v)


class ReportingFixture:
    def __init__(self, path, expected_sha256):
        body = Path(path).read_bytes()
        self.sha256 = hashlib.sha256(body).hexdigest()
        if self.sha256 != expected_sha256:
            raise ValueError('Reporting fixture checksum mismatch')
        self._data = json.loads(body)
        if canonical(self._data) != body:
            raise ValueError('Noncanonical reporting fixture serialization')
        validate(self._data)

    def vectors(self, replicate):
        if type(replicate) is not int or replicate not in REPLICATES:
            raise ValueError('Unknown reporting replicate')
        return copy.deepcopy(self._data['replicates'][str(replicate)])

    def provenance(self, replicate):
        self.vectors(replicate)
        return dict(version=VERSION, sha256=self.sha256, reportingReplicate=replicate)


def validate_visits(visits, alternative):
    if set(alternative) != {'model', 'amplitudeMetres'} or not finite(alternative['amplitudeMetres']):
        raise ValueError('Invalid reporting model')
    if (alternative['model'], alternative['amplitudeMetres']) not in [('exact', 0.), ('readout-jitter', .001)]:
        raise ValueError('Unsupported reporting amplitude/model')
    if len(visits) != 17 or any(len(v['samples']) != 5 for v in visits):
        raise ValueError('Reporting requires 17 complete five-readout windows')
    times = []
    for v in visits:
        if not all(finite(v['target'][a]) for a in ('x', 'y')):
            raise ValueError('Nonfinite target')
        for s in v['samples']:
            if not all(finite(s[a]) for a in ('x', 'y', 'time', 'value')):
                raise ValueError('Nonfinite retained observation')
            times.append(s['time'])
    if any(b <= a for a, b in zip(times, times[1:])):
        raise ValueError('Readouts/windows must remain in chronological order')


def transform(visits, alternative, replicate, fixture):
    validate_visits(visits, alternative)
    vectors = fixture.vectors(replicate)
    transformed = copy.deepcopy(visits)
    errors = []
    for i, visit in enumerate(transformed):
        row = []
        for j, sample in enumerate(visit['samples']):
            unit = [0., 0.] if alternative['model'] == 'exact' else vectors['samples'][i][j]
            error = [alternative['amplitudeMetres']*x for x in unit]
            for k, axis in enumerate(('x', 'y')):
                # Keep separate operations in the original order, without FMA.
                sample[axis] = sample[axis]+(error[k]-0.)/OFFSET_METRES
            row.append(error)
        errors.append(row)
    return dict(visits=transformed, worldErrorsMetres=errors,
                anchorErrorMetres=[0., 0.], unitErrors=vectors)
