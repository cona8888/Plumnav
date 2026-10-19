import { ALGORITHM_METADATA } from '../sim/algorithms/metadata'
import type { AlgorithmId, AlgorithmDecision } from '../sim/types'

type AlgorithmDetailsProps = {
  algorithmId: AlgorithmId
  decision: AlgorithmDecision
}

export function AlgorithmDetails({ algorithmId, decision }: AlgorithmDetailsProps) {
  const algorithm = ALGORITHM_METADATA[algorithmId]
  return (
    <section className="method-card">
      <div className="method-card__header">
        <span className="eyebrow">METHOD NOTE · {algorithm.index}</span>
        <span className="family-pill">{algorithm.family}</span>
      </div>
      <h2>{algorithm.name}</h2>
      <p className="method-card__summary">{algorithm.summary}</p>

      <div className="method-state">
        <div>
          <span>Live state</span>
          <strong>{decision.phase}</strong>
        </div>
        <span className="sr-only">Convergence score</span>
        <div className="confidence-gauge" role="meter" aria-label="Algorithm convergence score" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(decision.confidence * 100)}>
          <i style={{ width: `${Math.round(decision.confidence * 100)}%`, background: algorithm.color }} />
        </div>
        <b>{Math.round(decision.confidence * 100)}%</b>
      </div>

      <p className="method-card__principle">{algorithm.principle}</p>
      <div className="method-grid">
        <div>
          <h3>Sensor inputs</h3>
          <ul>
            {algorithm.sensors.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
        <div>
          <h3>Core assumptions</h3>
          <ul>
            {algorithm.assumptions.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      </div>
      <details>
        <summary>Strengths, limits & provenance</summary>
        <div className="method-grid method-grid--details">
          <div>
            <h3>Strengths</h3>
            <ul>{algorithm.strengths.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
          <div>
            <h3>Limitations</h3>
            <ul>{algorithm.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
          </div>
        </div>
        <a href={algorithm.citationUrl} target="_blank" rel="noreferrer" className="citation-link">
          Reference / prior art · {algorithm.citationLabel} ↗
        </a>
      </details>
    </section>
  )
}
