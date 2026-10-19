"""File-chain fixtures only. Synthetic audit receipts are explicitly not real audits."""
import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import time
from lib.si_terminal_binding_v1 import bind_fixture, bind_fixtures


def raw(value): return (json.dumps(value, indent=2, allow_nan=True)+'\n').encode()
def sha(data): return hashlib.sha256(data).hexdigest()


def history(field, kind, name):
    case=dict(worldKey='synthetic-'+name,arm='GL',field=field,navDt='1/64')
    config=dict(domainMeters=10,targetStatus='absent' if field=='blank' else 'present')
    if field!='blank':config['sourcePositionOverride']=dict(x=.5,y=.5)
    nomination=None if kind=='no-nomination' else dict(point=dict(x=.52 if kind=='out-of-tolerance' else .5,y=.5))
    verification=None;errors=[]
    stage='no-eligible-nomination' if kind=='no-nomination' else 'mission-budget-exhausted' if kind=='incomplete' else 'inspection-complete'
    if stage=='inspection-complete':
        status='abstained' if kind=='abstained' else 'supported';peak=[.4,.3]
        decision=dict(status=status,candidate=dict(diagnostic='synthetic-abstention') if status=='abstained' else dict(geometry=dict(peak=peak)))
        verification=dict(exactPoseOnly=True,arms=[dict(poseRadiusMetres=0.,decision=decision)])
        report=None if status=='abstained' else {k:nomination['point'][k]+.01*peak[i] for i,k in enumerate(('x','y'))}
        error=None if report is None or field=='blank' else math.hypot(report['x']-.5,report['y']-.5)*10
        errors=[dict(poseRadiusMetres=0.,reportedPoint=report,sourceErrorMetres=error)]
    return dict(version='synthetic-terminal-history-v1',syntheticOnly=True,identity=case,config=config,nomination=nomination,verification=verification,summary=dict(stage=stage,errors=errors))


def make_fixture(root,h,*,modify=None,manifest_change=None,raw_history=None,missing=None,symlink=None):
    root.mkdir(parents=True,exist_ok=False);h=copy.deepcopy(h);modify=modify or {}
    if 'history' in modify:modify['history'](h)
    hraw=raw(h) if raw_history is None else raw_history(h);hsha=sha(hraw)
    common=dict(syntheticOnly=True,identity=copy.deepcopy(h['identity']))
    data=dict(history=h,completion=dict(version='synthetic-terminal-completion-v1',**common,completed=True,historySha256=hsha),process=dict(version='synthetic-terminal-process-v1',**common,exitCode=0,timedOut=False),audit=dict(version='synthetic-terminal-audit-v1',**common,passed=True,historySha256=hsha,realAuditExecuted=False))
    # Separate identity objects prevent a one-receipt mutation changing all receipts.
    data=copy.deepcopy(data)
    for role in ('completion','process','audit'):data[role]['identity']=copy.deepcopy(h['identity'])
    for role,change in modify.items():
        if role!='history':change(data[role])
    artifacts={}
    for role,value in data.items():
        value_raw=hraw if role=='history' else raw(value);path=root/(role+'.json')
        if role==symlink:path.symlink_to('history.json')
        elif role!=missing:
            with path.open('xb') as f:f.write(value_raw)
        artifacts[role]=dict(path=path.name,sha256=sha(value_raw))
    manifest=dict(version='synthetic-terminal-manifest-v1',purpose='synthetic-terminal-binding-only',syntheticOnly=True,identity=copy.deepcopy(h['identity']),artifacts=artifacts)
    if manifest_change:manifest_change(manifest)
    data_raw=raw(manifest)
    with (root/'manifest.json').open('xb') as f:f.write(data_raw)
    return dict(directory=str(root),manifestSha256=sha(data_raw))


def inventory(root):
    return {str(p.relative_to(root)):('symlink:'+str(p.readlink()) if p.is_symlink() else sha(p.read_bytes())) for p in root.rglob('*') if p.is_file() or p.is_symlink()}


