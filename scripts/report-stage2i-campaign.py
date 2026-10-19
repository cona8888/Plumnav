#!/usr/bin/env python3
"""Report frozen replication statistics only after independent campaign closure."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import statistics

LABELS = {('coverage', 'reference'): 'Coverage', ('surge-cast', 'reference'): 'Surge–cast-inspired',
          ('quad-sniff-refine', 'reference'): 'Periodic quad',
          ('quad-sniff-refine', 'encounter-gated'): 'Encounter-gated quad'}
FIELDS = {'si-continuous': 'Continuous', 'si-pulse': 'Pulsed', 'blank': 'Absent'}


def main():
    p = argparse.ArgumentParser()
    for key in ['audit', 'closure', 'output']: p.add_argument('--'+key, type=Path, required=True)
    a = p.parse_args()
    closure = json.loads(a.closure.read_text()); body = a.audit.read_bytes()
    assert closure['accepted'] and closure['downloadedAndIndependentlyAudited']
    assert closure['independentAuditSha256'] == hashlib.sha256(body).hexdigest()
    data = json.loads(body); perf = data['performance']
    assert data['accepted'] and perf['independentWorlds'] == 32 and perf['primaryMissions'] == 384
    assert perf['responseContrasts'] == []
    primary = [r for r in data['runs'] if r['spec']['caseRole'] == 'primary']
    rows = []
    for arm in perf['arms']:
        group = [r for r in primary if (r['spec']['field'], r['spec']['method'], r['spec']['policy']) == (arm['field'], arm['method'], arm['policy'])]
        assert len(group) == 32 and arm['responseScale'] == 1
        errors = arm['conditionalReleaseErrorsMetres']
        row = dict(field=arm['field'], algorithm=LABELS[arm['method'], arm['policy']], n=32,
                   binary=arm['binary'], continuous=arm['continuous'],
                   conditionalSupportedReleaseErrorsMetres=errors,
                   conditionalReleaseErrorMedianMetres=statistics.median(errors) if errors else None,
                   conditionalReleaseErrorRangeMetres=[min(errors), max(errors)] if errors else None,
                   stages=dict(Counter(r['summary']['stage'] for r in group)),
                   exactVerificationReasons=dict(Counter(str(d['reason']) for r in group for d in r['decisions'] if d['radius'] == 0)))
        rows.append(row)
    a.output.mkdir(parents=True, exist_ok=False)
    result = dict(auditSha256=closure['independentAuditSha256'], rows=rows,
                  schedulingContrasts=perf['schedulingContrasts'], primaryMissions=384,
                  independentPairedWorlds=32, numericalWitnessesNotReplicates=True,
                  responseSensitivityNotRun=True, claimBoundary=closure['claimBoundary'])
    with (a.output/'summary.json').open('x') as f: json.dump(result, f, indent=2, allow_nan=False); f.write('\n')
    text = ['# Stage 2i: independently accepted nominal-response replication', '',
            'All 480 full histories and 48 coupled-resolution triplets passed. Performance uses 384 primary missions across **32 fresh paired worlds**; coarse histories and reporting repeats are not independent samples. These worlds are reported separately from the earlier 16 exploratory worlds.', '',
            'The prespecified intervention changes the scan trigger from periodic to encounter-gated, with the shared nomination/verifier, nominal sensor response and physical inputs fixed. Coverage and surge–cast-inspired integrations provide context, not claims of complete canonical-method equivalence.', '',
            '## Outcomes', '',
            '| Field | Method | Encounter /32 | Nominee /32 | Inspection /32 | Maximum support exact / jitter | Supported release within 0.10 m /32 | Restricted encounter time (s) |',
            '|---|---|---:|---:|---:|---:|---:|---:|']
    for r in rows:
        b, c = r['binary'], r['continuous']
        text.append(f"| {FIELDS[r['field']]} | {r['algorithm']} | {b['encounter']['successes']} | {b['nomination']['successes']} | {b['inspectionCompleted']['successes']} | {b['supportedExact']['successes']} / {b['supportedJitter']['successes']} | {b['supportedReleaseWithinPointOne']['successes']} | {c['restrictedEncounterSeconds']['mean']:.1f} |")
    text += ['', 'The release-tolerance endpoint is separate from local-maximum support and was frozen before this campaign. Unresolved missions remain in the /32 denominator. Conditional error distributions in summary.json include supported exact-coordinate reports only; they are not all-mission accuracy.', '',
             '## Paired scheduling contrasts', '',
             'Gated minus periodic; intervals use the frozen 10,000 paired-world bootstrap resamples (seed 282991). Negative time/distance differences mean less. Binary arm rates and Wilson intervals are retained in summary.json. No formal superiority test or universal ranking was specified.', '',
             '| Field | Metric | Difference | Paired percentile 95% interval |', '|---|---|---:|---|']
    for con in perf['schedulingContrasts']:
        for metric in ['encounter', 'supportedExact', 'supportedReleaseWithinPointOne', 'restrictedEncounterSeconds', 'distanceAtEncounterOrSearchEnd', 'scanHeldSeconds', 'airLitres']:
            d = con['metrics'][metric]; scale = 100 if metric in ['encounter', 'supportedExact', 'supportedReleaseWithinPointOne'] else 1
            suffix = ' pp' if scale == 100 else ''
            lo, hi = d['bootstrapPercentile95']
            text.append(f"| {FIELDS[con['field']]} | {metric} | {d['mean']*scale:.3f}{suffix} | [{lo*scale:.3f}, {hi*scale:.3f}] |")
    text += ['', 'A degenerate empirical interval does not rule out rare unobserved outcomes. Failure-to-encounter time is restricted at the frozen 600 s search budget; route distance is measured to encounter or that route’s search endpoint.', '',
             '## Full failure accounting', '',
             'The exact-coordinate reason is counted once per primary inspection. The jittered observation is paired sensitivity, not an independent trial.', '']
    for r in rows:
        text.append(f"- {FIELDS[r['field']]} / {r['algorithm']}: stages {json.dumps(r['stages'])}; verifier reasons {json.dumps(r['exactVerificationReasons'])}.")
    text += ['', '## Claim and deployment limits', '',
             closure['claimBoundary'], '',
             'This campaign is a controlled nominal-response numerical replication under prescribed open-terrain transport. The slower-response condition failed admission before fresh-world outcomes and was excluded using the prospective fallback; no slower-sensor performance result exists. A first-order instrument model and ideal odometry are declared assumptions, not calibrated commercial hardware.', '',
             'The six sand/clay saturation calculations remain supporting source-strength sensitivity. This campaign does not validate coupled soil-to-atmosphere flux, urban wakes, long-range suction, or buried-pipe defect coordinates. Non-detection remains unresolved, not evidence of no leak. The app is a demonstration/replay interface, not the scientific validation method.', '',
             'The fixed study is now ready for bounded synthesis, not post-hoc tuning. Preserve every abstention and failed earlier stage; do not pool exploratory worlds into the untouched replication or relabel maximum support as release localization.', '']
    with (a.output/'report.md').open('x') as f: f.write('\n'.join(text))
    print(json.dumps(dict(report=str(a.output/'report.md'), rows=len(rows), auditSha256=closure['independentAuditSha256'])))


if __name__ == '__main__': main()
