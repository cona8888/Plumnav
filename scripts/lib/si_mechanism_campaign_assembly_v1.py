"""Prospective full-campaign join; unchanged numerical/endpoint/statistics kernels.

This component is not a terminal AWS auditor. Matching downloaded audit files
does not establish that an independent audit was executed. The future terminal
verifier must establish launch/runtime/membership and re-execute all full audits
before treating this component's derived result as scientific evidence.
"""
import hashlib
from pathlib import Path
import numpy as np
from lib.si_exact_registry_v1 import strict_json
from lib.si_mechanism_registry_v3 import Registry, validate, ARMS, FIELDS
from lib.si_linear_integration_audit import compare
from lib.si_release_endpoint_v2 import endpoint, refinement_check
from lib.si_paired_statistics_v2 import paired_statistics

MANIFEST_SHA='625706ed07b9be7415f81d214272348d1f5757cb32833f14cf4272aecddb7e6d'
INDEX_SHA='de17dcd5e156970f16944104286e825952f4eaebd9f5de66203e873e8c5cc2d8'
ANALYSIS_SHA='47e5c2b62e4d818df35b235dddecd207f2f19e2d593a0fd53f8a067a2e8b3f71'


def need(ok, why):
    if not ok:
        raise ValueError(why)


def sha(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f,'sha256').hexdigest()


def load(path):
    return strict_json(Path(path).read_bytes())


def regular(root, relative):
    """Reject symlinked ancestors and traversal, not just symlinked leaves."""
    root=Path(root).resolve(); p=Path(relative)
    need(not p.is_absolute() and '..' not in p.parts and str(p)==relative
         and '\\' not in relative,'Noncanonical evidence path')
    current=root
    for part in p.parts:
        current=current/part
        need(not current.is_symlink(),'Symlinked evidence path')
    need(current.is_file() and current.resolve().is_relative_to(root),'Missing evidence file')
    return current


def frozen(root, manifest, index, analysis):
    root=Path(root).resolve()
    need(sha(manifest)==MANIFEST_SHA and sha(index)==INDEX_SHA
         and sha(analysis)==ANALYSIS_SHA,'Frozen analysis input hash')
    registry=Registry(manifest,MANIFEST_SHA)
    document, routing, config=registry.document,load(index),load(analysis)
    for name, expected in config['kernelHashes'].items():
        need(sha(regular(root,name))==expected,'Changed inherited analysis kernel')
    need(config['portableManifestSha256']==MANIFEST_SHA and config['auditIndexSha256']==INDEX_SHA,
         'Analysis identity chain')
    for key in ('scientificProtocol','inheritedDesign'):
        pin=config[key]
        need(sha(regular(root,pin['path']))==pin['sha256'],'Changed inherited protocol/design')
    namespace=config['bootstrap']['seedNamespace'].encode()
    digest=hashlib.sha256(namespace).digest()
    need(digest.hex()==config['bootstrap']['namespaceSha256']
         and int.from_bytes(digest[:4],'big')==config['bootstrap']['seed'], 'Prospective resampling seed')
    registry.protect()
    return document,routing,config


def check_compact(case, metadata, data):
    need(data['spec']==case['spec'] and metadata['field']==case['spec']['field'], 'Compact case/field mismatch')
    state=endpoint(metadata)
    need(data['summary']['stage']==metadata['stage']
         and (data['nomination'] is not None)==metadata['nominationPresent'],'Compact terminal mismatch')
    if metadata['stage']=='inspection-complete':
        need(len(data['decisions'])==1 and data['decisions'][0]['radius']==0
             and data['decisions'][0]['status']==metadata['nominalStatus'],'Compact support mismatch')
    else:
        need(data['decisions']==[],'Incomplete compact contains decisions')
    for key in ('positions','scalar'):
        a=data[key]
        need(isinstance(a,np.ndarray) and a.dtype.kind=='f' and np.isfinite(a).all(), 'Invalid compact array')
    positions,scalar=data['positions'],data['scalar']
    t=data['summary']['completedAt']
    need(type(t) in (int,float) and np.isfinite(t) and 0<t<=1200
         and positions.shape==(round(t*16)+1,2) and scalar.shape==(int(t)+1,), 'Compact array clocks/shape')
    need(np.all(positions>=0) and np.all(positions<=1) and np.all(scalar>=0), 'Compact physical range')
    return state


