"""No-scan treatment contract, then unchanged readout/motion/sensor audit."""
import copy
from lib.si_readout_terminal_audit import audit as readout_audit

def contract(record):
    assert record['acquisitionMode']=='scan-disabled'
    assert record['scanDisabledVersion']=='scan-disabled-acquisition-v1'
    assert record['schedulingTraceRole']=='passive-eligibility-observer'
    assert record['spec']['policy']=='reference' and record['availability']=='live-passive'
    controls=record['controls'];trace=record['scanDisabledTrace']
    acquisition=[r for r in controls if r['stage']=='acquisition']
    assert len(acquisition)==len(trace)==len(record['schedulingTrace'])==9600
    queries=0
    for row,g,s in zip(acquisition,trace,record['schedulingTrace']):
        assert row['time']==g['time']==s['time']
        assert g['requestedScanId'] is None and g['pendingScanId'] is None and g['scanSequence']==0
        assert type(g['predicateQueries']) is int and g['predicateQueries']>=0
        assert not s['queries'] and s['requestedScanId'] is None
        queries+=g['predicateQueries']
    assert queries>0
    for i,row in enumerate(controls):
        assert row['time']==i/16
        m=row['measurement'];assert m['sampleMode']=='passive' and m['valid']==(i%16==0)
        assert 'quadSniff' not in m and 'quadSniff' not in row['decision']
        assert row['stage']!='drain' and row['decision']['phase']!='AWAITING FOUR CHANNELS'
    assert all(not seg['held'] for seg in record['segments'])
    assert record['summary']['acquisitionBudgetSeconds']==600
    assert record['summary']['inspectionAt']==(600 if record['nomination'] else None)
    return dict(acquisitionMode='scan-disabled',acquisitionControlRows=len(acquisition),predicateQueries=queries,issuedScans=0,scanHeldSegments=0,inspectionPathExercised=record['summary']['inspectionAt'] is not None)

def audit(record):
    treatment=contract(record)
    result=readout_audit(record)
    assert result['availability']['scanCount']==result['availability']['promotedReadouts']==result['availability']['drainRows']==0
    return dict(**result,scanDisabled=treatment)

def self_test():
    rows=[dict(time=i/16,stage='acquisition' if i<9600 else 'no-eligible-nomination',measurement=dict(sampleMode='passive',valid=i%16==0),decision=dict(phase='fixture')) for i in range(9601)]
    r=dict(acquisitionMode='scan-disabled',scanDisabledVersion='scan-disabled-acquisition-v1',schedulingTraceRole='passive-eligibility-observer',spec=dict(policy='reference'),availability='live-passive',controls=rows,scanDisabledTrace=[dict(time=i/16,requestedScanId=None,pendingScanId=None,scanSequence=0,predicateQueries=1) for i in range(9600)],schedulingTrace=[dict(time=i/16,requestedScanId=None,queries=[]) for i in range(9600)],segments=[dict(held=False) for _ in range(9600)],summary=dict(acquisitionBudgetSeconds=600,inspectionAt=None),nomination=None)
    result=contract(r)
    def reject(change):
        bad=copy.deepcopy(r);change(bad)
        try:contract(bad)
        except AssertionError:return
        raise AssertionError('Corruption escaped scan-disabled contract')
    reject(lambda x:x['controls'][0]['decision'].update(quadSniff=dict(scanId=1)))
    reject(lambda x:x['scanDisabledTrace'][0].update(pendingScanId=1))
    reject(lambda x:x['controls'][1]['measurement'].update(valid=True))
    reject(lambda x:x['scanDisabledTrace'].pop())
    return dict(passed=True,validFixture=result,corruptionsRejected=4,fullHistoryAuditNotSubstituted=True)
