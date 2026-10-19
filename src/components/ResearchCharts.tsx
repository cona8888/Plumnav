import { useId } from 'react'
import { ALGORITHM_METADATA, ALGORITHM_ORDER } from '../sim/algorithms/metadata'
import { percentile } from '../sim/math'
import type { AlgorithmId, BatchResult, GasBuoyancy, ScenarioKind, TargetStatus } from '../sim/types'

type ResearchChartsProps = {
  results: readonly BatchResult[]
}

export type ResearchChartPoint = {
  checkpointSeconds: number
  runs: number
  medianError: number
  errorQ1: number
  errorQ3: number
  successRate: number
  successLow: number
  successHigh: number
}

export type ResearchChartSeries = {
  algorithmId: AlgorithmId
  points: ResearchChartPoint[]
}

export type ResearchChartScenario = {
  scenarioKind: ScenarioKind
  targetStatus: TargetStatus
  obstacleComplexityLevel: number
  terrainSlopeDegrees: number
  terrainUphillDirectionDegrees: number
  gasBuoyancy: GasBuoyancy
  terrainGasDriftScale: number
  robotSlopeLimitDegrees: number
  series: ResearchChartSeries[]
}

type Metric = 'error' | 'success'

type PlotPoint = {
  checkpointSeconds: number
  runs: number
  value: number
  low: number
  high: number
}

const VIEW_WIDTH = 720
const VIEW_HEIGHT = 340
const MARGIN = { top: 24, right: 20, bottom: 58, left: 62 }
const PLOT_WIDTH = VIEW_WIDTH - MARGIN.left - MARGIN.right
const PLOT_HEIGHT = VIEW_HEIGHT - MARGIN.top - MARGIN.bottom

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

/** Two-sided Wilson score interval for a binomial proportion. */
export const wilsonScoreInterval = (
  successes: number,
  runs: number,
  z = 1.959963984540054,
): [number, number] => {
  if (runs <= 0) return [0, 0]
  const boundedSuccesses = clamp(successes, 0, runs)
  const proportion = boundedSuccesses / runs
  const zSquared = z * z
  const denominator = 1 + zSquared / runs
  const center = (proportion + zSquared / (2 * runs)) / denominator
  const margin =
    (z / denominator) *
    Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * runs)) / runs)
  return [clamp(center - margin, 0, 1), clamp(center + margin, 0, 1)]
}

