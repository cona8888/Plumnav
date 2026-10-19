"""Analytic/development-only diagnosis. No mission, tuning or protected-world replay."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import platform
import signal
import time

import numpy as np
import scipy
from scipy.integrate import quad
from scipy.optimize import brentq
from lib.si_head_motion_audit import physical_values
from lib.si_stationary_head_contract import evaluate

ROOT = Path(__file__).resolve().parents[1]
FROZEN = ROOT/'aws/build/si-mechanism-campaign-sealed-v3-attempt01-20260930/project'
PROTOCOL = ROOT/'research/protocols/si_source_identifiability_diagnostic_v1_2026-10-02.json'
RESOURCE = ROOT/'research/results/si_mechanism_resource_independent_audit_v2_terminal_acceptance_attempt01_2026-09-30'
SOURCE_NAMES = ('src/sim/halfspaceTransport.ts', 'scripts/lib/si_stationary_head_contract.py',
    'scripts/lib/si_bounded_pose_v4.py', 'scripts/lib/si-readout-integration.ts',
    'scripts/lib/si_head_motion_audit.py', 'scripts/lib/si-research-config.ts',
    'src/sim/physicalDesign.ts', 'scripts/lib/si-head-motion.ts', 'scripts/lib/si-integration.ts')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def need(value, message):
    if not value:
        raise ValueError(message)


def active_age_intervals(age, pulse=False):
    """Emission-time pulse edges converted to puff ages; no engine quadrature."""
    need(age > 0, 'Positive source age required')
    if not pulse:
        return [(0., age)]
    intervals, lo = [], 0.
    while lo < age:
        hi = min(age, (math.floor((lo + 5 + 1e-10)/10)+1)*10-5)
        need(hi > lo, 'Pulse edge must advance')
        if ((lo+hi)/2+5) % 20 < 10:
            intervals.append((age-hi, age-lo))
        lo = hi
    return intervals


def value(x, y, age, *, wind=.02, rate=2e-9, pulse=False, derivative=False):
    """C/C0, or d(C/C0)/dx: adaptive integration of Gaussian puff age."""
    if rate == 0:
        return 0.
    def integrand(a):
        variance = .15**2 + 2*.001*a
        dx = x-wind*a
        vertical = math.exp(-(.05-.025)**2/(2*variance)) + math.exp(-(.05+.025)**2/(2*variance))
        kernel = rate/1e-6/(2*math.pi*variance)**1.5*math.exp(-(dx*dx+y*y)/(2*variance))*vertical
        return -dx/variance*kernel if derivative else kernel
    return sum(quad(integrand, lo, hi, epsabs=1e-11, epsrel=1e-10, limit=200)[0]
               for lo, hi in active_age_intervals(age, pulse))


def four_inlet_value(x, age, *, derivative=False):
    return sum(value(x+dx, dy, age, derivative=derivative)
               for dx, dy in ((.05,0),(-.05,0),(0,.05),(0,-.05)))/4


def peak(age, *, mean_inlets=False, wind=.02, rate=2e-9):
    derivative = (lambda x: four_inlet_value(x, age, derivative=True)) if mean_inlets else (
        lambda x: value(x, 0, age, wind=wind, rate=rate, derivative=True))
    grid = np.linspace(-.5, 2, 101)
    gradients = [derivative(float(x)) for x in grid]
    crossings = [(float(a),float(b)) for a,b,ga,gb in zip(grid[:-1],grid[1:],gradients[:-1],gradients[1:]) if ga > 0 and gb <= 0]
    need(len(crossings)==1, 'One interior positive-to-negative gradient crossing required')
    a,b = crossings[0]
    optimum = brentq(derivative, a, b, xtol=1e-12)
    need(derivative(optimum-.001)>0 and derivative(optimum+.001)<0, 'Strict local maximum sign check')
    return optimum


def synthetic_visits(quadratic=True):
    visits = []
    for i in range(17):
        theta = (i//2)*math.pi/4
        x,y = (0.,0.) if i%2==0 else (math.cos(theta),math.sin(theta))
        scalar = 1-.05*(x*x+y*y) if quadratic else 1.
        arrival = 12.*i
        visits.append(dict(arrivedAt=arrival, closedAt=arrival+12,
            samples=[dict(time=arrival+8+j, x=x, y=y, value=scalar,
                          hit=True, telemetryComplete=True, clipped=False) for j in range(5)]))
    return visits


def synthetic_verifier(quadratic):
    visits = synthetic_visits(quadratic)
    contract = dict(version='continuous-stationary-head-v1', basis='prescribed-numerical-constraint',
        scope='continuous-head-centre-and-orientation', windows=[dict(visit=i,start=v['arrivedAt'],
        end=v['closedAt'],translationDiameterMetres=0,orientationSpanRadians=0) for i,v in enumerate(visits)])
    return evaluate(visits, 0., motion_contract=contract)


def development_metadata():
    receipt_path = RESOURCE/'terminal-verification.json'
    need(sha(receipt_path)=='9b77cb37c03940342becdf5d1f28a1a25f83799622a5a32c8f58239fedca9b35', 'Accepted development receipt changed')
    receipt = json.loads(receipt_path.read_text())
    need(receipt['accepted'] and receipt['performanceEvidence'] is False, 'Fixed-development admission required')
    results = []
    for field in ('si-continuous','si-pulse'):
        case = f'mechanism-development-3000-GL-{field}-n64'
        matches = [r for r in receipt['verifiedHistories'] if r['phase']=='baseline' and r['caseId']==case]
        need(len(matches)==1 and matches[0]['passed'], 'Exactly one accepted development body')
        path = RESOURCE/'download/output/independent-audit/runs/baseline/audits'/f'{case}-diagnostics.json'
        need(sha(path)==matches[0]['independentDiagnosticSha256'], 'Actual development diagnostic body hash changed')
        data = json.loads(path.read_text()); compact = data['compact']
        need(compact['spec']['replicate']==3000 and data['details']['passed'], 'Development identity and audit required')
        results.append(dict(field=field,case=case,path=str(path),sha256=sha(path),
            summary=compact['summary'],decisions=compact['decisions'],scope='Fixed development only; not 128 protected performance worlds'))
    return results


def run():
    sources = {}
    for name in SOURCE_NAMES:
        need((ROOT/name).read_bytes()==(FROZEN/name).read_bytes(), 'Inspected source differs from frozen campaign: '+name)
        sources[name] = sha(ROOT/name)
    protocol = json.loads(PROTOCOL.read_text())
    need(protocol['protectedCampaignUsedForTuning'] is False, 'No protected-world tuning')
    checks = []
    zero = peak(900, wind=0.)
    need(abs(zero)<1e-10, 'Zero-wind maximum should be centred on source'); checks.append('zero-wind-centred-peak')
    need(value(.15,0,900,rate=0)==0, 'Zero emission must be zero'); checks.append('zero-emission')
    x = peak(900)
    need(abs(peak(900,rate=4e-9)-x)<1e-10 and abs(value(x,0,900,rate=4e-9)/value(x,0,900)-2)<1e-12,
         'Emission scaling must not move maximum'); checks.append('linear-flux-scaling')
    need(value(.2,.1,900)==value(.2,-.1,900), 'Transverse symmetry'); checks.append('transverse-symmetry')
    dx = 1e-5
    fd = (value(0+dx,0,900)-value(0-dx,0,900))/(2*dx)
    need(abs(fd-value(0,0,900,derivative=True))<1e-7, 'Independent finite difference gradient'); checks.append('finite-difference-gradient')
    # Original audit evaluator has fixed four-node panels, unlike adaptive age integration above.
    config = dict(domainMeters=10., sourcePositionOverride=dict(x=.5,y=.5), windDirectionDegrees=90,
        localInletSampling=dict(referenceWindMetresPerSecond=.02,inletHeightMetres=.05),
        physicalAtmosphere=dict(diffusivityMetresSquaredPerSecond=.001,sourceWidthMetres=.15,
            releaseHeightMetres=.025,emissionRateKgPerSecond=2e-9,sourceAgeAtMissionStartSeconds=300,
            quadraturePanelSeconds=2,measurement=dict(backgroundKgPerCubicMetre=0,concentrationScaleKgPerCubicMetre=1e-6)))
    points = np.array([[.5,.5],[.5+x/10,.5],[.51,.5]])
    reference = physical_values(points,600,config,dict(field='si-continuous'))
    adaptive = np.array([value((p[0]-.5)*10,(p[1]-.5)*10,900) for p in points])
    evaluator_error = float(np.max(abs(reference-adaptive)))
    need(evaluator_error<1e-7, 'Adaptive/panel forward evaluator check'); checks.append('independent-quadrature-agreement')
    config['physicalAtmosphere'].update(emissionRateKgPerSecond=4e-9,pulse=dict(periodSeconds=20,phaseSeconds=5))
    pulse_reference = float(physical_values(np.array([.515,.5]),600,config,dict(field='si-pulse')))
    pulse_error = abs(pulse_reference-value(.15,0,900,rate=4e-9,pulse=True))
    need(pulse_error<1e-7, 'Pulse edge convention or evaluator mismatch'); checks.append('pulse-quadrature-agreement')
    positive, uniform = synthetic_verifier(True), synthetic_verifier(False)
    need(positive['status']=='supported' and uniform['status']=='abstained', 'Unchanged verifier positive/negative controls')
    checks.extend(('static-quadratic-supported','uniform-not-strict-maximum'))
    rows = [dict(sourceAgeSeconds=t,pointwisePeakOffsetMetres=peak(t),
                 fourInletInstantaneousMeanPeakOffsetMetres=peak(t,mean_inlets=True),
                 downwindGradientAtRelease=value(0,0,t,derivative=True),
                 downwindGradientAtToleranceBoundary=value(.10,0,t,derivative=True)) for t in (300,900,1500)]
    pulse = [dict(sourceAgeSeconds=t,concentrationC0=value(.15,0,t,rate=4e-9,pulse=True)) for t in (900,905,910,915,920)]
    delay = math.pi*.001**2/.000004166666666666667
    tau = 2/math.log(9)
    return dict(version='source-identifiability-diagnostic-v1',createdAtUTC=datetime.now(timezone.utc).isoformat(),
        runtime=dict(architecture=platform.machine(),python=platform.python_version(),numpy=np.__version__,scipy=scipy.__version__),
        protocolSha256=sha(PROTOCOL),sourceScriptSha256=sha(Path(__file__)),inspectedFrozenSourceHashes=sources,
        checksPassed=checks,continuousAnalyticRows=rows,pulseFixedPointRows=pulse,
        evaluatorAbsoluteC0Errors=dict(continuous=evaluator_error,pulse=pulse_error),
        syntheticVerifierControls=dict(quadratic=dict(status=positive['status'],reason=positive['reason']),
                                      uniform=dict(status=uniform['status'],reason=uniform['reason'])),
        dimensionless=dict(sourcePeclet=.02*.15/.001,toleranceOverSourceWidth=.1/.15,
            opposingInletSpacingOverSourceWidth=.1/.15,pulsePeriodOverDwell=20/12),
        inheritedTiming=dict(tubeDelaySeconds=delay,riseTimeConstantSeconds=tau,recoveryTimeConstantSeconds=2,
            averagingSeconds=1,approximateMovingRiseMemoryDistanceMetres=.1*(delay+tau+.5),
            stationaryInspectionDwellSeconds=12,pulsePeriodSeconds=20,
            minimumSeventeenDwellInspectionSeconds=17*12,
            warning='Memory distance is an approximate rise-response scale, not a calibrated spatial error or proof of the cause of a particular failure'),
        acceptedFixedDevelopmentMetadata=development_metadata(),
        analyticExplanation='At the true release, each older puff centre lies downwind. For positive wind and nonzero emission the downwind derivative sum is positive. A local concentration maximum is therefore not the release in this model. Nominal continuous maxima beyond 0.10m are an objective mismatch, not a universal limit on source estimation.',
        limits=['Instantaneous pointwise/mean-inlet maxima omit time-filtering, noise and executed motion.',
            'Measurement-inconsistency in one fixed pulsed development history is not proof of the reason in every protected history.',
            'No new robot histories, fresh performance worlds, numerical-history audits, AWS jobs, controller corrections or manuscript changes.',
            'No tolerance relaxation or retrospective conversion of supported maxima into successful release localisation.',
            'Within-model mathematical verification, not physical, hardware, urban or aerodynamic sniffing validation.'],
        newMissions=0,protectedWorldsEvaluated=0,newAWSJobs=0,frozenSourcesModified=False)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    target=args.output.absolute()
    need(not target.exists() and target.parent.is_dir() and target.resolve().is_relative_to(ROOT)
         and not any(p.is_symlink() for p in (target,*target.parents)), 'Fresh nonsymlink workspace output')
    def timeout(*_): raise TimeoutError('Bounded 60-second diagnostic exceeded')
    signal.signal(signal.SIGALRM,timeout);signal.alarm(60)
    started=time.monotonic();result=run();result['elapsedSeconds']=time.monotonic()-started
    body=json.dumps(result,indent=2,allow_nan=False)+'\n';need(len(body.encode())<=1048576,'Diagnostic output cap')
    with target.open('x') as stream: stream.write(body)
    signal.alarm(0)
    print('SOURCE_IDENTIFIABILITY_DIAGNOSTIC_COMPLETE '+json.dumps(dict(path=str(target),checks=len(result['checksPassed']),
        elapsedSeconds=result['elapsedSeconds'],continuous=result['continuousAnalyticRows'],development=[dict(field=r['field'],decisions=r['decisions']) for r in result['acceptedFixedDevelopmentMetadata']])))


if __name__=='__main__': main()
