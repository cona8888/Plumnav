"""Artificial state enumeration and blank accounting; no scientific missions."""
import argparse
import copy
from datetime import datetime,timezone
import hashlib
import itertools
import json
from pathlib import Path
import time
from lib.si_release_endpoint_v1 import endpoint as old_endpoint, refinement_check as old_refinement
from lib.si_release_endpoint_v2 import endpoint, refinement_check, BLANK_CATEGORIES
from lib.si_paired_statistics_v1 import paired_statistics as old_statistics
from lib.si_paired_statistics_v2 import paired_statistics,FIELDS,ARMS
from lib.si_blank_statistics_delta_v2 import check as delta_check

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def meta(field,stage='no-eligible-nomination',nominated=False,status=None,reported=False,error=None):
    return dict(auditPassed=True,field=field,stage=stage,nominationPresent=nominated,nominalStatus=status,reportedPointPresent=reported,sourceErrorMetres=error)
def blanks():
    return [meta('blank'),meta('blank','mission-budget-exhausted',True),meta('blank','inspection-complete',True,'abstained'),meta('blank','inspection-complete',True,'supported',True)]
def witness(states,parent=True):
    return dict(parentNumericalPassed=parent,resolutions=[dict(worldKey='synthetic-world',arm='GL',navDt=dt,endpoint=copy.deepcopy(state)) for dt,state in zip(('1/16','1/32','1/64'),states)])

