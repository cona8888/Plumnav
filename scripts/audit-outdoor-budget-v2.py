#!/usr/bin/env python3
"""Separate closure with corrected reference; preserves failed v1 and all raw data."""
import argparse
from datetime import datetime,timezone
import importlib.util
import json
from pathlib import Path
import shutil
import time
from lib.outdoor_budget_quadrature_v2 import independent_concentration

spec=importlib.util.spec_from_file_location('budget_v1',Path(__file__).with_name('audit-outdoor-budget.py'))
budget=importlib.util.module_from_spec(spec);spec.loader.exec_module(budget)
read,sha,require=budget.read,budget.sha,budget.require
SOURCES=['scripts/audit-outdoor-budget-v2.py','scripts/lib/outdoor_budget_quadrature_v2.py',
    'scripts/test-outdoor-budget-quadrature-v2.py','scripts/test-outdoor-budget-adversarial.py',
    'scripts/lib/outdoor_budget_statistics.py','scripts/test-outdoor-budget-statistics.py',
    'research/protocols/outdoor_budget_reference_amendment_v2_2026-09-22.md']


def dump(file,value):
    with file.open('x') as out:json.dump(value,out,indent=2,allow_nan=False);out.write('\n')


def main():
    p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    args=p.parse_args();root=args.input;out=args.output
    require(not out.exists(),'Output exists; preserve previous review')
    original=read(root/'manifest.json');failure=read(root/'audit.failed.json')
    require(failure['accepted'] is False and failure['diagnosticOnly'],'Expected preserved reference failure')
    source_hashes=[dict(file=f,sha256=sha(f)) for f in SOURCES]
    out.mkdir(parents=True)
    for r in source_hashes:
        dest=out/'source-snapshot'/r['file'];dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(r['file'],dest)
    manifest=dict(schemaVersion='outdoor-budget-reference-review-v2',createdAt=datetime.now(timezone.utc).isoformat(),
        inputDirectory=str(root.resolve()),inputManifestSha256=sha(root/'manifest.json'),
        inputExecutionSha256=sha(root/'execution-complete.json'),preservedFailedAuditSha256=sha(root/'audit.failed.json'),
        sourceHashes=source_hashes,forwardModelChanged=False,tolerancesChanged=False,physicalValidation=False)
    dump(out/'manifest.json',manifest);start=time.perf_counter()
    previous=budget.pilot.independent_concentration
    try:
        budget.pilot.independent_concentration=independent_concentration
        development_start=time.perf_counter();development=budget.audit(root)
        development['auditSeconds']=time.perf_counter()-development_start
        print('Extended development full audit passed; rechecking earlier 128-world campaign.',flush=True)
        priorroot=Path('research/results/outdoor_holdout_campaign_v1_2026-09-22')
        prior_start=time.perf_counter();prior=budget.holdout.audit(priorroot)
        prior_seconds=time.perf_counter()-prior_start
        require(prior['statistics']==read(priorroot/'audit.json')['statistics'],'Previous performance statistics changed')
        require(all(sha(r['file'])==r['sha256'] for r in source_hashes),'New reference source changed')
        require(sha(root/'manifest.json')==manifest['inputManifestSha256'] and sha(root/'audit.failed.json')==manifest['preservedFailedAuditSha256'],'Original development record changed')
        projected_audit=development['auditSeconds']*544/24
        total_estimate=1.25*(development['projectedCampaignComputeSeconds']+projected_audit)
        result=dict(schemaVersion='outdoor-budget-reference-review-v2',accepted=True,developmentOnly=True,
            checkedAt=datetime.now(timezone.utc).isoformat(),development=development,
            priorCampaign=dict(directory=str(priorroot.resolve()),acceptedWithCorrectedReference=True,
                histories=prior['rawHistories'],resolutionTriplets=len(prior['resolutionTriplets']),
                fieldPoints=sum(r['independentFieldPoints']+r['sourceProbes']['points'] for r in prior['checks']),
                unchangedStatistics=True,priorAuditSha256=sha(priorroot/'audit.json'),auditSeconds=prior_seconds),
            projectedCampaignAuditSeconds=projected_audit,projectedEndToEndWith25PercentHeadroomSeconds=total_estimate,
            seconds=time.perf_counter()-start,reservedEvaluationWorldsUsed=0,campaignLaunched=False,awsLaunched=False,
            originalFailedAuditPreserved=True,simulatorUnchanged=True,tolerancesUnchanged=True,physicalValidation=False)
        dump(out/'audit.json',result)
        dump(out/'closure.json',dict(accepted=True,developmentOnly=True,manifestSha256=sha(out/'manifest.json'),
            auditSha256=sha(out/'audit.json'),inputManifestSha256=sha(root/'manifest.json'),
            inputExecutionSha256=sha(root/'execution-complete.json'),
            preservedFailedAuditSha256=sha(root/'audit.failed.json'),reservedEvaluationWorldsUsed=0,awsLaunched=False))
        print(json.dumps({k:v for k,v in result.items() if k!='development'}))
    except Exception as error:
        dump(out/'audit.failed.json',dict(accepted=False,diagnosticOnly=True,error=str(error)))
        raise
    finally:
        budget.pilot.independent_concentration=previous


if __name__=='__main__':main()
