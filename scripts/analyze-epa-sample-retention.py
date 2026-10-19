"""Frozen sample-index retention analysis of a preserved, cell-addressed export."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
import math
from pathlib import Path
import time

THRESHOLDS=(.01,.05,.1,.5,1.,5.)
FACTORS=(1,2,5,10,20,50)
PERSISTENCE=(1,2)
PROTOCOL=Path('research/protocols/epa_sample_index_retention_v1_2026-09-24.md')
EXTRACTION=Path('research/analysis/public_methane_admission_2026-09-24/epa_workbook_structure.json')
RAW_SHA='d408f8d7b9b0630132720ad069095230f442a6d24a8be159a8558bdb4b9e1b4d'
BLOCKS=(('CR_1','A','B','C',None),('CR_2','E','F','G',None),('CR_3','I','J','K',None),('FS_1','M','N','O','P'),('FS_2','R','S','T','U'),('FS_3','W','X','Y','Z'),('FS_4','AB','AC','AD','AE'))
def load(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def numeric(x):return type(x) in (int,float) and math.isfinite(x)
def percentile5(values):
    ordered=sorted(values);assert ordered
    position=(len(ordered)-1)*.05;lower=math.floor(position);upper=math.ceil(position)
    return ordered[lower]+(position-lower)*(ordered[upper]-ordered[lower])
def excursions(values,background,threshold):
    result=[];begin=None
    for i,value in enumerate(values+[None]):
        above=value is not None and value-background>=threshold
        if above and begin is None:begin=i
        elif not above and begin is not None:result.append((begin,i-1));begin=None
    return result
def phase_counts(bounds,k,phase):
    return [sum(i%k==phase for i in range(first,last+1)) for first,last in bounds]
def split_valid(records):
    groups=[];last=None
    for row in records:
        if not row['valid']:last=None;continue
        identity=(type(row['transectId']).__name__,row['transectId'])
        if last is None or row['sourceRow']!=last['sourceRow']+1 or identity!=(type(last['transectId']).__name__,last['transectId']):groups.append([])
        groups[-1].append(row);last=row
    return groups
def valid_id(value):return (isinstance(value,str) and bool(value.strip())) or numeric(value)
def self_test():
    assert percentile5([0.,10.])==.5 and percentile5([4.])==4.
    assert excursions([0.,.5,.5,0.,1.],0.,.5)==[(1,2),(4,4)]
    assert excursions([0.,0.],0.,.01)==[]
    assert phase_counts([(1,2),(4,4)],2,0)==[1,1] and phase_counts([(1,2),(4,4)],2,1)==[1,0]
    for n in (1,2,7,51):
        for k in FACTORS:
            assert sum(sum(i%k==phase for i in range(n)) for phase in range(k))==n
    rows=[dict(sourceRow=3,transectId=1,valid=True),dict(sourceRow=4,transectId=1,valid=False),dict(sourceRow=5,transectId=1,valid=True),dict(sourceRow=6,transectId=2,valid=True),dict(sourceRow=8,transectId=2,valid=True)]
    assert [len(x) for x in split_valid(rows)]==[1,1,1,1]
    assert not valid_id(None) and not valid_id('') and not valid_id(True) and valid_id(0) and valid_id('A')
    return dict(passed=True,groups=6,sourceValuesNotUsed=True)

def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    begin=time.monotonic();tests=self_test()
    assert sha(PROTOCOL)=='c2f1bf736be1e1532ef922e011479a326438e4ac1833cbcf3674a3b11c7df207'
    d=load(EXTRACTION);raw=Path(d['source']);assert d['sha256']==sha(raw)==RAW_SHA and d['sourceUnchanged'] and not d['recalculated']
    sheet=next(x for x in d['sheets'] if x['name']=='Methane Transects Data Set');assert sheet['formulaCells']==0
    cells={c['cell']:c for row in sheet['rows'] for c in row['cells']}
    a.output.mkdir(parents=True,exist_ok=False);written=[]
    def write(name,value):
        encoded=(json.dumps(value,indent=2,allow_nan=False)+'\n').encode()
        assert sum(x['bytes'] for x in written)+len(encoded)<=100*1024**2,'Output cap'
        with (a.output/name).open('xb') as f:f.write(encoded)
        written.append(dict(file=name,bytes=len(encoded),sha256=hashlib.sha256(encoded).hexdigest()))
    inputs=[dict(path=str(p),sha256=sha(p)) for p in (raw,EXTRACTION,PROTOCOL,Path(__file__),Path('scripts/audit-epa-sample-retention.py'))]
    write('manifest.json',dict(version='epa-sample-index-retention-v1',createdAt=datetime.now(timezone.utc).isoformat(),inputs=inputs,thresholdsPpmv=THRESHOLDS,factors=FACTORS,persistence=PERSISTENCE,sourceSheet=sheet['name'],selfTests=tests,exactTimeAvailable=False,retrospectiveBackground=True,maximumOutputBytes=100*1024**2))
    try:
        segments=[];ledger=[];blocks=[]
        for short,lat,lon,methane,identifier in BLOCKS:
            label=cells[lat+'1']['value'];cols=[lat,lon,methane]+([identifier] if identifier else [])
            header=[''.join(str(cells[col+'2']['value']).lower().split()) for col in cols]
            assert header==['latitude','longitude','methane(ppmv)']+(['transect'] if identifier else [])
            records=[];blocked=False;last_populated=max([row for row in range(3,sheet['maxRow']+1) if any(col+str(row) in cells for col in cols)]+[2])
            for row in range(3,sheet['maxRow']+1):
                source_cells={col:cells.get(col+str(row)) for col in cols};values=[source_cells[col]['value'] if source_cells[col] else None for col in cols]
                if all(x is None for x in values):reason='trailing-padding' if row>last_populated else 'empty-row'
                elif identifier and not valid_id(values[3]):reason='missing-or-invalid-transect-id';blocked=True
                elif not all(source_cells[col] and source_cells[col]['dataType']=='n' and numeric(values[i]) for i,col in enumerate(cols[:3])):reason='missing-or-nonnumeric-sample'
                elif not (-90<=values[0]<=90 and -180<=values[1]<=180 and values[2]>=0):reason='coordinate-or-concentration-range'
                else:reason=None
                r=dict(block=short,blockLabel=label,studyGroup='controlled-release-experiment' if identifier is None else label,sourceRow=row,sourceCells={key:col+str(row) for key,col in zip(('latitude','longitude','methane','transectId'),cols)},latitude=values[0],longitude=values[1],methanePpmv=values[2],transectId=values[3] if identifier else label,valid=reason is None,exclusionReason=reason)
                records.append(r)
            groups=split_valid(records) if not blocked else []
            for number,group in enumerate(groups):
                segment_id=f'{short}-segment-{number+1:03d}'
                for i,r in enumerate(group):r.update(segmentId=segment_id,sampleIndex=i)
                segments.append(dict(segmentId=segment_id,block=short,blockLabel=label,studyGroup=group[0]['studyGroup'],transectId=group[0]['transectId'],samples=group))
            ledger.extend(dict(r,blockNumericallyAdmitted=not blocked) for r in records)
            blocks.append(dict(block=short,label=label,numericallyAdmitted=not blocked,segmentCount=len(groups),validSamples=sum(r['valid'] for r in records),invalidPopulatedRows=sum(r['exclusionReason'] not in (None,'trailing-padding','empty-row') for r in records),excludedEmptyRows=sum(r['exclusionReason']=='empty-row' for r in records),trailingPaddingRows=sum(r['exclusionReason']=='trailing-padding' for r in records)))
        write('sample_ledger.json',ledger);write('segments.json',segments);write('blocks.json',blocks)
        references=[];phases=[];summaries=[]
        for segment in segments:
            samples=segment['samples'];values=[r['methanePpmv'] for r in samples];background=percentile5(values);n=len(values)
            for threshold in THRESHOLDS:
                bounds=excursions(values,background,threshold);denominator=len(bounds)
                reference_id=segment['segmentId']+f'-threshold-{threshold:g}'
                references.append(dict(referenceId=reference_id,segmentId=segment['segmentId'],thresholdPpmv=threshold,backgroundPpmv=background,nativeSamples=n,excursions=[dict(firstIndex=first,lastIndex=last,firstSourceRow=samples[first]['sourceRow'],lastSourceRow=samples[last]['sourceRow']) for first,last in bounds]))
                for k in FACTORS:
                    total_samples=0;observed={p:[] for p in PERSISTENCE}
                    for phase in range(k):
                        selected=sum(i%k==phase for i in range(n));total_samples+=selected;counts=phase_counts(bounds,k,phase)
                        for persistence in PERSISTENCE:
                            retained=sum(count>=persistence for count in counts);fraction=retained/denominator if denominator else None
                            phases.append(dict(referenceId=reference_id,factor=k,phase=phase,persistence=persistence,selectedSampleCount=selected,retainedCountsByExcursion=counts,representedExcursions=retained,referenceExcursions=denominator,retentionFraction=fraction))
                            observed[persistence].append(fraction)
                    assert total_samples==n
                    for persistence in PERSISTENCE:
                        ratios=observed[persistence]
                        summaries.append(dict(referenceId=reference_id,segmentId=segment['segmentId'],studyGroup=segment['studyGroup'],thresholdPpmv=threshold,factor=k,persistence=persistence,phases=k,referenceExcursions=denominator,minimumRetention=min(ratios) if denominator else None,meanRetention=sum(ratios)/k if denominator else None,maximumRetention=max(ratios) if denominator else None))
            assert time.monotonic()-begin<110,'Analysis runtime cap'
        write('reference_excursions.json',references);write('phase_results.json',phases);write('summary.json',summaries)
        for r in inputs:assert sha(Path(r['path']))==r['sha256']
        write('complete.json',dict(completed=True,createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-begin,files=written.copy(),blocks=len(blocks),admittedBlocks=sum(b['numericallyAdmitted'] for b in blocks),segments=len(segments),nativeSamples=sum(len(s['samples']) for s in segments),phaseRows=len(phases),summaryRows=len(summaries),independentlyAudited=False,sampleIndexOnly=True,hardwareValidation=False,noLeakTruth=True))
        print(json.dumps(load(a.output/'complete.json'),indent=2))
    except BaseException as error:
        write('failed.json',dict(completed=False,error=str(error),at=datetime.now(timezone.utc).isoformat(),diagnosticOnly=True));raise

if __name__=='__main__':main()
