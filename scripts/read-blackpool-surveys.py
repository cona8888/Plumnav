"""Decode the authors' time-aligned UAV surveys from their published MATLAB files."""
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile

import numpy as np
from scipy.io import loadmat

archive = Path(sys.argv[1])
with archive.open('rb') as src:
    if hashlib.file_digest(src, 'sha256').hexdigest() != '4f1053c692a4210092238bba855ff2236ae6357bb7dada86ea1bce16c986b603':
        raise ValueError('Expected the unmodified Blackpool Zenodo v1 archive')

with zipfile.ZipFile(archive) as data:
    for uav, count in [(1, 7), (2, 15)]:
        for flight in range(1, count + 1):
            survey = f'T{uav}.{flight}'
            item = data.read(f'UAV{uav} Results/{survey}.mat')
            mat = loadmat(io.BytesIO(item), simplify_cells=True, variable_names=['FullData', 'Variables', 'CH4'])
            full, meta = mat['FullData'], mat['Variables']
            # Absolute GPS and mole fraction only. X/Y, Q and model fields use the study's source information.
            samples = np.column_stack([full[k] for k in ('Time', 'IntLatitude', 'IntLongitude', 'CH4')])
            if not np.isfinite(samples).all() or np.any(np.diff(samples[:, 0]) <= 0):
                raise ValueError(f'Invalid observations in {survey}')
            if not np.allclose(samples[:, 3] * 1e-6, mat['CH4'], rtol=1e-10, atol=0):
                raise ValueError(f'Inconsistent methane units in {survey}')
            # At the station height the archived profile reproduces the observed mean U/V.
            reference = np.flatnonzero(np.isclose(full['WindHeights'], 3.30, atol=1e-8, rtol=0))
            if reference.size != 1:
                raise ValueError(f'Missing wind reference height in {survey}')
            east, north = (float(full[k][reference[0]]) for k in ('WindU', 'WindV'))
            bearing_from = np.arctan2(-east, -north)
            if abs(np.angle(np.exp(1j * (bearing_from - meta['WindDirection'])))) > 1e-6:
                raise ValueError(f'Station wind bearing convention mismatch in {survey}')
            # Propagate the archived component uncertainties into an angular sensitivity.
            # An uncertainty rectangle enclosing zero gives no usable direction.
            ue, un = (float(full[k][reference[0]]) for k in ('WindUUncertainty', 'WindVUncertainty'))
            if not np.isfinite([ue, un]).all() or min(ue, un) < 0:
                raise ValueError(f'Invalid wind-component uncertainties in {survey}')
            if abs(east) <= ue and abs(north) <= un:
                spread = 180.0
            else:
                corners = [np.arctan2(-(east + i * ue), -(north + j * un))
                           for i in (-1, 1) for j in (-1, 1)]
                spread = float(np.degrees(max(abs(np.angle(np.exp(1j * (a - bearing_from)))) for a in corners)))
            wind = {'eastMetresPerSecond': east, 'northMetresPerSecond': north,
                    'angularSpreadDegrees': spread}
            print(json.dumps({'survey': survey, 'rows': samples.tolist(), 'wind': wind,
                              'truth': {'latitude': meta['SourceLatitude'], 'longitude': meta['SourceLongitude']}},
                             allow_nan=False, separators=(',', ':')))
