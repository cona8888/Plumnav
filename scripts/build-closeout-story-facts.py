#!/usr/bin/env python3
"""Compact Stage 1 facts derived only from frozen, already accepted summaries.

This is not a simulation, re-audit of raw physics, or a new statistical fit.
"""
import argparse
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
BASE=ROOT/'research/publication_closeout_2026-09-22'
DATA_SHA='474b9b9c1b60b852a862a2344e9b6779b91189f9f3f56b45355cdc548160e88f'

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def derive(d):
    assert d['stage2i']['independentPairedWorlds']==32
    assert d['screen']['independentWorldsPerSetting']==128
    assert d['budget']['independentWorldsPerSetting']==128
    assert d['mechanism']['postHoc'] is True and d['mechanism']['newIndependentWorlds']==0
    continuous=[];pulse=[];blank=[]
    for i,r in enumerate(d['stage2i']['rows']):
        row={'sourcePointer':f'/stage2i/rows/{i}','algorithm':r['algorithm'],'n':r['n'],
             'encounters':r['binary']['encounter']['successes'],
             'supportedMaxima':r['binary']['supportedExact']['successes'],
             'supportedReleaseWithin0p10m':r['binary']['supportedReleaseWithinPointOne']['successes']}
        assert row['n']==32
        if r['field']=='si-continuous':continuous.append(row)
        elif r['field']=='si-pulse':pulse.append(row)
        elif r['field']=='blank':blank.append(row)
        else:raise AssertionError('Unexpected field')
    assert len(continuous)==len(pulse)==len(blank)==4
    assert [r['supportedMaxima'] for r in continuous]==[0,2,5,28]
    assert all(r['supportedReleaseWithin0p10m']==0 for r in continuous+pulse+blank)
    gated=d['stage2i']['rows'][3]
    assert gated['algorithm']=='Encounter-gated quad' and len(gated['conditionalSupportedReleaseErrorsMetres'])==28
    mechanism=[]
    for i,g in enumerate(d['mechanism']['selectedPrimarySettingGroups']):
        assert g['n']==128 and g['observedMisses']==47 and g['missesWithoutMidpointOpportunity']==46
        mechanism.append({'sourcePointer':f'/mechanism/selectedPrimarySettingGroups/{i}',
                          'sensor':g['sensor'],'n':g['n'],'misses':g['observedMisses'],
                          'missesWithoutThresholdOpportunity':g['missesWithoutMidpointOpportunity'],
                          'stageCounts':{k:v['positive'] for k,v in g['stages'].items()}})
    budget=[]
    for i,g in enumerate(d['budget']['groups']):
        if g['rateKgPerSecond']==0:
            assert all(b['alarms']==0 for b in g['budgets'])
            continue
        assert g['rateKgPerSecond']==.0001 and g['n']==128
        budget.append({'sourcePointer':f'/budget/groups/{i}','wind':g['wind'],'speed':g['speed'],
                       'sensor':g['sensor'],'n':g['n'],
                       'budgets':[{k:b[k] for k in ['budgetSeconds','alarms','estimate','wilson95']} for b in g['budgets']]})
    assert len(budget)==8
    assert d['budget']['primary'][0]['lateAlarms']==44 and d['budget']['primary'][1]['lateAlarms']==0
    return {'C1_stage2i_continuous':continuous,
            'C2_stage2i_scheduling':d['stage2i']['schedulingContrasts'][0],
            'C3_stage2i_pulsed':pulse,'C3_stage2i_blank':blank,
            'C1_conditionalGatedError':{'n':28,'medianMetres':gated['conditionalReleaseErrorMedianMetres'],
                                       'rangeMetres':gated['conditionalReleaseErrorRangeMetres']},
            'C4_screen_primary':d['screen']['primaryContrast'],
            'C5_mechanism_posthoc':mechanism,
            'C6_budget_primary':d['budget']['primary'],
            'C7_budget_allEmittingCells':budget}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);a=parser.parse_args()
    assert not a.output.exists(),'Refuse to replace an existing artifact'
    data=BASE/'evidence/figure_data.json'; assert sha(data)==DATA_SHA
    index=json.loads((BASE/'evidence/evidence_index.json').read_text())
    for record in index['sources']:
        path=ROOT/record['file']
        assert path.stat().st_size==record['bytes'] and sha(path)==record['sha256'],record['file']
    facts=derive(json.loads(data.read_text()))
    facts={'schemaVersion':'plumenav-stage1-story-facts-v1','newSimulation':False,
           'parent':{'path':str(data.relative_to(ROOT)),'sha256':DATA_SHA},
           'acceptedSourceHashesRechecked':len(index['sources']),
           'worldSetsMustRemainSeparate':True,'facts':facts}
    a.output.parent.mkdir(parents=True,exist_ok=True)
    with a.output.open('x') as f:json.dump(facts,f,indent=2);f.write('\n')
    print(json.dumps({'acceptedSourceHashesRechecked':len(index['sources']),
                      'factBlocks':len(facts['facts']),'output':str(a.output)}))

if __name__=='__main__':main()
