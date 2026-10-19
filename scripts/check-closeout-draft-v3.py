#!/usr/bin/env python3
"""Read-only v3 transcription/claim checks; never executes a simulation."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'research/publication_closeout_2026-09-22'
DRAFT = BASE / 'draft_v3'
FIELD = {'si-continuous': 'Continuous', 'si-pulse': 'Pulsed', 'blank': 'Absent'}
REVIEW_IDS = ([f'CFD-{i}' for i in range(1, 6)] +
              [f'GS{i}' for i in range(1, 7)] +
              [f'R{i}' for i in range(1, 8)] +
              [f'P{i}' for i in range(1, 7)])


def outcome_row(r):
    b = r['binary']
    keys = ['encounter', 'nomination', 'inspectionCompleted',
            'supportedExact', 'supportedReleaseWithinPointOne']
    values = [FIELD[r['field']], r['algorithm']]
    values += [str(b[k]['successes']) for k in keys]
    values += [f"{r['continuous']['restrictedEncounterSeconds']['mean']:.1f}"]
    return '| ' + ' | '.join(values) + ' |'


def resource_row(r):
    c = r['continuous']
    return '| ' + ' | '.join([r['algorithm'],
        f"{c['scanHeldSeconds']['mean']:.1f}",
        f"{c['validReadouts']['mean']:.1f}",
        f"{c['completedAt']['mean']:.1f}",
        f"{c['airLitres']['mean']:.2f}"]) + ' |'


def inputs():
    summary = json.loads((ROOT / 'research/analysis/si_stage2i_campaign_2026-09-22/summary.json').read_text())
    controller = (ROOT / 'aws/build/stage2i-20260921-v2/src/sim/algorithms/quadSoilSniff.ts').read_text()
    predicate = re.search(r'  private shouldScan\(.*?(?=\n\n  private adaptiveTriangulationTarget)', controller, re.S).group()
    return summary, predicate


def check_text(text, appendix, log, summary, predicate):
    def need(fragment, body=text):
        if fragment not in body:
            raise ValueError('Missing checked fragment: ' + fragment)
    abstract = text.split('## Abstract\n', 1)[1].split('\nKeywords:', 1)[0].strip()
    if not 1 <= len(abstract.split()) <= 200:
        raise ValueError('Abstract length')
    if re.search(r'\d+/\d+|\d+\.\d{3,}|\[[^\]]+\]\(', abstract):
        raise ValueError('Abstract precision/citation')
    for fragment in [
        'approximately 16% to 88%', '0.10 m tolerance',
        '10 to 17.1 min', 'approximately 66% to 100%',
        'do not demonstrate scale transfer', 'not physical validation']:
        need(fragment, abstract)
    for fragment in [
        'National Institute of Standards and Technology (NIST)',
        'mark intermediate readings ineligible',
        'exactly zero background reference',
        '0.001525 ppm per channel',
        'deliberately imposed motion–readout contract',
        'prospectively primary scheduling outcomes',
        'Nomination occurs at the fixed 600 s',
        'all eligible observation ages',  # checked case-insensitively below
    ]:
        if fragment == 'all eligible observation ages':
            if fragment not in text.lower():
                raise ValueError('Observation ages not disclosed')
        else:
            need(fragment)
    for fragment in [
        'All methods have zero supported release locations within 0.10 m.',
        'Surge–cast encounters gas sooner',
        'separately archived, post-hoc diagnostic of the earlier Stage 2h',
        'not a new diagnostic of the 32 Stage 2i worlds',
        'do not establish that source position is fundamentally unidentifiable',
        'not operational',  # appendix caveat instead, handled below
    ]:
        if fragment == 'not operational':
            need('no operational background-estimation/subtraction', appendix)
        else:
            need(fragment)
    assert len(summary['rows']) == 12
    for r in summary['rows']:
        need(outcome_row(r))
        if r['field'] == 'si-continuous':
            need(resource_row(r), appendix)
    for fragment in [
        '32 | 384 | 480 | 48', '128 | 512 | 544 | 16',
        '128 new | 512 | 544 | 16', '0 new | 512 reused | 544 reused | 16 reused',
        'same 81 of 128 worlds', 'paired counts are 84 and 128',
        '71.9 percentage points', '0.164 m',
        '97.3 s', '85.4', '2.68 × 10⁻¹⁴']:
        need(fragment)
    if predicate.strip() not in appendix:
        raise ValueError('Frozen scan predicate differs')
    for fragment in [
        'rank(A)=6', '≤10⁶', 'λ_upper <−0.006',
        'RMSE_upper ≤0.003', '||p*||₂+ρ* ≤1',
        '17 closed visits', 'five finite samples',
        '598p³', 'not a new statistical analysis',
        'v20.19.6', '1.26.4', '1.16.3']:
        need(fragment, appendix)
    ids = re.findall(r'^\| ((?:CFD-|GS|R|P)\d+) \|', log, re.M)
    if sorted(ids) != sorted(REVIEW_IDS):
        raise ValueError('Review disposition coverage')
    headings = ['## 1. Introduction', '## 2. Previous studies',
                '## 3. Methods', '## 4. Results', '## 5. Discussion',
                '## 6. Conclusions']
    positions = [text.index(x) for x in headings]
    if positions != sorted(positions):
        raise ValueError('Section order')
    tables = re.findall(r'\*\*Table (\d+)\.', text)
    if tables != ['1', '2', '3', '4']:
        raise ValueError('Main table numbering')
    cites = sorted(set(map(int, re.findall(r'\[(\d+)\]\(https://', text))))
    refs = list(map(int, re.findall(r'^(\d+)\. ', text, re.M)))
    if cites != list(range(1, 12)) or refs != cites:
        raise ValueError('Working reference numbering')
    return dict(abstractWords=len(abstract.split()),
        bodyWordsApprox=len(text.split('## 1. Introduction', 1)[1].split('## Declarations', 1)[0].split()),
        appendixWordsApprox=len(appendix.split()), checkedOutcomeRows=12,
        checkedResourceRows=4, reviewDispositions=len(ids),
        exactFrozenScanPredicate=True, mainTables=4, references=cites,
        scope='Selected transcription/structure/claim guard checks; not exhaustive scientific validation')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.output and args.output.exists():
        raise ValueError('Refuse to replace an existing receipt')
    inventory = json.loads((DRAFT / 'revision_sources.json').read_text())
    for r in inventory['protectedDocuments'] + inventory['transcriptionSources']:
        assert hashlib.sha256((ROOT / r['path']).read_bytes()).hexdigest() == r['sha256'], r['path']
    summary, predicate = inputs()
    result = check_text((DRAFT / 'manuscript_v3.md').read_text(),
                        (DRAFT / 'methods_appendix.md').read_text(),
                        (DRAFT / 'revision_record.md').read_text(), summary, predicate)
    parent = subprocess.run([sys.executable, str(ROOT / 'scripts/check-closeout-draft-v2.py')],
                            cwd=ROOT, capture_output=True, text=True, check=True)
    previous = json.loads(parent.stdout)
    tests = subprocess.run([sys.executable, str(ROOT / 'scripts/test-closeout-draft-v3.py')],
                           cwd=ROOT, capture_output=True, text=True, check=True)
    assert 'Ran 10 tests' in tests.stdout + tests.stderr and '\nOK\n' in tests.stdout + tests.stderr
    result.update(checkedAtUtc=datetime.now(timezone.utc).isoformat(),
        protectedDocumentsUnchanged=len(inventory['protectedDocuments']),
        transcriptionSourcesUnchanged=len(inventory['transcriptionSources']),
        acceptedEvidenceSourcesUnchanged=previous['packageChecks']['acceptedSourceHashesUnchanged'],
        inheritedTestsPassed=previous['packageChecks']['testsPassed'] + previous['draftRegressionTestsPassed'],
        newRegressionTestsPassed=10,
        markdownFilesChecked=previous['packageChecks']['markdownFilesChecked'],
        localLinksChecked=previous['packageChecks']['localLinksChecked'],
        factsExactlyReproduced=previous['packageChecks']['factsExactlyReproduced'],
        newSimulation=False, rawHistoryReaudit=False, physicalValidation=False,
        publicDatasetAnalysis=False, submissionReady=False,
        outputHashes={p.name: hashlib.sha256(p.read_bytes()).hexdigest()
                      for p in sorted(DRAFT.glob('*.md'))})
    if args.output:
        with args.output.open('x') as f:
            json.dump(result, f, indent=2)
            f.write('\n')
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
