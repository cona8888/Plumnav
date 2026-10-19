import { useCallback, useEffect, useRef, useState } from 'react'
import { AlgorithmDetails } from './components/AlgorithmDetails'
import { MetricCard } from './components/MetricCard'
import { ResearchPanel } from './components/ResearchPanel'
import { ReplayTimeline } from './components/ReplayTimeline'
import { SimulationCanvas } from './components/SimulationCanvas'
import { ALGORITHM_METADATA, ALGORITHM_ORDER } from './sim/algorithms/metadata'
import {
  createDefaultConfig,
  DEFAULT_ACTIVE_SNIFF_CONTROLS,
  DEFAULT_FLOW_CONTROLS,
  DEFAULT_OBSTACLE_COMPLEXITY_LEVEL,
  DEFAULT_QUAD_CHANNEL_NUISANCE_CONTROLS,
  DEFAULT_SENSOR_CONTROLS,
  DEFAULT_TERRAIN_CONTROLS,
  effectiveSensorThreshold as sensorThresholdFor,
} from './sim/config'
import {
  OBSTACLE_COMPLEXITY_LABELS,
  rasterizedObstacleFraction,
  summarizeObstacleComplexity,
} from './sim/fractalObstacles'
import { SimulationEngine } from './sim/engine'
import { appendReplayFrame, snapshotSimulationFrame } from './sim/replay'
import { getScenarioFlowBaseline } from './sim/scenarios'
import {
  COMMERCIAL_SENSOR_PROFILES,
  OPEN_PATH_TDLAS_PROFILE,
  commercialSensorPatch,
  commercialSensorProfile,
  sensorT90Seconds,
} from './sim/sensorProfiles'
import { terrainGasDrift } from './sim/terrain'
import type { AlgorithmId, ScenarioKind, SimulationConfig, SimulationFrame } from './sim/types'

type View = 'simulation' | 'benchmark'

const formatTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds - minutes * 60
  return minutes > 0 ? `${minutes}:${remainder.toFixed(1).padStart(4, '0')}` : `${remainder.toFixed(1)}s`
}

const randomSeed = () => Math.floor(100 + Math.random() * 99_899)

const compassLabel = (degrees: number) => {
  const labels = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
  return labels[Math.round((((degrees % 360) + 360) % 360) / 45) % labels.length] ?? 'N'
}

