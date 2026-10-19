"""Transparent v1/v2 arithmetic-change ledger, only after independent v2 audit."""
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path

old=Path('research/analysis/epa_sample_index_retention_v1_attempt01_2026-09-24')
new=Path('research/analysis/epa_sample_index_retention_v2_attempt01_2026-09-24');data=new/'generated'
load=lambda p:json.loads(p.read_text())
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
accepted=load(new/'acceptance.json');assert accepted['accepted'] and accepted['auditSha256']==sha(new/'independent_audit.json')
assert load(new/'independent_audit.json')['passed'] and not load(old/'audit_failure.json')['accepted']
for root in (old,data):
    for row in load(root/'manifest.json')['inputs']:assert sha(Path(row['path']))==row['sha256']
    for row in load(root/'complete.json')['files']:assert sha(root/row['file'])==row['sha256']
assert load(old/'blocks.json')==load(data/'blocks.json')
segments=load(data/'segments.json');old_segments=load(old/'segments.json')
stripped=json.loads(json.dumps(segments))
for s in stripped:
    for row in s['samples']:row.pop('methaneStoredNumericText')
assert stripped==old_segments,'Undeclared segmentation/sample change'
old_refs={r['referenceId']:r for r in load(old/'reference_excursions.json')}
new_refs={r['referenceId']:r for r in load(data/'reference_excursions.json')};assert old_refs.keys()==new_refs.keys()
changes=[]
for name,r in new_refs.items():
    previous=old_refs[name]
    assert r['thresholdPpmv']==previous['thresholdPpmv'] and r['nativeSamples']==previous['nativeSamples']
    expand=lambda x:{i for e in x['excursions'] for i in range(e['firstIndex'],e['lastIndex']+1)}
    old_indices,new_indices=expand(previous),expand(r)
    if old_indices!=new_indices:
        changes.append(dict(referenceId=name,thresholdPpmv=r['thresholdPpmv'],oldBackgroundPpmv=previous['backgroundPpmv'],exactBackground=r['backgroundExact'],includedByV2=sorted(new_indices-old_indices),excludedByV2=sorted(old_indices-new_indices),v1Excursions=len(previous['excursions']),v2Excursions=len(r['excursions'])))
old_summary={ (x['referenceId'],x['factor'],x['persistence']):x for x in load(old/'summary.json')}
summary=load(data/'summary.json');changed_cells=[]
for row in summary:
    prior=old_summary[(row['referenceId'],row['factor'],row['persistence'])]
    keys=('referenceExcursions','minimumRetention','meanRetention','maximumRetention')
    if any(row[k]!=prior[k] for k in keys):changed_cells.append(dict(referenceId=row['referenceId'],factor=row['factor'],persistence=row['persistence'],v1={k:prior[k] for k in keys},v2={k:row[k] for k in keys}))
result=dict(createdAt=datetime.now(timezone.utc).isoformat(),scriptSha256=sha(Path(__file__)),v1ManifestSha256=sha(old/'manifest.json'),v2ManifestSha256=sha(data/'manifest.json'),v2AuditSha256=sha(new/'independent_audit.json'),sourceSegmentationAndValuesUnchanged=True,thresholdsUnchanged=True,v1RemainsUnaccepted=True,referencesCompared=len(new_refs),referencesWithMembershipChanges=len(changes),sampleThresholdMembershipChanges=sum(len(x['includedByV2'])+len(x['excludedByV2']) for x in changes),changes=changes,summaryCellsChanged=len(changed_cells),changedSummaryCells=changed_cells,newExternalExperiment=False,physicalClaimExpansion=False)
with (new/'arithmetic_change_ledger.json').open('x') as f:json.dump(result,f,indent=2);f.write('\n')
print(json.dumps({k:v for k,v in result.items() if k not in ('changes','changedSummaryCells')},indent=2))
