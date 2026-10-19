#!/usr/bin/env python3
"""Algebra/provenance review of saved M60/M61 evidence. Never calls a solver."""
import hashlib
import json
import math
from pathlib import Path
from collections import Counter, defaultdict

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'research/publication_closeout_2026-09-22/soil_support_v1'
SOIL='research/protocols/m60_soil_regimes/soil-regime-contract.json'
OLD='research/evidence/m61_soil_localization_final_locked_2026-09-12/'
PINNED={
    SOIL:'443e3d334a60efee2c64152c4e4d00378851d1e29ae39cdee6fa955b3567e79a',
    OLD+'manifest.json':'b2683ffebc0d36932845c1822859d973cbfbec48d6e484d3b77ffa32200fde5e',
    OLD+'raw-results.json':'36397f7c75fe19ffb0e4fb3286bb68fd1486495e697caea45f40e7afbf0247b1',
    OLD+'results.csv':'d2f540091471bc4e542fdd40761a723c15088d5c9033177b2e82e1a6fb3fb0eb',
    OLD+'summary.json':'73421c5f95e44ecf6beb4f80ed32a6cf4414dff02819c20ae1873574263bc2ea',
}

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
    return h.hexdigest()

def read(path): return json.loads((ROOT/path).read_text())
def close(a,b): assert math.isclose(a,b,rel_tol=1e-12,abs_tol=1e-25),(a,b)

