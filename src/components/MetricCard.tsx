import type { ReactNode } from 'react'

type MetricCardProps = {
  label: string
  value: string
  detail: string
  icon?: ReactNode
  tone?: 'neutral' | 'good' | 'warn' | 'accent'
}

export function MetricCard({ label, value, detail, icon, tone = 'neutral' }: MetricCardProps) {
  return (
    <div className={`metric-card metric-card--${tone}`}>
      <div className="metric-card__top">
        <span>{label}</span>
        {icon && <span className="metric-card__icon">{icon}</span>}
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  )
}
