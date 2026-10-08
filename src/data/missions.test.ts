import { getInterfaceReviewMissions, getReleasedMissions, missions } from './missions'

describe('mission catalog', () => {
  it('keeps interface review data ordered and complete', () => {
    const catalog = getInterfaceReviewMissions()
    expect(catalog).toHaveLength(5)
    expect(catalog.map((mission) => mission.order)).toEqual([1, 2, 3, 4, 5])
  })

  it('filters unreleased missions for a public catalog', () => {
    const released = getReleasedMissions()
    expect(released.every((mission) => mission.status === 'released')).toBe(true)
    expect(released.map((mission) => mission.id)).toEqual(['mars-rover'])
  })

  it('has unique ids, coordinates and posters', () => {
    expect(new Set(missions.map((mission) => mission.id)).size).toBe(missions.length)
    expect(new Set(missions.map((mission) => mission.coordinate)).size).toBe(missions.length)
    expect(missions.every((mission) => mission.poster.endsWith('.webp'))).toBe(true)
  })
})
