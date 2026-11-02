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
            print(json.dumps({'survey': survey, 'rows': samples.tolist(),
                              'truth': {'latitude': meta['SourceLatitude'], 'longitude': meta['SourceLongitude']}},
                             allow_nan=False, separators=(',', ':')))
