"""Independent midpoint oracle using the previously tested M54 implementation."""
import json
from m54_source_reference import Release, pulse, continuous

rows = []
for wind in (0.02, 0.1):
    release = Release(diffusivity=0.001, wind=(wind, 0), source=(0, 0, 0.025), sigma=0.15)
    for point in ((0.05, 0, 0.05), (0.35, 0.1, 0.05), (0.45, 0.1, 0.05)):
        for time in (300, 307, 900):
            rows.append(dict(wind=wind, point=dict(zip(('x', 'y', 'z'), point)), time=time,
                pulse=pulse(point, 3, 2e-9, release),
                midpoint65536=continuous(point, time, 2e-9, panels=65536, release=release),
                midpoint131072=continuous(point, time, 2e-9, panels=131072, release=release)))
print(json.dumps(rows))
