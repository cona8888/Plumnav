"""Record strict diagnostics relative to the immutable research-graph baseline."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import subprocess


def main():
    p=argparse.ArgumentParser();p.add_argument('--node',required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    roots=str(Path(a.node).parents[1]/'node_modules/@types')
    common=[a.node,'node_modules/typescript/bin/tsc','--noEmit','--strict','--skipLibCheck','--target','ES2022','--module','ESNext','--moduleResolution','Bundler','--types','node','--typeRoots',roots]
    receipts={}
    for name,source in [('baseline','scripts/test-si-readout-emitting-timing.ts'),('candidate','scripts/run-si-mechanism-case-v1.ts')]:
        command=common+[source];r=subprocess.run(command,text=True,capture_output=True,timeout=60)
        receipts[name]=dict(command=command,exitCode=r.returncode,diagnostics=r.stdout.splitlines(),stderr=r.stderr)
    prior=json.loads(Path('research/results/si_readout_admission_v1_attempt01_2026-09-24/typecheck.json').read_text())['baseline']['diagnostics']
    passed=receipts['baseline']['diagnostics']==receipts['candidate']['diagnostics']==prior and receipts['baseline']['exitCode']==receipts['candidate']['exitCode']==2
    result=dict(noNewDiagnostics=passed,strictGraphClean=False,inheritedDiagnosticCount=len(prior),createdAt=datetime.now(timezone.utc).isoformat(),**receipts,scriptSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    with a.output.open('x') as f:json.dump(result,f,indent=2);f.write('\n')
    print(json.dumps(dict(noNewDiagnostics=passed,inheritedDiagnosticCount=len(prior),strictGraphClean=False)))
    if not passed:raise SystemExit(1)


if __name__=='__main__':main()
