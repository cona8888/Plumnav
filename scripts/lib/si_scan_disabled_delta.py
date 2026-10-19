"""Require the prospective mechanical run-loop changes and nothing else."""
import hashlib
from pathlib import Path

def check():
    base=Path('scripts/lib/si-readout-integration.ts');candidate=Path('scripts/lib/si-scan-disabled-integration.ts')
    source=base.read_text();expected=source
    substitutions=[
      ("import {schedulingController} from './si-encounter-gate'", "import {schedulingController} from './si-encounter-gate'\nimport {noScanController,NO_SCAN_CONTROLLER_VERSION} from './si-no-scan-controller'"),
      ('bridge:VerifierBridge,availability:ReadoutAvailability,development?', 'bridge:VerifierBridge,development?'),
      (" if(!['original-withheld','live-passive'].includes(availability))throw Error('Unknown readout availability')", " const availability:ReadoutAvailability='live-passive'\n if(s.policy!=='reference')throw Error('No-scan uses reference config carrier only')"),
      ('schedule=schedulingController(engine.controller,s.policy)', "noScan=noScanController(engine.controller),schedule=schedulingController(noScan.controller,'reference')"),
      ('schedule=schedulingController(engine.controller,record.spec.policy)', "noScan=noScanController(engine.controller),schedule=schedulingController(noScan.controller,'reference')"),
      ('  availabilityVersion:', "  acquisitionMode:'scan-disabled' as const,scanDisabledVersion:NO_SCAN_CONTROLLER_VERSION,scanDisabledTrace:noScan.trace,schedulingTraceRole:'passive-eligibility-observer' as const,\n  availabilityVersion:"),
      (' const engine=new SimulationEngine(record.config)', " if(record.acquisitionMode!=='scan-disabled'||record.scanDisabledVersion!==NO_SCAN_CONTROLLER_VERSION||record.spec.policy!=='reference')throw Error('Incorrect scan-disabled replay label')\n const engine=new SimulationEngine(record.config)"),
      (' return {passed:true,decisionsChecked:checked,privateFieldQueries:0,schedulingTraceMatched:true}', " if(JSON.stringify(noScan.trace)!==JSON.stringify(record.scanDisabledTrace))throw Error('Scan-disabled replay mismatch')\n return {passed:true,decisionsChecked:checked,privateFieldQueries:0,schedulingTraceMatched:true,scanDisabledTraceMatched:true,acquisitionMode:'scan-disabled'}")
    ]
    for old,new in substitutions:
        assert expected.count(old)==1,old
        expected=expected.replace(old,new)
    assert expected.count('runReadoutIntegration')==2 and expected.count('replayReadoutIntegration')==1
    expected=expected.replace('runReadoutIntegration','runScanDisabledIntegration').replace('replayReadoutIntegration','replayScanDisabledIntegration')
    assert candidate.read_text().rstrip()==expected.rstrip(),'Undeclared run-loop delta'
    return dict(passed=True,baseSha256=hashlib.sha256(base.read_bytes()).hexdigest(),candidateSha256=hashlib.sha256(candidate.read_bytes()).hexdigest(),declaredSubstitutions=len(substitutions),entryPointRenameChecks=3)
