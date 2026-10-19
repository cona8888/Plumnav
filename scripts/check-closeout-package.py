#!/usr/bin/env python3
"""Read-only package checks plus an optional new receipt; never runs a simulator."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT/'research/publication_closeout_2026-09-22'


def check():
    index = json.loads((BASE/'evidence/evidence_index.json').read_text())
    for source in index['sources']:
        path = ROOT/source['file']
        assert path.stat().st_size == source['bytes'], source['file']
        assert hashlib.sha256(path.read_bytes()).hexdigest() == source['sha256'], source['file']
    links = []
    markdown = sorted(BASE.rglob('*.md'))
    for path in markdown:
        for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)', path.read_text()):
            target = target.strip().strip('<>')
            if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', target) or target.startswith('#'):
                continue
            target = unquote(target.split('#', 1)[0])
            resolved = (path.parent/target).resolve()
            assert resolved.exists(), f'Broken link: {path.relative_to(ROOT)} -> {target}'
            links.append({'document': str(path.relative_to(ROOT)), 'target': target})
    tests = []
    for name, expected in [('test-closeout-evidence.py', 12),
                           ('test-closeout-figures.py', 3),
                           ('test-closeout-editable-figures.py', 5),
                           ('test-closeout-story-facts.py', 5)]:
        result = subprocess.run([sys.executable, str(ROOT/'scripts'/name)],
                                cwd=ROOT, text=True, capture_output=True, check=True)
        output = result.stdout + result.stderr
        assert f'Ran {expected} tests' in output and '\nOK\n' in output, output
        tests.append({'script': 'scripts/'+name, 'passed': expected, 'output': output})
    # Exact reproduction of the existing compact fact artifact; no new output.
    spec = importlib.util.spec_from_file_location('facts', ROOT/'scripts/build-closeout-story-facts.py')
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    parent = BASE/'evidence/figure_data.json'
    assert hashlib.sha256(parent.read_bytes()).hexdigest() == mod.DATA_SHA
    saved = json.loads((BASE/'story_v1/claim_facts.json').read_text())
    assert mod.derive(json.loads(parent.read_text())) == saved['facts']
    return {'schemaVersion': 'plumenav-closeout-package-check-v1',
            'checkedAtUtc': datetime.now(timezone.utc).isoformat(),
            'newSimulation': False, 'rawHistoryReaudit': False,
            'acceptedSourceHashesUnchanged': len(index['sources']),
            'markdownFilesChecked': len(markdown), 'localLinksChecked': len(links),
            'localLinkExistenceOnly': True, 'externalLinksRecheckedByThisScript': False,
            'factsExactlyReproduced': True, 'testsPassed': sum(t['passed'] for t in tests),
            'tests': tests, 'localLinks': links,
            'scope': 'Packaging regression and link checks, not physical validation or author approval'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.output:
        assert not args.output.exists(), 'Refuse to replace an existing receipt'
    receipt = check()
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x') as stream:
            json.dump(receipt, stream, indent=2)
            stream.write('\n')
    print(json.dumps({k: receipt[k] for k in ['acceptedSourceHashesUnchanged',
          'markdownFilesChecked', 'localLinksChecked', 'factsExactlyReproduced', 'testsPassed']}))


if __name__ == '__main__':
    main()