export const aggregateResearchChartData = (
  results: readonly BatchResult[],
): ResearchChartScenario[] => {
  const grouped = new Map<string, BatchResult[]>()
  const stratumFor = (result: BatchResult) => {
    const obstacleComplexityLevel =
      result.scenarioKind === 'obstructed' ? result.config.obstacleComplexityLevel : 0
    const value = {
      scenarioKind: result.scenarioKind,
      targetStatus: result.config.targetStatus,
      obstacleComplexityLevel,
      terrainSlopeDegrees: result.config.terrainSlopeDegrees,
      terrainUphillDirectionDegrees: result.config.terrainUphillDirectionDegrees,
      gasBuoyancy: result.config.gasBuoyancy,
      terrainGasDriftScale: result.config.terrainGasDriftScale,
      robotSlopeLimitDegrees: result.config.robotSlopeLimitDegrees,
    }
    return {
      ...value,
      key: [
        value.scenarioKind,
        value.targetStatus,
        value.obstacleComplexityLevel,
        value.terrainSlopeDegrees,
        value.terrainUphillDirectionDegrees,
        value.gasBuoyancy,
        value.terrainGasDriftScale,
        value.robotSlopeLimitDegrees,
      ].join('|'),
    }
  }

  for (const result of results) {
    if (!Number.isFinite(result.checkpointSeconds) || result.checkpointSeconds < 0) continue
    if (!Number.isFinite(result.metrics.normalizedError)) continue
    const key = `${stratumFor(result).key}|${result.algorithmId}|${result.checkpointSeconds}`
    const group = grouped.get(key) ?? []
    group.push(result)
    grouped.set(key, group)
  }

  const scorableResults = results.filter((result) => result.metrics.normalizedError !== null)
  const strata = [...new Map(scorableResults.map((result) => {
    const stratum = stratumFor(result)
    return [stratum.key, stratum]
  })).values()].sort((a, b) => {
    const scenarioOrder = ['open', 'obstructed'].indexOf(a.scenarioKind) -
      ['open', 'obstructed'].indexOf(b.scenarioKind)
    return scenarioOrder ||
      a.targetStatus.localeCompare(b.targetStatus) ||
      a.obstacleComplexityLevel - b.obstacleComplexityLevel ||
      a.terrainSlopeDegrees - b.terrainSlopeDegrees ||
      a.terrainUphillDirectionDegrees - b.terrainUphillDirectionDegrees ||
      a.gasBuoyancy.localeCompare(b.gasBuoyancy) ||
      a.terrainGasDriftScale - b.terrainGasDriftScale ||
      a.robotSlopeLimitDegrees - b.robotSlopeLimitDegrees
  })

  return strata.map((stratum) => ({
    scenarioKind: stratum.scenarioKind,
    targetStatus: stratum.targetStatus,
    obstacleComplexityLevel: stratum.obstacleComplexityLevel,
    terrainSlopeDegrees: stratum.terrainSlopeDegrees,
    terrainUphillDirectionDegrees: stratum.terrainUphillDirectionDegrees,
    gasBuoyancy: stratum.gasBuoyancy,
    terrainGasDriftScale: stratum.terrainGasDriftScale,
    robotSlopeLimitDegrees: stratum.robotSlopeLimitDegrees,
    series: ALGORITHM_ORDER.flatMap((algorithmId) => {
      const points = [...grouped.entries()]
        .filter(([key]) => key.startsWith(
          `${stratum.key}|${algorithmId}|`,
        ))
        .map(([, group]) => {
          const first = group[0]
          if (!first) return null
          const errors = group.flatMap((result) =>
            result.metrics.normalizedError === null ? [] : [result.metrics.normalizedError],
          )
          const successes = group.filter((result) => result.metrics.success).length
          const [successLow, successHigh] = wilsonScoreInterval(successes, group.length)
          return {
            checkpointSeconds: first.checkpointSeconds,
            runs: group.length,
            medianError: percentile(errors, 0.5),
            errorQ1: percentile(errors, 0.25),
            errorQ3: percentile(errors, 0.75),
            successRate: successes / group.length,
            successLow,
            successHigh,
          } satisfies ResearchChartPoint
        })
        .filter((point): point is ResearchChartPoint => point !== null)
        .sort((a, b) => a.checkpointSeconds - b.checkpointSeconds)

      return points.length > 0 ? [{ algorithmId, points }] : []
    }),
  }))
}

const niceCeiling = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return 0.02
  const padded = Math.max(value * 1.08, 0.02)
  const magnitude = 10 ** Math.floor(Math.log10(padded))
  const normalized = padded / magnitude
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return factor * magnitude
}

const formatPercent = (value: number) => {
  const percent = value * 100
  if (percent === 0 || percent >= 10) return `${percent.toFixed(0)}%`
  return `${percent.toFixed(1)}%`
}

const linePath = (
  points: readonly PlotPoint[],
  x: (value: number) => number,
  y: (value: number) => number,
) => points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(point.checkpointSeconds)} ${y(point.value)}`).join(' ')

const bandPath = (
  points: readonly PlotPoint[],
  x: (value: number) => number,
  y: (value: number) => number,
) => {
  if (points.length === 0) return ''
  const upper = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(point.checkpointSeconds)} ${y(point.high)}`).join(' ')
  const lower = [...points].reverse().map((point) => `L ${x(point.checkpointSeconds)} ${y(point.low)}`).join(' ')
  return `${upper} ${lower} Z`
}

const toPlotPoints = (series: ResearchChartSeries, metric: Metric): PlotPoint[] =>
  series.points.map((point) => ({
    checkpointSeconds: point.checkpointSeconds,
    runs: point.runs,
    value: metric === 'error' ? point.medianError : point.successRate,
    low: metric === 'error' ? point.errorQ1 : point.successLow,
    high: metric === 'error' ? point.errorQ3 : point.successHigh,
  }))

