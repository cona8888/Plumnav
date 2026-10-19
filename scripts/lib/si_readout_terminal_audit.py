"""Read-only terminal navigation-mode adapter for the frozen motion auditor."""
import importlib.util
from pathlib import Path

spec=importlib.util.spec_from_file_location('frozen_full_readout_audit',Path(__file__).parents[1]/'audit-si-readout-full-history.py')
base=importlib.util.module_from_spec(spec);spec.loader.exec_module(base)

def terminal_raw_view(record,raw_mode):
    terminal=record['navigation'][-1]
    assert terminal['time']==record['controls'][-1]['time']
    assert terminal['sampleMode']==record['controls'][-1]['measurement']['sampleMode'],'Invalid effective terminal navigation mode'
    assert raw_mode in ('passive','blanked','quad-passive-return')
    navigation=record['navigation'][:-1]+[dict(terminal,sampleMode=raw_mode)]
    return dict(record,navigation=navigation)

def audit(record):
    raw,_=base.availability_audit(record)
    view=terminal_raw_view(record,raw['controls'][-1]['measurement']['sampleMode'])
    return base.audit(view)

def self_test():
    for raw,effective in [('blanked','passive'),('blanked','blanked'),('passive','passive'),('quad-passive-return','quad-passive-return')]:
        r=dict(navigation=[dict(time=600,sampleMode=effective,unchanged=[1,2,3])],controls=[dict(time=600,measurement=dict(sampleMode=effective))])
        v=terminal_raw_view(r,raw)
        assert r['navigation'][0]['sampleMode']==effective and v['navigation'][0]['sampleMode']==raw
        assert v['controls'] is r['controls'] and v['navigation'][0]['unchanged'] is r['navigation'][0]['unchanged']
    bad=dict(navigation=[dict(time=600,sampleMode='passive')],controls=[dict(time=600,measurement=dict(sampleMode='blanked'))])
    try:terminal_raw_view(bad,'blanked')
    except AssertionError:pass
    else:raise AssertionError('Bad terminal mode escaped adapter')
    return dict(passed=True,validModeFixtures=4,negativeModeFixtures=1,savedRecordUnmodified=True)
