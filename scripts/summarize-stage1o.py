#!/usr/bin/env python3
"""Post-audit descriptive summary; does not alter frozen Stage 1o gates."""
import argparse,gzip,hashlib,json,statistics
from collections import Counter
from pathlib import Path
import numpy as np


def sha(b):return hashlib.sha256(b).hexdigest()


def main():
    p=argparse.ArgumentParser();p.add_argument('--raw',type=Path,required=True);p.add_argument('--analysis',type=Path,required=True);a=p.parse_args()
    marker=json.loads((a.analysis/'complete.json').read_text());assert marker['complete']
    for name,digest in marker['files'].items():assert sha((a.analysis/name).read_bytes())==digest
    analysis=json.loads((a.analysis/'analysis.json').read_text());audit=json.loads((a.analysis/'independent-audit.json').read_text());records=json.loads((a.analysis/'run-summaries.json').read_text())
    assert analysis['integrityAccepted'] and audit['accepted'] and len(records)==192
    manifest=(a.raw/'manifest.json').read_bytes();m=json.loads(manifest)
    assert analysis['rawManifestSha256']==audit['rawManifestSha256']==sha(manifest)
    for source in m['sources']:
        assert sha(Path(source['file']).read_bytes())==source['sha256']==sha((a.raw/'source-snapshot'/source['name']).read_bytes())
    for item in analysis['rawInventory']:
        raw=(a.raw/item['file']).read_bytes();assert sha(raw)==item['sha256'] and len(raw)==item['bytes']
    details={}
    for r in records:
        item=r['detail'];raw=(a.analysis/item['file']).read_bytes();assert sha(raw)==item['sha256'] and len(raw)==item['bytes']
        details[r['spec']['index']]=json.loads(gzip.decompress(raw))
    positives={'peak','offset-peak','si-continuous'}
    primary=[(r,v) for r in records for v in r['variants'] if v['contractClass']=='declared-motion']
    wrong=[(r,v) for r in records for v in r['variants'] if v['contractClass']!='declared-motion']
    baseline={(r['spec']['field'],r['spec']['phaseSeconds'],r['spec']['replicate']):r for r in records if r['spec']['mode']==0}
    changes=[]
    for r in records:
        s=r['spec'];b=baseline[s['field'],s['phaseSeconds'],s['replicate']]
        d=details[s['index']]['variants'][0];bd=details[b['spec']['index']]['variants'][0]
        measured=np.array([sample['value'] for v in d['visits'] for sample in v['samples']])
        base=np.array([sample['value'] for v in bd['visits'] for sample in v['samples']])
        peak_shift=None
        if d['v4']['status']=='supported' and bd['v4']['status']=='supported':
            peak_shift=.1*float(np.linalg.norm(np.array(d['v4']['geometry']['peak'])-bd['v4']['geometry']['peak']))
        changes.append({'spec':s,'maxPairedRetainedMeasurementChangeC0':float(np.max(abs(measured-base))),
                        'relativeFittedPeakShiftMetres':peak_shift})
    def summarize_group(rows):
        return {'evaluations':len(rows),'supports':sum(v['status']=='supported' for r,v in rows),
                'reasons':dict(Counter(v['reason'] for r,v in rows))}
    modes=[]
    for mode in range(6):
        row={'mode':m['modes'][mode], 'corePositives':{},'controls':{}}
        for model in ['exact','readout-jitter']:
            row['corePositives'][model]=summarize_group([(r,v) for r,v in primary if r['spec']['mode']==mode and r['spec']['field'] in positives and v['model']==model])
            row['controls'][model]=summarize_group([(r,v) for r,v in primary if r['spec']['mode']==mode and r['spec']['field'] not in positives and v['model']==model])
        if mode>=4:row['misspecifiedRotation']=summarize_group([(r,v) for r,v in wrong if r['spec']['mode']==mode])
        rs=[r for r in records if r['spec']['mode']==mode]
        for metric in ['fullRateHeadDisplacementDiameterMetres','retainedHeadDisplacementDiameterMetres','fullRateAngularSpanRadians','retainedAngularSpanRadians']:
            row[metric]=max(w[metric] for r in rs for w in r['motionWindows'])
        vals=[v['maxPairedRetainedMeasurementChangeC0'] for v in changes if v['spec']['mode']==mode]
        row['pairedMeasurementChangeC0']={'medianOfCaseMaxima':statistics.median(vals),'maximum':max(vals)}
        modes.append(row)
    peak_errors=[v['analyticFieldPeakErrorMetres'] for r,v in primary if v['analyticFieldPeakErrorMetres'] is not None]
    summary={'integrityAccepted':True,'scientificGatesPassed':analysis['passed'],'scientificGates':analysis['scientificGates'],
             'primaryPhysicalInspections':192,'unwrappedReferences':32,'prescribedPathRefinements':16,
             'primaryPairedEvaluations':len(primary),'misspecifiedPairedEvaluations':len(wrong),
             'primaryControls':summarize_group([(r,v) for r,v in primary if r['spec']['field'] not in positives]),
             'misspecifiedControls':summarize_group([(r,v) for r,v in wrong if r['spec']['field'] not in positives]),
             'supportedAnalyticPeakErrors':{'n':len(peak_errors),'medianMetres':statistics.median(peak_errors) if peak_errors else None,'maxMetres':max(peak_errors) if peak_errors else None},
             'modes':modes,'pairedCaseChanges':changes,'convergence':analysis['convergence'],
             'physicalWallSeconds':analysis['physicalWallSeconds'],'analysisWallSeconds':analysis['analysisWallSeconds'],
             'maximumSampledWorkerRssBytes':max(w['maxRssBytes'] for w in analysis['workers']),
             'inspectionSeconds':analysis['inspectionSeconds'],'rawManifestSha256':sha(manifest),
             'analysisSha256':sha((a.analysis/'analysis.json').read_bytes()),'auditorArtifactSha256':sha((a.analysis/'independent-audit.json').read_bytes()),
             'summaryScriptSha256':sha(Path(__file__).read_bytes()),'frozenSourcesUnchanged':True,
             'claimBoundary':'Paired numerical challenge on prescribed fields and idealized head-pose information; no field calibration, source-absence proof, or autonomous GSL result.'}
    with (a.analysis/'validation-summary.json').open('x') as f:f.write(json.dumps(summary,sort_keys=True,indent=2)+'\n')
    print(json.dumps({k:v for k,v in summary.items() if k not in ['pairedCaseChanges','modes']},indent=2))
    print(json.dumps(modes,indent=2))


if __name__=='__main__':main()
