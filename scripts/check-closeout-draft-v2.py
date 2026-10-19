#!/usr/bin/env python3
"""Read-only idea-draft v2 checks; no simulation or new statistical estimation."""
import argparse
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT/'research/publication_closeout_2026-09-22'
DRAFT = BASE/'draft_v2/manuscript_idea_v2.md'


def rounded(x, places=1):
    return f'{Decimal(str(x)).quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP):.{places}f}'


def check_text(text, facts):
    def need(s):
        if s not in text:
            raise ValueError('Missing checked fragment: '+s)
        return s
    abstract = text.split('## Abstract\n', 1)[1].split('\nKeywords:', 1)[0].strip()
    if not 1 <= len(abstract.split()) <= 200:
        raise ValueError('Abstract length exceeds 200 words')
    if re.search(r'\d+/\d+|\d+\.\d{3,}|\[[^\]]+\]\(', abstract):
        raise ValueError('Abstract contains raw fraction, excessive precision or citation')
    for fragment in ['approximately 16% to 88%', '0.10 m tolerance',
                     '10 to 17.1 min', 'approximately 66% to 100%',
                     'not physical validation']:
        if fragment not in abstract:
            raise ValueError('Abstract scientific anchor missing: '+fragment)
    headings = ['## 1. Introduction', '## 2. Previous studies', '## 3. Methods',
                '## 4. Results', '## 5. Discussion', '## 6. Conclusions']
    pos = [text.index(h) for h in headings]
    if pos != sorted(pos):
        raise ValueError('Section order')
    intro = text.split('## 1. Introduction',1)[1].split('## 2.',1)[0]
    if not re.search(r'National Institute of Standards and Technology \(NIST\)', intro):
        raise ValueError('NIST first-use expansion missing')
    if intro.index('NIST') != intro.index('(NIST)')+1:
        raise ValueError('NIST used before expansion')
    methods=text.split('## 3. Methods',1)[1].split('## 4.',1)[0]
    first_prose=methods.split('\n\n',2)[2]
    if not first_prose.startswith('PlumeNav represents the full inspection sequence:'):
        raise ValueError('Methods must open with the inspection configuration')
    need('### 4.1. Numerical verification, configuration admission and validation status')
    need('No physical calibration or validation was performed.')
    need('No closed-loop algorithm comparison was performed in the 100 m survey study.')
    need('Infotaxis and these published estimators are literature context, not algorithms benchmarked')
    need('An indoor demonstration should not be interpreted as proof that GADEN is restricted to indoor use.')
    need('g becomes g OR E(t), and scan permission is g AND P(t)')
    need('Once true, g remains true for the mission.')
    need('AUTHOR GATE 2: Check the scientific ideas and order. Language polishing comes later.')
    c=facts['C1_stage2i_continuous']
    assert [r['n'] for r in c] == [32]*4
    assert [r['supportedMaxima'] for r in c] == [0,2,5,28]
    assert all(r['supportedReleaseWithin0p10m']==0 for r in c)
    need('All methods have zero supported release locations within 0.10 m.')
    need('These are 32 paired blank worlds per controller, not 128 independent blank tests.')
    checked=[]
    for r in c[2:]:
        checked.append(need(rounded(100*r['supportedMaxima']/r['n'])+'%'))
    m=facts['C2_stage2i_scheduling']['metrics']
    checked.append(need(rounded(100*m['supportedExact']['mean'])+' percentage points'))
    for key,unit in [('distanceAtEncounterOrSearchEnd','m'),('airLitres','L')]:
        checked.append(need(rounded(m[key]['mean'])+' '+unit))
    checked.append(need(rounded(facts['C1_conditionalGatedError']['medianMetres'],3)+' m'))
    screen=facts['C4_screen_primary']
    assert screen['n']==128 and screen['both']==81 and screen['neither']==47
    assert screen['fastOnly']==screen['slowOnly']==0
    checked.append(need('same 81 of 128 worlds'))
    budget=facts['C6_budget_primary']
    assert budget[0]['lateAlarms']==44 and budget[1]['lateAlarms']==0
    for val in [budget[0]['difference'],*budget[0]['interval975'],budget[1]['interval975'][1]]:
        checked.append(need(rounded(100*val)))
    need('paired counts are 84 and 128 of the same 128 worlds')
    for row in ['32 | 384 | 480 | 48','128 | 512 | 544 | 16','128 new | 512 | 544 | 16','0 new | 512 reused | 544 reused | 16 reused']:
        need(row)
    cited=sorted(set(map(int,re.findall(r'\[(\d+)\]\(https://',text))))
    refs=sorted(map(int,re.findall(r'^(\d+)\. ',text,re.M)))
    if cited!=list(range(1,12)) or refs!=cited:
        raise ValueError('Reference numbering mismatch')
    if any(x in text.split('## Declarations')[0] for x in ['localisation','modelling','normalisation','metres']):
        raise ValueError('American English consistency')
    return {'abstractWords':len(abstract.split()),'bodyWordsApprox':len(text.split('## 1. Introduction',1)[1].split('## Declarations',1)[0].split()),
            'checkedSelectedNumericFragments':checked,'referencesCited':cited,
            'stage2GatePresent':True,'scope':'Selected claims/structure, not exhaustive scientific or source validation'}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path);args=parser.parse_args()
    if args.output and args.output.exists():
        raise ValueError('Refuse to overwrite a receipt')
    spec=importlib.util.spec_from_file_location('pkg',ROOT/'scripts/check-closeout-package.py')
    pkg=importlib.util.module_from_spec(spec);spec.loader.exec_module(pkg)
    parent=pkg.check()
    prior=json.loads((BASE/'draft_v1/draft_check.json').read_text())
    assert hashlib.sha256((BASE/'draft_v1/manuscript_idea_v1.md').read_bytes()).hexdigest()==prior['draftSha256']
    for test, count in [('test-closeout-draft.py',6),('test-closeout-draft-v2.py',8)]:
        r=subprocess.run([sys.executable,str(ROOT/'scripts'/test)],cwd=ROOT,text=True,capture_output=True,check=True)
        assert f'Ran {count} tests' in r.stdout+r.stderr and '\nOK\n' in r.stdout+r.stderr
    facts=json.loads((BASE/'story_v1/claim_facts.json').read_text())['facts']
    result=check_text(DRAFT.read_text(),facts)
    result.update({'checkedAtUtc':datetime.now(timezone.utc).isoformat(),'draftSha256':hashlib.sha256(DRAFT.read_bytes()).hexdigest(),
                   'version1Unchanged':True,'newSimulation':False,'authorApprovedFinalDraft':False,
                   'packageChecks':{k:parent[k] for k in ['acceptedSourceHashesUnchanged','markdownFilesChecked','localLinksChecked','factsExactlyReproduced','testsPassed']},
                   'draftRegressionTestsPassed':14})
    if args.output:
        with args.output.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(result,indent=2))


if __name__=='__main__':main()
