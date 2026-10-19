"""Versioned, explicit projection substitution into unchanged v1 test harness."""
import copy
import importlib.util
from pathlib import Path
from lib.si_saved_development_binding_v2 import mapped_record, project, extract


def main():
    valid = invalid = 0
    for field in ('si-continuous', 'si-pulse', 'blank'):
        expected = 'absent' if field == 'blank' else 'emitting'
        raw = dict(config=dict(targetStatus=expected, domainMeters=10))
        before = copy.deepcopy(raw)
        mapped = mapped_record(raw, field)
        assert raw == before and mapped is not raw and mapped['config'] is not raw['config']
        assert mapped['config']['targetStatus'] == ('absent' if field == 'blank' else 'present')
        valid += 1
        for wrong in ('present', 'emitting' if field == 'blank' else 'absent'):
            raw['config']['targetStatus'] = wrong
            try: mapped_record(raw, field)
            except ValueError: invalid += 1
            else: raise AssertionError('Wrong engine target accepted')
    assert valid == 3 and invalid == 6
    print('STATUS MAPPING: 3 valid, 6 invalid; raw inputs unchanged', flush=True)
    path = Path(__file__).with_name('test-si-saved-development-binding-v1.py')
    spec = importlib.util.spec_from_file_location('saved_binding_v1_harness', path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    # Exactly these two globals are changed in this separate test process.
    # No v1 file, saved record, chain checker or independent checker is edited.
    module.project = project
    module.extract = extract
    module.main()


if __name__ == '__main__': main()
