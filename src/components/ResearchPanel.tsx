import { useEffect, useMemo, useRef, useState } from 'react'
import { ALGORITHM_METADATA, ALGORITHM_ORDER } from '../sim/algorithms/metadata'
import { batchResultsToCsv, runBatch, type BatchProgress } from '../sim/batch'
import type { AlgorithmId, BatchResult, BatchSummary, ScenarioKind, SimulationConfig } from '../sim/types'
import { ResearchCharts } from './ResearchCharts'

type ResearchPanelProps = {
  baseConfig: SimulationConfig
}

const downloadCsv = (contents: string) => {
  const blob = new Blob([contents], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `plumenav-benchmark-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

export function ResearchPanel({ baseConfig }: ResearchPanelProps) {
  const [algorithms, setAlgorithms] = useState<AlgorithmId[]>(ALGORITHM_ORDER)
  const [scenarios, setScenarios] = useState<ScenarioKind[]>(['open', 'obstructed'])
  const [runs, setRuns] = useState(5)
  const [checkpoint, setCheckpoint] = useState(180)
  const [progress, setProgress] = useState<BatchProgress | null>(null)
  const [summaries, setSummaries] = useState<BatchSummary[]>([])
  const [rawResults, setRawResults] = useState<BatchResult[]>([])
  const [running, setRunning] = useState(false)
  const [runMessage, setRunMessage] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const visibleSummaries = useMemo(
    () => summaries.filter((summary) => summary.checkpointSeconds === checkpoint),
    [checkpoint, summaries],
  )

  const toggleAlgorithm = (algorithmId: AlgorithmId) => {
    setAlgorithms((current) =>
      current.includes(algorithmId)
        ? current.filter((item) => item !== algorithmId)
        : [...current, algorithmId],
    )
  }

  const toggleScenario = (scenario: ScenarioKind) => {
    setScenarios((current) =>
      current.includes(scenario)
        ? current.filter((item) => item !== scenario)
        : [...current, scenario],
    )
  }

  const startBatch = async () => {
    if (algorithms.length === 0 || scenarios.length === 0) return
    setRunning(true)
    setProgress(null)
    setSummaries([])
    setRawResults([])
    setRunMessage('')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const result = await runBatch(
        { ...baseConfig, durationSeconds: 180, checkpointSeconds: [30, 60, 120, 180] },
        algorithms,
        scenarios,
        runs,
        setProgress,
        controller.signal,
      )
      setSummaries(result.summaries)
      setRawResults(result.results)
      setRunMessage(`Benchmark complete: ${algorithms.length * scenarios.length * runs} seeded runs.`)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        setRunMessage('Benchmark cancelled. No partial results were retained.')
      } else {
        setRunMessage(error instanceof Error ? `Benchmark failed: ${error.message}` : 'Benchmark failed.')
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
        setRunning(false)
      }
    }
  }

  const cancelBatch = () => abortRef.current?.abort()

  const total = progress?.total ?? algorithms.length * scenarios.length * runs
  const completed = progress?.completed ?? 0
  const progressPercent = total ? (completed / total) * 100 : 0
  const resultRuns = summaries[0]?.runs ?? runs

  return (
    <section className="research-panel">
      <div className="research-intro">
        <div>
          <span className="eyebrow">SEEDED MONTE CARLO BENCHMARK</span>
          <h2>Compare methods on identical plume realizations.</h2>
        </div>
        <p>
          Native declaration remains visible in the live simulator. Here every method receives the same fixed time budget,
          scenario seed and robot start; controller randomness uses a separate paired seed. {baseConfig.targetStatus === 'absent'
            ? 'No target coordinate exists, so the endpoints are spurious declaration, explicit abstention and fixed-budget rejection.'
            : 'The hidden source placement is paired across methods, declared estimates are carried forward to later checkpoints, and success is normalized error ≤ 0.01.'}
          {' '}The selected process-floor stratum is L{baseConfig.obstacleComplexityLevel}; terrain is {baseConfig.terrainSlopeDegrees > 0
            ? `${baseConfig.terrainSlopeDegrees}° uphill toward ${baseConfig.terrainUphillDirectionDegrees}° with ${baseConfig.gasBuoyancy} gas behavior, ${baseConfig.terrainGasDriftScale}× coupling, and ${baseConfig.robotSlopeLimitDegrees}° robot reference grade`
            : 'flat'}.
          {' '}Bayesian/map-based likelihoods know the selected reduced-order gas response; wind-reactive methods receive only ambient wind measurements. Treat that contrast as model-aware versus ambient-wind-reactive performance, not as algorithm quality alone.
        </p>
      </div>

      <div className="research-controls">
        <div className="research-control-group research-control-group--wide" role="group" aria-labelledby="algorithm-filter-label">
          <label id="algorithm-filter-label">Algorithms</label>
          <div className="check-grid">
            {ALGORITHM_ORDER.map((algorithmId) => {
              const item = ALGORITHM_METADATA[algorithmId]
              return (
                <button
                  type="button"
                  key={algorithmId}
                  className={algorithms.includes(algorithmId) ? 'check-chip check-chip--active' : 'check-chip'}
                  onClick={() => toggleAlgorithm(algorithmId)}
                  aria-pressed={algorithms.includes(algorithmId)}
                  disabled={running}
                  style={{ '--chip-color': item.color } as React.CSSProperties}
                >
                  <i /> {item.shortName}
                </button>
              )
            })}
          </div>
        </div>
        <div className="research-control-group" role="group" aria-labelledby="scenario-filter-label">
          <label id="scenario-filter-label">Scenarios</label>
          <div className="check-grid check-grid--two">
            <button type="button" className={scenarios.includes('open') ? 'check-chip check-chip--active' : 'check-chip'} aria-pressed={scenarios.includes('open')} disabled={running} onClick={() => toggleScenario('open')}>Open</button>
            <button type="button" className={scenarios.includes('obstructed') ? 'check-chip check-chip--active' : 'check-chip'} aria-pressed={scenarios.includes('obstructed')} disabled={running} onClick={() => toggleScenario('obstructed')}>Obstructed</button>
          </div>
        </div>
        <div className="research-control-group">
          <label htmlFor="run-count">Seeds per cell</label>
          <select id="run-count" value={runs} disabled={running} onChange={(event) => setRuns(Number(event.target.value))}>
            <option value={3}>3 · quick</option>
            <option value={5}>5 · standard</option>
            <option value={10}>10 · broader</option>
            <option value={20}>20 · extended</option>
          </select>
        </div>
        {running ? (
          <button type="button" className="secondary-button research-run" onClick={cancelBatch}>Cancel benchmark</button>
        ) : (
          <button type="button" className="primary-button research-run" disabled={algorithms.length === 0 || scenarios.length === 0} onClick={startBatch}>Run benchmark</button>
        )}
      </div>

      {(running || progress) && (
        <div className="batch-progress">
          <div role="progressbar" aria-label="Benchmark progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed}><i style={{ width: `${progressPercent}%` }} /></div>
          <span aria-live="polite">{completed} / {total} seeded runs</span>
          {progress && <small>{ALGORITHM_METADATA[progress.currentAlgorithm].shortName} · {progress.currentScenario}</small>}
        </div>
      )}
      {runMessage && <p className="batch-message" role="status">{runMessage}</p>}

      {summaries.length > 0 && (
        <>
          <div className="results-toolbar">
            <div className="checkpoint-tabs" role="tablist" aria-label="Result checkpoint">
              {[30, 60, 120, 180].map((seconds) => (
                <button type="button" role="tab" aria-selected={checkpoint === seconds} key={seconds} className={checkpoint === seconds ? 'active' : ''} onClick={() => setCheckpoint(seconds)}>{seconds}s</button>
              ))}
            </div>
            <button type="button" className="secondary-button" onClick={() => downloadCsv(batchResultsToCsv(rawResults))}>Export raw CSV ↓</button>
          </div>
          <ResearchCharts results={rawResults} />
          <div className="results-table-wrap" tabIndex={0} role="region" aria-label={`Benchmark results at ${checkpoint} seconds`}>
            <table className="results-table">
              <caption className="sr-only">Summary of {resultRuns} seeded runs per selected method and scenario at the {checkpoint}-second checkpoint.</caption>
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Scenario</th>
                  <th>Median error</th>
                  <th>Success</th>
                  <th>Direct-distance overhead</th>
                  <th>Contacts</th>
                  <th>Active cost</th>
                  <th>Compute / step</th>
                  <th>Declaration safety</th>
                </tr>
              </thead>
              <tbody>
                {visibleSummaries.map((summary) => {
                  const item = ALGORITHM_METADATA[summary.algorithmId]
                  return (
                    <tr key={`${summary.algorithmId}-${summary.scenarioKind}-${summary.targetStatus}-${summary.obstacleComplexityLevel}-${summary.terrainSlopeDegrees}-${summary.terrainUphillDirectionDegrees}-${summary.gasBuoyancy}-${summary.terrainGasDriftScale}-${summary.robotSlopeLimitDegrees}`}>
                      <td><i style={{ background: item.color }} /> <strong>{item.shortName}</strong></td>
                      <td>
                        <span className="scenario-label">
                          {summary.scenarioKind}
                          {summary.scenarioKind === 'obstructed' && ` · L${summary.obstacleComplexityLevel}`}
                          <small>
                            {summary.targetStatus} · {summary.terrainSlopeDegrees > 0
                              ? `${summary.terrainSlopeDegrees}° slope · ${summary.gasBuoyancy}`
                              : 'flat terrain'}
                          </small>
                        </span>
                      </td>
                      <td className={summary.medianNormalizedError !== null && summary.medianNormalizedError <= 0.01 ? 'result-good' : ''}>
                        {summary.medianNormalizedError === null ? 'N/A' : `${(summary.medianNormalizedError * 100).toFixed(2)}%`}
                        <small>{summary.medianNormalizedError === null || summary.p90NormalizedError === null
                          ? 'no target coordinate'
                          : `${(summary.medianNormalizedError * baseConfig.domainMeters).toFixed(2)} m · p90 ${(summary.p90NormalizedError * 100).toFixed(2)}%`}</small>
                      </td>
                      <td>{summary.successRate === null ? 'N/A' : `${(summary.successRate * 100).toFixed(0)}%`}</td>
                      <td>
                        {(summary.terrainSlopeDegrees > 0
                          ? summary.medianSurfacePathOverhead
                          : summary.medianPathOverhead) === null
                          ? 'N/A'
                          : `${(summary.terrainSlopeDegrees > 0
                              ? summary.medianSurfacePathOverhead
                              : summary.medianPathOverhead)!.toFixed(2)}×`}
                        {summary.terrainSlopeDegrees > 0 && (
                          <small>{(summary.medianTerrainMobilityScale * 100).toFixed(0)}% mobility · {summary.medianElevationGainMeters.toFixed(1)} m ascent</small>
                        )}
                      </td>
                      <td>{summary.medianPlumeContacts.toFixed(0)}</td>
                      <td>
                        {summary.algorithmId === 'pulse-sniff'
                          ? `${summary.medianActiveProbes.toFixed(0)} probes`
                          : summary.algorithmId === 'quad-sniff' || summary.algorithmId === 'quad-sniff-wind' || summary.algorithmId === 'quad-sniff-range' || summary.algorithmId === 'quad-sniff-corridor' || summary.algorithmId === 'quad-sniff-bracket' || summary.algorithmId === 'quad-sniff-refine'
                            ? `${summary.medianQuadSniffCycles.toFixed(0)} quad cycles`
                            : '—'}
                        {summary.algorithmId === 'pulse-sniff' && (
                          <small>{summary.medianPulseEnergy.toFixed(2)} energy proxy</small>
                        )}
                        {(summary.algorithmId === 'quad-sniff' || summary.algorithmId === 'quad-sniff-wind' || summary.algorithmId === 'quad-sniff-range' || summary.algorithmId === 'quad-sniff-corridor' || summary.algorithmId === 'quad-sniff-bracket' || summary.algorithmId === 'quad-sniff-refine') && (
                          <small>{summary.medianQuadSuctionEnergy.toFixed(2)} cost · {(summary.medianQuadValidDirectionRate * 100).toFixed(0)}% directional · n_eff {summary.medianQuadEffectiveSamples.toFixed(1)}</small>
                        )}
                      </td>
                      <td>{summary.medianComputeMs.toFixed(2)} ms</td>
                      <td>{summary.targetStatus === 'absent'
                        ? `${(summary.spuriousDeclarationRate * 100).toFixed(0)}% spurious`
                        : summary.declarationRate > 0
                          ? `${(summary.falseDeclarationRate * 100).toFixed(0)}% false | declared`
                          : '—'}
                        <small>{summary.targetStatus === 'absent'
                          ? summary.correctRejectionRate === null
                            ? 'rejection pending'
                            : `${(summary.correctRejectionRate * 100).toFixed(0)}% correct rejection`
                          : `${(summary.declarationRate * 100).toFixed(0)}% declared`}</small>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="results-footnote">
            Each cell contains n={resultRuns} paired seeds. Compute/step is local browser-device timing. Terrain-aware inverse likelihoods and ambient-wind-reactive policies use different model knowledge by design; report that distinction, uncertainty intervals, grid sensitivity, and independent validation for formal work.
          </p>
        </>
      )}
    </section>
  )
}
