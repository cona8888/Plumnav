#!/usr/bin/env python3
"""In-memory corruption witnesses; never edits a raw history."""
import argparse
import copy
import gzip
import importlib.util
import json
from pathlib import Path

spec=importlib.util.spec_from_file_location('checker',Path(__file__).with_name('audit-outdoor-budget.py'))
checker=importlib.util.module_from_spec(spec);spec.loader.exec_module(checker)


def main():
    p=argparse.ArgumentParser();p.add_argument('trace',type=Path);args=p.parse_args()
    before=checker.sha(args.trace);trace=json.loads(gzip.decompress(args.trace.read_bytes()))
    checker.check_trace(trace,trace['spec'])
    def renormalise(t):
        w=t['world']
        for r in t['inlet']:
            r['backgroundPpm']=2+w['backgroundOffsetPpm']+w['backgroundDriftPpm']*r['t']/t['durationSeconds']
    def reset(t):
        for m in t['measurements']:m['readings'][600]=2
    mutations={
        'wrong-duration':lambda t:t.update(durationSeconds=t['durationSeconds']-1),
        'truncated-route':lambda t:t['inlet'].pop(),
        'wrong-substep-clock':lambda t:t['inlet'][round(600/t['resolution']['dt'])].update(t=600),
        'renormalised-background':renormalise,
        'reset-sensor-at-prefix':reset,
        'wrong-full-route-distance':lambda t:t.update(distanceMetres=989),
        'truncated-noise-clock':lambda t:t['noise'].pop(),
        'invented-budget-alarm':lambda t:t['measurements'][0]['outcomes'][1].update(alarmSeconds=0),
    }
    passed=[]
    for name,mutate in mutations.items():
        damaged=copy.deepcopy(trace);mutate(damaged)
        try:checker.check_trace(damaged,trace['spec'])
        except (ValueError,AssertionError):passed.append(name)
        else:raise AssertionError('Checker accepted corruption: '+name)
    assert checker.sha(args.trace)==before
    print(json.dumps(dict(passed=True,unchangedTraceSha256=before,rejectedMutations=passed)))


if __name__=='__main__':main()
