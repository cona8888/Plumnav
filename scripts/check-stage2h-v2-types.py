#!/usr/bin/env python3
"""Disclose existing frozen-source strict errors; require zero new diagnostics."""
import json
import subprocess
from pathlib import Path

type_root='/Users/w.cha@bham.ac.uk/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@types'
args=['node_modules/.bin/tsc','--noEmit','--target','es2022','--module','esnext','--moduleResolution','bundler',
      '--skipLibCheck','--strict','--typeRoots',type_root,'--types','node']
results={}
for version in ['stage2h','stage2h_v2']:
    p=subprocess.run([*args,f'aws/{version}/worker.ts'],capture_output=True,text=True)
    results[version]=dict(exitCode=p.returncode,diagnostics=(p.stdout+p.stderr).strip().splitlines())
assert results['stage2h']==results['stage2h_v2'],results
project=subprocess.run(['node_modules/.bin/tsc','-b'],capture_output=True,text=True)
assert project.returncode==0,project.stdout+project.stderr
record=dict(noNewStrictDiagnostics=True,wholeResearchGraphStrictClean=results['stage2h']['exitCode']==0,
            projectTypecheckPassed=True,checks=results)
with Path('research/results/si_stage2h_v2_typecheck_2026-09-18.json').open('x') as f:
    json.dump(record,f,indent=2);f.write('\n')
print(json.dumps(record,indent=2))