function MetricChart({
  metric,
  scenario,
}: {
  metric: Metric
  scenario: ResearchChartScenario
}) {
  const id = useId().replace(/:/g, '')
  const titleId = `research-chart-title-${id}`
  const descriptionId = `research-chart-description-${id}`
  const allPoints = scenario.series.flatMap((series) => toPlotPoints(series, metric))
  const checkpoints = [...new Set(allPoints.map((point) => point.checkpointSeconds))].sort((a, b) => a - b)
  const maxCheckpoint = Math.max(...checkpoints, 1)
  const yMax = metric === 'success'
    ? 1
    : niceCeiling(Math.max(...allPoints.map((point) => point.high), 0.01))
  const yTicks = Array.from({ length: 5 }, (_, index) => (yMax * index) / 4)
  const x = (value: number) => MARGIN.left + (value / maxCheckpoint) * PLOT_WIDTH
  const y = (value: number) => MARGIN.top + PLOT_HEIGHT - (clamp(value, 0, yMax) / yMax) * PLOT_HEIGHT
  const metricTitle = metric === 'error' ? 'Localization error over time' : 'Success rate over time'
  const scenarioTitle = scenario.scenarioKind === 'obstructed'
    ? `${scenario.scenarioKind} L${scenario.obstacleComplexityLevel}, ${scenario.targetStatus}`
    : `${scenario.scenarioKind}, ${scenario.targetStatus}`
  const terrainTitle = scenario.terrainSlopeDegrees > 0
    ? `${scenarioTitle}, ${scenario.terrainSlopeDegrees}° uphill ${scenario.terrainUphillDirectionDegrees}°, ${scenario.gasBuoyancy}, coupling ${scenario.terrainGasDriftScale}, robot reference grade ${scenario.robotSlopeLimitDegrees}°`
    : `${scenarioTitle}, flat, robot reference grade ${scenario.robotSlopeLimitDegrees}° inactive`
  const intervalDescription = metric === 'error'
    ? 'Lines show median normalized error and shaded regions show the interquartile range.'
    : 'Lines show observed success rate and shaded regions show a two-sided Wilson 95 percent interval.'

  return (
    <article className="research-charts__card">
      <header className="research-charts__card-header">
        <div>
          <span>{metric === 'error' ? 'ACCURACY' : 'RELIABILITY'}</span>
          <h4>{metricTitle}</h4>
        </div>
        <small>{metric === 'error' ? 'Median + IQR' : 'Rate + Wilson 95% interval'}</small>
      </header>

      <svg
        className="research-charts__svg"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <title id={titleId}>{metricTitle}, {terrainTitle} scenario</title>
        <desc id={descriptionId}>{intervalDescription} Results are grouped by algorithm and checkpoint.</desc>

        {yTicks.map((tick) => (
          <g key={`y-${tick}`} aria-hidden="true">
            <line
              className="research-charts__grid-line"
              x1={MARGIN.left}
              y1={y(tick)}
              x2={VIEW_WIDTH - MARGIN.right}
              y2={y(tick)}
            />
            <text className="research-charts__axis-text" x={MARGIN.left - 10} y={y(tick) + 4} textAnchor="end">
              {formatPercent(tick)}
            </text>
          </g>
        ))}

        {checkpoints.map((checkpoint) => (
          <g key={`x-${checkpoint}`} aria-hidden="true">
            <line
              className="research-charts__tick-line"
              x1={x(checkpoint)}
              y1={MARGIN.top + PLOT_HEIGHT}
              x2={x(checkpoint)}
              y2={MARGIN.top + PLOT_HEIGHT + 6}
            />
            <text className="research-charts__axis-text" x={x(checkpoint)} y={MARGIN.top + PLOT_HEIGHT + 24} textAnchor="middle">
              {checkpoint}s
            </text>
          </g>
        ))}

        <line
          className="research-charts__axis-line"
          x1={MARGIN.left}
          y1={MARGIN.top}
          x2={MARGIN.left}
          y2={MARGIN.top + PLOT_HEIGHT}
          aria-hidden="true"
        />
        <line
          className="research-charts__axis-line"
          x1={MARGIN.left}
          y1={MARGIN.top + PLOT_HEIGHT}
          x2={VIEW_WIDTH - MARGIN.right}
          y2={MARGIN.top + PLOT_HEIGHT}
          aria-hidden="true"
        />

        {metric === 'error' && yMax >= 0.01 && (
          <g aria-hidden="true">
            <line
              className="research-charts__target-line"
              x1={MARGIN.left}
              y1={y(0.01)}
              x2={VIEW_WIDTH - MARGIN.right}
              y2={y(0.01)}
            />
            <text className="research-charts__target-text" x={VIEW_WIDTH - MARGIN.right - 4} y={y(0.01) - 7} textAnchor="end">
              1% success target
            </text>
          </g>
        )}

        {scenario.series.map((series) => {
          const points = toPlotPoints(series, metric)
          const metadata = ALGORITHM_METADATA[series.algorithmId]
          const bandPoints = metric === 'error' ? points.filter((point) => point.runs >= 3) : points
          return (
            <g key={series.algorithmId}>
              {bandPoints.length > 0 && (
                <path
                  d={bandPath(bandPoints, x, y)}
                  fill={metadata.color}
                  fillOpacity={0.1}
                  stroke="none"
                  aria-hidden="true"
                />
              )}
              <path
                d={linePath(points, x, y)}
                fill="none"
                stroke={metadata.color}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                aria-hidden="true"
              />
              {points.map((point) => (
                <circle
                  key={point.checkpointSeconds}
                  cx={x(point.checkpointSeconds)}
                  cy={y(point.value)}
                  r={4}
                  fill="#09110f"
                  stroke={metadata.color}
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                >
                  <title>
                    {metadata.shortName}, {point.checkpointSeconds} seconds: {formatPercent(point.value)}; interval {formatPercent(point.low)} to {formatPercent(point.high)}; n={point.runs}
                  </title>
                </circle>
              ))}
            </g>
          )
        })}

        <text className="research-charts__axis-label" x={MARGIN.left + PLOT_WIDTH / 2} y={VIEW_HEIGHT - 8} textAnchor="middle">
          Simulation time
        </text>
        <text
          className="research-charts__axis-label"
          x={15}
          y={MARGIN.top + PLOT_HEIGHT / 2}
          textAnchor="middle"
          transform={`rotate(-90 15 ${MARGIN.top + PLOT_HEIGHT / 2})`}
        >
          {metric === 'error' ? 'Normalized error' : 'Successful runs'}
        </text>
      </svg>

      <table className="research-charts__sr-only">
        <caption>{metricTitle}, {terrainTitle} scenario</caption>
        <thead>
          <tr><th>Algorithm</th><th>Time</th><th>Estimate</th><th>Interval low</th><th>Interval high</th><th>Runs</th></tr>
        </thead>
        <tbody>
          {scenario.series.flatMap((series) =>
            toPlotPoints(series, metric).map((point) => (
              <tr key={`${series.algorithmId}-${point.checkpointSeconds}`}>
                <th>{ALGORITHM_METADATA[series.algorithmId].shortName}</th>
                <td>{point.checkpointSeconds} seconds</td>
                <td>{formatPercent(point.value)}</td>
                <td>{formatPercent(point.low)}</td>
                <td>{formatPercent(point.high)}</td>
                <td>{point.runs}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </article>
  )
}

const COMPONENT_STYLES = `
  .research-charts { margin-top: 22px; }
  .research-charts__heading { display: flex; align-items: end; justify-content: space-between; gap: 20px; margin-bottom: 18px; }
  .research-charts__heading span, .research-charts__card-header span { color: #2dd4bf; font: 700 9px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .16em; }
  .research-charts__heading h3 { margin: 7px 0 0; color: #e8f0ec; font-size: clamp(18px, 2vw, 24px); }
  .research-charts__heading p { max-width: 520px; margin: 0; color: #8b9d95; font-size: 12px; line-height: 1.55; }
  .research-charts__scenario { margin-top: 20px; }
  .research-charts__scenario-title { display: flex; align-items: center; gap: 10px; margin: 0 0 10px; color: #d8e4de; font-size: 13px; text-transform: capitalize; }
  .research-charts__scenario-title::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: #2dd4bf; box-shadow: 0 0 12px rgba(45, 212, 191, .45); }
  .research-charts__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .research-charts__card { min-width: 0; overflow: hidden; border: 1px solid rgba(148, 163, 184, .15); border-radius: 12px; background: #0a1210; }
  .research-charts__card-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 15px 17px 4px; }
  .research-charts__card-header h4 { margin: 5px 0 0; color: #e8f0ec; font-size: 13px; }
  .research-charts__card-header small { color: #8b9d95; font: 600 9px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; text-align: right; }
  .research-charts__svg { display: block; width: 100%; height: auto; }
  .research-charts__grid-line { stroke: rgba(148, 163, 184, .12); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .research-charts__tick-line, .research-charts__axis-line { stroke: rgba(148, 163, 184, .28); stroke-width: 1; vector-effect: non-scaling-stroke; }
  .research-charts__axis-text { fill: #82938c; font: 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .research-charts__axis-label { fill: #a8b8b1; font: 600 10px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .04em; }
  .research-charts__target-line { stroke: #4ade80; stroke-width: 1; stroke-dasharray: 5 5; vector-effect: non-scaling-stroke; opacity: .7; }
  .research-charts__target-text { fill: #86efac; font: 9px ui-monospace, SFMono-Regular, Menlo, monospace; }
  .research-charts__legend { display: flex; flex-wrap: wrap; gap: 8px 15px; margin: 14px 0 0; padding: 0; list-style: none; }
  .research-charts__legend li { display: inline-flex; align-items: center; gap: 7px; color: #a8b8b1; font-size: 10px; }
  .research-charts__legend i { width: 15px; height: 2px; background: var(--series-color); box-shadow: 0 0 5px var(--series-color); }
  .research-charts__method-note { margin: 13px 0 0; color: #75877f; font-size: 10px; line-height: 1.5; }
  .research-charts__sr-only { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
  @media (max-width: 900px) {
    .research-charts__grid { grid-template-columns: 1fr; }
    .research-charts__heading { align-items: start; flex-direction: column; }
  }
  @media (max-width: 520px) {
    .research-charts__card-header { align-items: start; flex-direction: column; }
    .research-charts__card-header small { text-align: left; }
  }
`

export function ResearchCharts({ results }: ResearchChartsProps) {
  const componentId = useId().replace(/:/g, '')
  const headingId = `research-charts-heading-${componentId}`
  const scenarios = aggregateResearchChartData(results)
  if (scenarios.length === 0) return null

  const algorithms = ALGORITHM_ORDER.filter((algorithmId) =>
    scenarios.some((scenario) => scenario.series.some((series) => series.algorithmId === algorithmId)),
  )

  return (
    <section className="research-charts" aria-labelledby={headingId}>
      <style>{COMPONENT_STYLES}</style>
      <div className="research-charts__heading">
        <div>
          <span>TIME-RESOLVED PERFORMANCE</span>
          <h3 id={headingId}>See how each method converges.</h3>
        </div>
        <p>
          Shaded regions expose variation across seeded plume realizations instead of presenting a single run as representative.
        </p>
      </div>

      <ul className="research-charts__legend" aria-label="Algorithm legend">
        {algorithms.map((algorithmId) => (
          <li key={algorithmId}>
            <i style={{ '--series-color': ALGORITHM_METADATA[algorithmId].color } as React.CSSProperties} aria-hidden="true" />
            {ALGORITHM_METADATA[algorithmId].shortName}
          </li>
        ))}
      </ul>

      {scenarios.map((scenario) => (
        <section
          className="research-charts__scenario"
          key={`${scenario.scenarioKind}-${scenario.targetStatus}-${scenario.obstacleComplexityLevel}-${scenario.terrainSlopeDegrees}-${scenario.terrainUphillDirectionDegrees}-${scenario.gasBuoyancy}-${scenario.terrainGasDriftScale}-${scenario.robotSlopeLimitDegrees}`}
          aria-labelledby={`${headingId}-${scenario.scenarioKind}-${scenario.targetStatus}-${scenario.obstacleComplexityLevel}-${scenario.terrainSlopeDegrees}-${scenario.terrainUphillDirectionDegrees}-${scenario.gasBuoyancy}-${scenario.terrainGasDriftScale}-${scenario.robotSlopeLimitDegrees}`}
        >
          <h4 className="research-charts__scenario-title" id={`${headingId}-${scenario.scenarioKind}-${scenario.targetStatus}-${scenario.obstacleComplexityLevel}-${scenario.terrainSlopeDegrees}-${scenario.terrainUphillDirectionDegrees}-${scenario.gasBuoyancy}-${scenario.terrainGasDriftScale}-${scenario.robotSlopeLimitDegrees}`}>
            {scenario.scenarioKind} scenario · {scenario.targetStatus}
            {scenario.scenarioKind === 'obstructed' && ` · complexity L${scenario.obstacleComplexityLevel}`}
            {scenario.terrainSlopeDegrees > 0
              ? ` · ${scenario.terrainSlopeDegrees}° slope · uphill ${scenario.terrainUphillDirectionDegrees}° · ${scenario.gasBuoyancy} gas · coupling ${scenario.terrainGasDriftScale}× · robot ref ${scenario.robotSlopeLimitDegrees}°`
              : ` · flat · robot ref ${scenario.robotSlopeLimitDegrees}° inactive`}
          </h4>
          <div className="research-charts__grid">
            <MetricChart metric="error" scenario={scenario} />
            <MetricChart metric="success" scenario={scenario} />
          </div>
        </section>
      ))}

      <p className="research-charts__method-note">
        Error bands are descriptive interquartile ranges and appear when n≥3. Success bands are two-sided Wilson 95% intervals for the observed binomial rate. Seed identities remain paired across algorithms.
      </p>
    </section>
  )
}
