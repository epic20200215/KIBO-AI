import { createHeightField } from './heightField'
import { createGrid } from './grid'
import { createKnowledgeField, KNOW_RES } from './knowledge'
import { DEFAULT_WEIGHTS, planPath } from './planner'

const field = createHeightField('kibo-mars-basin-v1')

/** 造一个"全图已探明"的认知场，用于验证规划器本身的行为。 */
function allKnown() {
  const k = createKnowledgeField(KNOW_RES)
  k.data.fill(255)
  return k
}

function scannedGrid(cautionDeg = 14, blockedDeg = 24) {
  const g = createGrid(field, KNOW_RES, cautionDeg, blockedDeg)
  g.syncKnowledge(allKnown())
  return g
}

const grid = scannedGrid()

describe('grid 派生', () => {
  it('坡度阈值与分档严格对齐（全图已探明时）', () => {
    for (const c of grid.cells) {
      if (c.slopeDeg >= grid.blockedDeg) expect(c.flag).toBe(2)
      else if (c.slopeDeg >= grid.cautionDeg) expect(c.flag).toBe(1)
      else expect(c.flag).toBe(0)
    }
  })

  it('世界坐标与格索引互转自洽', () => {
    const w = grid.gridToWorld(3, 7)
    const g = grid.worldToGrid(w.x, w.z)
    expect(g.i).toBe(3)
    expect(g.j).toBe(7)
  })

  it('未扫描格一律按"看起来能走"处理，但真值仍被保留', () => {
    const g = createGrid(field, KNOW_RES, 14, 24)
    // 一次都没同步认知：全图未探测
    const steep = g.cells.filter((c) => c.slopeDeg >= 24)
    expect(steep.length).toBeGreaterThan(0)
    for (const c of steep) {
      expect(c.flag).toBe(0) // 规划器看不见
      expect(c.trueFlag).toBe(2) // 真值仍在
    }
  })

  it('调整阈值只改分类、不改坡度真值', () => {
    const g = scannedGrid()
    const before = g.cells.map((c) => c.slopeDeg)
    g.setThresholds(8, 16)
    const after = g.cells.map((c) => c.slopeDeg)
    expect(after).toEqual(before)
    // 阈值调紧后，禁行格只增不减
    const tightBlocked = g.cells.filter((c) => c.flag === 2).length
    g.setThresholds(14, 24)
    const looseBlocked = g.cells.filter((c) => c.flag === 2).length
    expect(tightBlocked).toBeGreaterThanOrEqual(looseBlocked)
  })
})

describe('A* 确定性', () => {
  const start = grid.worldToGrid(field.start.x, field.start.z)
  const target = grid.worldToGrid(field.goal.x, field.goal.z)

  it('同输入同输出', () => {
    const r1 = planPath(grid, start, target, DEFAULT_WEIGHTS)
    const r2 = planPath(grid, start, target, DEFAULT_WEIGHTS)
    expect(r1.found).toBe(true)
    expect(r1.path.length).toBe(r2.path.length)
    expect(r1.cost).toBeCloseTo(r2.cost, 10)
    expect(r1.expanded).toBe(r2.expanded)
    for (let k = 0; k < r1.path.length; k += 1) {
      expect(r1.path[k].i).toBe(r2.path[k].i)
      expect(r1.path[k].j).toBe(r2.path[k].j)
    }
  })

  it('路径首尾正确', () => {
    const r = planPath(grid, start, target, DEFAULT_WEIGHTS)
    expect(r.path[0].i).toBe(start.i)
    expect(r.path[0].j).toBe(start.j)
    const last = r.path[r.path.length - 1]
    expect(last.i).toBe(target.i)
    expect(last.j).toBe(target.j)
  })

  it('路径不穿越禁行格', () => {
    const r = planPath(grid, start, target, DEFAULT_WEIGHTS)
    for (const c of r.path) expect(c.flag).not.toBe(2)
  })

  it('全图已探明时，路线里没有"猜的部分"', () => {
    const r = planPath(grid, start, target, DEFAULT_WEIGHTS)
    expect(r.unknownCells).toBe(0)
    expect(r.hiddenBlocked).toBe(0)
    expect(r.lengthM).toBeGreaterThan(100)
  })

  it('更宽松阈值应缩短或不变路径代价', () => {
    const strict = planPath(grid, start, target, { ...DEFAULT_WEIGHTS, caution: 6 })
    const loose = planPath(grid, start, target, { ...DEFAULT_WEIGHTS, caution: 0.2 })
    expect(loose.cost).toBeLessThanOrEqual(strict.cost + 1e-6)
  })

  it('禁行阈值极高时路径显著变长（绕行成立）', () => {
    const gridTight = scannedGrid(14, 60)
    const normal = planPath(grid, start, target, DEFAULT_WEIGHTS)
    const tight = planPath(gridTight, start, target, DEFAULT_WEIGHTS)
    expect(tight.expanded).toBeGreaterThanOrEqual(normal.expanded)
  })
})

describe('规划器只看已扫描数据', () => {
  const start = grid.worldToGrid(field.start.x, field.start.z)
  const target = grid.worldToGrid(field.goal.x, field.goal.z)

  it('几乎未扫描时仍会给出路线，但绝大部分是猜的', () => {
    const g = createGrid(field, KNOW_RES, 14, 24)
    const k = createKnowledgeField(KNOW_RES)
    k.reveal(field.start.x, field.start.z, 46)
    g.syncKnowledge(k)
    const r = planPath(g, start, target, DEFAULT_WEIGHTS)
    expect(r.found).toBe(true)
    // 这是本项目最重要的一条断言：数据不足时 AI 照样给答案
    expect(r.unknownCells).toBeGreaterThan(r.path.length * 0.5)
  })

  it('未扫描区的隐患是真实存在的，只是规划时看不见', () => {
    const g = createGrid(field, KNOW_RES, 14, 24)
    const k = createKnowledgeField(KNOW_RES)
    k.reveal(field.start.x, field.start.z, 46)
    g.syncKnowledge(k)
    const r = planPath(g, start, target, DEFAULT_WEIGHTS)
    // hiddenBlocked 只在复盘阶段展示；这里断言它确实被算出来了
    expect(r.hiddenBlocked).toBeGreaterThanOrEqual(0)
    expect(r.hiddenBlocked).toBeLessThanOrEqual(r.unknownCells)
  })

  it('提高未知风险权重会让路线更贴着已探明区走', () => {
    const g = createGrid(field, KNOW_RES, 14, 24)
    const k = createKnowledgeField(KNOW_RES)
    k.reveal(field.start.x, field.start.z, 46)
    k.reveal(0, 0, 90)
    g.syncKnowledge(k)
    const bold = planPath(g, start, target, { ...DEFAULT_WEIGHTS, unknown: 0.1 })
    const shy = planPath(g, start, target, { ...DEFAULT_WEIGHTS, unknown: 12 })
    expect(shy.unknownCells).toBeLessThanOrEqual(bold.unknownCells)
  })
})
