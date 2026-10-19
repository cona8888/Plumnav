#!/usr/bin/env python3
"""Read-only diagnosis of field quadrature; never grants acceptance."""
import gzip
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('auditor', Path(__file__).with_name('audit-outdoor-detectability.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
root = Path(sys.argv[1])
for file in sorted(root.glob('trace-*.json.gz')):
    trace = json.loads(gzip.decompress(file.read_bytes()))
    if trace['spec']['world'] != 0:
        continue
    rows = trace['inlet']
    peak = max(range(len(rows)), key=lambda i: rows[i]['referenceExcessPpm'])
    checks = []
    for i in sorted({0, len(rows)//2, len(rows)-1, peak, max(0, peak-1), min(len(rows)-1, peak+1)}):
        row = rows[i]
        reference = audit.independent_concentration(row, trace['fieldSettings'], row['t']+600)
        error = abs(row['referenceExcessPpm']-reference)
        checks.append(dict(i=i, referencePpm=reference, actualPpm=row['referenceExcessPpm'],
                           absoluteErrorPpm=error, errorToTolerance=error/(1e-6+.001*abs(reference))))
    print(json.dumps(dict(file=file.name, spec=trace['spec'], source=trace['world']['source'],
                         worst=max(checks, key=lambda r: r['errorToTolerance']))))
