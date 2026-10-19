"""Export a compact evidence handoff only after full terminal acceptance.

No simulations, numerical replays, new tests of superiority, dropped worlds or
new uncertainty calculation. All reported primary intervals come from the
frozen x86 analysis; simple scheduling differences are the prospectively
specified descriptive arm-rate contrasts. The complete accepted archive and
assembly remain authoritative, not this derived summary.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERIFIER_SHA = '56cd3260db55d138873cdfdb844b6be321fee29607c0c95c4636e54238767231'


def need(value, message):
    if not value:
        raise ValueError(message)


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def make_handoff(directory):
    directory = directory.resolve()
    need(directory.is_relative_to(ROOT), 'Workspace acceptance evidence required')
    receipt_path = directory / 'terminal-acceptance.json'
    receipt = json.loads(receipt_path.read_text())
    need(receipt['scientificallyAccepted'] is True
         and receipt['terminalProvenanceAccepted'] is True
         and receipt['independentAllHistoryExecutionAccepted'] is True
         and receipt['primaryInferentialClaimsAdmitted'] is True
         and receipt['exactDiscreteStatisticsReconstructionPassed'] is True
         and receipt['histories'] == 2400 and receipt['worlds'] == 128
         and receipt['resolutionTriplets'] == 240 and receipt['failedTriplets'] == []
         and receipt['sourceScriptSha256'] == VERIFIER_SHA, 'Actual full terminal acceptance required')
    for key in ('physicalValidation', 'hardwareValidation', 'urbanValidation',
                'aerodynamicSniffing', 'universalWinnerClaim', 'validatedAbsenceOfRealLeak'):
        need(receipt[key] is False, 'Invalid broader validation claim')
    assembly_path = directory / 'download/output/independent/assembly.json'
    need(sha(assembly_path) == receipt['assemblySha256'], 'Accepted full assembly body changed')
    assembly = json.loads(assembly_path.read_text())
    need(assembly['componentPassed'] is True and assembly['failedTriplets'] == [], 'Refinement gate required')
    stats = assembly['statistics']
    need(stats['independentWorlds'] == 128 and len(stats['primary']) == 4 and len(stats['arms']) == 15,
         'Complete frozen statistical population required')
    arms = {(row['field'], row['arm']): row for row in stats['arms']}
    descriptive = []
    for field in ('si-continuous', 'si-pulse'):
        rate = {arm: arms[field, arm]['proportion'] for arm in ('RW', 'GW', 'RL', 'GL', 'NS')}
        descriptive.append(dict(field=field,
            withheldSchedulingRiskDifference=rate['GW'] - rate['RW'],
            liveSchedulingRiskDifference=rate['GL'] - rate['RL'],
            meaning='Descriptive simple scheduling contrasts; no new uncertainty estimate or winner test'))
    return dict(version='mechanism-campaign-derived-findings-handoff-v1',
        createdAtUTC=datetime.now(timezone.utc).isoformat(),
        acceptanceReceipt=str(receipt_path), acceptanceReceiptSha256=sha(receipt_path),
        acceptedArchiveSha256=receipt['archiveSha256'], assemblySha256=receipt['assemblySha256'],
        auditorJob=receipt['auditorJob'], producerJob=receipt['producerJob'],
        manifestSha256=receipt['manifestSha256'], releaseSha256=receipt['releaseSha256'],
        independentWorlds=128, totalHistories=2400, primaryHistories=1920,
        refinementHistories=480, refinementTriplets=240, refinementFailures=[],
        arms=dict(RW='Reference scans; passive readings withheld during scans',
                  GW='Encounter-gated scans; passive readings withheld during scans',
                  RL='Reference scans; existing passive readings available during scans',
                  GL='Encounter-gated scans; existing passive readings available during scans',
                  NS='Acquisition scans disabled; passive readings retained; common final inspection retained'),
        primaryEffects=stats['primary'], armFieldOutcomes=stats['arms'],
        descriptiveSchedulingContrasts=descriptive,
        bootstrap={k: v for k, v in stats['bootstrap'].items() if k not in ('drawIndices', 'contrastSampleMeans')},
        primaryDefinitions=dict(I='(GL-RL)-(GW-RW): scheduling-by-reading-availability interaction',
                                D='GL-NS: combined scan-acquisition contrast, not a pure pause effect'),
        endpoint='Supported reported maximum within 0.10m of the numerical release; valid emitting abstentions/unresolved missions retain zero; blank localisation success is undefined',
        testedConditions=dict(domainMetres=10, prescribedWindMetresPerSecond=0.02,
            effectiveDiffusivityMetresSquaredPerSecond=0.001, finiteSourceWidthMetres=0.15,
            sourceAgeSeconds=300, sourceHeightMetres=0.025, inletHeightMetres=0.05,
            opposingInletSpacingMetres=0.10, physicalReadoutHertz=1, controllerHertz=16,
            acquisitionBudgetSeconds=600, missionBudgetSeconds=1200, scanInspectionDwellSeconds=12,
            continuousEmissionKgPerSecond=2e-9, pulsedOnEmissionKgPerSecond=4e-9,
            pulsePeriodSeconds=20, pulseDutyFraction=0.5, pulsePhaseSeconds=5,
            sourceAbsentBackground='Zero release and zero background under inherited numerical noise; not a real interference/drift challenge'),
        uncertainty=dict(marginal='Approximate whole-world paired bootstrap intervals; not four-effect simultaneous coverage or equivalence',
                         family='Frozen conservative four-contrast bounds conditional on independent bounded numerical world draws; no physical model discrepancy included'),
        limitations=[
            'Numerical verification is not physical or hardware validation.',
            'Only prescribed open-terrain transport and fixed sensing/mobility assumptions are tested in this mechanism campaign; no urban CFD, drone, soil/water-saturation or 100m transfer inference.',
            'Availability changes information delivered to the controller, not physical sample count or aerodynamic gas collection.',
            'Scan-disabled comparison removes acquisition scans and their evidence, not only pause time.',
            'Detection, nomination, completed inspection, local-maximum support and true release localisation must remain separate.',
            'The 240 refinement triplets cover a fixed one-eighth subset of worlds, not convergence of every trajectory.',
            'No calibrated commercial sensor sensitivity threshold, company system certification, universal-best algorithm or real-world absence-of-leak claim follows.',
            'Primary mechanism results require author scientific-story approval before manuscript changes.'
        ], newMissions=0, newNumericalAudits=0, frozenEvidenceChanged=False,
        manuscriptChanged=False, derivedArtifactOnly=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--accepted-directory', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    target = args.output.absolute()
    need(not target.exists() and target.parent.is_dir() and target.resolve().is_relative_to(ROOT)
         and not any(p.is_symlink() for p in (target, *target.parents)), 'Fresh workspace derived output required')
    value = make_handoff(args.accepted_directory)
    with target.open('x') as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write('\n')
    print('ACCEPTED_MECHANISM_FINDINGS_HANDOFF ' + str(target))


if __name__ == '__main__':
    main()
