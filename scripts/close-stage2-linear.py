#!/usr/bin/env python3
"""Post-analysis provenance closure; never changes a scientific acceptance gate."""
import hashlib
import json
from pathlib import Path


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def sources(root, manifest):
    for item in manifest['sources']:
        assert digest(item['file']) == item['sha256'], item['file']
        assert digest(root / 'source-snapshot' / item['name']) == item['sha256']
    return len(manifest['sources'])


def close_panel(panel, expected):
    root = Path(f'research/evidence/si_linear_{panel}_2026-09-17')
    result = Path(f'research/results/si_linear_{panel}_2026-09-17')
    manifest = read(root / 'manifest.json')
    done = read(root / 'complete.json')
    analysis = read(result / 'analysis.json')
    accepted = read(result / 'complete.json')
    assert done['complete'] and not done['failures']
    assert len(done['workers']) == 4
    assert all(w['status'] == 'fulfilled' and w['value']['code'] == 0 for w in done['workers'])
    assert done['manifestSha256'] == digest(root / 'manifest.json') == analysis['manifestSha256']
    assert accepted['complete'] and accepted['analysisSha256'] == digest(result / 'analysis.json')
    flags = ['integrityPassed', 'coupledResolutionPassed', 'absentControlPassed', 'absentBitIdentical']
    assert all(analysis[k] == accepted[k] for k in flags)
    assert analysis['integrityPassed'] and analysis['performance'] is None
    assert manifest['caseCount'] == done['caseCount'] == len(analysis['runs']) == expected
    assert len(analysis['triples']) == expected // 3
    count = sources(root, manifest)
    indices = []
    byte_count = 0
    max_rss = 0
    for worker in range(4):
        directory = root / f'worker-{worker}'
        status = read(directory / 'complete.json')
        assert status['complete'] and status['worker'] == worker
        assert status['pid'] == done['workers'][worker]['value']['pid']
        assert len(status['inventory']) == expected // 4
        assert {p.name for p in directory.glob('*.json.gz')} == {i['file'] for i in status['inventory']}
        for item in status['inventory']:
            path = directory / item['file']
            assert digest(path) == item['sha256'] and path.stat().st_size == item['bytes']
            assert item['index'] % 4 == worker
            assert item['replay']['passed'] and item['replay']['schedulingTraceMatched']
            assert item['replay']['privateFieldQueries'] == 0
            indices.append(item['index'])
            byte_count += item['bytes']
        max_rss = max(max_rss, status['maxRssBytes'])
    assert sorted(indices) == list(range(expected))
    triples = analysis['triples']
    return dict(panel=panel, **{k: analysis[k] for k in flags}, cases=expected,
                passedTriplets=sum(t['passed'] for t in triples), totalTriplets=len(triples),
                sourceCount=count, rawBytes=byte_count, maxSampledWorkerRssBytes=max_rss,
                simulationSeconds=done['elapsedSeconds'], auditSeconds=analysis['elapsedSeconds'],
                manifestSha256=digest(root / 'manifest.json'), analysisSha256=digest(result / 'analysis.json'),
                counts=analysis['counts'],
                maximumFineDifferences=dict(
                    bodyMetres=max(t['maximumBodyDifferenceMetres'] for t in triples),
                    nomineeMetres=max(t['nominationDifferenceMetres'] or 0 for t in triples),
                    completionSeconds=max(t['completionDifferenceSeconds'] for t in triples),
                    scalarC0=max(t['scalarFineDifference'] for t in triples),
                    headingRadians=max(t['directionalFine']['all']['headingRadians'] for t in triples),
                    inletOffsetMetres=max(t['directionalFine']['all']['inletOffsetMetres'] for t in triples),
                    labeledInletMetres=max(t['directionalFine']['all']['labeledInletMetres'] for t in triples),
                    filteredC0=max(max(t['directionalFine']['all']['filteredC0']) for t in triples),
                    readoutC0=max(max(t['directionalFine']['all']['readoutC0']) for t in triples)),
                failedTriplets=[dict(world=t['worldIndex'], field=t['field'], method=t['method'],
                                     policy=t['policy'], indices=t['indices'],
                                     gates=[k for k, v in t['gates'].items() if not v])
                                for t in triples if not t['passed']])


def main():
    fixed = Path('research/evidence/si_linear_fixed_2026-09-17')
    fm = read(fixed / 'manifest.json')
    fd = read(fixed / 'complete.json')
    fa = Path('research/results/si_linear_fixed_2026-09-17')
    result = read(fa / 'analysis.json')
    assert fd['complete'] and result['integrityPassed'] and result['numericalPassed']
    assert digest(fixed / 'manifest.json') == fd['manifestSha256'] == result['manifestSha256']
    assert digest(fa / 'analysis.json') == read(fa / 'complete.json')['analysisSha256']
    sources(fixed, fm)
    assert digest(fm['canonicalRawFile']) == fm['canonicalRawSha256']
    for item in fd['histories']:
        assert digest(fixed / item['file']) == item['sha256']
    assert len(fd['histories']) == 15
    old = Path('research/results/si_turn_fresh_2026-09-17/analysis.json')
    assert digest(old) == 'b59a5cc5ef4ca697932719e0515a6976a355325f09e1317b14fa2c3b2298341e'
    prior = read(old)
    assert prior['integrityPassed'] and not prior['coupledResolutionPassed'] and prior['performance'] is None
    panels = [close_panel('diagnostic', 36), close_panel('fresh', 144)]
    dm = read('research/evidence/si_linear_diagnostic_2026-09-17/manifest.json')
    nm = read('research/evidence/si_linear_fresh_2026-09-17/manifest.json')
    assert dm['designs']['linear-fresh'] == nm['cases']
    assert dm['sources'] == nm['sources']
    assert nm['diagnosticAnalysisSha256'] == panels[0]['analysisSha256']
    closure = dict(schemaVersion='si-linear-provenance-closure-v1', provenancePassed=True,
                   frozenSourcesPreserved=True, previousFailurePreserved=True,
                   freshDesignProspectivelyFrozen=True, panels=panels,
                   fixedPathAnalysisSha256=digest(fa / 'analysis.json'),
                   concurrencyWitnessSha256=digest('research/evidence/si_linear_fresh_2026-09-17/concurrency-witness.md'),
                   closureScriptSha256=digest(__file__), performance=None)
    output = Path('research/results/si_linear_response_closure_2026-09-17.json')
    with output.open('x') as stream:
        json.dump(closure, stream, indent=2, allow_nan=False)
        stream.write('\n')
    print(json.dumps(closure, indent=2))


if __name__ == '__main__':
    main()
