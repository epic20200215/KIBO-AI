export type MarsPoint = { x: number; y: number }

export type MarsMapId = 'ridge' | 'sand' | 'blind'
export type ScannerKind = 'rock' | 'slope' | 'soft'
export type TerrainStatus = 'passable' | 'caution' | 'blocked' | 'unknown'
export type UnknownPolicy = 'normal' | 'pass' | 'detour'
export type BlindCommand = 'pass' | 'detour' | 'review'

export type TerrainCell = MarsPoint & {
  slope: number
  rock: number
  soft: number
  uncertainty: number
}

export type TerrainThresholds = {
  rock: number
  slope: number
  soft: number
}

export type MissionWeights = {
  safety: number
  energy: number
  distance: number
}

export type MarsMap = {
  id: MarsMapId
  name: string
  subtitle: string
  start: MarsPoint
  goal: MarsPoint
  cells: TerrainCell[]
}

export type RouteMetrics = {
  distance: number
  energy: number
  risk: number
  uncertainty: number
}

export type PathResult = {
  found: boolean
  path: MarsPoint[]
  visited: MarsPoint[]
  metrics: RouteMetrics
}

export type BlindDecisionResult =
  | { status: 'route'; command: Exclude<BlindCommand, 'review'>; result: PathResult }
  | { status: 'review'; command: 'review'; result: null }

export const MAP_WIDTH = 24
export const MAP_HEIGHT = 16

export const DEFAULT_THRESHOLDS: TerrainThresholds = { rock: 78, slope: 67, soft: 78 }
export const DEFAULT_WEIGHTS: MissionWeights = { safety: 4, energy: 3, distance: 3 }

const START = { x: 1, y: 13 }
const GOAL = { x: 22, y: 2 }

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value))
}

export function thresholdFromEvidence(
  feature: ScannerKind,
  sampleValue: number,
  judgment: Exclude<TerrainStatus, 'unknown'>,
  current: TerrainThresholds,
) {
  const offset = judgment === 'passable' ? 18 : judgment === 'caution' ? 9 : 0
  return { ...current, [feature]: clamp(sampleValue + offset, 45, 100) }
}

function baseCell(x: number, y: number, seed: number): TerrainCell {
  const a = (x * 37 + y * 53 + seed * 17 + x * y * 7) % 31
  const b = (x * 19 + y * 29 + seed * 23 + x * y * 11) % 37
  const c = (x * 13 + y * 41 + seed * 31 + x * y * 5) % 33
  return {
    x,
    y,
    slope: 18 + a,
    rock: 17 + b,
    soft: 16 + c,
    uncertainty: 8 + ((x * 23 + y * 17 + seed * 29) % 28),
  }
}

function makeCells(id: MarsMapId) {
  const seed = id === 'ridge' ? 1 : id === 'sand' ? 2 : 3
  const cells: TerrainCell[] = []

  for (let y = 0; y < MAP_HEIGHT; y += 1) {
    for (let x = 0; x < MAP_WIDTH; x += 1) {
      const cell = baseCell(x, y, seed)

      if (id === 'ridge') {
        const ridge = x >= 9 && x <= 11 && y >= 2 && y <= 14 && ![4, 10, 11].includes(y)
        if (ridge) {
          cell.rock = 88 + ((x + y) % 9)
          cell.slope = 52 + ((x * y) % 18)
        }
        if (x >= 15 && x <= 18 && y >= 5 && y <= 8) cell.slope = 66 + ((x + y) % 13)
        if (x >= 5 && x <= 8 && y >= 9 && y <= 13) cell.soft = 67 + ((x * 3 + y) % 14)
      }

      if (id === 'sand') {
        const directY = Math.round(13 - (x / 23) * 11)
        if (Math.abs(y - directY) <= 1) {
          cell.rock = 14 + ((x + y) % 9)
          cell.slope = 15 + ((x * 2 + y) % 12)
          cell.soft = 64 + ((x * 5 + y) % 11)
        }
        if (x >= 9 && x <= 14 && y >= 7 && y <= 11 && Math.abs(y - directY) > 1) {
          cell.rock = 82 + ((x + y) % 12)
        }
      }

      if (id === 'blind') {
        if ((x === 12 || x === 13) && y >= 7 && y <= 10) {
          cell.uncertainty = 88
          cell.rock = 10
          cell.slope = 10
          cell.soft = 10
        }
      }

      cells.push(cell)
    }
  }

  const sampleOverrides: Array<[MarsPoint, Partial<TerrainCell>]> = [
    [{ x: 1, y: 12 }, { rock: 70, slope: 29, soft: 32, uncertainty: 14 }],
    [{ x: 13, y: 4 }, { rock: 34, slope: 62, soft: 27, uncertainty: 18 }],
    [{ x: 17, y: 2 }, { rock: 24, slope: 31, soft: 70, uncertainty: 20 }],
  ]

  if (id === 'ridge') {
    sampleOverrides.forEach(([point, values]) => {
      const index = point.y * MAP_WIDTH + point.x
      cells[index] = { ...cells[index], ...values }
    })
  }

  ;[START, GOAL].forEach((point) => {
    const index = point.y * MAP_WIDTH + point.x
    cells[index] = { ...cells[index], rock: 8, slope: 8, soft: 8, uncertainty: 5 }
  })

  return cells
}

