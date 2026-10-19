import { useEffect, useId, useRef, useState } from 'react'
import { estimateQuadGradient } from '../sim/algorithms/quadSoilSniff'
import type { PlumeModel } from '../sim/plume'
import { terrainGasDrift, terrainUphillUnit } from '../sim/terrain'
import type { SimulationFrame, Vec2 } from '../sim/types'

type CanvasLayers = {
  terrain: boolean
  plume: boolean
  wind: boolean
  belief: boolean
  samples: boolean
  groundTruth: boolean
}

type SimulationCanvasProps = {
  frame: SimulationFrame
  plume: PlumeModel
  layers: CanvasLayers
  accent: string
}

const mix = (start: [number, number, number], end: [number, number, number], amount: number) => {
  const value = Math.max(0, Math.min(1, amount))
  return start.map((channel, index) => Math.round(channel + ((end[index] ?? channel) - channel) * value)) as [
    number,
    number,
    number,
  ]
}

const heatColor = (value: number, alphaScale = 1) => {
  const normalized = Math.max(0, Math.min(1, value))
  const low: [number, number, number] = [13, 34, 38]
  const middle: [number, number, number] = [21, 128, 114]
  const high: [number, number, number] = [250, 204, 21]
  const color = normalized < 0.55 ? mix(low, middle, normalized / 0.55) : mix(middle, high, (normalized - 0.55) / 0.45)
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${Math.min(0.78, normalized * 0.72 * alphaScale)})`
}

const beliefColor = (palette: string, value: number) => {
  if (palette === 'hit-map') return `rgba(45, 212, 191, ${value * 0.48})`
  if (palette === 'information') return `rgba(56, 189, 248, ${value * 0.5})`
  return `rgba(192, 132, 252, ${value * 0.5})`
}

const activeSniffPhaseLabel = {
  exhale: 'AIR PULSE',
  settle: 'SETTLING / BLANKED',
  return: 'RETURN SAMPLE',
} as const

export function SimulationCanvas({ frame, plume, layers, accent }: SimulationCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const descriptionId = useId()
  const [size, setSize] = useState({ width: 900, height: 620 })
  const plumeMass = plume.totalMassAt?.(frame.time)

  useEffect(() => {
    const element = wrapRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const width = Math.max(280, Math.floor(entry.contentRect.width))
      const minimumHeight = width < 520 ? 300 : 390
      setSize({ width, height: Math.max(minimumHeight, Math.min(650, width * 0.66)) })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const deviceScale = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size.width * deviceScale)
    canvas.height = Math.round(size.height * deviceScale)
    canvas.style.width = `${size.width}px`
    canvas.style.height = `${size.height}px`
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(deviceScale, 0, 0, deviceScale, 0, 0)

    const outerPadding = { left: 42, right: 20, top: 20, bottom: 38 }
    const availableWidth = size.width - outerPadding.left - outerPadding.right
    const availableHeight = size.height - outerPadding.top - outerPadding.bottom
    // The simulated domain is a unit square. Preserve one visual scale for x
    // and y so paths, compass directions, distances, and terrain contours are
    // not distorted by the responsive canvas aspect ratio.
    const plotSide = Math.min(availableWidth, availableHeight)
    const padding = {
      left: outerPadding.left + (availableWidth - plotSide) / 2,
      right: outerPadding.right + (availableWidth - plotSide) / 2,
      top: outerPadding.top + (availableHeight - plotSide) / 2,
      bottom: outerPadding.bottom + (availableHeight - plotSide) / 2,
    }
    const plotWidth = plotSide
    const plotHeight = plotSide
    const map = (point: Vec2) => ({
      x: padding.left + point.x * plotWidth,
      y: padding.top + point.y * plotHeight,
    })

    const background = context.createLinearGradient(0, 0, size.width, size.height)
    background.addColorStop(0, '#091412')
    background.addColorStop(1, '#050a0a')
    context.fillStyle = background
    context.fillRect(0, 0, size.width, size.height)

    context.save()
    context.beginPath()
    context.rect(padding.left, padding.top, plotWidth, plotHeight)
    context.clip()

    if (layers.terrain && frame.scenario.terrainSlopeDegrees > 0) {
      const uphill = terrainUphillUnit(frame.scenario.terrainUphillDirectionDegrees)
      const contourDirection = { x: -uphill.y, y: uphill.x }
      const downhillPoint = map({ x: 0.5 - uphill.x * 0.75, y: 0.5 - uphill.y * 0.75 })
      const uphillPoint = map({ x: 0.5 + uphill.x * 0.75, y: 0.5 + uphill.y * 0.75 })
      const terrainShade = context.createLinearGradient(
        downhillPoint.x,
        downhillPoint.y,
        uphillPoint.x,
        uphillPoint.y,
      )
      terrainShade.addColorStop(0, 'rgba(14, 116, 144, 0.08)')
      terrainShade.addColorStop(0.5, 'rgba(148, 163, 184, 0.015)')
      terrainShade.addColorStop(1, 'rgba(245, 158, 11, 0.10)')
      context.fillStyle = terrainShade
      context.fillRect(padding.left, padding.top, plotWidth, plotHeight)

      context.lineWidth = 1
      context.strokeStyle = 'rgba(251, 191, 36, 0.15)'
      for (let offset = -1.2; offset <= 1.2; offset += 0.12) {
        const center = {
          x: 0.5 + uphill.x * offset,
          y: 0.5 + uphill.y * offset,
        }
        const start = map({
          x: center.x - contourDirection.x * 1.5,
          y: center.y - contourDirection.y * 1.5,
        })
        const end = map({
          x: center.x + contourDirection.x * 1.5,
          y: center.y + contourDirection.y * 1.5,
        })
        context.beginPath()
        context.moveTo(start.x, start.y)
        context.lineTo(end.x, end.y)
        context.stroke()
      }

      const arrowOrigin = map({ x: 0.12, y: 0.86 })
      const mappedUphill = {
        x: uphill.x * plotWidth,
        y: uphill.y * plotHeight,
      }
      const mappedUphillLength = Math.max(1e-9, Math.hypot(mappedUphill.x, mappedUphill.y))
      const arrowLength = 34
      const arrowEnd = {
        x: arrowOrigin.x + mappedUphill.x / mappedUphillLength * arrowLength,
        y: arrowOrigin.y + mappedUphill.y / mappedUphillLength * arrowLength,
      }
      context.strokeStyle = 'rgba(251, 191, 36, 0.9)'
      context.fillStyle = 'rgba(253, 230, 138, 0.95)'
      context.lineWidth = 2
      context.beginPath()
      context.moveTo(arrowOrigin.x, arrowOrigin.y)
      context.lineTo(arrowEnd.x, arrowEnd.y)
      context.stroke()
      const arrowAngle = Math.atan2(arrowEnd.y - arrowOrigin.y, arrowEnd.x - arrowOrigin.x)
      context.beginPath()
      context.moveTo(arrowEnd.x, arrowEnd.y)
      context.lineTo(
        arrowEnd.x - Math.cos(arrowAngle - 0.55) * 7,
        arrowEnd.y - Math.sin(arrowAngle - 0.55) * 7,
      )
      context.lineTo(
        arrowEnd.x - Math.cos(arrowAngle + 0.55) * 7,
        arrowEnd.y - Math.sin(arrowAngle + 0.55) * 7,
      )
      context.closePath()
      context.fill()
      context.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace'
      context.fillText(
        `UPHILL ${frame.scenario.terrainSlopeDegrees.toFixed(0)}°`,
        arrowOrigin.x,
        arrowOrigin.y + 16,
      )

      const gasDrift = terrainGasDrift(frame.scenario)
      const gasDriftMagnitude = Math.hypot(gasDrift.x, gasDrift.y)
      if (gasDriftMagnitude > 0) {
        const driftOrigin = map({ x: 0.78, y: 0.86 })
        const mappedDrift = {
          x: gasDrift.x * plotWidth,
          y: gasDrift.y * plotHeight,
        }
        const mappedDriftLength = Math.max(1e-9, Math.hypot(mappedDrift.x, mappedDrift.y))
        const driftEnd = {
          x: driftOrigin.x + mappedDrift.x / mappedDriftLength * 30,
          y: driftOrigin.y + mappedDrift.y / mappedDriftLength * 30,
        }
        context.setLineDash([4, 3])
        context.strokeStyle = 'rgba(249, 115, 22, 0.95)'
        context.lineWidth = 2
        context.beginPath()
        context.moveTo(driftOrigin.x, driftOrigin.y)
        context.lineTo(driftEnd.x, driftEnd.y)
        context.stroke()
        context.setLineDash([])
        context.fillStyle = 'rgba(254, 215, 170, 0.95)'
        context.fillText('DENSE-GAS DRIFT', driftOrigin.x, driftOrigin.y + 16)
      } else if (frame.scenario.gasBuoyancy === 'light') {
        const escape = map({ x: 0.78, y: 0.86 })
        context.fillStyle = 'rgba(186, 230, 253, 0.9)'
        context.fillText('LIGHT GAS: SLOPE LOSS', escape.x, escape.y + 16)
      }
    }

    context.strokeStyle = 'rgba(148, 163, 184, 0.075)'
    context.lineWidth = 1
    for (let index = 0; index <= 10; index += 1) {
      const x = padding.left + (plotWidth * index) / 10
      const y = padding.top + (plotHeight * index) / 10
      context.beginPath()
      context.moveTo(x, padding.top)
      context.lineTo(x, padding.top + plotHeight)
      context.stroke()
      context.beginPath()
      context.moveTo(padding.left, y)
      context.lineTo(padding.left + plotWidth, y)
      context.stroke()
    }

    if (layers.plume) {
      const preparedGrid = plume.gridAt?.(frame.time)
      const columns = preparedGrid?.width ?? Math.max(32, Math.round(size.width / 18))
      const rows = preparedGrid?.height ?? Math.max(22, Math.round(size.height / 18))
      const puffs = plume.puffsAt(frame.time)
      const cellWidth = plotWidth / columns
      const cellHeight = plotHeight / rows
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < columns; x += 1) {
          const gridIndex = y * columns + x
          const value = preparedGrid
            ? (preparedGrid.values[gridIndex] ?? 0)
            : plume.concentrationAt(
                { x: (x + 0.5) / columns, y: (y + 0.5) / rows },
                frame.time,
                puffs,
              )
          if (value < 0.015) continue
          context.fillStyle = heatColor(value)
          context.fillRect(
            padding.left + x * cellWidth - 0.5,
            padding.top + y * cellHeight - 0.5,
            cellWidth + 1,
            cellHeight + 1,
          )
        }
      }

      for (const puff of puffs.filter((_, index) => index % 2 === 0)) {
        if (puff.position.x < 0 || puff.position.x > 1 || puff.position.y < 0 || puff.position.y > 1) continue
        const point = map(puff.position)
        context.beginPath()
        context.arc(point.x, point.y, Math.max(1.2, puff.sigma * plotWidth * 0.12), 0, Math.PI * 2)
        context.fillStyle = `rgba(167, 243, 208, ${Math.min(0.45, puff.intensity * 0.2)})`
        context.fill()
      }
    }

    const debugGrid = frame.decision.debug?.grid
    if (layers.belief && debugGrid) {
      const cellWidth = plotWidth / debugGrid.width
      const cellHeight = plotHeight / debugGrid.height
      for (let index = 0; index < debugGrid.values.length; index += 1) {
        const value = debugGrid.values[index] ?? 0
        if (value < 0.012) continue
        const x = index % debugGrid.width
        const y = Math.floor(index / debugGrid.width)
        context.fillStyle = beliefColor(debugGrid.palette, value)
        context.fillRect(
          padding.left + x * cellWidth,
          padding.top + y * cellHeight,
          cellWidth + 0.6,
          cellHeight + 0.6,
        )
      }
    }

    if (layers.wind) {
      context.lineWidth = 1
      for (let y = 0.1; y < 1; y += 0.19) {
        for (let x = 0.09; x < 1; x += 0.16) {
          if (frame.scenario.obstacles.some((obstacle) => x >= obstacle.x && x <= obstacle.x + obstacle.width && y >= obstacle.y && y <= obstacle.y + obstacle.height)) continue
          const wind = plume.windAt({ x, y }, frame.time)
          const windSpeed = Math.hypot(wind.x, wind.y)
          const arrowLength = Math.max(5, Math.min(28, (windSpeed / 0.052) * 15))
          const length = windSpeed || 1
          const origin = map({ x, y })
          const end = {
            x: origin.x + (wind.x / length) * arrowLength,
            y: origin.y + (wind.y / length) * arrowLength,
          }
          context.strokeStyle = 'rgba(147, 197, 253, 0.34)'
          context.beginPath()
          context.moveTo(origin.x, origin.y)
          context.lineTo(end.x, end.y)
          context.stroke()
          const angle = Math.atan2(end.y - origin.y, end.x - origin.x)
          context.beginPath()
          context.moveTo(end.x, end.y)
          context.lineTo(end.x - Math.cos(angle - 0.55) * 4, end.y - Math.sin(angle - 0.55) * 4)
          context.moveTo(end.x, end.y)
          context.lineTo(end.x - Math.cos(angle + 0.55) * 4, end.y - Math.sin(angle + 0.55) * 4)
          context.stroke()
        }
      }
    }

    for (const obstacle of frame.scenario.obstacles) {
      const topLeft = map({ x: obstacle.x, y: obstacle.y })
      const width = obstacle.width * plotWidth
      const height = obstacle.height * plotHeight
      const obstacleGradient = context.createLinearGradient(topLeft.x, topLeft.y, topLeft.x + width, topLeft.y + height)
      obstacleGradient.addColorStop(0, '#26342f')
      obstacleGradient.addColorStop(1, '#111b18')
      context.fillStyle = obstacleGradient
      context.fillRect(topLeft.x, topLeft.y, width, height)
      context.strokeStyle = 'rgba(148, 163, 184, 0.38)'
      context.strokeRect(topLeft.x + 0.5, topLeft.y + 0.5, width - 1, height - 1)
      context.strokeStyle = 'rgba(148, 163, 184, 0.09)'
      for (let offset = -height; offset < width; offset += 11) {
        context.beginPath()
        context.moveTo(topLeft.x + Math.max(0, offset), topLeft.y + Math.max(0, -offset))
        context.lineTo(
          topLeft.x + Math.min(width, offset + height),
          topLeft.y + Math.min(height, height + offset),
        )
        context.stroke()
      }
    }

    if (layers.samples) {
      for (const observation of frame.observations.filter((_, index) => index % 3 === 0)) {
        const point = map(observation.position)
        context.beginPath()
        context.arc(point.x, point.y, observation.hit ? 2.1 : 1.2, 0, Math.PI * 2)
        context.fillStyle = observation.hit ? 'rgba(250, 204, 21, 0.72)' : 'rgba(148, 163, 184, 0.2)'
        context.fill()
      }
    }

    if (frame.robot.path.length > 1) {
      context.beginPath()
      const first = map(frame.robot.path[0] ?? frame.robot.position)
      context.moveTo(first.x, first.y)
      for (let index = 1; index < frame.robot.path.length; index += 1) {
        const point = map(frame.robot.path[index] ?? frame.robot.position)
        context.lineTo(point.x, point.y)
      }
      context.strokeStyle = accent
      context.globalAlpha = 0.72
      context.lineWidth = 2
      context.stroke()
      context.globalAlpha = 1
    }

    const particles = frame.decision.debug?.particles
    if (layers.belief && particles) {
      const maxWeight = Math.max(...particles.map((particle) => particle.weight), 1e-8)
      for (const particle of particles.filter((_, index) => index % 2 === 0)) {
        const point = map(particle)
        const alpha = 0.1 + Math.min(0.65, particle.weight / maxWeight)
        context.beginPath()
        context.arc(point.x, point.y, 1.5 + alpha * 2, 0, Math.PI * 2)
        context.fillStyle = `rgba(56, 189, 248, ${alpha})`
        context.fill()
      }
    }

    const target = frame.decision.debug?.target
    if (target) {
      const start = map(frame.robot.position)
      const end = map(target)
      context.setLineDash([5, 6])
      context.strokeStyle = `${accent}80`
      context.lineWidth = 1
      context.beginPath()
      context.moveTo(start.x, start.y)
      context.lineTo(end.x, end.y)
      context.stroke()
      context.setLineDash([])
      context.beginPath()
      context.arc(end.x, end.y, 7, 0, Math.PI * 2)
      context.strokeStyle = accent
      context.stroke()
    }

    const estimate = frame.decision.estimate
    if (estimate) {
      const point = map(estimate)
      context.save()
      context.translate(point.x, point.y)
      context.rotate(Math.PI / 4)
      context.fillStyle = '#f8fafc'
      context.fillRect(-5, -5, 10, 10)
      context.strokeStyle = '#07100f'
      context.lineWidth = 2
      context.strokeRect(-5, -5, 10, 10)
      context.restore()
      context.fillStyle = '#f8fafc'
      context.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'
      context.fillText('EST', point.x + 9, point.y - 8)
    }

    if ((layers.groundTruth || frame.completed) && frame.scenario.source) {
      const point = map(frame.scenario.source)
      const glow = context.createRadialGradient(point.x, point.y, 1, point.x, point.y, 18)
      glow.addColorStop(0, 'rgba(251, 113, 133, 0.95)')
      glow.addColorStop(1, 'rgba(251, 113, 133, 0)')
      context.fillStyle = glow
      context.beginPath()
      context.arc(point.x, point.y, 18, 0, Math.PI * 2)
      context.fill()
      context.beginPath()
      context.arc(point.x, point.y, 5.5, 0, Math.PI * 2)
      context.fillStyle = '#fb7185'
      context.fill()
      context.fillStyle = '#fecdd3'
      context.font = '600 10px ui-monospace, SFMono-Regular, Menlo, monospace'
      context.fillText('SOURCE', point.x + 9, point.y + 4)

      if (estimate) {
        const estimated = map(estimate)
        context.strokeStyle = 'rgba(251, 113, 133, 0.8)'
        context.lineWidth = 1.5
        context.setLineDash([3, 4])
        context.beginPath()
        context.moveTo(point.x, point.y)
        context.lineTo(estimated.x, estimated.y)
        context.stroke()
        context.setLineDash([])
      }
    }

    const activeSniff = frame.activeSniff
    if (activeSniff) {
      const directionLength = Math.hypot(activeSniff.direction.x, activeSniff.direction.y)
      const direction = directionLength > 1e-6
        ? { x: activeSniff.direction.x / directionLength, y: activeSniff.direction.y / directionLength }
        : { x: Math.cos(frame.robot.heading), y: Math.sin(frame.robot.heading) }
      const origin = map(activeSniff.origin)
      const mappedDirection = {
        x: direction.x * plotWidth,
        y: direction.y * plotHeight,
      }
      const mappedLength = Math.max(1e-6, Math.hypot(mappedDirection.x, mappedDirection.y))
      const angle = Math.atan2(mappedDirection.y, mappedDirection.x)
      const reachPixels = activeSniff.reach * mappedLength
      const progress = Math.max(0, Math.min(1, activeSniff.progress))
      const strength = Math.max(0, Math.min(1, activeSniff.strength))
      const visibleReach = activeSniff.phase === 'exhale'
        ? reachPixels * (0.24 + progress * 0.76)
        : reachPixels
      const fanWidth = Math.max(5, visibleReach * (0.14 + strength * 0.09))

      context.save()
      context.translate(origin.x, origin.y)
      context.rotate(angle)

      const fanGradient = context.createLinearGradient(0, 0, visibleReach, 0)
      if (activeSniff.phase === 'return') {
        fanGradient.addColorStop(0, 'rgba(250, 204, 21, 0.24)')
        fanGradient.addColorStop(1, 'rgba(250, 204, 21, 0.06)')
      } else {
        fanGradient.addColorStop(0, `rgba(34, 211, 238, ${0.18 + strength * 0.26})`)
        fanGradient.addColorStop(1, 'rgba(45, 212, 191, 0.03)')
      }
      context.beginPath()
      context.moveTo(4, 0)
      context.lineTo(visibleReach, -fanWidth)
      context.quadraticCurveTo(visibleReach * 1.06, 0, visibleReach, fanWidth)
      context.closePath()
      context.fillStyle = fanGradient
      context.fill()

      if (activeSniff.phase === 'exhale') {
        context.lineWidth = 1.2 + strength
        context.strokeStyle = 'rgba(103, 232, 249, 0.86)'
        for (const offset of [-0.55, 0, 0.55]) {
          context.beginPath()
          context.moveTo(5, 0)
          context.quadraticCurveTo(visibleReach * 0.52, fanWidth * offset * 0.45, visibleReach, fanWidth * offset)
          context.stroke()
        }
        context.beginPath()
        context.arc(0, 0, visibleReach, -0.2, 0.2)
        context.strokeStyle = 'rgba(103, 232, 249, 0.52)'
        context.stroke()
      } else if (activeSniff.phase === 'settle') {
        context.setLineDash([3, 4])
        context.lineWidth = 1.2
        context.strokeStyle = 'rgba(167, 243, 208, 0.62)'
        context.beginPath()
        context.moveTo(5, 0)
        context.lineTo(visibleReach, -fanWidth)
        context.quadraticCurveTo(visibleReach * 1.06, 0, visibleReach, fanWidth)
        context.closePath()
        context.stroke()
        context.setLineDash([])
        for (let index = 0; index < 5; index += 1) {
          const fraction = 0.28 + index * 0.14
          const offset = Math.sin(index * 2.4) * fanWidth * 0.46
          context.beginPath()
          context.arc(visibleReach * fraction, offset, 1.4, 0, Math.PI * 2)
          context.fillStyle = 'rgba(167, 243, 208, 0.68)'
          context.fill()
        }
      } else {
        context.lineWidth = 1.45
        context.strokeStyle = 'rgba(253, 224, 71, 0.88)'
        for (const offset of [-0.48, 0, 0.48]) {
          const startY = fanWidth * offset
          context.beginPath()
          context.moveTo(visibleReach, startY)
          context.lineTo(7, startY * 0.1)
          context.stroke()
          context.beginPath()
          context.moveTo(7, startY * 0.1)
          context.lineTo(14, startY * 0.1 - 3.5)
          context.moveTo(7, startY * 0.1)
          context.lineTo(14, startY * 0.1 + 3.5)
          context.stroke()
        }
      }
      context.restore()
    }

    const quadSniff = frame.quadSniff
    if (quadSniff) {
      const origin = map(quadSniff.origin)
      const readings = quadSniff.readings ?? []
      const labels = { front: 'F', left: 'L', aft: 'A', right: 'R' } as const
      const progress = Math.max(0, Math.min(1, quadSniff.progress))
      const strength = Math.max(0, Math.min(1, quadSniff.strength))
      const passiveArray = quadSniff.samplingMode === 'passive-array'

      for (const channel of quadSniff.channels) {
        const mappedDirection = {
          x: channel.direction.x * plotWidth,
          y: channel.direction.y * plotHeight,
        }
        const mappedLength = Math.max(1e-6, Math.hypot(mappedDirection.x, mappedDirection.y))
        const angle = Math.atan2(mappedDirection.y, mappedDirection.x)
        const reachPixels = channel.reach * mappedLength
        const visibleReach = passiveArray
          ? reachPixels
          : quadSniff.phase === 'aspirate'
          ? reachPixels * (0.22 + progress * 0.78)
          : reachPixels
        const fanWidth = Math.max(4, visibleReach * 0.16)
        const support = Math.max(0, Math.min(1, channel.support))
        const reading = readings.find((item) => item.channel === channel.channel)

        context.save()
        context.translate(origin.x, origin.y)
        context.rotate(angle)
        if (passiveArray) {
          context.setLineDash(support < 0.55 ? [3, 3] : [])
          context.strokeStyle = 'rgba(96, 165, 250, 0.78)'
          context.lineWidth = 1.4
          context.beginPath()
          context.moveTo(5, 0)
          context.lineTo(visibleReach, 0)
          context.stroke()
          context.setLineDash([])
          context.beginPath()
          context.arc(visibleReach, 0, reading?.hit ? 4.5 : 3.5, 0, Math.PI * 2)
          context.fillStyle = reading?.hit ? '#fde047' : '#93c5fd'
          context.fill()
        } else {
          const fanGradient = context.createLinearGradient(0, 0, visibleReach, 0)
          fanGradient.addColorStop(
            0,
            quadSniff.phase === 'return'
              ? `rgba(190, 242, 100, ${0.15 + support * 0.2})`
              : `rgba(34, 211, 238, ${0.12 + strength * support * 0.2})`,
          )
          fanGradient.addColorStop(1, 'rgba(163, 230, 53, 0.025)')
          context.beginPath()
          context.moveTo(5, 0)
          context.lineTo(visibleReach, -fanWidth)
          context.quadraticCurveTo(visibleReach * 1.05, 0, visibleReach, fanWidth)
          context.closePath()
          context.fillStyle = fanGradient
          context.fill()

          context.setLineDash(support < 0.55 ? [3, 3] : [])
          context.strokeStyle = quadSniff.phase === 'return'
            ? 'rgba(190, 242, 100, 0.72)'
            : 'rgba(103, 232, 249, 0.68)'
          context.lineWidth = 1 + strength * 0.6
          for (const offset of [-0.42, 0, 0.42]) {
            const startY = fanWidth * offset
            context.beginPath()
            context.moveTo(visibleReach, startY)
            context.lineTo(7, startY * 0.12)
            context.stroke()
          }
          context.setLineDash([])
        }
        context.rotate(-angle)
        context.fillStyle = reading?.hit ? '#fde047' : '#d9f99d'
        context.font = '700 9px ui-monospace, SFMono-Regular, Menlo, monospace'
        context.textAlign = 'center'
        context.fillText(
          reading
            ? `${labels[channel.channel]} ${reading.concentration.toFixed(2)}`
            : labels[channel.channel],
          Math.cos(angle) * (visibleReach + 13),
          Math.sin(angle) * (visibleReach + 13) + 3,
        )
        context.restore()
      }

      if (
        readings.length === 4 &&
        (passiveArray || quadSniff.strength >= 0.05)
      ) {
        const gradient = estimateQuadGradient(readings, frame.config.sensorNoise)
        if (gradient.validDirection && gradient.quality > 0.01) {
          const mappedGradient = {
            x: gradient.direction.x * plotWidth,
            y: gradient.direction.y * plotHeight,
          }
          const mappedMagnitude = Math.max(1e-6, Math.hypot(mappedGradient.x, mappedGradient.y))
          const arrowLength = 22 + gradient.quality * 38
          const end = {
            x: origin.x + mappedGradient.x / mappedMagnitude * arrowLength,
            y: origin.y + mappedGradient.y / mappedMagnitude * arrowLength,
          }
          context.save()
          context.strokeStyle = '#fef08a'
          context.fillStyle = '#fef08a'
          context.lineWidth = 2.4
          context.beginPath()
          context.moveTo(origin.x, origin.y)
          context.lineTo(end.x, end.y)
          context.stroke()
          const arrowAngle = Math.atan2(end.y - origin.y, end.x - origin.x)
          context.beginPath()
          context.moveTo(end.x, end.y)
          context.lineTo(end.x - Math.cos(arrowAngle - 0.52) * 8, end.y - Math.sin(arrowAngle - 0.52) * 8)
          context.lineTo(end.x - Math.cos(arrowAngle + 0.52) * 8, end.y - Math.sin(arrowAngle + 0.52) * 8)
          context.closePath()
          context.fill()
          context.restore()
        }
      }
    }

    const robot = map(frame.robot.position)
    context.save()
    context.translate(robot.x, robot.y)
    context.rotate(frame.robot.heading)
    context.shadowBlur = 14
    context.shadowColor = accent
    context.fillStyle = '#f8fafc'
    context.beginPath()
    context.moveTo(11, 0)
    context.lineTo(-7, -7)
    context.lineTo(-4, 0)
    context.lineTo(-7, 7)
    context.closePath()
    context.fill()
    context.shadowBlur = 0
    context.strokeStyle = accent
    context.lineWidth = 2
    context.stroke()
    context.restore()
    context.beginPath()
    context.arc(robot.x, robot.y, 16, 0, Math.PI * 2)
    context.strokeStyle = `${accent}35`
    context.stroke()

    context.restore()
    context.strokeStyle = 'rgba(148, 163, 184, 0.26)'
    context.strokeRect(padding.left + 0.5, padding.top + 0.5, plotWidth - 1, plotHeight - 1)

    context.fillStyle = 'rgba(148, 163, 184, 0.72)'
    context.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace'
    context.textAlign = 'center'
    for (let index = 0; index <= 5; index += 1) {
      const value = (frame.config.domainMeters * index) / 5
      context.fillText(`${value.toFixed(frame.config.domainMeters < 10 ? 1 : 0)}m`, padding.left + (plotWidth * index) / 5, size.height - 15)
    }
    context.save()
    context.translate(14, padding.top + plotHeight / 2)
    context.rotate(-Math.PI / 2)
    context.fillText(`${frame.config.domainMeters} m domain`, 0, 0)
    context.restore()
  }, [accent, frame, layers, plume, size])

  return (
    <div className="canvas-wrap" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Two-dimensional gas source localization plan-view map"
        aria-describedby={descriptionId}
      />
      <p id={descriptionId} className="sr-only">
        {`State ${frame.decision.phase}. Plan-view robot position ${(frame.robot.position.x * frame.config.domainMeters).toFixed(1)}, ${(frame.robot.position.y * frame.config.domainMeters).toFixed(1)} metres. ${frame.scenario.terrainSlopeDegrees > 0 ? `The implicit terrain slopes ${frame.scenario.terrainSlopeDegrees.toFixed(0)} degrees uphill toward ${frame.scenario.terrainUphillDirectionDegrees.toFixed(0)} compass degrees. ` : 'Terrain is flat. '}${frame.activeSniff ? `Active probe ${frame.activeSniff.probeId} is in its ${frame.activeSniff.phase} phase. ` : ''}${frame.quadSniff ? `${frame.quadSniff.samplingMode === 'passive-array' ? 'Four-head passive array' : 'Four-channel aspiration'} cycle ${frame.quadSniff.scanId} is in its ${frame.quadSniff.phase} phase. ` : ''}${frame.measurement.hit ? 'Plume contact detected.' : 'No plume contact.'} ${frame.metrics.normalizedError === null ? frame.decision.estimate ? 'A source estimate exists, but localization error is not applicable because this is a no-target trial.' : 'This is a no-target trial; localization error is not applicable.' : frame.decision.estimate ? `Current estimate error is ${(frame.metrics.normalizedError * 100).toFixed(2)} percent of the domain.` : 'No source estimate yet.'}`}
      </p>
      <div className="canvas-readout canvas-readout--left">
        <span className={frame.activeSniff || frame.quadSniff ? 'status-dot status-dot--probe' : frame.measurement.hit ? 'status-dot status-dot--hit' : 'status-dot'} />
        <strong>{frame.activeSniff
          ? activeSniffPhaseLabel[frame.activeSniff.phase]
          : frame.quadSniff
            ? frame.quadSniff.phase === 'aspirate'
              ? frame.quadSniff.samplingMode === 'passive-array' ? 'PASSIVE ARRAY INTEGRATION' : 'QUAD ASPIRATION'
              : '4-CHANNEL RETURN'
            : frame.measurement.hit ? 'PLUME CONTACT' : 'SAMPLING AIR'}</strong>
        <span>{(frame.activeSniff && frame.activeSniff.phase !== 'return') || (frame.quadSniff?.phase === 'aspirate' && frame.quadSniff.samplingMode !== 'passive-array') ? 'sensor array blanked' : frame.quadSniff?.phase === 'aspirate' ? 'integrating four passive heads' : `${frame.measurement.concentration.toFixed(3)} rel.`} {plumeMass !== undefined ? `· mass ${plumeMass.toExponential(1)}` : ''}</span>
      </div>
      {frame.activeSniff && (
        <div className={`active-sniff-readout active-sniff-readout--${frame.activeSniff.phase}`} role="status" aria-live="polite">
          <span>PROBE {String(frame.activeSniff.probeId).padStart(2, '0')}</span>
          <strong>{activeSniffPhaseLabel[frame.activeSniff.phase]}</strong>
          <i aria-hidden="true"><b style={{ width: `${Math.max(0, Math.min(1, frame.activeSniff.progress)) * 100}%` }} /></i>
        </div>
      )}
      {frame.quadSniff && (
        <div className={`active-sniff-readout active-sniff-readout--quad active-sniff-readout--${frame.quadSniff.phase}`} role="status" aria-live="polite">
          <span>QUAD {String(frame.quadSniff.scanId).padStart(2, '0')}</span>
          <strong>{frame.quadSniff.readings
            ? `${frame.quadSniff.readings.map((reading) => `${reading.channel[0]?.toUpperCase()} ${reading.concentration.toFixed(2)}`).join(' · ')} · n_eff=${(frame.quadSniff.readings[0]?.effectiveIntegrationSamples ?? 1).toFixed(1)}`
            : frame.quadSniff.samplingMode === 'passive-array' ? 'PASSIVE HEAD INTEGRATION' : 'SIMULTANEOUS DRAW'}</strong>
          <i aria-hidden="true"><b style={{ width: `${Math.max(0, Math.min(1, frame.quadSniff.progress)) * 100}%` }} /></i>
        </div>
      )}
      <div className="canvas-readout canvas-readout--right">
        <span>{frame.config.physicsMode === 'grid' ? `${frame.config.gridResolution}² PDE` : 'PUFF MODEL'} · STATE</span>
        <strong>{frame.decision.phase}</strong>
      </div>
      {frame.completed && (
        <div className="completion-banner" role="status" aria-live="polite">
          <span>RUN COMPLETE</span>
          <strong>{frame.completionReason}</strong>
        </div>
      )}
    </div>
  )
}