def main():
    p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=False);start=time.monotonic();negative=[]
    def write(name,data):
        with (a.output/name).open('x') as f:json.dump(data,f,indent=2,allow_nan=False);f.write('\n')
    entries=[];expected=[];fixture_root=a.output/'fixtures'
    try:
        for field in ('si-continuous','si-pulse','blank'):
            kinds=['no-nomination','incomplete','abstained','within-tolerance']+([] if field=='blank' else ['out-of-tolerance'])
            for kind in kinds:
                name=field+'-'+kind;h=history(field,kind,name);entry=make_fixture(fixture_root/name,h);entries.append(entry)
                category={'no-nomination':'no-nomination','incomplete':'inspection-incomplete','abstained':'verifier-abstained','within-tolerance':'within-tolerance-report','out-of-tolerance':'out-of-tolerance-report'}[kind]
                if field=='blank':category='blank-'+('supported-report' if kind=='within-tolerance' else category)
                expected.append(dict(category=category,success=None if field=='blank' else kind=='within-tolerance'))
        bindings=bind_fixtures(entries)
        assert len(bindings)==14
        for bound,wanted in zip(bindings,expected):
            assert bound['endpoint']['category']==wanted['category'] and bound['endpoint']['success']==wanted['success']
            assert bound['scope']==dict(syntheticOnly=True,realAuditExecuted=False,realHistoryBindingVerified=False,physicalValidation=False,realCampaignAdmitted=False)
        # A valid exact-threshold fixture avoids nominal-coordinate cancellation.
        h=history('si-continuous','within-tolerance','exact-boundary')
        h['config']['sourcePositionOverride']=dict(x=0.,y=0.);h['nomination']['point']=dict(x=0.,y=0.)
        h['verification']['arms'][0]['decision']['candidate']['geometry']['peak']=[1.,0.]
        h['summary']['errors'][0].update(reportedPoint=dict(x=.01,y=0.),sourceErrorMetres=.1)
        exact_entry=make_fixture(fixture_root/'exact-boundary',h);exact_result=bind_fixture(**dict(directory=exact_entry['directory'],expected_manifest_sha256=exact_entry['manifestSha256']))
        assert exact_result['endpoint']['success'] is True
        entries.append(exact_entry);bindings.append(exact_result);expected.append(dict(category='within-tolerance-report',success=True))
        baseline=history('si-continuous','within-tolerance','negative-base')
        def reject(name,entry):
            before=inventory(Path(entry['directory']))
            try:bind_fixture(entry['directory'],entry['manifestSha256'])
            except (ValueError,TypeError,KeyError) as error:
                negative.append(dict(name=name,entry=entry,error=str(error)))
            else:raise AssertionError('Invalid fixture accepted: '+name)
            assert inventory(Path(entry['directory']))==before
        for role in ('history','completion','process','audit'):
            reject('missing-'+role,make_fixture(fixture_root/('missing-'+role),baseline,missing=role))
            reject('wrong-identity-'+role,make_fixture(fixture_root/('wrong-identity-'+role),baseline,manifest_change=(lambda m:m['identity'].update(arm='RW')) if role=='history' else None,modify={} if role=='history' else {role:lambda d:d['identity'].update(arm='RW')}))
            reject('unknown-schema-'+role,make_fixture(fixture_root/('unknown-schema-'+role),baseline,modify={role:lambda d:d.update(version='unknown')}))
        mutations=[
            ('incomplete-receipt','completion',lambda d:d.update(completed=False)),('integer-completion','completion',lambda d:d.update(completed=1)),
            ('stale-completion','completion',lambda d:d.update(historySha256='0'*64)),('stale-audit','audit',lambda d:d.update(historySha256='0'*64)),
            ('failed-audit','audit',lambda d:d.update(passed=False)),('integer-audit','audit',lambda d:d.update(passed=1)),
            ('real-audit-claim','audit',lambda d:d.update(realAuditExecuted=True)),('failed-process','process',lambda d:d.update(exitCode=1)),
            ('boolean-exit','process',lambda d:d.update(exitCode=False)),('timed-out','process',lambda d:d.update(timedOut=True)),('integer-timeout','process',lambda d:d.update(timedOut=0)),
            ('extra-history-key','history',lambda d:d.update(auditPassed=True)),('nonfinite-point','history',lambda d:d['summary']['errors'][0]['reportedPoint'].update(x=float('nan'))),
            ('missing-report-key','history',lambda d:d['summary']['errors'][0].pop('reportedPoint')),('multiple-arms','history',lambda d:d['verification']['arms'].append(copy.deepcopy(d['verification']['arms'][0]))),
            ('nonzero-radius','history',lambda d:d['verification']['arms'][0].update(poseRadiusMetres=.001)),('boolean-radius','history',lambda d:d['verification']['arms'][0].update(poseRadiusMetres=False)),
            ('false-exact-pose','history',lambda d:d['verification'].update(exactPoseOnly=False)),('unsupported-domain','history',lambda d:d['config'].update(domainMeters=100)),
            ('wrong-report-map','history',lambda d:d['summary']['errors'][0]['reportedPoint'].update(x=.7)),('wrong-source-error','history',lambda d:d['summary']['errors'][0].update(sourceErrorMetres=.8)),
            ('missing-source','history',lambda d:d['config'].pop('sourcePositionOverride')),('unresolved-has-report','history',lambda d:d['summary'].update(stage='mission-budget-exhausted')),
            ('report-without-nomination','history',lambda d:d.update(nomination=None)),('abstention-with-report','history',lambda d:d['verification']['arms'][0]['decision'].update(status='abstained')),
        ]
        for name,role,mutation in mutations:reject(name,make_fixture(fixture_root/name,baseline,modify={role:mutation}))
        for name,mutation in [
            ('wrong-artifact-digest',lambda m:m['artifacts']['history'].update(sha256='0'*64)),('path-traversal',lambda m:m['artifacts']['history'].update(path='../outside.json')),
            ('absolute-path',lambda m:m['artifacts']['history'].update(path='/outside.json')),('duplicate-path',lambda m:m['artifacts']['audit'].update(path='history.json')),
            ('manifest-as-artifact',lambda m:m['artifacts']['history'].update(path='manifest.json')),('unknown-manifest-version',lambda m:m.update(version='unknown')),
            ('non-synthetic-purpose',lambda m:m.update(purpose='campaign')),('non-synthetic-flag',lambda m:m.update(syntheticOnly=False)),
        ]:reject(name,make_fixture(fixture_root/name,baseline,manifest_change=mutation))
        reject('symlink-artifact',make_fixture(fixture_root/'symlink-artifact',baseline,symlink='process'))
        reject('duplicate-json-key',make_fixture(fixture_root/'duplicate-json-key',baseline,raw_history=lambda d:raw(d).replace(b'"version":',b'"version":"duplicate","version":',1)))
        wrong=make_fixture(fixture_root/'wrong-manifest-digest',baseline);wrong['manifestSha256']='0'*64;reject('wrong-manifest-digest',wrong)
        blank=history('blank','within-tolerance','blank-bad')
        reject('blank-has-source',make_fixture(fixture_root/'blank-has-source',blank,modify={'history':lambda d:d['config'].update(sourcePositionOverride=dict(x=.5,y=.5))}))
        reject('blank-numeric-error',make_fixture(fixture_root/'blank-numeric-error',blank,modify={'history':lambda d:d['summary']['errors'][0].update(sourceErrorMetres=0.)}))
        # Mathematically close but opposite classifications: must not be rounded away.
        near=history('si-continuous','within-tolerance','near-boundary')
        near['verification']['arms'][0]['decision']['candidate']['geometry']['peak']=[1.,0.]
        near['summary']['errors'][0].update(reportedPoint=dict(x=.51,y=.5),sourceErrorMetres=.1)
        discrepancy=abs((.51-.5)*10-.1);assert 0<discrepancy<1e-10 and (.51-.5)*10>.1
        reject('near-boundary-classification',make_fixture(fixture_root/'near-boundary-classification',near))
        assert 'classification disagreement' in negative[-1]['error']
        try:bind_fixtures([entries[0],entries[0]])
        except ValueError:duplicate_rejected=True
        else:raise AssertionError('Duplicate case accepted')
        before=inventory(fixture_root);assert bind_fixtures(entries)==bindings;assert inventory(fixture_root)==before
        write('bindings.json',dict(entries=entries,expected=expected,bindings=bindings))
        write('negative_receipts.json',negative)
        write('fixture_inventory.json',before)
        receipt=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),elapsedSeconds=time.monotonic()-start,validFixtures=len(bindings),negativeFixtures=len(negative),duplicateCaseRejected=duplicate_rejected,nearBoundaryDifferenceMetres=discrepancy,inputBytesUnchanged=True,files={name:sha((a.output/name).read_bytes()) for name in ('bindings.json','negative_receipts.json','fixture_inventory.json')},syntheticOnly=True,realAuditExecuted=False,realHistoriesRead=0,newMissions=0)
        write('complete.json',receipt);print(json.dumps(receipt))
    except BaseException as error:
        write('failure.json',dict(passed=False,error=repr(error),negativeChecksCompleted=len(negative)));raise

if __name__=='__main__':main()
