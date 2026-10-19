#!/usr/bin/env python3
"""Mutation tests against an actual pilot history; never edits that history."""
import copy
import gzip
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('auditor', Path(__file__).with_name('audit-outdoor-detectability.py'))
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
trace = json.loads(gzip.decompress(Path(sys.argv[1]).read_bytes()))
assert audit.check_trace(trace, trace['spec'])['passed']


def rejected(name, mutate):
    bad = copy.deepcopy(trace)
    mutate(bad)
    try:
        audit.check_trace(bad, trace['spec'])
    except (ValueError, AssertionError):
        print('PASS rejected '+name)
        return
    raise AssertionError('Accepted corrupt '+name)


rejected('pose', lambda t: t['inlet'][0].update(x=10))
rejected('clock', lambda t: t['inlet'][0].update(t=0))
rejected('world/source', lambda t: t['world']['source'].update(x=50))
rejected('negative concentration', lambda t: t['inlet'][0].update(referenceExcessPpm=-1))
rejected('measurement', lambda t: t['measurements'][0]['readings'].__setitem__(1, 1234))
rejected('decision', lambda t: t['measurements'][0]['outcomes'][0].update(alarmSeconds=-3))
rejected('sensor calibration', lambda t: t['measurements'][0]['sensor'].update(riseSeconds=100))
rejected('background', lambda t: t['inlet'][0].update(backgroundPpm=4))
print(json.dumps(dict(passed=True, mutationTests=8, rawHistoryUnchanged=True)))