def main():
    p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False);start=time.monotonic()
    def write(name,value):
        with (a.output/name).open('x') as f:json.dump(value,f,indent=2,allow_nan=False);f.write('\n')
    negative=[]
    def reject(name,call):
        try:call()
        except (ValueError,TypeError,KeyError):negative.append(name)
        else:raise AssertionError('Unexpected acceptance: '+name)
    try:
        delta=delta_check();enumeration=[];valid=0;emitting_equivalent=0
        for field,stage,nomination,status,report,error in itertools.product(FIELDS,('no-eligible-nomination','mission-budget-exhausted','inspection-complete'),(False,True),(None,'supported','abstained'),(False,True),(None,-.01,0.,.099,.1,.101)):
            value=meta(field,stage,nomination,status,report,error);before=copy.deepcopy(value)
            try:result=endpoint(value);row=dict(metadata=value,accepted=True,result=result);valid+=1
            except (ValueError,TypeError,KeyError) as exc:row=dict(metadata=value,accepted=False,error=type(exc).__name__)
            assert value==before
            if field!='blank':
                try:legacy=old_endpoint(value);assert row['accepted'] and row['result']==legacy
                except (ValueError,TypeError,KeyError):assert not row['accepted']
                emitting_equivalent+=1
            enumeration.append(row)
        assert len(enumeration)==648 and valid==18 and emitting_equivalent==432
        for field in FIELDS:
            base=meta(field)
            for name,mutation in [('missing',lambda d:d.pop('stage')),('extra',lambda d:d.update(extra=True)),('audit-false',lambda d:d.update(auditPassed=False)),('audit-integer',lambda d:d.update(auditPassed=1)),('nominated-integer',lambda d:d.update(nominationPresent=0)),('reported-integer',lambda d:d.update(reportedPointPresent=0)),('unknown-stage',lambda d:d.update(stage='unknown'))]:
                bad=copy.deepcopy(base);mutation(bad);reject(field+':'+name,lambda:endpoint(bad))
        for error in [True,'0.1',float('nan'),float('inf')]:
            for field in FIELDS:
                bad=meta(field,'inspection-complete',True,'supported',True,error)
                reject(field+':error:'+repr(error),lambda:endpoint(bad))
        blank=blanks();witnesses=[]
        for ids in itertools.product(range(4),repeat=3):
            for parent in (False,True):
                value=witness([blank[i] for i in ids],parent);result=refinement_check(value)
                assert result['passed']==(parent and len(set(ids))==1)
                assert result['endpointStable'] is None and result['blankOutcomeStable']==(len(set(ids))==1)
                witnesses.append(dict(input=value,result=result))
        assert len(witnesses)==128 and sum(row['result']['passed'] for row in witnesses)==4
        emitting_witnesses=[]
        for field,errors,parent in itertools.product(FIELDS[:2],[(.099,.1,.099),(.099,.101,.099)],(False,True)):
            value=witness([meta(field,'inspection-complete',True,'supported',True,error) for error in errors],parent)
            result=refinement_check(value);legacy=old_refinement(value)
            assert {k:v for k,v in result.items() if k not in ('version','blankOutcomeStable')}=={k:v for k,v in legacy.items() if k!='version'}
            emitting_witnesses.append(dict(input=value,result=result))
        for name,mutation in [('missing-resolution',lambda d:d['resolutions'].pop()),('wrong-order',lambda d:d['resolutions'].reverse()),('mixed-world',lambda d:d['resolutions'][1].update(worldKey='other')),('mixed-arm',lambda d:d['resolutions'][1].update(arm='RW')),('mixed-field',lambda d:d['resolutions'][1].update(endpoint=meta('si-continuous'))),('parent-integer',lambda d:d.update(parentNumericalPassed=1))]:
            bad=witness([blank[0]]*3);mutation(bad);reject('witness:'+name,lambda:refinement_check(bad))
        worlds=[f'synthetic-world-{i:02d}' for i in range(32)];records=[]
        patterns=list(itertools.product((0,1),repeat=5))
        for i,world in enumerate(worlds):
            for field in FIELDS:
                for j,arm in enumerate(ARMS):
                    value=copy.deepcopy(blank[(i+j)%4]) if field=='blank' else (meta(field,'inspection-complete',True,'supported',True,.05) if patterns[i if field=='si-continuous' else 31-i][j] else meta(field))
                    records.append(dict(worldKey=world,field=field,arm=arm,endpoint=value))
        before=copy.deepcopy(records);result=paired_statistics(records,worlds,bootstrap_seed=924213)
        assert records==before
        assert result==paired_statistics(records,worlds,bootstrap_seed=924213)
        assert result==paired_statistics(list(reversed(records)),worlds,bootstrap_seed=924213)
        comparison=copy.deepcopy(records)
        for row in comparison:
            if row['field']=='blank':row['endpoint']=meta('blank')
        legacy=old_statistics(comparison,worlds,bootstrap_seed=924213)
        assert result['primary']==legacy['primary'] and result['bootstrap']==legacy['bootstrap']
        assert [row for row in result['arms'] if row['field']!='blank']==[row for row in legacy['arms'] if row['field']!='blank']
        for summary in result['arms']:
            if summary['field']!='blank':continue
            assert summary['successes'] is None and summary['proportion'] is None and not summary['localisationApplicable']
            assert summary['categories']==dict.fromkeys(BLANK_CATEGORIES,8)
            for name,count in [('falseNomination',24),('inspectionCompleted',16),('falseReport',8)]:
                assert summary['blankControls'][name]==dict(count=count,denominator=32,proportion=count/32)
        for name,mutation in [('missing-row',lambda r:r.pop()),('duplicate-row',lambda r:r.append(copy.deepcopy(r[0]))),('audit-failed',lambda r:r[0]['endpoint'].update(auditPassed=False)),('blank-numeric-error',lambda r:next(row for row in r if row['field']=='blank')['endpoint'].update(sourceErrorMetres=0.)),('wrong-blank-field',lambda r:next(row for row in r if row['field']=='blank')['endpoint'].update(field='si-pulse'))]:
            bad=copy.deepcopy(records);mutation(bad);reject('statistics:'+name,lambda:paired_statistics(bad,worlds,bootstrap_seed=924213))
        # Zero category counts must remain explicit, not disappear from tables.
        zero=paired_statistics(comparison,worlds,bootstrap_seed=924213,draws=[[i for i in range(32)]]*2)
        for summary in zero['arms']:
            if summary['field']=='blank':assert summary['categories']==dict(zip(BLANK_CATEGORIES,[32,0,0,0]))
        write('endpoint_enumeration.json',enumeration);write('witnesses.json',dict(blank=witnesses,emitting=emitting_witnesses))
        write('paired_fixture.json',dict(worlds=worlds,records=records,result=result))
        complete=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,enumeratedMetadata=len(enumeration),acceptedMetadata=valid,emittingV1Equivalences=emitting_equivalent,blankWitnesses=len(witnesses),emittingWitnesses=len(emitting_witnesses),negativeChecks=negative,negativeCheckCount=len(negative),mechanicalDelta=delta,primaryAndBootstrapV1Equivalent=True,inputUnchanged=True,reversedRowsEquivalent=True,zeroCategoriesExplicit=True,files={name:sha(a.output/name) for name in ('endpoint_enumeration.json','witnesses.json','paired_fixture.json')},newMissions=0,realHistoriesRead=0)
        write('complete.json',complete);print(json.dumps(complete))
    except BaseException as error:
        write('failure.json',dict(passed=False,error=repr(error),negativeChecks=negative));raise

if __name__=='__main__':main()
