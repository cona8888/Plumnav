"""Post-audit matched-clock pose/readout diagnostic for the 1 mm intervention."""
import gzip, hashlib, json, math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STUDY = ROOT / 'research/evidence/si_precision_arrival_2026-09-15'
AUDIT = ROOT / 'research/evidence/si_precision_arrival_audit_2026-09-15'
OUT = ROOT / 'research/evidence/si_precision_pose_diagnostic_2026-09-15'

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def load(index):
    return json.loads(gzip.decompress((STUDY / f'run-{index}.json.gz').read_bytes()))

assert json.loads((STUDY / 'complete.json').read_text())['cases'] == 66
assert json.loads((AUDIT / 'complete.json').read_text())['complete']
rows = json.loads((STUDY / 'summary.json').read_text())['rows']
comparisons = []
for field in sorted(set(r['field'] for r in rows)):
    for mode in ('nominal', 'zero'):
        fine_index = next(i for i, r in enumerate(rows) if (r['field'], r['noiseMode'], r['dt']) == (field, mode, .0625))
        fine = load(fine_index)
        for dt in (.25, .125):
            index = next(i for i, r in enumerate(rows) if (r['field'], r['noiseMode'], r['dt']) == (field, mode, dt))
            coarse = load(index)
            L = coarse['config']['domainMeters']
            half_head = coarse['config']['localInletSampling']['opposingInletSpacingMetres'] / 2
            positions, headings, inlet_bounds, readouts = [], [], [], []
            for cv, fv in zip(coarse['visits'], fine['visits']):
                assert [s['time'] for s in cv['samples']] == [s['time'] for s in fv['samples']]
                for cs, fs in zip(cv['samples'], fv['samples']):
                    ct = coarse['trace'][round(cs['time'] / dt)]
                    ft = fine['trace'][round(fs['time'] / .0625)]
                    d = L * math.hypot(ct['position']['x'] - ft['position']['x'], ct['position']['y'] - ft['position']['y'])
                    angle = abs(math.atan2(math.sin(ct['heading'] - ft['heading']), math.cos(ct['heading'] - ft['heading'])))
                    positions.append(d)
                    headings.append(angle)
                    inlet_bounds.append(d + 2 * half_head * abs(math.sin(angle / 2)))
                    readouts.append(abs(cs['value'] - fs['value']))
            comparisons.append({'field': field, 'noiseMode': mode, 'dt': dt, 'matchedReadouts': len(readouts), 'maxPositionDifferenceMetres': max(positions), 'meanPositionDifferenceMetres': sum(positions) / len(positions), 'maxHeadingDifferenceRadians': max(headings), 'maxCorrespondingInletDisplacementUpperBoundMetres': max(inlet_bounds), 'maxMatchedReadoutDifferenceC0': max(readouts), 'medianMatchedReadoutDifferenceC0': sorted(readouts)[len(readouts)//2]})

OUT.mkdir()
body = {'scope': 'Post-audit descriptive matching at identical sample times. The corresponding-inlet displacement is an upper bound; residual readout differences may also reflect history, temporal transport quadrature, or noise. No frozen gate is revised.', 'parentCompleteSha256': sha(STUDY / 'complete.json'), 'auditCompleteSha256': sha(AUDIT / 'complete.json'), 'comparisons': comparisons}
(OUT / 'diagnostic.json').write_text(json.dumps(body, indent=2) + '\n')
(OUT / 'si-precision-pose-diagnostic.py').write_bytes(Path(__file__).read_bytes())
(OUT / 'complete.json').write_text(json.dumps({'complete': True, 'diagnosticSha256': sha(OUT / 'diagnostic.json'), 'sourceSha256': sha(OUT / 'si-precision-pose-diagnostic.py')}) + '\n')
print(json.dumps({'comparisons': len(comparisons), 'maximumPositionDifferenceMetres': max(c['maxPositionDifferenceMetres'] for c in comparisons), 'maximumHeadingDifferenceRadians': max(c['maxHeadingDifferenceRadians'] for c in comparisons), 'maximumReadoutDifferenceC0': max(c['maxMatchedReadoutDifferenceC0'] for c in comparisons)}))
