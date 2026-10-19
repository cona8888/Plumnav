#!/usr/bin/env python3
"""Assemble derived evidence from closed studies; never simulate or alter inputs.

The closure pins are recorded at the start of the overnight closeout. Output
is exclusive-create. Source pointers refer to full, preserved JSON records.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parents[1]
PINS = {
    'stage2i': ('research/results/si_stage2i_campaign_closure_2026-09-22.json', 'd8ec434a51df2a579dd9acfcf5f88de6d98830d1dc6d240b4cdeb4eb77c97349'),
    'screen': ('research/results/outdoor_holdout_campaign_v1_2026-09-22/closure.json', 'a58d04fb22b1a3aee31486afc7ee884541b752cb53be15e97f99d9671ad4f0ef'),
    'mechanism': ('research/results/outdoor_mechanism_diagnostic_v1_2026-09-22/closure.json', 'f532719a8c472246a0921965270794aec9219f7d5c74d15733391692575d564c'),
    'budget': ('research/results/outdoor_budget_campaign_v1_2026-09-22/closure.json', 'bdd9d10dc23fbaa060596a9ddea9e9cf29ed7b1ff3a710df9f318f9b2d51ef4e'),
    'reference_correction': ('research/results/outdoor_budget_reference_review_v2_2026-09-22/closure.json', '7e4ce8c5546c9219ce939816e5fa9bef4c91262ec35df1edac32182a1f148d48'),
}
LABELS = {('coverage', 'reference'): 'Coverage', ('surge-cast', 'reference'): 'Surge–cast-inspired',
          ('quad-sniff-refine', 'reference'): 'Periodic quad', ('quad-sniff-refine', 'encounter-gated'): 'Encounter-gated quad'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def wilson(x, n):
    z = 1.959963984540054
    p, zz = x / n, z*z
    centre = (p+zz/(2*n))/(1+zz/n)
    radius = z*math.sqrt(p*(1-p)/n+zz/(4*n*n))/(1+zz/n)
    return [max(0., centre-radius), min(1., centre+radius)]


def check_rate(record, count_key, n):
    x = record[count_key]
    require(isinstance(x, int) and 0 <= x <= n and record.get('n', n) == n, 'Invalid rate denominator/count')
    p = record.get('proportion', record.get('estimate'))
    require(p == x/n, 'Rate disagrees with count')
    require(all(abs(a-b) < 1e-12 for a, b in zip(record['wilson95'], wilson(x, n))), 'Wilson interval disagreement')


def check_stage2i(summary, audit):
    require(summary['primaryMissions'] == 384 and summary['independentPairedWorlds'] == 32, 'Stage 2i denominator')
    require(summary['schedulingContrasts'] == audit['performance']['schedulingContrasts'], 'Stage 2i contrasts changed')
    runs = [r for r in audit['runs'] if r['spec']['caseRole'] == 'primary']
    require(len(runs) == 384 and len(summary['rows']) == 12, 'Stage 2i inventory')
    lookup = {(r['field'], r['algorithm']): r for r in summary['rows']}
    require(len(lookup) == 12, 'Duplicate Stage 2i arm')
    for arm in audit['performance']['arms']:
        key = (arm['field'], LABELS[arm['method'], arm['policy']])
        row = lookup[key]
        group = [r for r in runs if (r['spec']['field'], r['spec']['method'], r['spec']['policy']) == (arm['field'], arm['method'], arm['policy'])]
        require(len(group) == 32 and sorted(r['spec']['replicate'] for r in group) == list(range(700, 732)), 'Stage 2i paired-world membership')
        require(row['n'] == 32 and row['binary'] == arm['binary'] and row['continuous'] == arm['continuous'], 'Stage 2i arm summary disagreement')
        for metric, value in row['binary'].items():
            check_rate(value, 'successes', 32)
            if metric != 'supportedReleaseWithinPointOne':
                require(value['successes'] == sum(bool(r['metrics'][metric]) for r in group), 'Stage 2i binary audit-run count')
        errors = arm['conditionalReleaseErrorsMetres']
        require(errors == row['conditionalSupportedReleaseErrorsMetres'], 'Conditional error values')
        require(row['binary']['supportedReleaseWithinPointOne']['successes'] == sum(e <= .1 for e in errors), 'Release tolerance count')
        require(row['conditionalReleaseErrorMedianMetres'] == (statistics.median(errors) if errors else None), 'Conditional error median')
        require(row['stages'] == dict(Counter(r['summary']['stage'] for r in group)), 'Stage reasons')
        require(row['exactVerificationReasons'] == dict(Counter(d['reason'] for r in group for d in r['decisions'] if d['radius'] == 0)), 'Verifier reasons')
    return list(range(700, 732))


def check_screen(stats):
    require(stats['independentWorldsPerSetting'] == 128 and stats['primaryOutcomes'] == 36864, 'Screen denominator')
    require(len(stats['groups']) == 288, 'Screen settings')
    ids = list(range(1000, 1128)); keys = set()
    for g in stats['groups']:
        check_rate(g, 'alarms', 128)
        require(g['pairedWorlds'] == ids and not g['simultaneousGuarantee'], 'Screen world set/claim boundary')
        key = tuple(g[k] for k in ['wind', 'speed', 'sensor', 'rateKgPerSecond', 'k'])
        require(key not in keys, 'Duplicate screen setting'); keys.add(key)
    return ids


def check_budget(stats):
    require(stats['independentWorldsPerSetting'] == 128 and stats['primaryHistories'] == 512 and stats['primaryOutcomes'] == 4096, 'Budget denominator')
    require(len(stats['groups']) == 16, 'Budget settings')
    ids = list(range(2000, 2128)); keys = set()
    for g in stats['groups']:
        key = tuple(g[k] for k in ['wind', 'speed', 'sensor', 'rateKgPerSecond'])
        require(key not in keys, 'Duplicate budget setting'); keys.add(key)
        pieces = [g[k] for k in ['earlyAlarmWorlds', 'lateOnlyWorlds', 'neitherWorlds']]
        require(sorted(sum(pieces, [])) == ids and g['n'] == 128, 'Budget paired-world partition')
        for j, b in enumerate(g['budgets']):
            check_rate(b, 'alarms', 128)
            expected = pieces[0] if j == 0 else sorted(pieces[0]+pieces[1])
            require(sorted(b['worlds']) == sorted(expected) and b['alarms'] == len(expected), 'Budget alarm membership')
        require([b['budgetSeconds'] for b in g['budgets']] == [600, int(990/g['speed']+36)], 'Budget caps')
        require(g['fullMinusShortAlarmProbability'] == len(pieces[1])/128, 'Paired budget difference')
    return ids


class Sources:
    def __init__(self, root):
        self.root = Path(root)
        self.records = {}

    def add(self, file, expected=None, role='evidence'):
        path = self.root/file
        digest = sha(path)
        if expected is not None:
            require(digest == expected, f'Hash mismatch: {file}')
        self.records[file] = dict(file=file, sha256=digest, bytes=path.stat().st_size, role=role)
        return read(path) if path.suffix == '.json' else path.read_text()

    def closure(self, study):
        file, digest = PINS[study]
        value = self.add(file, digest, 'pinned-acceptance-closure')
        require(value['accepted'] is True, f'Unaccepted study: {study}')
        return value, str(Path(file).parent)

    def closed_files(self, study, names):
        closure, directory = self.closure(study)
        values = {}
        for name in names:
            stem = name.split('.')[0]
            values[stem] = self.add(f'{directory}/{name}', closure[stem+'Sha256'])
        return closure, values


def build(root=ROOT):
    s = Sources(root)
    sc, _ = s.closure('stage2i')
    sa_path = 'research/results/si_stage2i_campaign_audit_2026-09-22/analysis.json'
    sa = s.add(sa_path, sc['independentAuditSha256'], 'accepted-independent-audit')
    ss_path = 'research/analysis/si_stage2i_campaign_2026-09-22/summary.json'
    ss = s.add(ss_path, role='derived-summary-crosschecked-to-audit')
    s.add('research/analysis/si_stage2i_campaign_2026-09-22/report.md', role='accepted-readable-report')
    require(ss['auditSha256'] == sc['independentAuditSha256'] and sa['accepted'], 'Stage 2i audit provenance')
    stage_ids = check_stage2i(ss, sa)
    require(len(sa['details']) == 480 and all(x['passed'] for x in sa['details']) and len(sa['triples']) == 48, 'Stage 2i audit inventory')
    require(all(all(t['gates'].values()) for t in sa['triples']), 'Stage 2i convergence gate')

    hc, hd = s.closed_files('screen', ['manifest.json', 'audit.json', 'report.md'])
    ha = hd['audit']; screen_ids = check_screen(ha['statistics'])
    bc, bd = s.closed_files('budget', ['manifest.json', 'audit.json', 'report.md'])
    ba = bd['audit']; budget_ids = check_budget(ba['statistics'])
    s.add('research/results/outdoor_budget_campaign_v1_2026-09-22/execution-complete.json', bc['executionReceiptSha256'])
    for audit in [ha, ba]:
        require(audit['accepted'] and audit['rawHistories'] == 544 and audit['primaryHistories'] == 512, 'Outdoor audit inventory')
        require(len(audit['checks']) == 544 and all(x['passed'] for x in audit['checks']), 'Outdoor history gate')
        require(len(audit['resolutionTriplets']) == 16 and all(x['passed'] for x in audit['resolutionTriplets']), 'Outdoor resolution gate')
    inf = s.add('research/results/outdoor_budget_campaign_inference_check_2026-09-22.json', '7d3d629a195039a5584e587b4e8ba73fce5187cedaeb4914af870b4e308e00d3', 'separate-counts-and-intervals-check')
    require(inf['accepted'] and inf['campaignClosureSha256'] == PINS['budget'][1], 'Inference acceptance')
    mc, md = s.closed_files('mechanism', ['manifest.json', 'audit.json', 'summary.json', 'report.md'])
    require(md['audit']['accepted'] and mc['postHoc'] and mc['newIndependentWorlds'] == 0, 'Mechanism boundary')
    rc, rd = s.closed_files('reference_correction', ['manifest.json', 'audit.json'])
    require(rd['audit']['priorCampaign']['acceptedWithCorrectedReference'] and rd['audit']['priorCampaign']['unchangedStatistics'], 'Corrected reference prior-campaign review')
    require(rd['audit']['priorCampaign']['priorAuditSha256'] == hc['auditSha256'], 'Corrected reference linkage')
    failed = 'research/results/outdoor_budget_development_v1_2026-09-22/audit.failed.json'
    s.add(failed, rc['preservedFailedAuditSha256'], 'preserved-failed-reference-audit')
    require(not set(screen_ids)&set(budget_ids), 'Outdoor evaluation world overlap')

    for f in ['research/protocols/si_response_replication_v1_2026-09-21.md',
              'research/protocols/si_response_replication_nominal_fallback_2026-09-21.md',
              'research/protocols/outdoor_detectability_v1_2026-09-22.md',
              'research/protocols/outdoor_detectability_holdout_execution_v1_2026-09-22.md',
              'research/protocols/outdoor_budget_campaign_v1_2026-09-22.md',
              'research/protocols/outdoor_budget_reference_amendment_v2_2026-09-22.md',
              'research/protocols/outdoor_mission_budget_development_v1_2026-09-22.md',
              'research/protocols/outdoor_controller_adapter_admission_2026-09-22.md']:
        s.add(f, role='scope-or-prospective-protocol')

    studies = [
        dict(id='stage2i', name='Nominal-response algorithm replication', role='prospective-replication',
             independentWorlds=32, worldIds=stage_ids, worldIdMeaning='replicate', primaryHistories=384,
             auditedHistories=480, resolutionTriplets=48, newWorlds=True, domainMetres=10,
             inference='Paired percentile 95% bootstrap, 10000 resamples; pointwise Wilson 95% arm rates. Degenerate bootstrap intervals do not exclude rare unobserved outcomes.',
             endpoints=['encounter', 'supported concentration maximum', 'supported release within 0.10 m', 'time/distance/air'],
             summarySource=dict(file=ss_path, pointer='/rows'), primarySource=dict(file=sa_path, pointer='/performance/schedulingContrasts')),
        dict(id='screen', name='Outdoor sensor/survey screen', role='prospective-held-out-evaluation',
             independentWorlds=128, worldIds=screen_ids, worldIdMeaning='world', primaryHistories=512,
             auditedHistories=544, resolutionTriplets=16, pairedOutcomes=36864, newWorlds=True, domainMetres=100,
             inference='Nominal Bonferroni-adjusted paired bootstrap for two primary endpoints; all grid intervals pointwise Wilson 95%, not simultaneous certification.',
             endpoints=['event alarm', 'blank alarm', '600 s restricted mean alarm time'],
             summarySource=dict(file='research/results/outdoor_holdout_campaign_v1_2026-09-22/audit.json', pointer='/statistics')),
        dict(id='budget', name='Outdoor mission-budget evaluation', role='prospective-held-out-evaluation',
             independentWorlds=128, worldIds=budget_ids, worldIdMeaning='world', primaryHistories=512,
             auditedHistories=544, resolutionTriplets=16, pairedOutcomes=4096, newWorlds=True, domainMetres=100,
             inference='Two exact Clopper–Pearson 97.5% paired late-alarm intervals; Bonferroni family coverage at least 95% under independent-world sampling. Other cells pointwise descriptive.',
             endpoints=['additional detection by full route', 'additional blank alarm', 'budget-specific restricted mean'],
             summarySource=dict(file='research/results/outdoor_budget_campaign_v1_2026-09-22/audit.json', pointer='/statistics')),
        dict(id='mechanism', name='Measurement-chain diagnostic', role='post-hoc-reanalysis',
             independentWorlds=128, worldIds=screen_ids, worldIdMeaning='same screen worlds', primaryHistories=512,
             auditedHistories=544, resolutionTriplets=16, newWorlds=False, newIndependentWorlds=0, domainMetres=100,
             inference='Descriptive paired counterfactual replay; some counterfactual decisions/times do not converge. Original recorded binary decisions remain stable.',
             endpoints=['threshold opportunity', 'ideal/lagged/noisy detector stages'],
             summarySource=dict(file='research/results/outdoor_mechanism_diagnostic_v1_2026-09-22/summary.json', pointer='/groups')),
    ]
    for study in studies:
        study['closure'] = dict(file=PINS[study['id']][0], sha256=PINS[study['id']][1])
        study['physicalValidation'] = False
    mechanism_groups = [g for g in md['summary']['groups'] if g['wind'] == .5 and g['speed'] == 1 and g['sensor'] in ['generic-sigma0.2-tau0.5', 'generic-sigma0.2-tau5'] and g['rateKgPerSecond'] == 1e-4 and g['k'] == 5]
    data = dict(stage2i=ss, screen=ha['statistics'], budget=ba['statistics'],
                mechanism=dict(postHoc=True, newIndependentWorlds=0, selectedPrimarySettingGroups=mechanism_groups,
                               refinement=md['summary']['refinement']))
    index = dict(schemaVersion='plumenav-evidence-index-v1', createdAt=datetime.now(timezone.utc).isoformat(),
                 derivationOnly=True, newSimulation=False, physicalValidation=False, studies=studies,
                 poolingPermitted=False, sources=list(s.records.values()),
                 disclosures=['Counterfactual replay is not new replication.',
                              'The long-interval independent quadrature correction is retained with its original failed audit.',
                              'The slower Stage 2i sensor failed prospective timing admission and has no performance result.',
                              'Separate model/endpoint/measurement contracts prevent a pooled algorithm ranking.',
                              'The application is a demo/replay companion, not a validation method.'],
                 verifier=dict(source='scripts/build-closeout-evidence.py', sha256=sha(Path(__file__)),
                               rawAuditsRerun=False, scope='Closed-artifact hashes, source-summary equality, counts, world memberships, intervals and numerical gate inventories; not a repeated raw-physics audit.'))
    return index, data


def render(index, output):
    def link(label, file):
        return f'[{label}]({os.path.relpath(ROOT/file, output)})'
    lines = ['# PlumeNav numerical evidence index', '',
             'Derived from accepted saved evidence. No simulation was run for this package. Numerical verification is not physical validation. Do not pool study denominators.', '',
             '| Study | Independent worlds per setting | Primary histories | Audited histories | Resolution triplets | Role |',
             '|---|---:|---:|---:|---:|---|']
    for x in index['studies']:
        role = x['role'] + ('; zero new worlds' if not x['newWorlds'] else '')
        lines.append(f"| {link(x['name'], x['closure']['file'])} | {x['independentWorlds']} | {x['primaryHistories']} | {x['auditedHistories']} | {x['resolutionTriplets']} | {role} |")
    lines += ['', 'Counts across paired variants, numerical refinements and reused diagnostic histories are not independent replicates. World numbering is study-specific; a disjoint numeric ID check alone is not proof of independent random streams.', '', '## Reproducibility and interpretation', '']
    for x in index['studies']:
        lines += [f"### {x['name']}", '',
                  f"- {x['domainMetres']} m domain; {x['worldIdMeaning']} IDs {x['worldIds'][0]}–{x['worldIds'][-1]}.",
                  '- Endpoints: '+', '.join(x['endpoints'])+'.',
                  '- Inference: '+x['inference'],
                  '- Source: '+link(x['summarySource']['pointer'], x['summarySource']['file'])+'.', '']
    lines += ['## Preserved limitations', ''] + ['- '+x for x in index['disclosures']]
    lines += ['', 'No calibrated device recommendation, universal minimum emission rate, physical suction reach, urban-flow validation, coupled soil–air validation or buried-defect location follows from these records.', '',
              '## Verification performed for this derived package', '', index['verifier']['scope']+'.', '',
              'The machine-readable index contains each inspected source path, size and SHA-256. `figure_data.json` carries the accepted numerical records without refitting or selecting favourable outcomes. Figure-specific captions must state any subset shown.', '',
              'Rebuild with `python scripts/build-closeout-evidence.py --output NEW_DIRECTORY`. Output must not already exist. A failed check raises an error before any package is created.', '']
    return '\n'.join(lines)


def main():
    p = argparse.ArgumentParser(); p.add_argument('--output', type=Path, required=True); args = p.parse_args()
    require(not args.output.exists(), 'Choose a new output directory; accepted packages are never overwritten')
    index, data = build()
    args.output.mkdir(parents=True, exist_ok=False)
    for name, value in [('evidence_index.json', index), ('figure_data.json', data)]:
        with (args.output/name).open('x') as f:
            json.dump(value, f, indent=2, allow_nan=False); f.write('\n')
    with (args.output/'README.md').open('x') as f:
        f.write(render(index, args.output.resolve()))
    receipt = dict(derivedPackage=True, checksPassed=True, newSimulation=False, physicalValidation=False,
                   sourcesChecked=len(index['sources']), studies=len(index['studies']),
                   outputs={name: sha(args.output/name) for name in ['evidence_index.json', 'figure_data.json', 'README.md']},
                   builderSha256=sha(Path(__file__)))
    with (args.output/'derivation_receipt.json').open('x') as f:
        json.dump(receipt, f, indent=2); f.write('\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