def main():
    sources=[]
    for name,expected in PINNED.items():
        actual=digest(ROOT/name)
        assert actual==expected,(name,'hash mismatch')
        sources.append({'path':name,'sha256':actual,'matches20260912Report':True})
    for name in ['scripts/m54_soil_closure.py','scripts/m55_soil_column.py','scripts/m60_soil_regimes.py',
                 'scripts/m61-soil-localization-benchmark.ts','research/protocols/m54_rosetta_texture_priors.json',
                 'research/analysis/m61_soil_localization_2026-09-12/stage4-report.md']:
        sources.append({'path':name,'sha256':digest(ROOT/name),'historicalCodeIdentityEstablished':False})
    soil=read(SOIL)
    priors=read('research/protocols/m54_rosetta_texture_priors.json')
    # Independently transcribed from official USDA page inspected 2026-09-22.
    official={'sand':{'N':308,'theta_s':[.375,.055],'log10_Ks_cm_per_day':[2.808,.59]},
              'clay':{'N':84,'theta_s':[.459,.079],'log10_Ks_cm_per_day':[1.169,.92]}}
    for name,fields in official.items():
        for key,value in fields.items(): assert priors['classes'][name][key]==value
    f=soil['forcing']; L=f['depth_m'];t=f['survey_time_s']
    base=soil['cases'][0]['surface_flux_normalized_tracer_kg_m2_s']
    cases=[]
    for c in soil['cases']:
        phi=c['porosity'];sw=c['water_saturation'];sg=1-sw
        ks=10**official[c['texture']]['log10_Ks_cm_per_day'][0]*.01/86400
        k=ks*1.002e-3/(998.2*9.80665)
        krg=max(0,min(1,(sg-.02)/(1-.05-.02)))**2
        d=f['free_diffusivity_m2_s']*(phi*sg)**(10/3)/(phi**2)
        q=k*krg/f['gas_viscosity_pa_s']*f['pressure_excess_pa']/L
        pe=q*L/d; fo=d*t/(phi*sg*L*L);pv=q*t/(phi*sg*L)
        expected={'water_hydraulic_conductivity_m_s':ks,'intrinsic_permeability_m2':k,
                  'gas_relative_permeability':krg,'bulk_diffusivity_m2_s':d,'darcy_flux_m_s':q,
                  'gas_pore_peclet':pe,'gas_pore_fourier':fo,'advective_pore_volumes':pv,
                  'emission_scale_relative_to_sand_sw_0p2':c['surface_flux_normalized_tracer_kg_m2_s']/base}
        for key,v in expected.items(): close(c[key],v)
        close(pv,pe*fo)
        # Exact STEADY flux for homogeneous 1D AD with maintained C(0)=C0,C(L)=0.
        # Comparing a saved finite-time FV value with this limit does not prove
        # convergence, isolate time/discretization error, or validate physics.
        steady=q*f['bottom_tracer_concentration_kg_m3_gas']/(-math.expm1(-pe))
        cases.append({'caseId':c['case_id'],'derivedFieldsChecked':list(expected),
                      'savedSevenDayFlux':c['surface_flux_normalized_tracer_kg_m2_s'],
                      'analyticalSteadyFlux':steady,
                      'finiteTimeFluxRelativeToSteadyMinusOne':c['surface_flux_normalized_tracer_kg_m2_s']/steady-1,
                      'relativeEmissionScale':expected['emission_scale_relative_to_sand_sw_0p2'],
                      'savedCoarseFineFluxChange':c['coarse_fine_surface_flux_relative_change'],
                      'savedMassBalanceError':c['mass_balance_error_kg_m2'],
                      'dimensionlessGroups':{'Pe':pe,'Fo':fo,'poreVolumes':pv},
                      'gasRelativePermeabilityAndDiffusionAreBothPositive':krg>0 and d>0})
    assert len(cases)==6 and all(soil['acceptance'].values())
    for texture in ['sand','clay']:
        selected=[c for c in cases if c['caseId'].startswith(texture)]
        assert all(a['savedSevenDayFlux']>b['savedSevenDayFlux'] for a,b in zip(selected,selected[1:]))
    manifest=read(OLD+'manifest.json'); summary=read(OLD+'summary.json'); raw=read(OLD+'raw-results.json')
    assert manifest['soilContractSha256']==PINNED[SOIL]
    assert manifest['manifestSha256']==summary['manifestSha256']
    assert len(raw)==2160==manifest['plannedRuns']==summary['completedRuns']
    by_id={c['case_id']:c for c in soil['cases']}
    by_cell=defaultdict(list)
    pooled=defaultdict(Counter)
    for row in raw:
        c=row['soil_case']; r=row['result']; m=r['metrics']; cfg=r['config']
        assert c==by_id[c['case_id']]
        close(cfg['emissionRateScale'],c['emission_scale_relative_to_sand_sw_0p2'])
        assert cfg['sensorProfileId']=='normalized-reference' and cfg['domainMeters']==100
        assert cfg['durationSeconds']==180 and cfg['sensorLag']==.05 and cfg['sensorNoise']==.025
        key='|'.join([c['case_id'],r['scenarioKind'],r['algorithmId']])
        by_cell[key].append(r)
        pooled[r['algorithmId']]['n']+=1
        pooled[r['algorithmId']][m['terminalOutcome']]+=1
    assert len(by_cell)==72
    for cell in summary['cells']:
        rows=by_cell[cell['key']]
        assert len(rows)==30==cell['runs']
        assert len({r['seed'] for r in rows})==30
        for label,outcome in [('correct_declaration_rate','correct-declaration'),('wrong_declaration_rate','wrong-declaration')]:
            close(cell[label],sum(r['metrics']['terminalOutcome']==outcome for r in rows)/30)
    quad=[r['result'] for r in raw if r['result']['algorithmId']=='quad-sniff']
    assert len(quad)==360 and all(not r['metrics']['nativeDeclaration'] for r in quad)
    report={'status':'supporting-only provenance/algebra review; not a simulation or renewed scientific acceptance',
            'sources':sources,'officialPriorFieldsChecked':official,'cases':cases,
            'legacyRowsChecked':len(raw),'legacyCellsChecked':len(by_cell),'legacyPooledOutcomes':dict(pooled),
            'legacyCandidateConfiguredReachMetres':sorted({r['config']['activeSniffReach']*r['config']['domainMeters'] for r in quad}),
            'sourceCodeSnapshotHistoricalIdentityEstablished':False,
            'excludedClaims':['calibrated soil gas transport','empirical gas/water percolation thresholds',
                              'buried-source recovery','hardware suction reach','urban performance',
                              'candidate superiority','membership in Stage2i or outdoor holdouts'],
            'reviewType':'single-agent self-review; algebra checked independently of imported solver functions',
            'noNewSimulation':True}
    OUT.mkdir(exist_ok=False)
    with (OUT/'provenance_check.json').open('x') as f: json.dump(report,f,indent=2); f.write('\n')
    print(json.dumps({'pinnedHashesPassed':len(PINNED),'soilCasesChecked':6,'oldRecordsChecked':len(raw),
                      'largestAbsoluteSteadyLimitDifference':max(abs(c['finiteTimeFluxRelativeToSteadyMinusOne']) for c in cases),
                      'legacyQuadConfiguredReachMetres':report['legacyCandidateConfiguredReachMetres']}))

if __name__=='__main__':main()
