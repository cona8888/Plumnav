import type { SimulationFrame } from '../sim/types'

type ReplayTimelineProps = {
  history: readonly SimulationFrame[]
  selectedIndex: number | null
  liveTime: number
  onSelect: (index: number) => void
  onLive: () => void
}

const formatReplayTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds - minutes * 60
  return minutes > 0
    ? `${minutes}:${remainder.toFixed(1).padStart(4, '0')}`
    : `${remainder.toFixed(1)}s`
}

export function ReplayTimeline({
  history,
  selectedIndex,
  liveTime,
  onSelect,
  onLive,
}: ReplayTimelineProps) {
  const lastIndex = Math.max(0, history.length - 1)
  const value = selectedIndex ?? lastIndex
  const selectedTime = selectedIndex === null
    ? liveTime
    : (history[selectedIndex]?.time ?? liveTime)

  return (
    <div className="replay-timeline" aria-label="Run replay timeline">
      <span className="replay-timeline__label">
        <i>RUN REPLAY</i>
        <strong>{selectedIndex === null ? 'Live frame' : 'Reviewing history'}</strong>
      </span>
      <input
        type="range"
        min={0}
        max={lastIndex}
        step={1}
        value={value}
        disabled={history.length <= 1}
        aria-label="Replay time"
        aria-valuetext={formatReplayTime(selectedTime)}
        onChange={(event) => onSelect(Number(event.target.value))}
      />
      <output aria-live="polite">{formatReplayTime(selectedTime)}</output>
      <button
        type="button"
        className={selectedIndex === null ? 'active' : ''}
        disabled={selectedIndex === null}
        onClick={onLive}
      >
        LIVE
      </button>
    </div>
  )
}
