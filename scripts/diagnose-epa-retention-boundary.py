"""Read-only diagnosis of a failed excursion-boundary audit; no acceptance."""
from datetime import datetime,timezone
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import statistics

root=Path('research/analysis/epa_sample_index_retention_v1_attempt01_2026-09-24')
load=lambda p:json.loads(p.read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
segments={x['segmentId']:x for x in load(root/'segments.json')};mismatches=[]
for ref in load(root/'reference_excursions.json'):
    samples=segments[ref['segmentId']]['samples'];values=[s['methanePpmv'] for s in samples]
    audit_bg=statistics.quantiles(values,n=20,method='inclusive')[0] if len(values)>1 else values[0]
    saved_bg=ref['backgroundPpmv'];threshold=ref['thresholdPpmv']
    saved={i for e in ref['excursions'] for i in range(e['firstIndex'],e['lastIndex']+1)}
    audit={i for i,v in enumerate(values) if v-audit_bg>=threshold}
    if saved!=audit:
        ordered=sorted(Fraction(str(v)) for v in values);position=Fraction(len(values)-1,20);lo=position.numerator//position.denominator;hi=min(lo+1,len(values)-1)
        exact_bg=ordered[lo]+(position-lo)*(ordered[hi]-ordered[lo]);exact_cutoff=Fraction(str(threshold))
        mismatches.append(dict(referenceId=ref['referenceId'],savedBackground=saved_bg,independentBackground=audit_bg,backgroundDifference=audit_bg-saved_bg,exactDecimalBackground=str(exact_bg),thresholdPpmv=threshold,changedRows=[dict(sampleIndex=i,sourceRow=samples[i]['sourceRow'],value=values[i],savedEnhancement=values[i]-saved_bg,auditEnhancement=values[i]-audit_bg,savedAbove=i in saved,auditAbove=i in audit,exactDecimalAbove=Fraction(str(values[i]))-exact_bg>=exact_cutoff) for i in sorted(saved^audit)]))
result=dict(createdAt=datetime.now(timezone.utc).isoformat(),scriptSha256=sha(Path(__file__)),manifestSha256=sha(root/'manifest.json'),independentAuditFailed=True,accepted=False,reason='Independent excursion bounds differ; diagnosis only.',mismatchedReferences=len(mismatches),mismatches=mismatches,rawAndDerivedResultsUnmodified=True,thresholdsUnchanged=True)
with (root/'boundary_diagnosis.json').open('x') as f:json.dump(result,f,indent=2);f.write('\n')
print(json.dumps(result,indent=2))