export const MARS_MAPS: Record<MarsMapId, MarsMap> = {
  ridge: {
    id: 'ridge',
    name: '地图 A · 岩脊边缘',
    subtitle: '岩石与坡度形成多条代价不同的走廊',
    start: START,
    goal: GOAL,
    cells: makeCells('ridge'),
  },
  sand: {
    id: 'sand',
    name: '地图 B · 松沙捷径',
    subtitle: '最短几何路线穿过连续松软地表',
    start: START,
    goal: GOAL,
    cells: makeCells('sand'),
  },
  blind: {
    id: 'blind',
    name: '地图 C · 扫描盲区',
    subtitle: '强阴影造成局部观测不完整',
    start: { x: 8, y: 10 },
    goal: { x: 17, y: 5 },
    cells: makeCells('blind'),
  },
}

export const SCAN_SAMPLES: Array<{ point: MarsPoint; kind: ScannerKind; label: string }> = [
  { point: { x: 1, y: 12 }, kind: 'rock', label: '岩影入口' },
  { point: { x: 13, y: 4 }, kind: 'slope', label: '岩脊缺口' },
  { point: { x: 17, y: 2 }, kind: 'soft', label: '浅色松沙' },
]

export function isPrimaryScanFeature(sampleKey: string, feature: ScannerKind) {
  return SCAN_SAMPLES.some((sample) => pointKey(sample.point) === sampleKey && sample.kind === feature)
}

export function pointKey(point: MarsPoint) {
  return `${point.x}-${point.y}`
}

export function getCell(map: MarsMap, point: MarsPoint) {
  return map.cells[point.y * MAP_WIDTH + point.x]
}

export function classifyTerrain(cell: TerrainCell, thresholds: TerrainThresholds): TerrainStatus {
  if (cell.uncertainty >= 75) return 'unknown'
  if (cell.rock >= thresholds.rock || cell.slope >= thresholds.slope || cell.soft >= thresholds.soft) return 'blocked'
  if (
    cell.rock >= thresholds.rock - 17
    || cell.slope >= thresholds.slope - 17
    || cell.soft >= thresholds.soft - 17
  ) return 'caution'
  return 'passable'
}

function terrainRisk(cell: TerrainCell) {
  return clamp(cell.rock * .44 + cell.slope * .31 + cell.soft * .25)
}

function terrainEnergy(cell: TerrainCell) {
  return 1 + cell.slope / 100 * 1.25 + cell.soft / 100 * 1.8 + cell.rock / 100 * .2
}

function heuristic(a: MarsPoint, b: MarsPoint, weights: MissionWeights) {
  return (Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) * Math.max(1, weights.distance)
}

