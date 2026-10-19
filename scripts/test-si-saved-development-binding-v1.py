"""Sequential saved-record binding with a separate terminal checker and negatives."""
import argparse
import copy
from datetime import datetime, timezone
import gc
import hashlib
import json
import math
from pathlib import Path
import time
from lib.si_exact_registry_v1 import strict_json
from lib.si_saved_development_binding_v1 import CASES, PARENT, PARENT_SHA, read_pinned, check_chain, checked_path, project, extract
from lib.si_saved_development_check_v1 import check

ROOT = Path(__file__).resolve().parents[1]


def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path, data):
    with path.open('x') as stream:
        json.dump(data, stream, indent=2, allow_nan=False); stream.write('\n')


def main():
    p = argparse.ArgumentParser(); p.add_argument('--manifest', type=Path, required=True); p.add_argument('--output', type=Path, required=True)
    args = p.parse_args(); start = time.monotonic()
    args.output.mkdir(exist_ok=False)
    m = strict_json(args.manifest.read_bytes()); assert m['protocolSha256'] == 'ad3630cbb5977789b667ee27898f7edfa8790e6a77960b9617e931fab840fb68'
    assert m['caseIds'] == list(CASES) and m['parentManifestSha256'] == PARENT_SHA
    def protect():
        for row in m['inputs'] + m['sources']:
            assert sha(checked_path(ROOT, row['path'])) == row['sha256'], row['path']
    protect()
    parent_docs = {key: read_pinned(ROOT, row) for key, row in m['parentFiles'].items()}
    for row in parent_docs['parent']['sources']:
        assert sha(ROOT/row['path']) == row['sha256'], row['path']
    assert len(parent_docs['parent']['sources']) == 334
    negatives = []
    def reject(name, fn):
        try:
            fn()
        except (ValueError, AssertionError, KeyError, TypeError, IndexError) as error:
            negatives.append(dict(name=name, rejected=True, error=type(error).__name__+': '+str(error)))
            return
        raise AssertionError('Negative escaped: '+name)
    results = []
    try:
        for case in CASES:
            files = m['caseFiles'][case]
            docs = dict(parent_docs, **{key: read_pinned(ROOT, row) for key, row in files.items() if key != 'history'})
            record, compressed_bytes = read_pinned(ROOT, files['history'], compressed=True)
            spec = check_chain(case, docs, files['history']['sha256'], compressed_bytes)
            result = extract(record, spec, docs['completion']); independent = check(record, result)
            results.append(dict(caseId=case, history=files['history'], reusedAudit=files['audit'],
                                extracted=result, independentProjection=independent,
                                fullHistoryBindingVerified=True, existingScientificAuditReceiptVerified=True,
                                newScientificAuditsExecuted=0, freshCampaignAdmitted=False))
            def chain_bad(name, role, change):
                d = dict(docs); d[role] = copy.deepcopy(d[role]); change(d[role])
                reject(case+': '+name, lambda: check_chain(case, d, files['history']['sha256'], compressed_bytes))
            chain_bad('incomplete', 'completion', lambda d: d.update(completed=False))
            chain_bad('missing completion', 'completion', lambda d: d.pop('completed'))
            chain_bad('wrong case', 'completion', lambda d: d.update(caseId='unknown'))
            chain_bad('wrong field', 'childManifest', lambda d: d['item']['spec'].update(field='blank' if spec['field'] != 'blank' else 'si-pulse'))
            chain_bad('wrong parent', 'childManifest', lambda d: d.update(parentManifestSha256='0'*64))
            chain_bad('wrong history', 'audit', lambda d: d.update(historySha256='0'*64))
            chain_bad('failed audit', 'audit', lambda d: d.update(passed=False))
            chain_bad('failed process', 'process', lambda d: d.update(exitCode=1))
            chain_bad('bool exit code', 'process', lambda d: d.update(exitCode=False))
            chain_bad('timed-out audit', 'auditProcess', lambda d: d.update(timedOut=True))
            chain_bad('wrong process command', 'process', lambda d: d['command'].__setitem__(-1, 'unknown'))
            chain_bad('missing parent audit command', 'batchComplete', lambda d: d.update(commands=[x for x in d['commands'] if x != docs['auditProcess']]))
            # Terminal-only copies preserve the large immutable arrays by reference.
            def view():
                r = dict(record)
                for key in ('config', 'spec', 'summary', 'nomination', 'verification'):
                    r[key] = copy.deepcopy(record[key])
                return r
            def projection_bad(name, change):
                r = view(); change(r)
                reject(case+': '+name, lambda: project(r, spec, docs['completion']))
            projection_bad('version', lambda r: r.update(schemaVersion='unknown'))
            projection_bad('undeclared development', lambda r: r.update(development={'analyticPeak': True}))
            projection_bad('target status', lambda r: r['config'].update(targetStatus='unknown'))
            projection_bad('terminal mismatch', lambda r: r['summary'].update(completedAt=599))
            if record['nomination'] is not None:
                projection_bad('missing nomination', lambda r: r.update(nomination=None))
                projection_bad('missing verification', lambda r: r.update(verification=None))
                projection_bad('nonzero radius', lambda r: r['verification']['arms'][0].update(poseRadiusMetres=.01))
                # Artificial supported view for report-mapping checks. This is
                # never represented as a genuine audited supported history.
                artificial = view(); origin = artificial['nomination']['point']; source = artificial['config']['sourcePositionOverride']
                artificial['verification']['arms'][0]['decision'] = dict(status='supported', candidate={'geometry': {'peak': [0, 0]}})
                artificial['summary']['errors'] = [dict(poseRadiusMetres=0, reportedPoint=dict(origin), sourceErrorMetres=math.hypot(origin['x']-source['x'], origin['y']-source['y'])*10)]
                project(artificial, spec, docs['completion'])
                bad = dict(artificial, summary=copy.deepcopy(artificial['summary']))
                bad['summary']['errors'][0]['reportedPoint']['x'] += .01
                reject(case+': artificial inconsistent report', lambda: project(bad, spec, docs['completion']))
                bad = dict(artificial, verification=copy.deepcopy(artificial['verification']))
                bad['verification']['arms'][0]['decision']['candidate']['geometry']['peak'] = [1]
                reject(case+': artificial invalid geometry', lambda: project(bad, spec, docs['completion']))
                # Remove references before the next full record is parsed.
                del artificial, bad
            else:
                projection_bad('blank invalid report/error', lambda r: r['summary'].update(errors=[{'sourceErrorMetres': .1}]))
                projection_bad('blank source coordinate', lambda r: r['config'].update(sourcePositionOverride={'x': .5, 'y': .5}))
            write(args.output/(case+'.json'), results[-1])
            print('BOUND '+case+'; existing audit receipt reused; no new scientific audit', flush=True)
            del record, result, independent, docs
            gc.collect()
        reject('unknown case', lambda: check_chain('unknown', {}, '0'*64, 1))
        for raw in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}', '{"x":1e400}'):
            reject('strict JSON '+raw, lambda raw=raw: strict_json(raw))
        for path in ('../manifest.json', '/etc/passwd', PARENT+'//manifest.json', PARENT+'/./manifest.json'):
            reject('unsafe path '+path, lambda path=path: checked_path(ROOT, path))
        row = dict(m['parentFiles']['parent'], sha256='0'*64)
        reject('wrong byte pin', lambda: read_pinned(ROOT, row))
        protect()
        for row in parent_docs['parent']['sources']:
            assert sha(ROOT/row['path']) == row['sha256']
        write(args.output/'negative_checks.json', negatives)
        write(args.output/'acceptance.json', dict(accepted=True, acceptedFor='three existing scan-disabled development histories: receipt binding and terminal projection only',
              createdAt=datetime.now(timezone.utc).isoformat(), elapsedSeconds=time.monotonic()-start,
              executionManifestSha256=sha(args.manifest), cases=len(results), negativeChecksRejected=len(negatives),
              parentSourceEntriesUnchanged=334, fullHistoryBindingVerified=True,
              existingScientificAuditReceiptsVerified=True, newScientificAuditsExecuted=0, newMissions=0,
              actualSupportedBlankAuditBranchAdmitted=False, freshCampaignAdmitted=False,
              independentWorldCount=1, performanceOutcomesAggregated=False, physicalValidation=False))
    except BaseException as error:
        write(args.output/'failed.json', dict(accepted=False, error=type(error).__name__+': '+str(error),
              elapsedSeconds=time.monotonic()-start, completedCases=[r['caseId'] for r in results],
              negativeChecks=negatives, diagnosticOnly=True))
        raise


if __name__ == '__main__': main()
