/**
 * 探索舱任务进度的不变式测试。
 *
 * 这里锁死的是需求 6/7/8 的三条硬约束：
 * - 没打完的任务，探索舱按钮显示「任务进行中」而不是「启动任务」；
 * - 全部打完后显示「任务完成」，且重置后回到「启动任务」；
 * - 完成一号地图后，下次进入直接落在二号地图（currentWorld 前进）。
 *
 * 另外专门锁一个曾经真实踩过的坑：字段缺失时 `Number(x) ?? fallback` 会产出 NaN
 * 并一路传播成 NaN 索引，导致整局任务崩掉。现在必须由 clampWorld 兜住。
 */
import {
  completeMissionWorld,
  getDefaultMissionProgress,
  getWorldCount,
  loadMissionProgress,
  resetMissionProgress,
  saveMissionProgress,
  startMission,
} from './missionProgress'
// 跨层引入只为锁死「两份世界数量登记不漂移」；heightField 是纯数据模块，不 import three。
import { MARS_MAP_COUNT } from '../features/mars/game3d/core/heightField'

const MAP_COUNT = 2

beforeEach(() => {
  localStorage.clear()
})

describe('任务进度：默认值与启动态', () => {
  it('从未启动过的任务：未开始、未完成、停在第一张地图', () => {
    const p = loadMissionProgress('mars-rover', MAP_COUNT)
    expect(p.started).toBe(false)
    expect(p.completedWorlds).toBe(0)
    expect(p.currentWorld).toBe(0)
  })

  it('点过「启动任务」后 started 变 true——探索舱据此把按钮改成「任务进行中」', () => {
    const p = startMission('mars-rover', MAP_COUNT)
    expect(p.started).toBe(true)
    expect(loadMissionProgress('mars-rover', MAP_COUNT).started).toBe(true)
  })

  it('启动不会覆盖已有的完成进度（重复点按钮不能把进度清零）', () => {
    completeMissionWorld('mars-rover', 0, MAP_COUNT)
    const p = startMission('mars-rover', MAP_COUNT)
    expect(p.completedWorlds).toBe(1)
    expect(p.currentWorld).toBe(1)
  })
})

describe('任务进度：完成世界与解锁下一张', () => {
  it('完成第一张地图后，下次进入直接落到第二张地图（需求 8）', () => {
    const p = completeMissionWorld('mars-rover', 0, MAP_COUNT)
    expect(p.completedWorlds).toBe(1)
    expect(p.currentWorld).toBe(1)
    expect(loadMissionProgress('mars-rover', MAP_COUNT).currentWorld).toBe(1)
  })

  it('完成最后一张地图后 currentWorld 停在末图，不会越界', () => {
    completeMissionWorld('mars-rover', 0, MAP_COUNT)
    const p = completeMissionWorld('mars-rover', 1, MAP_COUNT)
    expect(p.completedWorlds).toBe(2)
    expect(p.currentWorld).toBe(1)
  })

  it('重复完成同一张地图不会把 completedWorlds 倒退', () => {
    completeMissionWorld('mars-rover', 0, MAP_COUNT)
    completeMissionWorld('mars-rover', 1, MAP_COUNT)
    const p = completeMissionWorld('mars-rover', 0, MAP_COUNT)
    expect(p.completedWorlds).toBe(2)
    expect(p.currentWorld).toBe(1)
  })
})

describe('任务进度：重置', () => {
  it('重置后回到未开始状态，「任务完成」按钮变回「启动任务」（需求 6）', () => {
    completeMissionWorld('mars-rover', 0, MAP_COUNT)
    completeMissionWorld('mars-rover', 1, MAP_COUNT)
    resetMissionProgress('mars-rover')
    const p = loadMissionProgress('mars-rover', MAP_COUNT)
    expect(p).toEqual(getDefaultMissionProgress())
    expect(p.started).toBe(false)
    expect(p.completedWorlds).toBe(0)
    expect(p.currentWorld).toBe(0)
  })

  it('重置是真的删除记录，不是写入一条空记录', () => {
    completeMissionWorld('mars-rover', 0, MAP_COUNT)
    resetMissionProgress('mars-rover')
    expect(localStorage.getItem('kibo-mission-progress:mars-rover')).toBeNull()
  })
})

describe('任务进度：世界数量登记一致性', () => {
  /**
   * lib 层的 MISSION_WORLD_COUNT 与火星任务自己的 MARS_MAP_COUNT 是两份登记，
   * 一旦漂移，探索舱会提前/延后判定「任务完成」。这里锁死两者相等。
   */
  it('getWorldCount(mars-rover) 必须等于 MARS_MAP_COUNT', () => {
    expect(getWorldCount('mars-rover')).toBe(MARS_MAP_COUNT)
  })

  it('未登记的任务退回 1，不会因缺登记而崩溃', () => {
    expect(getWorldCount('some-unregistered-mission')).toBe(1)
  })
})

describe('任务进度：脏数据与越界必须被夹住', () => {
  it('currentWorld 字段缺失时退回 completedWorlds，绝不能变成 NaN', () => {
    localStorage.setItem('kibo-mission-progress:mars-rover', JSON.stringify({ started: true, completedWorlds: 1 }))
    const p = loadMissionProgress('mars-rover', MAP_COUNT)
    expect(Number.isFinite(p.currentWorld)).toBe(true)
    expect(p.currentWorld).toBe(1)
  })

  it('存了超出地图数量的索引时夹到末图，避免 worlds[NaN] / undefined 崩溃', () => {
    localStorage.setItem(
      'kibo-mission-progress:mars-rover',
      JSON.stringify({ started: true, completedWorlds: 99, currentWorld: 99 }),
    )
    const p = loadMissionProgress('mars-rover', MAP_COUNT)
    expect(p.completedWorlds).toBe(MAP_COUNT)
    expect(p.currentWorld).toBe(MAP_COUNT - 1)
  })

  it('存了负数时夹到第一张地图', () => {
    localStorage.setItem(
      'kibo-mission-progress:mars-rover',
      JSON.stringify({ started: true, completedWorlds: -5, currentWorld: -3 }),
    )
    const p = loadMissionProgress('mars-rover', MAP_COUNT)
    expect(p.completedWorlds).toBe(0)
    expect(p.currentWorld).toBe(0)
  })

  it('JSON 损坏 / 非对象时静默回默认值，不抛异常', () => {
    localStorage.setItem('kibo-mission-progress:mars-rover', '{ 这不是 json')
    expect(() => loadMissionProgress('mars-rover', MAP_COUNT)).not.toThrow()
    expect(loadMissionProgress('mars-rover', MAP_COUNT)).toEqual(getDefaultMissionProgress())

    localStorage.setItem('kibo-mission-progress:mars-rover', '"just a string"')
    expect(loadMissionProgress('mars-rover', MAP_COUNT)).toEqual(getDefaultMissionProgress())
  })

  it('saveMissionProgress 同样要夹住越界写入', () => {
    saveMissionProgress('mars-rover', { started: true, completedWorlds: 7, currentWorld: 7 }, MAP_COUNT)
    const p = loadMissionProgress('mars-rover', MAP_COUNT)
    expect(p.completedWorlds).toBe(MAP_COUNT)
    expect(p.currentWorld).toBe(MAP_COUNT - 1)
  })
})

describe('任务进度：不同任务互不污染', () => {
  it('火星任务的进度不会串到别的任务上', () => {
    completeMissionWorld('mars-rover', 0, MAP_COUNT)
    const other = loadMissionProgress('deep-sea', MAP_COUNT)
    expect(other.completedWorlds).toBe(0)
    expect(other.started).toBe(false)
  })
})