def bind_saved_case(producer, independent, case, release_sha):
    """Hash every saved input; compare all audit diagnostics and array bodies.

    Re-execution provenance is a separate prerequisite, not inferred here.
    Producer layout is the frozen campaign run.py layout; independent layout
    is audits/<case> plus logs/<case>.log, in a separate fresh audit tree.
    """
    cid=case['id']
    p_receipt=regular(producer,'run/audits/'+cid+'.json')
    i_receipt=regular(independent,'audits/'+cid+'.json')
    history=regular(producer,'run/cases/'+cid+'/mission.json.gz')
    h=sha(history); diagnostics=[]; bindings=[]; arrays=[]
    for root,prefix,receipt_path in ((producer,'run/audits/',p_receipt),(independent,'audits/',i_receipt)):
        receipt=load(receipt_path)
        need(receipt['passed'] is True and receipt['detailsPassed'] is True
             and receipt['caseId']==cid and receipt['case']==case
             and receipt['manifestSha256']==MANIFEST_SHA and receipt['releaseSha256']==release_sha
             and receipt['historySha256']==h,'Saved audit receipt identity')
        diagnostic=regular(root,prefix+cid+'-diagnostics.json')
        array=regular(root,prefix+cid+'-arrays.npz')
        need(sha(diagnostic)==receipt['diagnosticsSha256'] and sha(array)==receipt['arraysSha256'],
             'Saved audit derivative checksum')
        d=load(diagnostic)
        need(d['historySha256']==h and d['arraysSha256']==receipt['arraysSha256']
             and d['details']['passed'] is True,'Diagnostic identity/full-audit gate')
        with np.load(array,allow_pickle=False) as z:
            need(set(z.files)=={'positions','scalar'},'NPZ exact membership')
            small={k:z[k].copy() for k in ('positions','scalar')}
        check_compact(case,d['extracted']['metadata'],dict(d['compact'],**small))
        need(endpoint(d['extracted']['metadata'])==d['extracted']['endpoint'],'Diagnostic endpoint differs')
        diagnostics.append(d); arrays.append(small)
        bindings.append(dict(receiptSha256=sha(receipt_path),diagnosticsSha256=sha(diagnostic),arraysSha256=sha(array)))
    need(diagnostics[0]==diagnostics[1], 'Producer/independent diagnostics differ')
    need(all(np.array_equal(arrays[0][k],arrays[1][k]) for k in arrays[0]), 'Producer/independent arrays differ')
    return dict(case=case,metadata=diagnostics[1]['extracted']['metadata'],
        compact=dict(diagnostics[1]['compact'],**arrays[1]),
        bindings=dict(historySha256=h,producer=bindings[0],independent=bindings[1]),
        independentExecutionProvenanceVerified=False)


