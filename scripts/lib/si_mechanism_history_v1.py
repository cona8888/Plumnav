"""Real artifact binding and terminal projection; no synthetic audit attestation."""
import gzip
import hashlib
import json
from pathlib import Path
from lib.si_terminal_report_v1 import terminal_metadata
from lib.si_release_endpoint_v2 import endpoint
from lib.si_absent_report_full_audit_v1 import derive, namespace, BASE_PATH
from lib.si_readout_terminal_audit import terminal_raw_view
from lib.si_scan_disabled_audit import contract as no_scan_contract

ROOT=Path(__file__).resolve().parents[2]
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def need(value,message):
    if not value:raise ValueError(message)
def load(p):return json.loads(Path(p).read_text())
def pinned(row):
    path=(ROOT/row['path']).resolve();need(path.is_relative_to(ROOT),'Path outside root')
    need(sha(path)==row['sha256'],'Changed artifact: '+row['path']);return path
def history(path):
    with gzip.open(path,'rb') as f:raw=f.read(1024**3+1)
    need(len(raw)<=1024**3,'History size cap');return json.loads(raw)


def old_record(ref,spec):
    paths={k:pinned(v) for k,v in ref.items()}
    done=load(paths['completion']);proc=load(paths['process']);audit=load(paths['audit']);parent=load(paths['parent']);accepted=load(paths['acceptance'])
    need(accepted['accepted'] is True and done['completed'] is True,'Unaccepted reference chain')
    need(type(proc['exitCode']) is int and proc['exitCode']==0 and proc['timedOut'] is False,'Reference process failure')
    need(audit.get('passed',audit.get('details',{}).get('passed')) is True and audit['details']['passed'] is True,'Reference audit failure')
    need(audit['historySha256']==done['historySha256']==ref['history']['sha256'],'Reference history binding')
    parent_sha=ref['parent']['sha256']
    need(audit.get('parentManifestSha256',audit.get('manifestSha256'))==parent_sha,'Reference audit parent binding')
    need(done.get('parentManifestSha256',load(paths['child'])['parentManifestSha256'])==parent_sha,'Reference completion parent binding')
    if 'prospectiveManifestSha256' in accepted:
        need(accepted['developmentManifestSha256']==parent_sha,'Reference mechanism acceptance pin')
    else:need(accepted['manifestSha256']==parent_sha,'Reference acceptance pin')
    item=done.get('case',done.get('item'));need(item is not None and item['spec']==spec,'Reference spec mismatch')
    declared=parent['cases'];need(sum(x==item for x in declared)==1,'Reference case absent from manifest')
    need(done['replay']['passed'] is True and done['replay']['privateFieldQueries']==0,'Reference replay')
    for row in parent['sources']:pinned(row)
    record=history(paths['history']);need(record['spec']==spec and record['development'] is None,'Raw reference spec')
    need(record['summary']['stage']==done['stage'] and record['summary']['completedAt']==done['completedAt'],'Reference terminal mismatch')
    return record,audit


def full_audit(record,arm):
    text,guard=derive(BASE_PATH.read_bytes());auditor=namespace(text,'mechanism_all_arm_full_audit')
    treatment=no_scan_contract(record) if arm=='NS' else None
    raw,_=auditor.availability_audit(record)
    view=terminal_raw_view(record,raw['controls'][-1]['measurement']['sampleMode'])
    details=auditor.audit(view)
    if treatment is not None:
        need(details['availability']['scanCount']==details['availability']['promotedReadouts']==details['availability']['drainRows']==0,'NS availability contract')
        details=dict(**details,scanDisabled=treatment)
    need(details['passed'] is True,'Full audit failed');return details,guard


def terminal(record):
    """Caller must first execute or verify a pinned independent audit."""
    s=record['spec'];c=record['config'];summary=record['summary'];blank=s['field']=='blank'
    need(c['targetStatus']==('absent' if blank else 'emitting'),'Raw target status')
    need(summary['assertedNoLeak'] is False and summary['physicalSourceConfirmed'] is False,'Unsupported physical claim')
    cfg=dict(domainMeters=c['domainMeters'],targetStatus='absent' if blank else 'present')
    if blank:need('sourcePositionOverride' not in c,'Blank with source coordinate')
    else:cfg['sourcePositionOverride']=c['sourcePositionOverride']
    nomination=None if record['nomination'] is None else dict(point=record['nomination']['point'])
    verification=None
    if record['verification'] is not None:
        arms=[]
        for arm in record['verification']['arms']:
            decision=arm['decision'];candidate=decision['candidate']
            if decision['status']=='supported':candidate=dict(geometry=dict(peak=candidate['geometry']['peak']))
            arms.append(dict(poseRadiusMetres=arm['poseRadiusMetres'],decision=dict(status=decision['status'],candidate=candidate)))
        verification=dict(exactPoseOnly=record['verification']['exactPoseOnly'],arms=arms)
    meta=terminal_metadata(s['field'],cfg,nomination,verification,{k:summary[k] for k in ('stage','errors')})
    meta=dict(auditPassed=True,**meta)
    return dict(metadata=meta,endpoint=endpoint(meta))


def canonical(record):
    record['summary']['rpcMilliseconds']=0
    if record['verification'] is not None:record['verification']={k:record['verification'][k] for k in ('exactPoseOnly','arms')}
    return record
