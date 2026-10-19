#!/usr/bin/env python3
"""Finalize the immutable Stage 1n evidence after both required gates pass."""
import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
import statistics


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--raw', type=Path, required=True)
    p.add_argument('--analysis', type=Path, required=True)
    args = p.parse_args()
    raw_manifest = (args.raw / 'manifest.json').read_bytes()
    manifest = json.loads(raw_manifest)
    analysis_bytes = (args.analysis / 'analysis.json').read_bytes()
    analysis = json.loads(analysis_bytes)
    audit_bytes = (args.analysis / 'independent-audit.json').read_bytes()
    audit = json.loads(audit_bytes)
    summaries_bytes = (args.analysis / 'run-summaries.json').read_bytes()
    summaries = json.loads(summaries_bytes)
    done = json.loads((args.analysis / 'complete.json').read_text())
    assert done['complete'] and done['analysisSha256'] == sha(analysis_bytes)
    assert done['summarySha256'] == sha(summaries_bytes)
    assert analysis['physicalIntegrityAccepted'] and analysis['passed']
    assert audit['accepted'] and not audit['errors']
    assert audit['analysisSha256'] == sha(analysis_bytes)
    assert audit['rawManifestSha256'] == analysis['rawManifestSha256'] == sha(raw_manifest)
    assert audit['reportingEvaluations'] == analysis['pairedEvaluations'] == len(summaries) == 4560
    for source in manifest['sources']:
        assert sha(Path(source['file']).read_bytes()) == source['sha256']
        assert sha((args.raw / 'source-snapshot' / source['name']).read_bytes()) == source['sha256']
    durations = []
    null_peaks = supported = 0
    for item in analysis['rawInventory']:
        raw = (args.raw / item['file']).read_bytes()
        assert sha(raw) == item['sha256']
        durations.append(json.loads(gzip.decompress(raw))['summary']['completedAt'])
    for item in analysis['variantInventory']:
        raw = (args.analysis / item['file']).read_bytes()
        assert sha(raw) == item['sha256'] and len(raw) == item['bytes']
        block = json.loads(gzip.decompress(raw))
        for variant in block['variants']:
            result = variant['v4']
            assert result['version'] == 'bounded-pose-v4'
            supported += result['status'] == 'supported'
            envelopes = ([result['geometry']] + [p['envelope'] for p in result['crossfit']['pairs']]) if 'geometry' in result else []
            for envelope in envelopes:
                if envelope['admitted'] and envelope['eigenMaxUpper'] >= -.006:
                    assert all(envelope[k] is None for k in ['peak', 'peakRadius', 'peakNormUpper'])
                    null_peaks += 1
    positive_fields = {'peak', 'offset-peak', 'si-continuous'}
    controls = [r for r in summaries if r['physicalSpec']['field'] not in positive_fields]
    core = [r for r in summaries if r['physicalSpec']['field'] in positive_fields and r['physicalSpec']['panel'] == 'core']
    stress = [r for r in summaries if r['physicalSpec']['field'] in positive_fields and r['physicalSpec']['panel'] == 'noise-stress']
    def counts(records):
        keys = sorted({(r['model'], r['amplitudeMetres']) for r in records})
        return [dict(model=model, amplitudeMetres=amplitude,
                     physicalCases=len(rs), v3Support=sum(r['v3']['status'] == 'supported' for r in rs),
                     v4Support=sum(r['v4']['status'] == 'supported' for r in rs),
                     v4Reasons=dict(Counter(r['v4']['reason'] for r in rs)))
                for model, amplitude in keys
                for rs in [[r for r in records if (r['model'], r['amplitudeMetres']) == (model, amplitude)]]]
    result = {
        'accepted': True, 'scope': 'Stage 1n conditional numerical component validation only; not app release or physical-source validation',
        'physicalInspections': len(durations), 'pairedEvaluations': len(summaries),
        'controlAlternatives': len(controls), 'controlSupports': sum(r['v4']['status'] == 'supported' for r in controls),
        'supportedAlternatives': supported,
        'pairedFitEnclosuresChecked': sum(r['coverageDiagnostic'] is not None for r in summaries),
        'unsupportedPeakNullDiagnosticsChecked': null_peaks,
        'corePositives': counts(core), 'noiseStressPositives': counts(stress),
        'simulatedInspectionSeconds': {'minimum': min(durations), 'median': statistics.median(durations), 'maximum': max(durations)},
        'physicalWallSeconds': analysis['physicalWallSeconds'], 'analysisWallSeconds': analysis['analysisWallSeconds'],
        'maxSampledWorkerRssBytes': max(w['maxRssBytes'] for w in analysis['workerExecution']),
        'rawManifestSha256': sha(raw_manifest), 'analysisSha256': sha(analysis_bytes),
        'auditSha256': sha(audit_bytes), 'summarySha256': sha(summaries_bytes),
        'finalizerSha256': sha(Path(__file__).read_bytes()), 'frozenSourcesUnchanged': True,
        'earlierFailuresRetained': True,
    }
    with (args.analysis / 'validation-summary.json').open('x') as handle:
        handle.write(json.dumps(result, sort_keys=True, indent=2) + '\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
