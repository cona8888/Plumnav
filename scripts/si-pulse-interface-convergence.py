"""Post-audit empirical convergence diagnostic for matched fixed-pose readouts."""
import gzip, hashlib, json, math
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
STUDY=ROOT/'research/evidence/si_pulse_interface_isolation_2026-09-15'
AUDIT=ROOT/'research/evidence/si_pulse_interface_isolation_audit_2026-09-15'
OUT=ROOT/'research/evidence/si_pulse_interface_convergence_2026-09-15'
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def load(index):return json.loads(gzip.decompress((STUDY/f'run-{index}.json.gz').read_bytes()))

assert json.loads((STUDY/'complete.json').read_text())['complete']
assert json.loads((AUDIT/'complete.json').read_text())['complete']
runs=[load(i) for i in range(36)];rows=[]
for pose in range(9):
    chosen={r['spec']['dt']:r for r in runs if r['spec']['pose']==pose}
    def scalar(run):return {t['time']:sum(t['readout'])/4 for t in run['ticks'] if 'readout' in t and t['time']>=40}
    values={dt:scalar(run) for dt,run in chosen.items()}
    adjacent=[]
    for coarse,fine in ((.25,.125),(.125,.0625),(.0625,.015625)):
        differences=[value-values[fine][time] for time,value in values[coarse].items()]
        adjacent.append({'coarseDt':coarse,'fineDt':fine,'stepRatio':coarse/fine,'rmsDifferenceC0':math.sqrt(sum(x*x for x in differences)/len(differences)),'maximumDifferenceC0':max(map(abs,differences))})
    order=math.log2(adjacent[0]['rmsDifferenceC0']/adjacent[1]['rmsDifferenceC0'])
    # For first-order error the non-adjacent 0.0625-to-0.015625 difference is
    # 0.75*C*0.0625; therefore the expected adjacent/non-adjacent ratio is 4/3.
    ratio=adjacent[1]['rmsDifferenceC0']/adjacent[2]['rmsDifferenceC0']
    rows.append({'pose':pose,'adjacent':adjacent,'observedOrderFromHalvings':order,'mediumToQuarterStepDifferenceRatio':ratio})
body={'scope':'Descriptive post-audit convergence calculation; it does not revise the frozen Stage 1f gates. Order uses the consecutive 0.25, 0.125 and 0.0625 s halvings.','studyCompleteSha256':sha(STUDY/'complete.json'),'auditCompleteSha256':sha(AUDIT/'complete.json'),'poses':rows,'observedOrderRange':[min(r['observedOrderFromHalvings'] for r in rows),max(r['observedOrderFromHalvings'] for r in rows)],'mediumToQuarterStepRatioRange':[min(r['mediumToQuarterStepDifferenceRatio'] for r in rows),max(r['mediumToQuarterStepDifferenceRatio'] for r in rows)]}
OUT.mkdir();(OUT/'diagnostic.json').write_text(json.dumps(body,indent=2)+'\n');(OUT/'si-pulse-interface-convergence.py').write_bytes(Path(__file__).read_bytes());(OUT/'complete.json').write_text(json.dumps({'complete':True,'diagnosticSha256':sha(OUT/'diagnostic.json'),'sourceSha256':sha(OUT/'si-pulse-interface-convergence.py')})+'\n')
print(json.dumps({k:v for k,v in body.items() if k!='poses'}))