export function findRoute(
  map: MarsMap,
  thresholds: TerrainThresholds,
  weights: MissionWeights,
  options: { unknownPolicy?: UnknownPolicy } = {},
): PathResult {
  const unknownPolicy = options.unknownPolicy ?? 'normal'
  const startKey = pointKey(map.start)
  const goalKey = pointKey(map.goal)
  const open = new Map<string, { point: MarsPoint; g: number; f: number }>()
  const cameFrom = new Map<string, string>()
  const gScore = new Map<string, number>([[startKey, 0]])
  const visited: MarsPoint[] = []
  open.set(startKey, { point: map.start, g: 0, f: heuristic(map.start, map.goal, weights) })

  const neighborDirections = [
    { x: 1, y: 0 },
    { x: 0, y: -1 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
  ]

  while (open.size > 0) {
    const current = [...open.values()].sort((a, b) => a.f - b.f || a.g - b.g || a.point.y - b.point.y || a.point.x - b.point.x)[0]
    const currentKey = pointKey(current.point)
    open.delete(currentKey)
    visited.push(current.point)

    if (currentKey === goalKey) {
      const path: MarsPoint[] = [map.goal]
      let cursor = goalKey
      while (cursor !== startKey) {
        const previous = cameFrom.get(cursor)
        if (!previous) break
        const [x, y] = previous.split('-').map(Number)
        path.push({ x, y })
        cursor = previous
      }
      path.reverse()

      const pathCells = path.map((point) => getCell(map, point))
      const energy = pathCells.reduce((sum, cell) => sum + terrainEnergy(cell), 0)
      const uncertainty = pathCells.reduce((sum, cell) => sum + (cell.uncertainty >= 75 ? cell.uncertainty : 0), 0)
      const risk = pathCells.reduce((sum, cell) => {
        const uncertaintyRisk = unknownPolicy === 'pass' && cell.uncertainty >= 75 ? cell.uncertainty * .42 : 0
        return sum + terrainRisk(cell) + uncertaintyRisk
      }, 0) / Math.max(1, pathCells.length)
      return {
        found: true,
        path,
        visited,
        metrics: {
          distance: Math.max(0, path.length - 1),
          energy: Math.round(energy * 10),
          risk: Math.round(risk),
          uncertainty: Math.round(uncertainty / Math.max(1, pathCells.length)),
        },
      }
    }

    for (const direction of neighborDirections) {
      const next = { x: current.point.x + direction.x, y: current.point.y + direction.y }
      if (next.x < 0 || next.x >= MAP_WIDTH || next.y < 0 || next.y >= MAP_HEIGHT) continue
      const nextKey = pointKey(next)
      const cell = getCell(map, next)
      const terrainStatus = classifyTerrain(cell, thresholds)
      if (nextKey !== goalKey && terrainStatus === 'blocked') continue
      if (nextKey !== goalKey && terrainStatus === 'unknown' && unknownPolicy === 'detour') continue

      const unknownCost = terrainStatus === 'unknown'
        ? unknownPolicy === 'pass' ? 0 : cell.uncertainty / 100 * 1.35
        : 0
      const risk = terrainRisk(cell) / 35 + unknownCost
      const energy = terrainEnergy(cell) / 1.8
      const moveCost = weights.distance + weights.safety * risk + weights.energy * energy
      const tentativeG = current.g + moveCost
      if (tentativeG >= (gScore.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue

      cameFrom.set(nextKey, currentKey)
      gScore.set(nextKey, tentativeG)
      open.set(nextKey, {
        point: next,
        g: tentativeG,
        f: tentativeG + heuristic(next, map.goal, weights),
      })
    }
  }

  return { found: false, path: [], visited, metrics: { distance: 0, energy: 0, risk: 0, uncertainty: 0 } }
}

export function resolveBlindDecision(
  map: MarsMap,
  thresholds: TerrainThresholds,
  weights: MissionWeights,
  command: BlindCommand,
): BlindDecisionResult {
  if (command === 'review') return { status: 'review', command, result: null }
  return {
    status: 'route',
    command,
    result: findRoute(map, thresholds, weights, { unknownPolicy: command }),
  }
}

export function routeCorridor(path: MarsPoint[]) {
  if (path.length === 0) return '未知'
  const averageY = path.reduce((sum, point) => sum + point.y, 0) / path.length
  if (averageY < 6.7) return '北侧岩脊'
  if (averageY < 9.7) return '中央走廊'
  return '南侧盆地'
}

export function changedCellCount(map: MarsMap, before: TerrainThresholds, after: TerrainThresholds) {
  return map.cells.filter((cell) => classifyTerrain(cell, before) !== classifyTerrain(cell, after)).length
}
