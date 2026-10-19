#!/usr/bin/env python3
"""Guard selected draft claims and structure; no simulation or statistical fit."""
import argparse
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import importlib.util
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT/'research/publication_closeout_2026-09-22'
DRAFT = BASE/'draft_v1/manuscript_idea_v1.md'


def rounded(x, places=3):
    return f'{Decimal(str(x)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP):.{places}f}'


def check_text(text, facts):
    def require(fragment):
        if fragment not in text:
            raise ValueError('Missing/changed checked fragment: '+fragment)
        return fragment
    abstract = text.split('## Abstract\n', 1)[1].split('\nKeywords:', 1)[0].strip()
    abstract_words = len(abstract.split())
    if not 1 <= abstract_words <= 200:
        raise ValueError(f'Abstract word count {abstract_words} exceeds 200')
    if re.search(r'\[[^\]]+\]\(', abstract):
        raise ValueError('Abstract contains a citation/link')
    keywords = text.split('Keywords:', 1)[1].split('\n\n', 1)[0].split(';')
    if not 3 <= len(keywords) <= 7:
        raise ValueError('Keyword count')
    for heading in ['## 1. Introduction', '## 2. Methods', '## 3. Results',
                    '## 4. Discussion', '## 5. Conclusions',
                    '### 2.7. Statistical analysis', '## Declarations']:
        require(heading)
    c = facts['C1_stage2i_continuous']
    assert [r['n'] for r in c] == [32]*4
    assert [r['supportedMaxima'] for r in c] == [0, 2, 5, 28]
    assert all(r['supportedReleaseWithin0p10m'] == 0 for r in c)
    checked = [require('supports a local concentration\nmaximum in 28/32 missions, compared with 5/32'),
               require('All four methods have zero supported release locations within 0.10 m'),
               require('using\nall 32 missions per method as the denominator')]
    metrics = facts['C2_stage2i_scheduling']['metrics']
    for key, label in [('encounter', '62.500'), ('supportedExact', '71.875')]:
        assert rounded(100*metrics[key]['mean']) == label
        checked.append(require(label))
    for key, label in [('distanceAtEncounterOrSearchEnd', '5.997'),
                       ('completedAt', '227.469'), ('airLitres', '3.791')]:
        assert rounded(metrics[key]['mean']) == label
        checked.append(require(label))
    errors = facts['C1_conditionalGatedError']
    checked.append(require(rounded(errors['medianMetres'], 5)))
    for value in errors['rangeMetres']:
        checked.append(require(rounded(value, 5)))
    screen = facts['C4_screen_primary']
    assert screen['n'] == 128 and screen['both'] == 81 and screen['neither'] == 47
    assert screen['fastOnly'] == screen['slowOnly'] == 0
    checked.append(require('both response models alarm in the same 81/128 worlds'))
    budget = facts['C6_budget_primary']
    assert budget[0]['n'] == budget[1]['n'] == 128
    assert budget[0]['lateAlarms'] == 44 and budget[1]['lateAlarms'] == 0
    for value in [budget[0]['difference'], *budget[0]['interval975'], budget[1]['interval975'][1]]:
        checked.append(require(rounded(100*value)))
    primary = [g for g in facts['C7_budget_allEmittingCells']
               if g['wind'] == .5 and g['speed'] == 1 and 'tau0.5' in g['sensor']]
    assert len(primary) == 1
    assert [b['alarms'] for b in primary[0]['budgets']] == [84, 128]
    checked.append(require('alarms increase from 84/128 at 600 s\nto 128/128 at 1026 s'))
    checked.append(require('0 new | 512 reused | 544 reused | 16 reused'))
    for row in ['32 | 384 | 480 | 48', '128 | 512 | 544 | 16', '128 new | 512 | 544 | 16']:
        checked.append(require(row))
    require('nominal\nBonferroni-adjusted paired bootstrap intervals')
    require('not a before/after effect')
    require('AUTHOR GATE 2: Check the scientific ideas and order. Language polishing comes later.')
    cited = sorted(set(int(n) for n in re.findall(r'\[(\d+)\]\(https://', text)))
    bibliography = sorted(int(n) for n in re.findall(r'^(\d+)\. ', text, re.M))
    if cited != list(range(1, 8)) or bibliography != cited:
        raise ValueError('Citation/bibliography numbering mismatch')
    prose = text.split('## Declarations', 1)[0]
    variants = re.findall(r'\b(?:localisation|modelling|normalisation|analysed|behaviour|metres|idealised)\b', prose)
    if variants:
        raise ValueError('Non-US prose variants: '+str(variants))
    return {'abstractWordsWhitespaceCount': abstract_words, 'keywords': len(keywords),
            'bodyWordsWhitespaceCountApprox': len(text.split('## 1. Introduction', 1)[1].split('## Declarations', 1)[0].split()),
            'checkedNumericAndInventoryFragments': checked,
            'referenceNumbersCited': cited, 'stage2ReviewGatePresent': True,
            'pendingFlags': re.findall(r'\[(?:author input needed|evidence needed|author check):[^\]]+\]', text),
            'scope': 'Selected numerical/structure checks only; not exhaustive scientific or citation validation'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.output:
        assert not args.output.exists(), 'Refuse to overwrite a receipt'
    spec = importlib.util.spec_from_file_location('package_check', ROOT/'scripts/check-closeout-package.py')
    package = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(package)
    parent = package.check()
    facts = json.loads((BASE/'story_v1/claim_facts.json').read_text())['facts']
    result = check_text(DRAFT.read_text(), facts)
    result.update({'checkedAtUtc': datetime.now(timezone.utc).isoformat(),
                   'draftSha256': hashlib.sha256(DRAFT.read_bytes()).hexdigest(),
                   'packageChecks': {k: parent[k] for k in ['acceptedSourceHashesUnchanged',
                      'markdownFilesChecked', 'localLinksChecked', 'factsExactlyReproduced', 'testsPassed']},
                   'newSimulation': False, 'authorApprovedFinalDraft': False})
    if args.output:
        with args.output.open('x') as stream:
            json.dump(result, stream, indent=2)
            stream.write('\n')
    print(json.dumps({k: result[k] for k in ['abstractWordsWhitespaceCount',
          'bodyWordsWhitespaceCountApprox', 'keywords', 'referenceNumbersCited', 'packageChecks']}))


if __name__ == '__main__':
    main()
