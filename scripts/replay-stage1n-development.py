#!/usr/bin/env python3
"""Archive v4 replay of Stages 1l/1m as development evidence only."""
import argparse,gzip,hashlib,json
from collections import Counter
from pathlib import Path
from lib.si_bounded_pose_v4 import evaluate


def sha(b):return hashlib.sha256(b).hexdigest()


def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
    source=json.loads((a.input/'analysis.json').read_text());records=[];counts=Counter();false=[]
    for item in source['variantInventory']:
        raw=(a.input/item['file']).read_bytes();assert sha(raw)==item['sha256'];b=json.loads(gzip.decompress(raw))
        for v in b['variants']:
            frame=v['model']=='frame-translation';result=evaluate(v['visits'],0. if frame else v['amplitudeMetres'],frame_radius_metres=v['amplitudeMetres'] if frame else 0.,observation_model='fixed-orientation-local-quadratic',dwell_heading_span_radians=0.)
            record={'physicalSpec':b['physicalSpec'],'alternativeIndex':v['alternativeIndex'],'model':v['model'],'amplitudeMetres':v['amplitudeMetres'],'status':result['status'],'reason':result['reason']};records.append(record)
            if b['physicalSpec']['field'] in ['peak','offset-peak','si-continuous']:counts[(v['model'],v['amplitudeMetres'],result['status'])]+=1
            elif result['status']=='supported':false.append(record)
    assert len(records)==source['pairedEvaluations'];a.output.mkdir(parents=True,exist_ok=False)
    report={'evidenceClass':'development replay, not fresh validation','pairedEvaluations':len(records),'controlSupports':false,
            'positiveCounts':[{'model':k[0],'amplitudeMetres':k[1],'status':k[2],'n':n} for k,n in sorted(counts.items())],
            'sourceAnalysisSha256':sha((a.input/'analysis.json').read_bytes()),'candidateSha256':sha(Path('scripts/lib/si_bounded_pose_v4.py').read_bytes()),'scriptSha256':sha(Path(__file__).read_bytes())}
    (a.output/'analysis.json').write_text(json.dumps(report,sort_keys=True,indent=2)+'\n');(a.output/'run-summaries.json').write_text(json.dumps(records,sort_keys=True,separators=(',',':'))+'\n')
    print(json.dumps({'pairedEvaluations':len(records),'controlSupports':len(false),'evidenceClass':'development only'},indent=2))


if __name__=='__main__':main()
