"""Artificial terminal-block admission, separate from full-history audits."""
import argparse
import copy
from decimal import Decimal, localcontext
import hashlib
import json
import math
from pathlib import Path
import numpy as np
from lib.si_absent_report_full_audit_v1 import BASE_PATH, derive, terminal_block


def run(block, fixture):
    residuals = {}
    def close(name, a, b, tolerance):
        error = float(np.max(np.abs(np.asarray(a)-np.asarray(b))))
        if not math.isfinite(error) or error > tolerance:
            raise AssertionError((name, error, tolerance))
        residuals[name] = error
    block(**fixture, close=close)
    return residuals


def oracle(f):
    # Independent decimal reconstruction; not the production NumPy/point path.
    with localcontext() as ctx:
        ctx.prec = 70
        dec = lambda x: Decimal(str(x))
        if f['arm']['decision']['status'] == 'abstained':
            assert f['report']['reportedPoint'] is None and f['report']['sourceErrorMetres'] is None
            return
        origin = f['nominee']['point']; peak = f['arm']['decision']['candidate']['geometry']['peak']
        p = f['report']['reportedPoint']; length = dec(f['L'])
        q = [dec(origin[axis])+Decimal('0.1')/length*dec(peak[i]) for i, axis in enumerate(('x','y'))]
        assert all(abs(dec(p[axis])-q[i]) <= Decimal('1e-12') for i, axis in enumerate(('x','y')))
        if f['s']['field'] == 'blank':
            assert f['report']['sourceErrorMetres'] is None and 'sourcePositionOverride' not in f['c']
        else:
            source = f['c']['sourcePositionOverride']
            distance = sum((q[i]-dec(source[axis]))**2 for i,axis in enumerate(('x','y'))).sqrt()*length
            assert abs(dec(f['report']['sourceErrorMetres'])-distance) <= Decimal('1e-10')


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);args=p.parse_args();args.output.mkdir(exist_ok=False)
    raw=BASE_PATH.read_bytes();text,guard=derive(raw);old=terminal_block(raw.decode());new=terminal_block(text)
    with (args.output/'derived_full_auditor.py').open('x') as stream:stream.write(text)
    valid=[];negative=[];old_blank_failures=[]
    def reject(name,fn):
        try:fn()
        except (AssertionError,ValueError,KeyError,TypeError) as e:
            negative.append(dict(name=name,rejected=True,error=type(e).__name__+': '+str(e)));return
        raise AssertionError('Invalid fixture escaped: '+name)
    for field in ('si-continuous','si-pulse','blank'):
        for peak in ([0,0],[1,-.5],[-.75,1.25]):
            centre=dict(x=.45,y=.55);point=dict(x=centre['x']+.01*peak[0],y=centre['y']+.01*peak[1])
            cfg=dict(targetStatus='absent' if field=='blank' else 'emitting')
            if field!='blank':cfg['sourcePositionOverride']=dict(x=.5,y=.5)
            error=None if field=='blank' else float(np.linalg.norm(np.array([point['x']-.5,point['y']-.5]))*10)
            f=dict(arm=dict(decision=dict(status='supported',candidate={'geometry':{'peak':list(peak)}})),nominee=dict(point=centre),L=10,
                   report=dict(reportedPoint=point,sourceErrorMetres=error),c=cfg,s=dict(field=field))
            before=copy.deepcopy(f);residuals=run(new,f);oracle(f);assert f==before
            if field=='blank':
                try:run(old,f)
                except KeyError as e:
                    assert e.args==('sourcePositionOverride',);old_blank_failures.append(dict(field=field,peak=peak,error=str(e)))
                else:raise AssertionError('Old missing-source branch unexpectedly passed')
                for value in (0,.1,False,float('nan')):
                    bad=copy.deepcopy(f);bad['report']['sourceErrorMetres']=value
                    reject(f'{field} {peak} non-null error {value}',lambda bad=bad:run(new,bad))
                bad=copy.deepcopy(f);bad['report'].pop('sourceErrorMetres')
                reject(f'{field} {peak} missing error',lambda bad=bad:run(new,bad))
            else:
                assert run(old,f)==residuals
                for value in (error+1,float('nan'),None):
                    bad=copy.deepcopy(f);bad['report']['sourceErrorMetres']=value
                    reject(f'{field} {peak} incorrect error {value}',lambda bad=bad:run(new,bad))
            bad=copy.deepcopy(f);bad['report']['reportedPoint']['x']+=.01
            reject(f'{field} {peak} inconsistent point',lambda bad=bad:run(new,bad))
            valid.append(dict(field=field,status='supported',peak=peak,residuals=residuals,artificialTerminalOnly=True))
        abstain=dict(arm=dict(decision=dict(status='abstained',candidate=None)),nominee=None,L=10,
                     report=dict(reportedPoint=None,sourceErrorMetres=None),c={},s=dict(field=field))
        assert run(old,abstain)==run(new,abstain)=={};oracle(abstain)
        valid.append(dict(field=field,status='abstained',artificialTerminalOnly=True))
        for key,value in (('reportedPoint',{'x':.5,'y':.5}),('sourceErrorMetres',0)):
            bad=copy.deepcopy(abstain);bad['report'][key]=value
            reject(f'{field} abstention {key}',lambda bad=bad:run(new,bad))
    for name,bad in (('changed source',raw+b'\n'),('empty source',b''),('removed call',raw.replace(b'reportedSourceError',b'changedSourceError'))):
        reject(name,lambda bad=bad:derive(bad))
    assert len(valid)==12 and len(old_blank_failures)==3 and len(negative)==51
    result=dict(passed=True,guard=guard,validCases=valid,negativeChecks=negative,oldMissingSourceFailures=old_blank_failures,
                emittingAndAbstentionEquivalence=True,independentDecimalOracle=True,decimalPrecision=70,
                artificialTerminalOnly=True,fullScientificAuditsExecuted=0,newMissions=0,
                physicallyValidSupportedBlankHistoryTested=False)
    with (args.output/'branch_acceptance.json').open('x') as stream:json.dump(result,stream,indent=2);stream.write('\n')
    print(json.dumps(dict(passed=True,validCases=12,negativeChecks=51,guard=guard)))


if __name__=='__main__':main()
