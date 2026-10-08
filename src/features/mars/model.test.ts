import {
  DEFAULT_THRESHOLDS,
  MARS_MAPS,
  findRoute,
  isPrimaryScanFeature,
  resolveBlindDecision,
  thresholdFromEvidence,
} from './model'

describe('mars deterministic pathfinding', () => {
  it('returns the same route and visit order for the same input', () => {
    const weights = { safety: 4, energy: 3, distance: 3 }
    const first = findRoute(MARS_MAPS.ridge, DEFAULT_THRESHOLDS, weights)
    const second = findRoute(MARS_MAPS.ridge, DEFAULT_THRESHOLDS, weights)

    expect(first.found).toBe(true)
    expect(second).toEqual(first)
  })

  it('keeps all route nodes inside the 24 by 16 map', () => {
    const result = findRoute(MARS_MAPS.ridge, DEFAULT_THRESHOLDS, { safety: 5, energy: 3, distance: 2 })

    expect(result.path.length).toBeGreaterThan(0)
    expect(result.path.every((point) => point.x >= 0 && point.x < 24 && point.y >= 0 && point.y < 16)).toBe(true)
  })

  it('changes the unseen-map route when the mission preference changes', () => {
    const distanceFirst = findRoute(MARS_MAPS.sand, DEFAULT_THRESHOLDS, { safety: 1, energy: 1, distance: 8 })
    const energyFirst = findRoute(MARS_MAPS.sand, DEFAULT_THRESHOLDS, { safety: 2, energy: 7, distance: 1 })

    expect(distanceFirst.found).toBe(true)
    expect(energyFirst.found).toBe(true)
    expect(energyFirst.path).not.toEqual(distanceFirst.path)
  })

  it('makes the new sand evidence visible across common mission strategies', () => {
    const strategies = [
      { safety: 4, energy: 3, distance: 3 },
      { safety: 6, energy: 2, distance: 2 },
      { safety: 2, energy: 6, distance: 2 },
      { safety: 2, energy: 2, distance: 6 },
    ]

    for (const weights of strategies) {
      const mapA = findRoute(MARS_MAPS.ridge, DEFAULT_THRESHOLDS, weights)
      const mapB = findRoute(MARS_MAPS.sand, DEFAULT_THRESHOLDS, weights)
      expect(mapA.found).toBe(true)
      expect(mapB.found).toBe(true)
      expect({ path: mapB.path, metrics: mapB.metrics }).not.toEqual({ path: mapA.path, metrics: mapA.metrics })
    }
  })

  it('turns a field judgment into a boundary that changes the route or its cost', () => {
    const sample = MARS_MAPS.ridge.cells.find((cell) => cell.x === 1 && cell.y === 12)!
    const allowRock = thresholdFromEvidence('rock', sample.rock, 'passable', DEFAULT_THRESHOLDS)
    const avoidRock = thresholdFromEvidence('rock', sample.rock, 'blocked', DEFAULT_THRESHOLDS)
    const weights = { safety: 4, energy: 3, distance: 3 }
    const allowed = findRoute(MARS_MAPS.ridge, allowRock, weights)
    const avoided = findRoute(MARS_MAPS.ridge, avoidRock, weights)

    expect(allowRock.rock).toBeGreaterThan(avoidRock.rock)
    expect(
      allowed.path.map((point) => `${point.x}-${point.y}`).join('|')
      === avoided.path.map((point) => `${point.x}-${point.y}`).join('|')
      && allowed.metrics.energy === avoided.metrics.energy
      && allowed.metrics.risk === avoided.metrics.risk,
    ).toBe(false)
  })

  it('requires each scan site to use its observable primary terrain feature', () => {
    expect(isPrimaryScanFeature('1-12', 'rock')).toBe(true)
    expect(isPrimaryScanFeature('1-12', 'slope')).toBe(false)
    expect(isPrimaryScanFeature('13-4', 'slope')).toBe(true)
    expect(isPrimaryScanFeature('17-2', 'soft')).toBe(true)
  })

  it('gives all three blind-zone commands observable consequences', () => {
    const weights = { safety: 4, energy: 3, distance: 3 }
    const pass = resolveBlindDecision(MARS_MAPS.blind, DEFAULT_THRESHOLDS, weights, 'pass')
    const detour = resolveBlindDecision(MARS_MAPS.blind, DEFAULT_THRESHOLDS, weights, 'detour')
    const review = resolveBlindDecision(MARS_MAPS.blind, DEFAULT_THRESHOLDS, weights, 'review')

    expect(pass.status).toBe('route')
    expect(detour.status).toBe('route')
    expect(review).toEqual({ status: 'review', command: 'review', result: null })
    if (pass.status === 'route' && detour.status === 'route') {
      expect(pass.result.found).toBe(true)
      expect(detour.result.found).toBe(true)
      expect(pass.result.path).not.toEqual(detour.result.path)
      expect(pass.result.metrics.uncertainty).toBeGreaterThan(detour.result.metrics.uncertainty)
    }
  })
})
