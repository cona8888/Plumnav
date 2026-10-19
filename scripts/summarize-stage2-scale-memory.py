#!/usr/bin/env python3
"""Summarize only integrity-accepted Stage 2 artifacts, preserving failed gates."""
import hashlib,json,math,statistics
from pathlib import Path


def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    root=Path('research/results/si_scale_memory_pilot_2026-09-16');raw=Path('research/evidence/si_scale_memory_pilot_2026-09-16')
    marker=json.loads((root/'complete.json').read_text());assert marker['complete']
    for file,digest in marker['files'].items():assert sha(root/file)==digest
    a=json.loads((root/'analysis.json').read_text());audit=json.loads((root/'independent-audit.json').read_text());rows=json.loads((root/'run-summaries.json').read_text())
    assert a['integrityAccepted'] and audit['accepted'] and len(rows)==64
    for r in rows:assert sha(root/r['detail']['file'])==r['detail']['sha256']
    m=json.loads((raw/'manifest.json').read_text());assert sha(raw/'manifest.json')==a['rawManifestSha256']
    for s in m['sources']:assert sha(Path(s['file']))==s['sha256']==sha(raw/'source-snapshot'/s['name'])
    groups=[]
    for field in ['peak','ridge','blank','si-continuous','si-pulse']:
        for variant in ['reference','settle-12','settle-16','wind-0.1']:
            chosen=[r for r in rows if r['spec']['field']==field and r['spec']['variant']==variant]
            if not chosen:continue
            assert len(chosen)==2
            finest=[r['levels'][-1] for r in chosen];motions=[r['audit']['actualMotion'] for r in finest]
            groups.append(dict(field=field,variant=variant,firstReadoutSeconds=chosen[0]['spec']['firstReadout'],n=2,
                inspectionSeconds=[min(r['inspectionSeconds'] for r in motions),max(r['inspectionSeconds'] for r in motions)],
                memoryMismatchRmsC0=math.sqrt(statistics.mean(r['audit']['memoryMismatch']['rmsC0']**2 for r in finest)),
                memoryMismatchMaximumC0=max(r['audit']['memoryMismatch']['maxAbsoluteC0'] for r in finest),
                exactSupports=sum(r['decisions'][0]['status']=='supported' for r in finest),jitterSupports=sum(r['decisions'][1]['status']=='supported' for r in finest),
                reasons=[dict(exact=r['decisions'][0]['reason'],jitter=r['decisions'][1]['reason']) for r in finest]))
    resolution=[r['convergence'] for r in rows]
    similarity_errors={key:max(q['errors'][key] for p in a['similarity'] for q in p['comparisons']) for key in ['clock','geometry','trueInput','filtered','observed']}
    summary=dict(integrityAccepted=True,scientificGates=a['scientificGates'],passed=a['passed'],groups=groups,similarityMaximumErrors=similarity_errors,
                 similarityMaximumGroupError=max(p['groupError'] for p in a['similarity']),similarityMaximumDecisionError=max(p['decisionQuantityError'] for p in a['similarity']),
                 maximumFinalScalarMeshDifferenceC0=max(c['comparisons'][1]['maxScalarChangeC0'] for c in resolution),failedResolutionIndices=a['failedResolutionIndices'],
                 physicalWallSeconds=a['physicalWallSeconds'],analysisWallSeconds=a['analysisWallSeconds'],maximumWorkerMiB=max(w['maxRssBytes'] for w in a['workers'])/1048576,
                 evidenceHashes=marker['files'],rawManifestSha256=a['rawManifestSha256'],summarizerSha256=sha(Path(__file__)))
    dest=Path('research/results/si_scale_memory_summary_2026-09-16');dest.mkdir(exist_ok=False)
    with (dest/'summary.json').open('x') as f:f.write(json.dumps(summary,sort_keys=True,indent=2)+'\n')
    verdict='passed all predefined gates' if a['passed'] else 'did not pass every predefined gate; do not expand before diagnosis'
    lines=['# Physical similarity and fixed-hardware settling findings','',f'16 September 2026. The Stage 2a/b witness **{verdict}**. Independent integrity acceptance passed. This is a prescribed-inspection component study, not autonomous GSL or experimental hardware validation.','',
           '## Completed evidence','',f'- 64 settings, 192 response histories and 384 exact/jittered-coordinate decisions; 10 paired body routes. All 91 Python preflight tests and TypeScript development checks passed.',
           f'- {audit["inletGeometriesChecked"]:,} inlet geometries and complete filtered channel values checked; {audit["fieldValuesChecked"]:,} concentration inputs checked. SI checks are selected-clock equation checks, not CFD validation.',
           f'- Local simulation {a["physicalWallSeconds"]:.2f} s; independent analysis {a["analysisWallSeconds"]:.2f} s. Maximum sampled worker RSS {summary["maximumWorkerMiB"]:.1f} MiB. No AWS resource was started.',
           '- Frozen v4, the stationary-head admission wrapper, engine and app remain unchanged. Every complete dwell includes the prescribed zero-motion constraint, checked against the trajectory. Channel history is never reset on arrival.','',
           '## Predefined outcomes','']
    lines.extend(f'- {k}: **{"pass" if v else "FAIL"}**.' for k,v in a['scientificGates'].items())
    lines.extend([f'- Final 1/128 → 1/256 reference-second scalar difference: at most {summary["maximumFinalScalarMeshDifferenceC0"]:.6g} C0; threshold 0.001 C0.',
                  f'- Static ridge/blank controls: {a["staticControlSupports"]}/{a["staticControlEvaluations"]} supported across reporting arms and meshes. These paired repeats are not independent population trials.',
                  f'- Failed resolution indices, if any: {a["failedResolutionIndices"]}.','',
                  '## Mathematical similarity','',
                  'Three scaled configurations were compared with each of ten same-seed references, at all three meshes. Geometry, source forcing, transport, source age/pulse timing, tube/pump and instrument clocks were scaled together. Two transformations change physical domain size (50 or 200 m versus 100 m); another changes physical time scales at fixed size. These instruments are mathematical constructions, not commercial hardware configurations.',
                  f'Maximum discrepancies: true inputs/filtered outputs {similarity_errors["trueInput"]:.3g}/{similarity_errors["filtered"]:.3g} C0; observed scalar {similarity_errors["observed"]:.3g} C0; normalized geometry/clock {similarity_errors["geometry"]:.3g}/{similarity_errors["clock"]:.3g}; dimensionless groups {summary["similarityMaximumGroupError"]:.3g}; audited fit/radius quantities in reference units {summary["similarityMaximumDecisionError"]:.3g}.',
                  'The explicit candidate adapter converts physical clocks and lengths to reference units and converts radius outputs back to physical metres. This does not make a fixed physical sensor scale-invariant. No Reynolds-number or pump-induced-flow similarity is claimed.','',
                  '## Fixed-hardware observations','',
                  'Values below use the finest mesh and two fresh paired replicates. C0 = 1e-6 kg/m³. RMS is pooled over the same 85 retained readings per replicate. Memory mismatch is noiseless filtered minus instantaneous actual inlet mean; it is **not** integration error, measurement-noise RMSE or source-location error.', '',
                  '| Field | Policy/environment | Inspection time (s) | Memory mismatch RMS (C0) | Exact support | 1 mm jitter support |',
                  '|---|---|---:|---:|---:|---:|'])
    for g in groups:
        if g['field'] in ['ridge','blank']:continue
        lo,hi=g['inspectionSeconds'];duration=f'{lo:g}–{hi:g}' if lo!=hi else f'{lo:g}'
        lines.append(f'| {g["field"]} | {g["variant"]} | {duration} | {g["memoryMismatchRmsC0"]:.5g} | {g["exactSupports"]}/2 | {g["jitterSupports"]}/2 |')
    lines.extend(['','Reference: first readout 8 s after arrival, 12 s dwell. `settle-12`/`settle-16`: first readout at 12/16 s, dwell 16/20 s. All retain five 1 Hz readings. Those changes add exactly 68/136 s over the 17-visit inspection while preserving the travel segments and instrument. `wind-0.1` keeps reference timing and changes wind from 0.02 to 0.1 m/s.',
                  f'For stationary analytic fields, a separate closed-form constant-target dwell solution, initialized from preceding history, agreed with filtered channels to {audit["maximumErrors"]["constantTargetDwell"]:.3g} C0. This verifies the modeled decay behavior; it does not calibrate the sensor.',
                  'In finite-age SI the plume itself evolves; pulsed cases also change phase sampled and total temporal exposure when dwells lengthen. Higher wind changes plume amplitude and geometry as well as the instrument/transport ratios. Do not interpret these as isolated causal sensor effects or choose an optimum from two replicates.','',
                  '## Limits and next decision','',
                  'The full parameter table and reason codes are retained in [summary.json](si_scale_memory_summary_2026-09-16/summary.json). Interpret support as conditional fitted-maximum evidence only. Neither support nor abstention establishes a buried source or proves no leak. Flat neutral prescribed transport, the ideal stationary-head constraint, uncalibrated error ranges and first-order channel response remain explicit assumptions.',
                  'All scaling uses prescribed body paths; no navigation controller was rerun under the changed readings. This does not demonstrate coupled autonomous-navigation convergence. The current five-minute-plus inspection cost must remain visible in end-to-end comparisons.',
                  ('The passed component gates permit a compact, prospective acquisition-plus-verification integration pilot with equal information and fully charged timing for the baseline algorithms. Do not launch a broad AWS benchmark yet or retune v4 using these held-out results.' if a['passed'] else 'Stop expansion and inspect the recorded failing settings under the unchanged criteria. Do not revise thresholds or discard cases after seeing the results.'),
                  'The previous Stage 1o failure and earlier failed validations remain preserved. Soil-interface balance, urban/outdoor transport fidelity and literature-supported hardware ranges remain separate from the current component result. This is not a publication-readiness or universal-superiority claim.','',
                  '## Reproducibility','',
                  '- [Frozen protocol](../protocols/si_scale_memory_v1_2026-09-16.md), [execution record](si_scale_memory_execution_2026-09-16.md).',
                  '- [Analysis](si_scale_memory_pilot_2026-09-16/analysis.json), [independent audit](si_scale_memory_pilot_2026-09-16/independent-audit.json), [all run summaries](si_scale_memory_pilot_2026-09-16/run-summaries.json).',
                  f'- Raw manifest SHA-256: `{a["rawManifestSha256"]}`.',f'- Analysis SHA-256: `{marker["files"]["analysis.json"]}`.',
                  '- Sources and all detailed analysis outputs were rechecked before generating this summary.',''])
    report=Path('research/results/si_scale_memory_findings_2026-09-16.md')
    with report.open('x') as f:f.write('\n'.join(lines))
    with (dest/'complete.json').open('x') as f:f.write(json.dumps(dict(complete=True,summarySha256=sha(dest/'summary.json'),reportSha256=sha(report)),indent=2)+'\n')
    print(json.dumps(summary,indent=2))


if __name__=='__main__':main()
