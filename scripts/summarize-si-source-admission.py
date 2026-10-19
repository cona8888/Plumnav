"""Receipt-level development summary; not a population performance analysis."""
import argparse
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path

def load(p):return json.loads(p.read_text())
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    manifest=load(a.input/'manifest.json');done=load(a.input/'complete.json');accepted=load(a.input/'acceptance.json')
    assert done['completed'] and done['accepted'] and accepted['accepted']
    assert accepted['manifestSha256']==sha(a.input/'manifest.json') and len(manifest['cases'])==20
    for r in manifest['sources']:assert sha(Path(r['path']))==r['sha256']
    inventory=[];triplets=[]
    for item in manifest['cases']:
        folder=a.input/item['id'];run=load(folder/'run/complete.json');process=load(folder/'process_terminal.json')
        assert run['completed'] and process['exitCode']==0 and not process['timedOut']
        assert run['item']==item and run['historySha256']==sha(folder/'run/mission.json.gz')
        row=dict(caseId=item['id'],kind=item['kind'],field=item['spec']['field'],policy=item['spec']['policy'],availability=item.get('availability'),navDt=item['spec']['navDt'],stage=run['stage'],completedAt=run['completedAt'],bytes=run['bytes'],terminalRssBytes=run['terminalRssBytes'],missionWallSeconds=process['elapsedSeconds'],publicReplay=run['replay'],historySha256=run['historySha256'])
        if item['kind']=='candidate':
            audit=load(folder/'independent_audit.json')
            assert audit['passed'] and audit['historySha256']==run['historySha256'] and audit['manifestSha256']==accepted['manifestSha256']
            row.update(exactParentMatched=audit['exactParentMatched'],availabilityAudit=audit['details']['availability'],traceRows=audit['details']['traceRows'],auditWallSeconds=load(folder/'audit_terminal.json')['elapsedSeconds'])
        inventory.append(row)
    for policy in ('reference','encounter-gated'):
        for availability in ('original-withheld','live-passive'):
            path=a.input/f'si-pulse-{policy}-{availability}-triplet.json';r=load(path);assert r['result']['passed'];triplets.append(dict(path=path.name,sha256=sha(path),**r))
    assert sum(x.get('exactParentMatched',False) for x in inventory)==4
    body=dict(passed=True,createdAt=datetime.now(timezone.utc).isoformat(),scriptSha256=sha(Path(__file__)),manifestSha256=sha(a.input/'manifest.json'),completeSha256=sha(a.input/'complete.json'),acceptanceSha256=sha(a.input/'acceptance.json'),sourceEntriesUnchanged=len(manifest['sources']),elapsedSeconds=done['elapsedSeconds'],childInvocations=len(done['commands']),newMissionCount=20,candidateAuditCount=16,exactParentMatches=4,passedPulseTriplets=4,totalCompressedHistoryBytes=sum(x['bytes'] for x in inventory),maxTerminalRssSnapshotBytes=max(x['terminalRssBytes'] for x in inventory),maxMissionWallSeconds=max(x['missionWallSeconds'] for x in inventory),maxAuditWallSeconds=max(x.get('auditWallSeconds',0) for x in inventory),inventory=inventory,triplets=triplets,developmentWorlds=1,claim='Correctness and refinement admission for the fixed development configuration, not an algorithm performance estimate.',physicalValidation=False,fullPerformanceCampaignAdmitted=False)
    with a.output.open('x') as f:json.dump(body,f,indent=2);f.write('\n')
    print(json.dumps({k:v for k,v in body.items() if k not in ('inventory','triplets')},indent=2))

if __name__=='__main__':main()
