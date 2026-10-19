"""Bounded interpretation of downloaded evidence; no new simulated histories."""
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'research/results/si_mechanism_smoke_v3_diagnostic_attempt01_2026-09-28'
SCIENCE = ROOT / 'aws/build/si-mechanism-preflight-candidate-20260925-v3'
OVERLAY = ROOT / 'aws/build/PlumeNav_mechanism_smoke_20260927_v3_attempt02/overlay'
sys.path.insert(0, str(OVERLAY))
import common
science, delivery, registry = common.context(SCIENCE)
from lib.si_mechanism_history_v1 import history, pinned, sha
from lib.si_stationary_head_contract import evaluate
import mechanism_portability_candidate_v1 as policy
import numpy as np

CID = 'mechanism-development-3000-GL-si-pulse-n64'
entry = next(x for x in delivery['smokeCases'] if x['caseId'] == CID)
refpath = pinned(entry['referenceHistory'])
cloudpath = OUT / 'download/output/cases' / CID / 'mission.json.gz'
hashes = [sha(refpath), sha(cloudpath)]
ref, cloud = history(refpath), history(cloudpath)
rejections = common.load(OUT / (CID + '-all-rejections.json'))


def semantic(record):
    d = record['verification']['arms'][0]['decision']
    c = d['candidate']
    return dict(wrapper={k:v for k,v in d.items() if k != 'candidate'},
        candidate={k:v for k,v in c.items() if k not in ('geometry','dwell','crossfit')},
        geometryAdmitted=c['geometry']['admitted'], geometryRank=c['geometry']['rank'],
        dwellState=c['dwell']['state'], crossfitState=c['crossfit']['state'],
        windows=[{k:w[k] for k in ('visit','state','reason')} for w in c['dwell']['windows']],
        pairs=[{k:p[k] for k in ('centres','trainingVisits','state','reason')} for p in c['crossfit']['pairs']])


def margins(record):
    c = record['verification']['arms'][0]['decision']['candidate']
    windows = c['dwell']['windows']
    gaps = [w['range'] - w.get('spatialChangeUpper', 0) - w['tolerance']
            for w in windows if w['state'] == 'reject']
    return dict(status=c['status'], reason=c['reason'],
        rejectedWindows=sum(w['state']=='reject' for w in windows),
        rejectedWindowMinimumMargin=min(gaps) if gaps else None,
        geometryRmse=c['geometry']['rmseUpper'], fitTolerance=.003,
        geometryRmseExcess=c['geometry']['rmseUpper']-.003,
        smallestCrossfitRmseExcess=min(p['envelope']['rmseUpper']-.003 for p in c['crossfit']['pairs']))


# This evaluates only the verifier on two EXISTING saved inputs using the frozen
# implementation; it does not move a robot, evolve a plume, or generate a mission.
reevaluated = {label: evaluate(r['visits'], 0., motion_contract=r['motionContract'])
              for label, r in (('referenceInputs',ref),('cloudInputs',cloud))}
audit = common.load(OUT / 'independent-audit' / (CID + '-comparison.json'))['audit']
report = dict(diagnosticOnly=True, accepted=False, campaignAllowed=False,
    allControllerDecisionsExact=policy.compare(
        [{k:v for k,v in c.items() if k in ('time','stage','decision')} for c in ref['controls']],
        [{k:v for k,v in c.items() if k in ('time','stage','decision')} for c in cloud['controls']])['passed'],
    controllerDecisionCount=len(cloud['controls']),
    allVerifierSemanticDecisionsExact=policy.compare(semantic(ref),semantic(cloud))['passed'],
    verifierSemantics=semantic(cloud),
    rawHistoryRejections=rejections['count'],
    retainedValueRejections=sum('/samples/' in r['path'] for r in rejections['allRejectedDifferences']),
    derivedVerifierRejections=sum('/decision/candidate/' in r['path'] for r in rejections['allRejectedDifferences']),
    maxRejectedAbsoluteDifference=max(r.get('absoluteDifference',0) for r in rejections['allRejectedDifferences']),
    zeroCrossingTypeRejections=[r for r in rejections['allRejectedDifferences'] if r['reason']=='type'],
    independentEquationResidualsPassed=not audit['invalidResiduals'],
    independentAuditMetadataComparisonPassed=audit['metadata']['passed'],
    auditMetadataRejections=audit['metadata']['examples'],
    initialDiagnosticLabelClarification='independentAuditResidualsWithinBounds in diagnostic.json copied the combined audit comparison result, which also requires exact metadata. For GL, the equation residuals passed; only the numerical decisionCheck/maximumNumericDifference metadata comparison failed. Use the separate fields in this report.',
    referenceDecisionMargins=margins(ref), cloudDecisionMargins=margins(cloud),
    rawCloudSummary=cloud['summary'],
    verifierReevaluationOnExistingInputs=reevaluated,
    localLinearAlgebraConfig=np.show_config(mode='dicts'),
    cloudLinearAlgebraBackendKnown=False,
    limitation='This is a two-history development diagnostic, not a prospective portability acceptance or physical validation.')
assert hashes == [sha(refpath),sha(cloudpath)]
registry.protect()
report['inputHashesUnchanged'] = True
report['scriptSha256'] = sha(Path(__file__))
common.write(OUT / 'interpretation.json', report)
print(json.dumps({k:v for k,v in report.items() if k not in (
    'verifierReevaluationOnExistingInputs','localLinearAlgebraConfig','zeroCrossingTypeRejections','verifierSemantics')},indent=2))
