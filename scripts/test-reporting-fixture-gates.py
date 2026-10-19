"""Ensure the versioned full auditor has no hidden physical gate changes."""
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch
from lib.si_reporting_fixture import ReportingFixture, transform
from lib.si_reporting_fixture_audit import transform as audit_transform


class GatePreservationTests(unittest.TestCase):
    def test_full_integration_auditor_exact_delta(self):
        expected=Path('scripts/lib/si_linear_integration_audit.py').read_text()
        changes=[
          ('"""Stage 2f: versioned maneuver reconstruction; all other Stage 2d checks unchanged."""','"""Reporting-fixture v1: only the input validation/reconstruction boundary changes."""'),
          ('from lib.si_reported_pose import transform','from lib.si_reporting_fixture_audit import transform'),
          ('def audit(record):','def audit(record,fixture):'),
          ("    assert record['responseVersion']=='linear-inlet-v1'","    assert record['responseVersion']=='linear-inlet-v1'\n    assert record['reportingFixture']==fixture.provenance(600000+record['spec']['replicate'])"),
          ("amplitudeMetres=radius),600000+s['replicate'])","amplitudeMetres=radius),600000+s['replicate'],fixture)")]
        for old,new in changes:
            self.assertEqual(expected.count(old),1)
            expected=expected.replace(old,new)
        self.assertEqual(Path('scripts/lib/si_fixture_integration_audit.py').read_text(),expected)

    def test_directional_and_scheduling_auditor_exact_delta(self):
        expected=Path('scripts/lib/si_linear_audit.py').read_text()
        for old,new in [('from lib.si_linear_integration_audit import','from lib.si_fixture_integration_audit import'),('def audit(record):','def audit(record,fixture):'),('result=event_audit(record);','result=event_audit(record,fixture);')]:
            expected=expected.replace(old,new)
        self.assertEqual(Path('scripts/lib/si_fixture_audit.py').read_text(),expected)

    def test_transforms_do_not_recompute_transcendentals(self):
        spec=importlib.util.spec_from_file_location('fixture_tests','scripts/test-reporting-fixture.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        f=ReportingFixture(module.FIXTURE,module.SHA)
        with patch('math.sin',side_effect=RuntimeError('runtime sin forbidden')),patch('math.cos',side_effect=RuntimeError('runtime cos forbidden')),patch('math.sqrt',side_effect=RuntimeError('runtime sqrt forbidden')):
            for radius in [0.,.001]:
                alt=dict(model='exact' if radius==0 else 'readout-jitter',amplitudeMetres=radius)
                self.assertEqual(transform(module.visits(),alt,600300,f),audit_transform(module.visits(),alt,600300,f))

    def test_bridge_rejects_private_input(self):
        spec=importlib.util.spec_from_file_location('fixture_bridge','scripts/si-fixture-integration-bridge.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with self.assertRaises(ValueError):module.handle(dict(operation='verify',sourcePosition=[.5,.5]),None)

    def test_bridge_rejects_unknown_operation(self):
        spec=importlib.util.spec_from_file_location('fixture_bridge','scripts/si-fixture-integration-bridge.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        with self.assertRaises(ValueError):module.handle(dict(operation='truth'),None)


if __name__=='__main__':unittest.main()
