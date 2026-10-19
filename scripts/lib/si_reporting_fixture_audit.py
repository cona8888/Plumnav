"""Independent reporting arithmetic: exact rationals, rounded at each operation."""
import copy
from fractions import Fraction
from lib.si_reporting_fixture import validate_visits


def number(x):
    return Fraction.from_float(float(x))


def transform(visits, alternative, replicate, fixture):
    validate_visits(visits, alternative)
    vectors = fixture.vectors(replicate)
    observations = copy.deepcopy(visits)
    errors = []
    amplitude = number(alternative['amplitudeMetres'])
    offset = number(.1)
    for i in range(17):
        errors.append([])
        for j in range(5):
            components = [0., 0.] if alternative['model'] == 'exact' else vectors['samples'][i][j]
            e = []
            for k, axis in enumerate(('x', 'y')):
                error = float(amplitude*number(components[k]))
                centred = float(number(error)-number(0.))
                shift = float(number(centred)/offset)
                observations[i]['samples'][j][axis] = float(number(visits[i]['samples'][j][axis])+number(shift))
                e.append(error)
            errors[-1].append(e)
    return dict(visits=observations, worldErrorsMetres=errors,
                anchorErrorMetres=[0., 0.], unitErrors=vectors)


def check_observation(visits, alternative, replicate, fixture, saved):
    expected = transform(visits, alternative, replicate, fixture)
    if expected != saved:
        raise ValueError('Exact fixed-input reporting observation mismatch')
    return True
