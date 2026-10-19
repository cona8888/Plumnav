"""Prospective audit routing only; no history, engine, AWS or outcome access."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from lib.si_mechanism_registry_v3 import Registry, validate, ARMS, FIELDS
from lib.si_exact_registry_v1 import strict_json

ROOT=Path(__file__).resolve().parents[1]
ORIGINAL=ROOT/'research/results/si_mechanism_all_arm_v2_attempt01_2026-09-25/prospective_manifest_v2.json'
ORIGINAL_SHA='0f68a87ea6a902848948338d1c5d076bef214bb7f5e59708203df77c2cb6d6cd'
PORTABLE=ROOT/'research/results/si_mechanism_portable_metadata_attempt01_2026-09-29/prospective_manifest_portable_v1.json'
PORTABLE_SHA='625706ed07b9be7415f81d214272348d1f5757cb32833f14cf4272aecddb7e6d'
ALIAS='/Users/w.cha@bham.ac.uk/Documents/Gas source localization App/scripts/audit-si-readout-full-history.py'


def need(ok,why):
    if not ok: raise ValueError(why)


def digest(raw): return hashlib.sha256(raw).hexdigest()


def index(document):
    worlds,cases=validate(document)
    need(document['purpose']=='prospective-128-not-authorised-to-run','Not a prospective campaign')
    lookup={(c['worldKey'],c['arm'],c['spec']['field'],c['spec']['navDt']):c['id'] for c in cases.values()}
    blocks=[]; triplets=[]; effects=[]
    for world in sorted(worlds.values(),key=lambda w:w['index']):
        key=world['key']
        primary={field:{arm:lookup[key,arm,field,1/64] for arm in ARMS} for field in FIELDS}
        blocks.append(dict(worldKey=key,worldIndex=world['index'],primary=primary,
            blankLocalisationSuccessDefined=False))
        if world['index']%8==0:
            for field in FIELDS:
                for arm in ARMS:
                    triplets.append(dict(worldKey=key,arm=arm,field=field,
                        caseIds=[lookup[key,arm,field,dt] for dt in (1/16,1/32,1/64)],
                        navDt=[1/16,1/32,1/64],primaryEndpointDefined=field!='blank'))
    for field in FIELDS[:2]:
        for name,weights in [('interaction',{'GL':1,'RL':-1,'GW':-1,'RW':1}),
                             ('scan-acquisition',{'GL':1,'NS':-1})]:
            effects.append(dict(field=field,name=name,weights=weights,
                pairedWorlds=[dict(worldKey=b['worldKey'],terms=[dict(caseId=b['primary'][field][arm],weight=weight)
                    for arm,weight in weights.items()]) for b in blocks]))
    ids=[cid for b in blocks for cell in b['primary'].values() for cid in cell.values()]
    refinement=[cid for t in triplets for cid in t['caseIds'][:2]]
    need(len(ids)==1920 and len(refinement)==480 and len(triplets)==240,'Audit routing cardinality')
    need(len(set(ids+refinement))==2400 and set(ids+refinement)==set(cases),'Complete one-to-one history coverage')
    return dict(version='mechanism-campaign-audit-index-v1',worldBlocks=blocks,
        resolutionTriplets=triplets,confirmatoryContrasts=effects,
        historyIds=sorted(cases),primaryHistories=1920,refinementHistories=480,
        histories=2400,worlds=128,triplets=240,confirmatoryFamilies=4,
        resamplingUnit='whole world block across all arms and source conditions',
        newMissions=0,awsCalls=0,containsOutcomes=False,productionAdmitted=False,
        scientificAcceptance=False)


def main():
    p=argparse.ArgumentParser(); p.add_argument('--output',type=Path,required=True); a=p.parse_args()
    dest=a.output.resolve()
    need(dest.is_relative_to(ROOT) and not dest.exists(),'Fresh workspace destination required')
    old=ORIGINAL.read_bytes(); need(digest(old)==ORIGINAL_SHA,'Original manifest changed')
    original=strict_json(old)
    registry=Registry(PORTABLE,PORTABLE_SHA)
    expected=dict(original,sources=[r for r in original['sources'] if r['path']!=ALIAS])
    need(registry.document==expected and len(original['sources'])==375
         and len(registry.document['sources'])==374,'Only previously verified duplicate alias removal allowed')
    result=index(registry.document)
    encoded=(json.dumps(result,indent=2)+'\n').encode()
    registry.protect(); need(ORIGINAL.read_bytes()==old,'Frozen original changed during preparation')
    dest.mkdir()
    (dest/'audit-index.json').write_bytes(encoded)
    receipt=dict(createdAt=datetime.now(timezone.utc).isoformat(),passed=True,
        indexSha256=digest(encoded),scriptSha256=digest(Path(__file__).read_bytes()),
        originalManifestSha256=ORIGINAL_SHA,portableManifestSha256=PORTABLE_SHA,
        verifiedSourcePins=374,worlds=128,histories=2400,triplets=240,
        confirmatoryFamilies=4,newMissions=0,awsCalls=0,containsOutcomes=False,
        productionAdmitted=False,scientificallyAccepted=False,
        remaining='Resource witness independent acceptance, frozen execution release, full campaign, all-history/triplet audits and prospective statistics')
    (dest/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt,indent=2))


if __name__=='__main__': main()