export default function App() {
  const [view, setView] = useState<View>('simulation')
  const [config, setConfig] = useState<SimulationConfig>(() => createDefaultConfig())
  const engineRef = useRef<SimulationEngine | null>(null)
  if (engineRef.current === null) engineRef.current = new SimulationEngine(config)
  const [frame, setFrame] = useState(() => engineRef.current!.getFrame())
  const [history, setHistory] = useState<SimulationFrame[]>(() => [
    snapshotSimulationFrame(engineRef.current!.getFrame()),
  ])
  const [replayIndex, setReplayIndex] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [playbackSpeed, setPlaybackSpeed] = useState(4)
  const [seedDraft, setSeedDraft] = useState(() => String(config.seed))
  const [sourceSeedDraft, setSourceSeedDraft] = useState(() => String(config.sourceSeed))
  const [layers, setLayers] = useState({
    terrain: true,
    plume: true,
    wind: true,
    belief: true,
    samples: true,
    groundTruth: false,
  })

  const algorithm = ALGORITHM_METADATA[config.algorithmId]
  const usesActiveOlfaction =
    config.algorithmId === 'pulse-sniff' ||
    config.algorithmId === 'quad-sniff' ||
    config.algorithmId === 'quad-sniff-wind' ||
    config.algorithmId === 'quad-sniff-range' ||
    config.algorithmId === 'quad-sniff-corridor' ||
    config.algorithmId === 'quad-sniff-bracket' ||
    config.algorithmId === 'quad-sniff-refine'
  const usesQuadSuction =
    config.algorithmId === 'quad-sniff' ||
    config.algorithmId === 'quad-sniff-wind' ||
    config.algorithmId === 'quad-sniff-range' ||
    config.algorithmId === 'quad-sniff-corridor' ||
    config.algorithmId === 'quad-sniff-bracket' ||
    config.algorithmId === 'quad-sniff-refine'
  const usesQuadPassive = config.algorithmId === 'quad-passive'
  const usesQuadArray = usesQuadSuction || usesQuadPassive
  const flowBaseline = getScenarioFlowBaseline(config.scenarioKind)
  const effectiveWindSpeed = flowBaseline.windSpeed * config.windSpeedScale
  const effectiveTurbulence = flowBaseline.turbulence * config.turbulenceScale
  const effectiveDiffusivity = flowBaseline.diffusivity * config.diffusivityScale
  const pecletNumber = effectiveWindSpeed / Math.max(effectiveDiffusivity, 1e-9)
  const effectiveSensorThreshold = sensorThresholdFor(config)
  const activeSensorProfile = commercialSensorProfile(config.sensorProfileId)
  const sensorResponseControlLabel = config.sensorProfileId === 'mems-mos-tgs8410'
    || config.sensorProfileId === 'budget-mq4'
    ? 'Model timing proxy'
    : 'Response time T90'
  const flowIsDefault = (
    Object.keys(DEFAULT_FLOW_CONTROLS) as (keyof typeof DEFAULT_FLOW_CONTROLS)[]
  ).every((key) => config[key] === DEFAULT_FLOW_CONTROLS[key])
  const sensorIsDefault = (
    Object.keys(DEFAULT_SENSOR_CONTROLS) as (keyof typeof DEFAULT_SENSOR_CONTROLS)[]
  ).every((key) => config[key] === DEFAULT_SENSOR_CONTROLS[key])
  const activeSniffIsDefault = (
    Object.keys(DEFAULT_ACTIVE_SNIFF_CONTROLS) as (keyof typeof DEFAULT_ACTIVE_SNIFF_CONTROLS)[]
  ).every((key) => config[key] === DEFAULT_ACTIVE_SNIFF_CONTROLS[key])
  const quadNuisanceIsDefault = (
    Object.keys(DEFAULT_QUAD_CHANNEL_NUISANCE_CONTROLS) as (
      keyof typeof DEFAULT_QUAD_CHANNEL_NUISANCE_CONTROLS
    )[]
  ).every((key) => config[key] === DEFAULT_QUAD_CHANNEL_NUISANCE_CONTROLS[key])
  const terrainIsDefault = (
    Object.keys(DEFAULT_TERRAIN_CONTROLS) as (keyof typeof DEFAULT_TERRAIN_CONTROLS)[]
  ).every((key) => config[key] === DEFAULT_TERRAIN_CONTROLS[key])
  const obstacleSummary = summarizeObstacleComplexity(frame.scenario.obstacles)
  const rasterizedObstacleArea = config.physicsMode === 'grid'
    ? rasterizedObstacleFraction(frame.scenario.obstacles, config.gridResolution)
    : null
  const gridCellMeters = config.domainMeters / config.gridResolution
  const cellsPerSuccessRadius = config.gridResolution * config.successThreshold
  const obstacleComplexityLabel =
    OBSTACLE_COMPLEXITY_LABELS[config.obstacleComplexityLevel] ?? 'Custom'
  const terrainGradePercent = Math.tan(config.terrainSlopeDegrees * Math.PI / 180) * 100
  const terrainRiseMeters = terrainGradePercent / 100 * config.domainMeters
  const terrainDrift = terrainGasDrift(frame.scenario)
  const terrainDriftSpeed = Math.hypot(terrainDrift.x, terrainDrift.y)

  useEffect(() => setSeedDraft(String(config.seed)), [config.seed])
  useEffect(() => setSourceSeedDraft(String(config.sourceSeed)), [config.sourceSeed])

  const replaceEngine = useCallback((nextConfig: SimulationConfig) => {
    setPlaying(false)
    const engine = new SimulationEngine(nextConfig)
    const nextFrame = engine.getFrame()
    engineRef.current = engine
    setConfig(nextConfig)
    setFrame(nextFrame)
    setHistory([snapshotSimulationFrame(nextFrame)])
    setReplayIndex(null)
  }, [])

  const presentLiveFrame = useCallback((nextFrame: SimulationFrame) => {
    setFrame(nextFrame)
    setReplayIndex(null)
    setHistory((current) => appendReplayFrame(current, nextFrame))
  }, [])

  const patchConfig = useCallback(
    (patch: Partial<SimulationConfig>) => {
      const nextConfig = {
        ...config,
        ...patch,
        checkpointSeconds: [...config.checkpointSeconds],
      }
      if (
        nextConfig.scenarioKind === 'obstructed' &&
        nextConfig.physicsMode === 'grid' &&
        nextConfig.obstacleComplexityLevel === 5 &&
        nextConfig.gridResolution < 48
      ) {
        nextConfig.gridResolution = 48
      }
      replaceEngine(nextConfig)
    },
    [config, replaceEngine],
  )

  useEffect(() => {
    if (!playing) return
    const engine = engineRef.current
    if (!engine || engine.isCompleted()) {
      setPlaying(false)
      return
    }
    engine.setRunning(true)
    setFrame(engine.getFrame())
    let animationFrame = 0
    let previous = performance.now()
    let accumulator = 0

    const animate = (timestamp: number) => {
      const elapsed = Math.min(0.1, Math.max(0, (timestamp - previous) / 1000))
      previous = timestamp
      accumulator += elapsed * playbackSpeed
      let steps = 0
      while (accumulator >= config.fixedDt && steps < 48 && !engine.isCompleted()) {
        engine.step()
        accumulator -= config.fixedDt
        steps += 1
      }
      if (steps > 0) presentLiveFrame(engine.getFrame())
      if (engine.isCompleted()) {
        setPlaying(false)
        presentLiveFrame(engine.getFrame())
        return
      }
      animationFrame = requestAnimationFrame(animate)
    }
    animationFrame = requestAnimationFrame(animate)
    return () => {
      cancelAnimationFrame(animationFrame)
      engine.setRunning(false)
    }
  }, [config.fixedDt, playbackSpeed, playing, presentLiveFrame])

  const togglePlayback = () => {
    const engine = engineRef.current
    if (!engine) return
    if (replayIndex !== null) {
      setReplayIndex(null)
      setFrame(engine.getFrame())
    }
    if (engine.isCompleted()) {
      replaceEngine(config)
      setPlaying(true)
      return
    }
    setPlaying((current) => !current)
  }

  const stepOnce = () => {
    const engine = engineRef.current
    if (!engine || engine.isCompleted()) return
    setPlaying(false)
    engine.step()
    presentLiveFrame(engine.getFrame())
  }

  const reset = () => replaceEngine(config)
  const commitSeed = () => {
    const candidate = Number(seedDraft)
    if (!Number.isFinite(candidate)) {
      setSeedDraft(String(config.seed))
      return
    }
    patchConfig({ seed: Math.max(1, Math.min(999_999, Math.round(candidate))) })
  }
  const commitSourceSeed = () => {
    const candidate = Number(sourceSeedDraft)
    if (!Number.isFinite(candidate)) {
      setSourceSeedDraft(String(config.sourceSeed))
      return
    }
    patchConfig({ sourceSeed: Math.max(1, Math.min(9_999_999, Math.round(candidate))) })
  }
  const hasEstimate = frame.decision.estimate !== null
  const normalizedError = frame.metrics.normalizedError
  const localizationEvaluable = normalizedError !== null
  const errorPercent = normalizedError !== null
    ? normalizedError * 100
    : null
  const errorTone = !hasEstimate || errorPercent === null
    ? 'neutral'
    : frame.metrics.success
      ? 'good'
      : errorPercent <= 3
        ? 'warn'
        : 'neutral'
  const budgetOutcome = !frame.completed
    ? 'IN PROGRESS'
    : frame.metrics.terminalOutcome === 'correct-declaration'
      ? 'CORRECT DECL.'
      : frame.metrics.terminalOutcome === 'wrong-declaration'
        ? 'WRONG DECL.'
        : frame.metrics.terminalOutcome === 'spurious-declaration'
          ? 'SPURIOUS DECL.'
          : frame.metrics.terminalOutcome === 'correct-abstention'
            ? 'CORRECT ABSTAIN'
            : frame.metrics.terminalOutcome === 'missed-source-abstention'
              ? 'MISSED SOURCE'
              : frame.metrics.terminalOutcome === 'correct-rejection-at-deadline'
                ? 'CORRECT REJECT.'
                : 'NO DECLARATION'
  const outcomeIsGood = [
    'correct-declaration',
    'correct-abstention',
    'correct-rejection-at-deadline',
  ].includes(frame.metrics.terminalOutcome)
  const outcomeIsWarning = [
    'wrong-declaration',
    'spurious-declaration',
    'missed-source-abstention',
  ].includes(frame.metrics.terminalOutcome)

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="#top" aria-label="PlumeNav Lab home">
          <span className="brand-mark"><i /><i /><i /></span>
          <span><strong>PLUMENAV</strong><small>RESEARCH LAB</small></span>
        </a>
        <nav aria-label="Primary navigation">
          <button type="button" aria-pressed={view === 'simulation'} className={view === 'simulation' ? 'active' : ''} onClick={() => setView('simulation')}>Live simulator</button>
          <button type="button" aria-pressed={view === 'benchmark'} className={view === 'benchmark' ? 'active' : ''} onClick={() => setView('benchmark')}>Research benchmark</button>
        </nav>
        <div className="header-status">
          <span className="status-dot status-dot--online" />
          <div><strong>DETERMINISTIC CORE</strong><small>world {config.seed} · {config.targetStatus === 'absent' ? 'no target' : `source ${config.sourceSeed}`}</small></div>
        </div>
      </header>

      <main id="top">
        <section className="hero-row">
          <div>
            <span className="eyebrow">MOBILE ROBOTIC OLFACTION · 2D RESEARCH WORKBENCH</span>
            <h1>See how a robot reasons <em>inside the plume.</em></h1>
          </div>
          <p>
            Six literature-grounded strategies plus two experimental active-olfaction prototypes. One reproducible atmosphere. Separate the path a method takes from the assumptions it makes.
          </p>
        </section>

        {view === 'simulation' ? (
          <>
            <section className="metric-strip" aria-label="Live run metrics">
              <MetricCard
                label="Normalized error"
                value={!localizationEvaluable ? 'N/A' : hasEstimate ? `${errorPercent!.toFixed(2)}%` : '—'}
                detail={!localizationEvaluable
                  ? 'No target coordinate by design'
                  : hasEstimate
                    ? `${frame.metrics.errorMeters!.toFixed(2)} m · target ≤ 1.00%`
                    : 'Waiting for an estimate'}
                tone={errorTone}
              />
              <MetricCard label="Mission clock" value={formatTime(frame.time)} detail={`${frame.config.durationSeconds}s research budget`} />
              <MetricCard
                label="Travelled"
                value={`${frame.metrics.surfacePathLengthMeters.toFixed(1)} m`}
                detail={config.terrainSlopeDegrees > 0
                  ? `${frame.metrics.pathLengthMeters.toFixed(1)} m plan · ${frame.metrics.elevationGainMeters.toFixed(1)} m ascent`
                  : frame.metrics.normalizedPathOverhead === null
                    ? 'No target-referenced path overhead'
                    : `${frame.metrics.normalizedPathOverhead.toFixed(2)}× direct-path overhead`}
              />
              <MetricCard label="Plume contacts" value={`${frame.metrics.contactEpisodes}`} detail={`${frame.metrics.hitCount} hit samples · ${frame.metrics.reacquisitions} reacquired`} tone="accent" />
              {usesActiveOlfaction || usesQuadArray ? (
                <MetricCard
                  label={usesQuadArray ? 'Quad cycles' : 'Active probes'}
                  value={`${usesQuadArray ? frame.metrics.quadSniffCycles : frame.metrics.activeProbeCount}`}
                  detail={usesQuadArray
                    ? `${frame.metrics.quadChannelReturns} ch · ${usesQuadPassive ? `${frame.metrics.quadPassiveSamplingSeconds.toFixed(1)}s passive` : `${frame.metrics.quadSuctionEnergy.toFixed(2)} suction cost`} · dir ${frame.metrics.quadValidDirections}/${frame.metrics.quadValidDirections + frame.metrics.quadDirectionAbstentions} · n_eff ${frame.metrics.meanQuadEffectiveSamples.toFixed(1)}`
                    : `${frame.metrics.airPulseEnergy.toFixed(2)} pulse-energy · ${frame.metrics.activeSamplingSeconds.toFixed(1)}s sampling`}
                  tone="accent"
                />
              ) : (
                <MetricCard label="Decision cost" value={`${frame.metrics.meanComputeMs.toFixed(2)} ms`} detail={`p95 ${frame.metrics.p95ComputeMs.toFixed(2)} ms · ${frame.metrics.samples} samples`} />
              )}
              <MetricCard
                label="Budget outcome"
                value={budgetOutcome}
                detail={frame.metrics.spuriousDeclaration
                  ? 'Declared a source in a no-target trial'
                  : frame.metrics.nativeAbstention
                    ? 'Explicit controller abstention recorded'
                    : 'Controller cannot access target truth'}
                tone={outcomeIsGood ? 'good' : outcomeIsWarning ? 'warn' : 'neutral'}
              />
            </section>

            <section className="workspace-grid">
              <div className="simulation-column">
                <div className="simulation-toolbar">
                  <div className="run-controls">
                    <button type="button" className="primary-button" onClick={togglePlayback}>
                      <span>{playing ? 'Ⅱ' : '▶'}</span> {playing ? 'Pause run' : frame.completed ? 'Run again' : 'Start run'}
                    </button>
                    <button type="button" className="icon-button" aria-label="Advance one fixed simulation step" onClick={stepOnce} disabled={playing || frame.completed} title="Advance one fixed simulation step">›|</button>
                    <button type="button" className="secondary-button" onClick={reset}>Reset</button>
                  </div>
                  <div className="toolbar-divider" />
                  <label className="compact-select">Playback
                    <select value={playbackSpeed} onChange={(event) => setPlaybackSpeed(Number(event.target.value))}>
                      <option value={1}>1×</option>
                      <option value={4}>4×</option>
                      <option value={12}>12×</option>
                      <option value={30}>30×</option>
                    </select>
                  </label>
                  <button type="button" aria-pressed={layers.groundTruth} className={layers.groundTruth ? 'truth-button truth-button--active' : 'truth-button'} onClick={() => setLayers((current) => ({ ...current, groundTruth: !current.groundTruth }))}>
                    {layers.groundTruth ? 'Hide source' : 'Reveal source'}
                  </button>
                </div>

                <SimulationCanvas frame={frame} plume={engineRef.current.plume} layers={layers} accent={algorithm.color} />

                <ReplayTimeline
                  history={history}
                  selectedIndex={replayIndex}
                  liveTime={engineRef.current.getTime()}
                  onSelect={(index) => {
                    const historicalFrame = history[index]
                    if (!historicalFrame) return
                    setPlaying(false)
                    setReplayIndex(index)
                    setFrame(historicalFrame)
                  }}
                  onLive={() => {
                    setReplayIndex(null)
                    setFrame(engineRef.current!.getFrame())
                  }}
                />

                <div className="layer-bar">
                  <span>MAP LAYERS</span>
                  {([
                    ['terrain', 'Slope contours'],
                    ['plume', 'Concentration'],
                    ['wind', 'Wind field'],
                    ['belief', 'Belief / particles'],
                    ['samples', 'Sensor samples'],
                  ] as const).map(([key, label]) => (
                    <button type="button" key={key} aria-pressed={layers[key]} className={layers[key] ? 'active' : ''} onClick={() => setLayers((current) => ({ ...current, [key]: !current[key] }))}>
                      <i /> {label}
                    </button>
                  ))}
                  <span className="layer-legend"><i className="legend-robot" /> Robot <i className="legend-estimate" /> Estimate</span>
                </div>
              </div>

              <aside className="control-column">
                <section className="control-card">
                  <div className="section-heading">
                    <div><span className="eyebrow">ALGORITHM</span><h2>Choose a search policy</h2></div>
                    <span className="counter">{ALGORITHM_ORDER.indexOf(config.algorithmId) + 1}/{ALGORITHM_ORDER.length}</span>
                  </div>
                  <div className="algorithm-list" role="radiogroup" aria-label="Localization algorithm">
                    {ALGORITHM_ORDER.map((algorithmId) => {
                      const item = ALGORITHM_METADATA[algorithmId]
                      const active = algorithmId === config.algorithmId
                      return (
                        <button
                          type="button"
                          key={algorithmId}
                          className={active ? 'algorithm-option algorithm-option--active' : 'algorithm-option'}
                          role="radio"
                          aria-checked={active}
                          onClick={() => patchConfig({ algorithmId })}
                          style={{ '--algorithm-color': item.color } as React.CSSProperties}
                        >
                          <span className="algorithm-index">{item.index}</span>
                          <span><strong>{item.shortName}</strong><small>{item.family}</small></span>
                          <i>{active ? '●' : '○'}</i>
                        </button>
                      )
                    })}
                  </div>
                </section>

                <section className="control-card">
                  <div className="section-heading"><div><span className="eyebrow">EXPERIMENT</span><h2>Scenario controls</h2></div></div>
                  <div className="scenario-switch" role="radiogroup" aria-label="Flow scenario">
                    {([
                      ['open', 'Open flow', 'Laminar'],
                      ['obstructed', 'Process floor', 'Turbulent'],
                    ] as [ScenarioKind, string, string][]).map(([kind, title, subtitle]) => (
                      <button
                        type="button"
                        role="radio"
                        aria-checked={config.scenarioKind === kind}
                        key={kind}
                        className={config.scenarioKind === kind ? 'active' : ''}
                        onClick={() => patchConfig({ scenarioKind: kind })}
                      >
                        <i className={`scenario-icon scenario-icon--${kind}`} />
                        <span><strong>{title}</strong><small>{subtitle}</small></span>
                      </button>
                    ))}
                  </div>
                  <p className="scenario-description">{frame.scenario.description}</p>
                  {config.scenarioKind === 'obstructed' && (
                    <div className="obstacle-complexity" role="group" aria-labelledby="obstacle-complexity-label">
                      <div className="obstacle-complexity__heading">
                        <label id="obstacle-complexity-label" htmlFor="obstacle-complexity-level">
                          Recursive obstacle complexity
                          <output htmlFor="obstacle-complexity-level">
                            L{config.obstacleComplexityLevel} · {obstacleComplexityLabel}
                          </output>
                        </label>
                        <button
                          type="button"
                          disabled={config.obstacleComplexityLevel === DEFAULT_OBSTACLE_COMPLEXITY_LEVEL}
                          onClick={() => patchConfig({ obstacleComplexityLevel: DEFAULT_OBSTACLE_COMPLEXITY_LEVEL })}
                        >
                          Reset
                        </button>
                      </div>
                      <input
                        id="obstacle-complexity-level"
                        type="range"
                        min={0}
                        max={5}
                        step={1}
                        value={config.obstacleComplexityLevel}
                        aria-valuetext={`Level ${config.obstacleComplexityLevel}, ${obstacleComplexityLabel}`}
                        onChange={(event) => {
                          const obstacleComplexityLevel = Number(event.target.value)
                          patchConfig({
                            obstacleComplexityLevel,
                            ...(config.physicsMode === 'grid' &&
                            obstacleComplexityLevel === 5 &&
                            config.gridResolution < 48
                              ? { gridResolution: 48 }
                              : {}),
                          })
                        }}
                      />
                      <div className="obstacle-complexity__scale" aria-hidden="true">
                        <span>Clear</span><span>Sparse</span><span>Light</span><span>Medium</span><span>Dense</span><span>Labyrinth</span>
                      </div>
                      <p>
                        {obstacleSummary.count} process units · {(obstacleSummary.occupiedFraction * 100).toFixed(1)}% occupied.
                        {rasterizedObstacleArea !== null && ` Grid-realized area ${(rasterizedObstacleArea * 100).toFixed(1)}%.`}
                        {config.obstacleComplexityLevel === 0
                          ? ' Clear control retains process-flow turbulence while removing solid geometry.'
                          : ' Seeded binary subdivision increases corners and wake interactions while preserving a central service route.'}
                      </p>
                    </div>
                  )}
                  <fieldset className="physics-controls">
                    <legend><span className="eyebrow">PHYSICS FIDELITY</span></legend>
                    <div className="physics-switch" role="radiogroup" aria-label="Plume physics model">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={config.physicsMode === 'filament'}
                        className={config.physicsMode === 'filament' ? 'active' : ''}
                        onClick={() => patchConfig({ physicsMode: 'filament' })}
                      >
                        <span><strong>Fast puffs</strong><small>Lagrangian demonstration</small></span>
                        <i>LIVE</i>
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={config.physicsMode === 'grid'}
                        className={config.physicsMode === 'grid' ? 'active' : ''}
                        onClick={() => patchConfig({ physicsMode: 'grid' })}
                      >
                        <span><strong>2D numerical</strong><small>Advection–diffusion grid</small></span>
                        <i>PDE</i>
                      </button>
                    </div>
                    {config.physicsMode === 'grid' && (
                      <>
                        <label className="grid-resolution" htmlFor="grid-resolution">
                          Grid resolution
                          <select id="grid-resolution" value={config.gridResolution} onChange={(event) => patchConfig({ gridResolution: Number(event.target.value) })}>
                            <option value={32} disabled={config.obstacleComplexityLevel === 5}>
                              32 × 32 · fast{config.obstacleComplexityLevel === 5 ? ' (L1–L4)' : ''}
                            </option>
                            <option value={48}>48 × 48 · balanced</option>
                            <option value={64}>64 × 64 · detailed</option>
                            <option value={96}>96 × 96 · research</option>
                            <option value={128}>128 × 128 · convergence (slow)</option>
                          </select>
                        </label>
                        <p className="physics-note">Numerical forward field; controllers retain their analytical inverse model to prevent solver-oracle access.</p>
                        <p className={`physics-note physics-note--resolution ${cellsPerSuccessRadius < 2 ? 'physics-note--warning' : ''}`}>
                          Cell width {gridCellMeters.toFixed(2)} m · success radius {(config.successThreshold * config.domainMeters).toFixed(2)} m · {cellsPerSuccessRadius.toFixed(2)} cells/radius.
                          {cellsPerSuccessRadius < 2
                            ? ' Under-resolved for a metre-accuracy claim; use a finer research grid or a wider endpoint.'
                            : ' Endpoint has at least two cells per radius; convergence evidence is still required.'}
                        </p>
                      </>
                    )}
                  </fieldset>
                  <fieldset className="flow-controls" aria-describedby="flow-controls-note">
                    <legend>
                      <span>
                        <i>FLOW + SOURCE</i>
                        <strong>Transport &amp; source</strong>
                        {!flowIsDefault && <b>Custom</b>}
                      </span>
                      <button
                        type="button"
                        disabled={flowIsDefault}
                        onClick={() => patchConfig(DEFAULT_FLOW_CONTROLS)}
                      >
                        Restore defaults
                      </button>
                    </legend>

                    <label className="flow-control flow-control--direction" htmlFor="wind-direction">
                      <span>Wind direction (toward)<output htmlFor="wind-direction">{config.windDirectionDegrees.toFixed(0)}° · {compassLabel(config.windDirectionDegrees)}</output></span>
                      <span className="direction-slider">
                        <i aria-hidden="true" style={{ '--wind-heading': `${config.windDirectionDegrees}deg` } as React.CSSProperties}>↑</i>
                        <input
                          id="wind-direction"
                          type="range"
                          min={0}
                          max={355}
                          step={5}
                          value={config.windDirectionDegrees}
                          aria-valuetext={`${config.windDirectionDegrees.toFixed(0)} degrees, flowing ${compassLabel(config.windDirectionDegrees)}`}
                          onChange={(event) => patchConfig({ windDirectionDegrees: Number(event.target.value) })}
                        />
                      </span>
                    </label>

                    <div className="flow-control-grid">
                      <label className="flow-control" htmlFor="target-status">
                        <span>Target condition</span>
                        <select
                          id="target-status"
                          value={config.targetStatus}
                          onChange={(event) => patchConfig({
                            targetStatus: event.target.value as SimulationConfig['targetStatus'],
                          })}
                        >
                          <option value="emitting">Present · emitting</option>
                          <option value="zero-emission">Present · zero emission</option>
                          <option value="absent">Absent · no target</option>
                        </select>
                      </label>
                      <label className="flow-control" htmlFor="wind-speed">
                        <span>Mean speed<output htmlFor="wind-speed">{config.windSpeedScale.toFixed(2)}× · {(effectiveWindSpeed * 100).toFixed(1)}%/s</output></span>
                        <input id="wind-speed" type="range" min={0.1} max={2.5} step={0.05} value={config.windSpeedScale} aria-valuetext={`${config.windSpeedScale.toFixed(2)} times the scenario baseline`} onChange={(event) => patchConfig({ windSpeedScale: Number(event.target.value) })} />
                      </label>
                      <label className="flow-control" htmlFor="flow-turbulence">
                        <span>Turbulence<output htmlFor="flow-turbulence">{config.turbulenceScale.toFixed(2)}× · {(effectiveTurbulence * 100).toFixed(0)}%</output></span>
                        <input id="flow-turbulence" type="range" min={0} max={2} step={0.05} value={config.turbulenceScale} aria-valuetext={`${config.turbulenceScale.toFixed(2)} times the scenario baseline`} onChange={(event) => patchConfig({ turbulenceScale: Number(event.target.value) })} />
                      </label>
                      <label className="flow-control" htmlFor="gust-strength">
                        <span>Gust amplitude<output htmlFor="gust-strength">±{(config.gustStrength * 100).toFixed(0)}% max</output></span>
                        <input id="gust-strength" type="range" min={0} max={0.5} step={0.01} value={config.gustStrength} aria-valuetext={`up to plus or minus ${(config.gustStrength * 100).toFixed(0)} percent of mean speed`} onChange={(event) => patchConfig({ gustStrength: Number(event.target.value) })} />
                      </label>
                      <label className="flow-control" htmlFor="flow-diffusivity">
                        <span>Diffusivity<output htmlFor="flow-diffusivity">{config.diffusivityScale.toFixed(2)}× · {effectiveDiffusivity.toExponential(1)}</output></span>
                        <input id="flow-diffusivity" type="range" min={0.1} max={4} step={0.05} value={config.diffusivityScale} aria-valuetext={`${config.diffusivityScale.toFixed(2)} times the scenario baseline`} onChange={(event) => patchConfig({ diffusivityScale: Number(event.target.value) })} />
                      </label>
                      <label className="flow-control flow-control--emission" htmlFor="source-emission-rate">
                        <span>Source emission rate<output htmlFor="source-emission-rate">{config.targetStatus === 'emitting' ? `${config.emissionRateScale < 0.1 ? config.emissionRateScale.toPrecision(2) : config.emissionRateScale.toFixed(2)}×` : '0× effective'}</output></span>
                        <input id="source-emission-rate" type="range" min={0.001} max={3} step={0.001} disabled={config.targetStatus !== 'emitting'} value={config.emissionRateScale} aria-valuetext={`${config.emissionRateScale.toPrecision(3)} times the scenario source output`} onChange={(event) => patchConfig({ emissionRateScale: Number(event.target.value) })} />
                      </label>
                    </div>
                    <p id="flow-controls-note">Convection moves gas downwind; diffusion broadens the represented plume without changing source forcing. Domain Péclet number ≈ {pecletNumber.toFixed(0)}. {config.targetStatus === 'emitting'
                      ? 'Emission rate scales source output only—not wind or diffusion.'
                      : config.targetStatus === 'zero-emission'
                        ? 'A hidden source coordinate is retained but physical gas output is zero; localization remains scorable.'
                        : 'No source coordinate exists, so localization error is not applicable; spurious declaration and rejection are scored instead.'} Ratios are dimensionless; changes restart the run.</p>
                  </fieldset>
                  <fieldset className="flow-controls terrain-controls" aria-describedby="terrain-controls-note">
                    <legend>
                      <span>
                        <i>2.5D TERRAIN</i>
                        <strong>Planar slope &amp; mobility</strong>
                        {!terrainIsDefault && <b>Custom</b>}
                      </span>
                      <button
                        type="button"
                        disabled={terrainIsDefault}
                        onClick={() => patchConfig(DEFAULT_TERRAIN_CONTROLS)}
                      >
                        Restore flat
                      </button>
                    </legend>

                    <label className="flow-control" htmlFor="terrain-slope">
                      <span>
                        Slope angle
                        <output htmlFor="terrain-slope">
                          {config.terrainSlopeDegrees.toFixed(0)}° · {terrainGradePercent.toFixed(1)}% grade
                        </output>
                      </span>
                      <input
                        id="terrain-slope"
                        type="range"
                        min={0}
                        max={20}
                        step={1}
                        value={config.terrainSlopeDegrees}
                        aria-valuetext={`${config.terrainSlopeDegrees.toFixed(0)} degrees, ${terrainGradePercent.toFixed(1)} percent grade`}
                        onChange={(event) => patchConfig({ terrainSlopeDegrees: Number(event.target.value) })}
                      />
                    </label>

                    <label className="flow-control flow-control--direction" htmlFor="terrain-uphill-direction">
                      <span>
                        Uphill direction
                        <output htmlFor="terrain-uphill-direction">
                          {config.terrainUphillDirectionDegrees.toFixed(0)}° · {compassLabel(config.terrainUphillDirectionDegrees)}
                        </output>
                      </span>
                      <span className="direction-slider">
                        <i aria-hidden="true" style={{ '--wind-heading': `${config.terrainUphillDirectionDegrees}deg` } as React.CSSProperties}>↑</i>
                        <input
                          id="terrain-uphill-direction"
                          type="range"
                          min={0}
                          max={355}
                          step={5}
                          disabled={config.terrainSlopeDegrees === 0}
                          value={config.terrainUphillDirectionDegrees}
                          aria-valuetext={`${config.terrainUphillDirectionDegrees.toFixed(0)} degrees, uphill ${compassLabel(config.terrainUphillDirectionDegrees)}`}
                          onChange={(event) => patchConfig({ terrainUphillDirectionDegrees: Number(event.target.value) })}
                        />
                      </span>
                    </label>

                    <div className="flow-control-grid terrain-control-grid">
                      <label className="flow-control" htmlFor="gas-buoyancy">
                        <span>Near-surface gas behavior</span>
                        <select
                          id="gas-buoyancy"
                          value={config.gasBuoyancy}
                          disabled={config.terrainSlopeDegrees === 0}
                          onChange={(event) => patchConfig({
                            gasBuoyancy: event.target.value as SimulationConfig['gasBuoyancy'],
                          })}
                        >
                          <option value="neutral">Neutral · ambient transport</option>
                          <option value="dense">Dense · downslope drainage</option>
                          <option value="light">Light · slope-coupled depletion</option>
                        </select>
                      </label>
                      <label className="flow-control" htmlFor="terrain-drift-scale">
                        <span>
                          Buoyancy coupling
                          <output htmlFor="terrain-drift-scale">
                            {config.terrainGasDriftScale.toFixed(1)}×
                            {config.gasBuoyancy === 'dense' && ` · ${(terrainDriftSpeed * 100).toFixed(2)}% domain/s`}
                          </output>
                        </span>
                        <input
                          id="terrain-drift-scale"
                          type="range"
                          min={0}
                          max={3}
                          step={0.1}
                          disabled={config.terrainSlopeDegrees === 0 || config.gasBuoyancy === 'neutral'}
                          value={config.terrainGasDriftScale}
                          aria-valuetext={`${config.terrainGasDriftScale.toFixed(1)} times reduced-order buoyancy coupling`}
                          onChange={(event) => patchConfig({ terrainGasDriftScale: Number(event.target.value) })}
                        />
                      </label>
                      <label className="flow-control" htmlFor="robot-slope-limit">
                        <span>
                          Robot reference grade
                          <output htmlFor="robot-slope-limit">{config.robotSlopeLimitDegrees.toFixed(0)}°</output>
                        </span>
                        <input
                          id="robot-slope-limit"
                          type="range"
                          min={10}
                          max={45}
                          step={1}
                          disabled={config.terrainSlopeDegrees === 0}
                          value={config.robotSlopeLimitDegrees}
                          aria-valuetext={`${config.robotSlopeLimitDegrees.toFixed(0)} degree reference grade`}
                          onChange={(event) => patchConfig({ robotSlopeLimitDegrees: Number(event.target.value) })}
                        />
                      </label>
                    </div>
                    <p id="terrain-controls-note">
                      Height remains implicit: this is a 2D plan view over one inclined plane. Nominal rise is {terrainRiseMeters.toFixed(config.domainMeters < 10 ? 2 : 1)} m across one domain. Dense gas receives a reduced-order downslope current; the light class adds a heuristic slope-coupled near-ground depletion term, not a general vertical-buoyancy law. Ambient wind sensing remains separate. Not 3D CFD or calibrated terramechanics.
                    </p>
                  </fieldset>
                  <details className="sensor-controls" open>
                    <summary>
                      <span><i>SENSOR MODEL</i><strong>Detection &amp; response</strong>{config.sensorProfileId === 'custom' && <b>Custom</b>}</span>
                      <small>{activeSensorProfile?.technology ?? `${(1 / config.fixedDt).toFixed(0)} Hz sampled`}</small>
                    </summary>
                    <div className="sensor-controls__toolbar">
                      <p>Commercial values are translated through a declared ppm-to-relative bridge; the plume itself remains dimensionless.</p>
                      <button type="button" disabled={sensorIsDefault} onClick={() => patchConfig(DEFAULT_SENSOR_CONTROLS)}>Restore normalized</button>
                    </div>
                    <div className="sensor-profile-picker">
                      <label htmlFor="sensor-profile">
                        <span>Technology preset</span>
                        <select
                          id="sensor-profile"
                          value={config.sensorProfileId}
                          onChange={(event) => {
                            const id = event.target.value as SimulationConfig['sensorProfileId']
                            if (id === 'normalized-reference') {
                              patchConfig(DEFAULT_SENSOR_CONTROLS)
                              return
                            }
                            if (id === 'custom') {
                              patchConfig({ sensorProfileId: 'custom' })
                              return
                            }
                            const profile = commercialSensorProfile(id)
                            if (profile) {
                              const compatibleScale = [100, 1_000, 10_000].find(
                                (scale) => profile.lowerLimitPpm / scale <= 2,
                              ) ?? 10_000
                              patchConfig(commercialSensorPatch(
                                profile,
                                Math.max(config.sensorPpmPerNormalizedUnit, compatibleScale),
                              ))
                            }
                          }}
                        >
                          <option value="normalized-reference">Normalized research reference</option>
                          {COMMERCIAL_SENSOR_PROFILES.map((profile) => (
                            <option key={profile.id} value={profile.id}>{profile.shortLabel}</option>
                          ))}
                          <option value="custom">Custom manual settings</option>
                        </select>
                      </label>
                      <label htmlFor="sensor-ppm-scale">
                        <span>Concentration bridge</span>
                        <select
                          id="sensor-ppm-scale"
                          value={config.sensorPpmPerNormalizedUnit}
                          onChange={(event) => {
                            const scale = Number(event.target.value)
                            const profile = commercialSensorProfile(config.sensorProfileId)
                            patchConfig(profile
                              ? commercialSensorPatch(profile, scale)
                              : { sensorPpmPerNormalizedUnit: scale })
                          }}
                        >
                          <option value={100} disabled={Boolean(activeSensorProfile && activeSensorProfile.lowerLimitPpm / 100 > 2)}>1 relative unit = 100 ppm</option>
                          <option value={1000} disabled={Boolean(activeSensorProfile && activeSensorProfile.lowerLimitPpm / 1_000 > 2)}>1 relative unit = 1,000 ppm</option>
                          <option value={10000}>1 relative unit = 10,000 ppm</option>
                        </select>
                      </label>
                    </div>
                    {activeSensorProfile && (
                      <div className="sensor-profile-card">
                        <div>
                          <span>Commercial anchor</span>
                          <strong>{activeSensorProfile.product}</strong>
                        </div>
                        <dl>
                          <div><dt>Sensitivity basis</dt><dd>{activeSensorProfile.lowerLimitLabel}</dd></div>
                          <div><dt>Dynamic response</dt><dd>{activeSensorProfile.responseLabel}</dd></div>
                          <div><dt>Native range</dt><dd>{activeSensorProfile.rangeLabel}</dd></div>
                          <div><dt>Applied threshold</dt><dd>{effectiveSensorThreshold.toPrecision(3)} rel · {(effectiveSensorThreshold * config.sensorPpmPerNormalizedUnit).toPrecision(3)} ppm</dd></div>
                          {activeSensorProfile.priceEvidence && <div><dt>Price evidence</dt><dd>{activeSensorProfile.priceEvidence}</dd></div>}
                        </dl>
                        <p>{activeSensorProfile.deploymentNote}</p>
                        <a href={activeSensorProfile.sourceUrl} target="_blank" rel="noreferrer">{activeSensorProfile.sourceLabel} ↗</a>
                        {activeSensorProfile.priceUrl && <a href={activeSensorProfile.priceUrl} target="_blank" rel="noreferrer">Retail price example ↗</a>}
                      </div>
                    )}
                    <div className="sensor-control-grid">
                      <label htmlFor="sensor-noise">Concentration noise σ<output htmlFor="sensor-noise">{config.sensorNoise < 0.001 ? config.sensorNoise.toExponential(1) : config.sensorNoise.toFixed(3)}</output>
                        <input id="sensor-noise" type="range" min={0} max={0.5} step={0.001} value={config.sensorNoise} aria-valuetext={`${config.sensorNoise.toPrecision(3)} normalized concentration`} onChange={(event) => patchConfig({ sensorNoise: Number(event.target.value), sensorProfileId: 'custom' })} />
                      </label>
                      <label htmlFor="sensor-lag">{sensorResponseControlLabel}<output htmlFor="sensor-lag">{sensorT90Seconds(config.sensorLag).toFixed(1)} s</output>
                        <input id="sensor-lag" type="range" min={0.05} max={15} step={0.05} value={config.sensorLag} aria-valuetext={`${sensorT90Seconds(config.sensorLag).toFixed(1)} seconds T90`} onChange={(event) => patchConfig({ sensorLag: Number(event.target.value), sensorProfileId: 'custom' })} />
                      </label>
                      <label htmlFor="sensor-threshold">Detection threshold<output htmlFor="sensor-threshold">{effectiveSensorThreshold.toFixed(3)}</output>
                        <input id="sensor-threshold" type="range" min={0.25} max={2.5} step={0.05} value={config.sensorThresholdScale} aria-valuetext={`${config.sensorThresholdScale.toFixed(2)} times the scenario threshold`} onChange={(event) => patchConfig({ sensorThresholdScale: Number(event.target.value) })} />
                      </label>
                      <label htmlFor="sensor-saturation">Saturation<output htmlFor="sensor-saturation">{config.sensorSaturation.toPrecision(3)}</output>
                        <input id="sensor-saturation" type="range" min={Math.max(0.001, effectiveSensorThreshold)} max={2} step={0.001} value={config.sensorSaturation} aria-valuetext={`${config.sensorSaturation.toPrecision(3)} normalized concentration`} onChange={(event) => patchConfig({ sensorSaturation: Number(event.target.value), sensorProfileId: 'custom' })} />
                      </label>
                      <label htmlFor="false-positive">False positive / sample<output htmlFor="false-positive">{(config.sensorFalsePositiveRate * 100).toFixed(0)}%</output>
                        <input id="false-positive" type="range" min={0} max={0.25} step={0.01} value={config.sensorFalsePositiveRate} aria-valuetext={`${(config.sensorFalsePositiveRate * 100).toFixed(0)} percent`} onChange={(event) => patchConfig({ sensorFalsePositiveRate: Number(event.target.value) })} />
                      </label>
                      <label htmlFor="false-negative">False negative / sample<output htmlFor="false-negative">{(config.sensorFalseNegativeRate * 100).toFixed(0)}%</output>
                        <input id="false-negative" type="range" min={0} max={0.25} step={0.01} value={config.sensorFalseNegativeRate} aria-valuetext={`${(config.sensorFalseNegativeRate * 100).toFixed(0)} percent`} onChange={(event) => patchConfig({ sensorFalseNegativeRate: Number(event.target.value) })} />
                      </label>
                      <label htmlFor="wind-noise">Wind direction noise<output htmlFor="wind-noise">{(config.windNoise * 180 / Math.PI).toFixed(1)}°</output>
                        <input id="wind-noise" type="range" min={0} max={0.25} step={0.01} value={config.windNoise} aria-valuetext={`${(config.windNoise * 180 / Math.PI).toFixed(1)} degrees`} onChange={(event) => patchConfig({ windNoise: Number(event.target.value) })} />
                      </label>
                    </div>
                    <div className="open-path-note">
                      <strong>Different observation class · {OPEN_PATH_TDLAS_PROFILE.product}</strong>
                      <span>{OPEN_PATH_TDLAS_PROFILE.sensitivity}; {OPEN_PATH_TDLAS_PROFILE.range}.</span>
                      <p>{OPEN_PATH_TDLAS_PROFILE.note}</p>
                      <a href={OPEN_PATH_TDLAS_PROFILE.sourceUrl} target="_blank" rel="noreferrer">Heath operating manual ↗</a>
                    </div>
                  </details>
                  {(usesActiveOlfaction || usesQuadArray) && (
                    <details className="sensor-controls active-sniff-controls" open>
                      <summary>
                        <span><i>{usesQuadPassive ? 'PASSIVE COMPARATOR' : 'ACTIVE OLFACTION'}</i><strong>{usesQuadPassive ? 'Four-sensor spatial array' : usesQuadSuction ? 'Four-channel suction array' : 'Pulse–return sampler'}</strong>{!usesQuadPassive && !activeSniffIsDefault && <b>Custom</b>}</span>
                        <small>{usesQuadPassive ? 'NO SUCTION' : !config.activeSniffEnabled ? 'OFF' : config.activeSniffStrength === 0 ? 'TIMING SHAM' : 'ENABLED'}</small>
                      </summary>
                      <div className="sensor-controls__toolbar">
                        <p>{usesQuadPassive
                          ? 'Four physical sensor heads integrate simultaneously at fixed body-frame offsets. The array uses no pump and receives no remote capture footprint.'
                          : usesQuadSuction
                          ? 'Four directional inlet/sensor channels aspirate simultaneously and average a time-aligned series before returning four filtered values.'
                          : 'A directional air-pulse proxy samples near-surface gas after settling and a delayed return.'}</p>
                        {!usesQuadPassive && <button type="button" disabled={activeSniffIsDefault} onClick={() => patchConfig(DEFAULT_ACTIVE_SNIFF_CONTROLS)}>Restore {usesQuadSuction ? 'array' : 'probe'}</button>}
                      </div>
                      {usesQuadPassive ? (
                        <div className="sensor-control-grid active-sniff-grid">
                          <p><strong>Fixed array radius</strong><br />1.25% of domain · {(0.0125 * config.domainMeters).toFixed(config.domainMeters < 10 ? 3 : 2)} m centre-to-head</p>
                          <p><strong>Matched controller</strong><br />Same plane fit, ray synthesis, movement, declaration score and abstention gate as Quad-Suction.</p>
                        </div>
                      ) : <div className="sensor-control-grid active-sniff-grid">
                        <label className="active-sniff-toggle" htmlFor="active-sniff-enabled">
                          <span><strong>{usesQuadSuction ? 'Active aspiration' : 'Active air pulses'}</strong><small>Disable for an off ablation; use zero strength for timing-matched sham.</small></span>
                          <input
                            id="active-sniff-enabled"
                            type="checkbox"
                            checked={config.activeSniffEnabled}
                            onChange={(event) => patchConfig({ activeSniffEnabled: event.target.checked })}
                          />
                        </label>
                        <label htmlFor="active-sniff-strength">{usesQuadSuction ? 'Collection strength' : 'Pulse strength'}<output htmlFor="active-sniff-strength">{(config.activeSniffStrength * 100).toFixed(0)}%</output>
                          <input id="active-sniff-strength" type="range" min={0} max={1} step={0.05} value={config.activeSniffStrength} disabled={!config.activeSniffEnabled} aria-valuetext={`${(config.activeSniffStrength * 100).toFixed(0)} percent active collection strength`} onChange={(event) => patchConfig({ activeSniffStrength: Number(event.target.value) })} />
                        </label>
                        <label htmlFor="active-sniff-reach">{usesQuadSuction ? 'Inlet capture reach' : 'Axial probe reach'}<output htmlFor="active-sniff-reach">{(config.activeSniffReach * 100).toFixed(1)}% · {(config.activeSniffReach * config.domainMeters).toFixed(config.domainMeters < 10 ? 2 : 1)} m surface</output>
                          <input id="active-sniff-reach" type="range" min={0.005} max={0.15} step={0.005} value={config.activeSniffReach} disabled={!config.activeSniffEnabled} aria-valuetext={`${(config.activeSniffReach * 100).toFixed(1)} percent of the domain`} onChange={(event) => patchConfig({ activeSniffReach: Number(event.target.value) })} />
                        </label>
                        <label htmlFor="active-sniff-cycle">{usesQuadSuction ? 'Aspiration cycle' : 'Pulse cycle'}<output htmlFor="active-sniff-cycle">{config.activeSniffCycleSeconds.toFixed(2)} s</output>
                          <input id="active-sniff-cycle" type="range" min={0.5} max={3} step={0.05} value={config.activeSniffCycleSeconds} disabled={!config.activeSniffEnabled} aria-valuetext={`${config.activeSniffCycleSeconds.toFixed(2)} seconds per ${usesQuadSuction ? 'aspiration integration' : 'active sample'}`} onChange={(event) => patchConfig({ activeSniffCycleSeconds: Number(event.target.value) })} />
                        </label>
                      </div>}
                      {usesQuadArray && (
                        <>
                          <div className="sensor-controls__toolbar">
                            <p><strong>Channel robustness stressors.</strong> These reduced-order terms test whether direction survives shared pump noise and unequal channels; they are not hardware calibration.</p>
                            <button type="button" disabled={quadNuisanceIsDefault} onClick={() => patchConfig(DEFAULT_QUAD_CHANNEL_NUISANCE_CONTROLS)}>Clear stressors</button>
                          </div>
                          <div className="sensor-control-grid active-sniff-grid">
                            <label htmlFor="quad-noise-correlation">Shared noise fraction<output htmlFor="quad-noise-correlation">{(config.quadChannelNoiseCorrelation * 100).toFixed(0)}%</output>
                              <input id="quad-noise-correlation" type="range" min={0} max={1} step={0.05} value={config.quadChannelNoiseCorrelation} aria-valuetext={`${(config.quadChannelNoiseCorrelation * 100).toFixed(0)} percent shared noise variance`} onChange={(event) => patchConfig({ quadChannelNoiseCorrelation: Number(event.target.value) })} />
                            </label>
                            <label htmlFor="quad-gain-mismatch">Gain mismatch<output htmlFor="quad-gain-mismatch">±{(config.quadChannelGainMismatch * 100).toFixed(0)}%</output>
                              <input id="quad-gain-mismatch" type="range" min={0} max={0.5} step={0.025} value={config.quadChannelGainMismatch} aria-valuetext={`${(config.quadChannelGainMismatch * 100).toFixed(0)} percent deterministic channel gain mismatch`} onChange={(event) => patchConfig({ quadChannelGainMismatch: Number(event.target.value) })} />
                            </label>
                            <label htmlFor="quad-crosstalk">Signal cross-talk<output htmlFor="quad-crosstalk">{(config.quadChannelCrossTalk * 100).toFixed(0)}%</output>
                              <input id="quad-crosstalk" type="range" min={0} max={1} step={0.05} value={config.quadChannelCrossTalk} aria-valuetext={`${(config.quadChannelCrossTalk * 100).toFixed(0)} percent mixing with channel common mode`} onChange={(event) => patchConfig({ quadChannelCrossTalk: Number(event.target.value) })} />
                            </label>
                            <label htmlFor="quad-lag-mismatch">Response-lag mismatch<output htmlFor="quad-lag-mismatch">±{(config.quadChannelLagMismatch * 100).toFixed(0)}%</output>
                              <input id="quad-lag-mismatch" type="range" min={0} max={0.9} step={0.05} value={config.quadChannelLagMismatch} aria-valuetext={`${(config.quadChannelLagMismatch * 100).toFixed(0)} percent deterministic response-lag mismatch`} onChange={(event) => patchConfig({ quadChannelLagMismatch: Number(event.target.value) })} />
                            </label>
                          </div>
                        </>
                      )}
                      <p className="active-sniff-caveat">{usesQuadPassive
                        ? 'Passive four-head sensor model—not a zero-strength sham. Spatial readings come from separate body-frame locations and incur no suction-energy proxy. Hardware calibration and resource matching remain required.'
                        : usesQuadSuction
                        ? 'Near-surface collection and surface-vent proxy—not porous-soil transport, pump/pressure CFD, or a flux chamber. Four channels cost four sensor returns and a dimensionless actuation-cost proxy. Compare against true off and zero-strength timing shams.'
                        : 'Near-surface sampling proxy—not a resolved jet CFD or deposited-odor model. Axial reach follows the terrain surface metric; the lateral fan remains a plan-view kernel. Use sham mode to isolate active probing.'}</p>
                    </details>
                  )}
                  <div className="form-grid">
                    <label>Display scale
                      <select value={config.domainMeters} onChange={(event) => patchConfig({ domainMeters: Number(event.target.value) })}>
                        <option value={1}>1 m</option>
                        <option value={10}>10 m</option>
                        <option value={100}>100 m</option>
                        <option value={1000}>1 km</option>
                      </select>
                    </label>
                    <label>Run budget
                      <select value={config.durationSeconds} onChange={(event) => patchConfig({ durationSeconds: Number(event.target.value) })}>
                        <option value={60}>60 s</option>
                        <option value={120}>120 s</option>
                        <option value={180}>180 s</option>
                        <option value={300}>300 s</option>
                      </select>
                    </label>
                    <label>Flow / layout seed
                      <span className="seed-input"><input type="number" min={1} max={999999} value={seedDraft} onChange={(event) => setSeedDraft(event.target.value)} onBlur={commitSeed} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /><button type="button" aria-label="Generate a new scenario seed" onClick={() => patchConfig({ seed: randomSeed() })} title="Generate a new seed">↻</button></span>
                    </label>
                    <label>Hidden-source seed
                      <span className="seed-input"><input type="number" min={1} max={9999999} disabled={config.targetStatus === 'absent'} value={sourceSeedDraft} onChange={(event) => setSourceSeedDraft(event.target.value)} onBlur={commitSourceSeed} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} /><button type="button" disabled={config.targetStatus === 'absent'} aria-label="Generate a new independent source seed" onClick={() => patchConfig({ sourceSeed: randomSeed() })} title="Generate an independent source seed">↻</button></span>
                    </label>
                  </div>
                  <div className="normalization-note">
                    <span>ε</span>
                    <p><strong>{config.targetStatus === 'absent' ? 'No-target safety endpoint' : 'Scale-independent success'}</strong>{config.targetStatus === 'absent'
                      ? 'Localization error is undefined. Report spurious-declaration probability, correct rejection, explicit abstention and decision time.'
                      : `Normalized error ≤ 0.01 = ${(config.domainMeters * 0.01).toFixed(config.domainMeters < 10 ? 2 : 1)} m tolerance here. Physics stays dimensionless; this selector converts display units only.`}</p>
                  </div>
                </section>

                <AlgorithmDetails algorithmId={config.algorithmId} decision={frame.decision} />
              </aside>
            </section>
          </>
        ) : (
          <ResearchPanel baseConfig={config} />
        )}

        <section className="methodology-strip">
          <div><span>01</span><p><strong>One atmosphere</strong>Seeded, time-indexed plume fields prevent algorithms from receiving easier random realizations.</p></div>
          <div><span>02</span><p><strong>Two declarations</strong>Native stopping explains behaviour; fixed checkpoints support fair comparisons.</p></div>
          <div><span>03</span><p><strong>No hidden oracle</strong>Controllers never receive source coordinates or unfiltered concentration truth.</p></div>
          <div><span>04</span><p><strong>Dimensionless core</strong>Positions and errors scale consistently from a 1 m bench to a 100 m site.</p></div>
        </section>
      </main>

      <footer>
        <span>PLUMENAV LAB · INTERACTIVE RESEARCH SIMULATOR</span>
        <p>Selectable puff and numerical-grid physics with explicit assumptions—not a substitute for CFD or field validation.</p>
        <button type="button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>Back to top ↑</button>
      </footer>
    </div>
  )
}