def assemble_rows(document,index,config,rows):
    """All-case structural/numerical gate then world-block statistics.

    Test fixtures may call this function. Therefore it never asserts terminal
    scientific acceptance or that the supplied audit assertions are authentic.
    """
    worlds,cases=validate(document)
    need(type(rows) is dict and set(rows)==set(cases),'Complete 2400-row membership required')
    need(index['histories']==2400 and index['worlds']==128 and index['triplets']==240
         and index['historyIds']==sorted(cases),'Complete frozen audit index required')
    need(config['worlds']==128 and config['primaryHistories']==1920
         and config['refinementHistories']==480 and config['refinementTriplets']==240
         and config['bootstrap']['seed']==711397807 and config['bootstrap']['draws']==10000,
         'Frozen population/resampling allocation')
    for cid,case in cases.items():
        row=rows[cid]
        need(row['case']==case,'Row case identity mismatch')
        check_compact(case,row['metadata'],row['compact'])
    keys=[w['key'] for w in sorted(worlds.values(),key=lambda w:w['index'])]
    need([b['worldKey'] for b in index['worldBlocks']]==keys,'Wrong world block order')
    primary=[]; primary_ids=[]; refinement_ids=[]; triplets=[]; identities=set()
    for block in index['worldBlocks']:
        w=worlds[block['worldKey']]
        need(block['worldIndex']==w['index'] and set(block['primary'])==set(FIELDS), 'Primary world/field identity')
        for field in FIELDS:
            need(set(block['primary'][field])==set(ARMS),'Primary arm membership')
            for arm in ARMS:
                cid=block['primary'][field][arm]; case=cases[cid]
                need((case['worldKey'],case['arm'],case['spec']['field'],case['spec']['navDt'])
                     ==(w['key'],arm,field,1/64),'Wrong primary case routing')
                primary_ids.append(cid)
                primary.append(dict(worldKey=w['key'],arm=arm,field=field,endpoint=rows[cid]['metadata']))
    for route in index['resolutionTriplets']:
        identity=(route['worldKey'],route['arm'],route['field'])
        need(identity not in identities and worlds[identity[0]]['index']%8==0,'Duplicate/undeclared refinement world')
        identities.add(identity)
        need(route['navDt']==[1/16,1/32,1/64] and len(route['caseIds'])==3,'Refinement resolution order')
        selected=[]
        for cid,dt in zip(route['caseIds'],route['navDt']):
            case=cases[cid]
            need((case['worldKey'],case['arm'],case['spec']['field'],case['spec']['navDt'])
                 ==(*identity,dt),'Wrong refinement case routing')
            selected.append(rows[cid])
        refinement_ids.extend(route['caseIds'][:2])
        numerical=compare([r['compact'] for r in selected])
        stability=refinement_check(dict(parentNumericalPassed=numerical['passed'],resolutions=[
            dict(worldKey=identity[0],arm=identity[1],navDt=dt,endpoint=r['metadata'])
            for dt,r in zip(('1/16','1/32','1/64'),selected)]))
        triplets.append(dict(worldKey=identity[0],arm=identity[1],field=identity[2],caseIds=route['caseIds'],
                             numerical=numerical,endpointGate=stability))
    all_ids=primary_ids+refinement_ids
    need(len(primary_ids)==1920 and len(refinement_ids)==480 and len(triplets)==240
         and len(set(all_ids))==2400 and set(all_ids)==set(cases),'Incomplete/duplicate assembly routing')
    failed=[t['caseIds'] for t in triplets if not (t['numerical']['passed'] and t['endpointGate']['passed'])]
    # Preserve the whole adverse resolution map, but never calculate primary
    # inferential results by dropping problematic worlds or resolutions.
    result=dict(version='mechanism-campaign-assembly-v1',componentPassed=not failed,
        histories=2400,worlds=128,primaryHistories=1920,refinementHistories=480,
        triplets=triplets,failedTriplets=failed,statistics=None,
        scope=dict(scientificallyAccepted=False,terminalProvenanceVerified=False,
            independentFullAuditExecutionVerified=False,physicalValidation=False,
            hardwareValidation=False,urbanValidation=False,aerodynamicSniffing=False,
            automaticWinnerSelection=False,validatedAbsenceOfLeak=False,
            explanation='Derived component only; independent all-history terminal acceptance is separately required'))
    if not failed:
        result['statistics']=paired_statistics(primary,keys,bootstrap_seed=config['bootstrap']['seed'])
        need(result['statistics']['bootstrap']['drawCount']==10000,'Prospective draw count')
    return result
