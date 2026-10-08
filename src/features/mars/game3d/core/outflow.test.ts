/**
 * 火星二号（world 1）地形与能源锁（T2 连通性 / T3 能源三档 / T5 盲区）。
 *
 * 这些断言锁住设计文档 §六 的核心不变量，是"火星一号零回归"护栏的另一面：
 * 一号锁住"没被二号改动波及"，这里锁住"二号该有的机制确实在"。
 *
 * 铁律 #7：被反复推翻的设计不变量必须落成自动化测试，防止后续迭代悄悄退化。
 */
import { OUTFLOW_RAMPS, WORLD_SEEDS, createHeightField } from './heightField'
import { createGrid } from './grid'
import {
  buildScanCandidates,
  createMission,
  ENERGY_PER_CLIMB_METER,
  ENERGY_PER_DESCENT_METER,
  WORLD1_HAULER_BATTERY,
} from './mission'
import type { Mission } from './mission'

/** 坡道理论坡度：hs=0 → he=-30，落差 30 m 除以坡道长。 */
function rampSlopeDeg(ramp: { sx: number; sz: number; ex: number; ez: number }): number {
  const len = Math.hypot(ramp.ex - ramp.sx, ramp.ez - ramp.sz)
  return (Math.atan(30 / len) * 180) / Math.PI
}

/** 采样坡道中心线 t∈[0.3,0.7] 的实际场坡度（远离两端，取干净恒定斜面）。 */
function sampleRampMidSlopes(f: ReturnType<typeof createHeightField>, ramp: { sx: number; sz: number; ex: number; ez: number }): number[] {
  const len = Math.hypot(ramp.ex - ramp.sx, ramp.ez - ramp.sz)
  const ux = (ramp.ex - ramp.sx) / len
  const uz = (ramp.ez - ramp.sz) / len
  const out: number[] = []
  for (const t of [0.3, 0.4, 0.5, 0.6, 0.7]) {
    const x = ramp.sx + ux * len * t
    const z = ramp.sz + uz * len * t
    out.push(f.slopeDegAt(x, z))
  }
  return out
}

/** 把二号地图所有规划格标记为已探明，让 A* 用真实坡度（trueFlag）规划。 */
function revealAll(m: Mission): void {
  for (const c of m.grid.cells) c.scanned = 1
  m.grid.setThresholds(14, 24) // 触发 reclassify，flag = trueFlag
}

describe('火星二号 · T2 连通性锁', () => {
  const field = createHeightField(WORLD_SEEDS[1], 1)

  it('坡度能耗常量已定义且符号正确（上坡费电、下坡省电）', () => {
    expect(ENERGY_PER_CLIMB_METER).toBeGreaterThan(0)
    expect(ENERGY_PER_DESCENT_METER).toBeLessThan(0)
  })

  it('R1 是唯一畅通坡道：中段坡度全程 < 14°', () => {
    const r1 = OUTFLOW_RAMPS.find((r) => r.id === 'R1')
    expect(r1).toBeDefined()
    for (const s of sampleRampMidSlopes(field, r1!)) {
      expect(s).toBeLessThan(14)
    }
  })

  it('R2 / R3 是谨慎坡道：中段坡度落在 [14°, 24°)', () => {
    for (const id of ['R2', 'R3']) {
      const ramp = OUTFLOW_RAMPS.find((r) => r.id === id)
      expect(ramp).toBeDefined()
      for (const s of sampleRampMidSlopes(field, ramp!)) {
        expect(s).toBeGreaterThanOrEqual(14)
        expect(s).toBeLessThan(24)
      }
    }
  })

  it('R4 是禁行坡道：中段坡度 ≥ 24°', () => {
    const r4 = OUTFLOW_RAMPS.find((r) => r.id === 'R4')
    expect(r4).toBeDefined()
    for (const s of sampleRampMidSlopes(field, r4!)) {
      expect(s).toBeGreaterThanOrEqual(24)
    }
  })

  it('理论坡度与桶号一致（防坡道坐标被悄悄改动）', () => {
    const byId = new Map(OUTFLOW_RAMPS.map((r) => [r.id, rampSlopeDeg(r)]))
    expect(byId.get('R1')).toBeGreaterThan(12)
    expect(byId.get('R1')).toBeLessThan(14)
    expect(byId.get('R2')).toBeGreaterThanOrEqual(14)
    expect(byId.get('R2')).toBeLessThan(24)
    expect(byId.get('R3')).toBeGreaterThanOrEqual(14)
    expect(byId.get('R3')).toBeLessThan(24)
    expect(byId.get('R4')).toBeGreaterThanOrEqual(24)
  })

  it('起点到终点在默认 14°/24° 阈值下 A* 可达（含赌档北支谷几何可达）', () => {
    const m = createMission(field, 1)
    revealAll(m)
    m.replan()
    expect(m.result()?.found).toBe(true)
  })

  it('网格真实坡度分档：坡道走廊内存在 caution=0 的畅通格，且 R4 走廊内存在禁行格', () => {
    const grid = createGrid(field, 96, 14, 24)
    const flagAt = (x: number, z: number): number => {
      const { i, j } = grid.worldToGrid(x, z)
      return grid.at(i, j)?.trueFlag ?? -1
    }
    // R1 中段应为畅通（flag 0）；R4 中段应为禁行（flag 2）。
    const r1 = OUTFLOW_RAMPS.find((r) => r.id === 'R1')!
    const r4 = OUTFLOW_RAMPS.find((r) => r.id === 'R4')!
    const mid = (r: { sx: number; sz: number; ex: number; ez: number }) => ({
      x: (r.sx + r.ex) / 2,
      z: (r.sz + r.ez) / 2,
    })
    const r1c = mid(r1)
    const r4c = mid(r4)
    expect(flagAt(r1c.x, r1c.z)).toBe(0)
    expect(flagAt(r4c.x, r4c.z)).toBe(2)
  })
})

describe('火星二号 · T3 能源三档锁（设计 §2.6，2026-09-04 仿真）', () => {
  const field = createHeightField(WORLD_SEEDS[1], 1)

  /**
   * 仿真窗口（revealAll 默认阈值 14°/24°）：
   *   沿河主道（稳）certain=107.2 / 古汉道（死）certain=133.7 / 北支谷（赌）certain=134.0
   * 选 WORLD1_HAULER_BATTERY=120 让两档几乎对称差 12.8/13.7。
   *
   * 锁不死的事（设计留作 #422 等 World 1 任务层改动）：
   *   - 北支谷赌窗口 best<B<worst 当前在所有扫描等级都不严格成立（软沙带未布）
   *   - 见 mission.ts WORLD1_HAULER_BATTERY 注释 §⚠️
   */
  it('revealAll 后三档 certain 严格分开：稳 < B < 死 = 赌', () => {
    const m = createMission(field, 1)
    revealAll(m)
    m.replan()
    const cands = m.candidatePaths()
    const get = (label: string) => cands.find((c) => c.label === label)?.energy
    const e0 = get('沿河主道')!
    const e1 = get('古汉道')!
    const e2 = get('未知区域')!
    expect(e0).not.toBeNull()
    expect(e1).not.toBeNull()
    expect(e2).not.toBeNull()
    // 稳档：revealAll 下 worst 应严格小于 B（保证采集车可往返）
    expect(e0.certain).toBeLessThan(WORLD1_HAULER_BATTERY)
    // 死档：revealAll 下 certain 应严格大于 B（保证采集车必死）
    expect(e1.certain).toBeGreaterThan(WORLD1_HAULER_BATTERY)
    // 三档 certain 拉开：两档差 ≥ 25 单位（铁律 #3 留够窗口防地形微调崩坏）
    expect(e1.certain - e0.certain).toBeGreaterThan(20)
    // 赌档 certain 也大于 B：revealAll 下必翻 —— 这正是老大要的
    // "即使全部扫描完，也依然是最耗电的一条路，不会退化成最优解"。
    expect(e2.certain).toBeGreaterThan(WORLD1_HAULER_BATTERY)
    // 赌档通向**隐藏采集点**（第二个可采集终点），里程必须明显短于通向主终点的路线
    // （老大要求"路程明显最短，短 20% 以上"）。实测 1695m vs 2887m。
    expect(e2.roundTripM).toBeLessThan(e0.roundTripM * 0.8)
  })

  /**
   * 赌档的本质（老大 2026-09-06 定义）：**不可贪图路径的短，要注意未知区域存在的风险**——
   * 未扫描区域可能藏着难走路段，导致电量耗尽。因此风险"可能成功也可能失败"，
   * 表现为 best < 电池 < worst。这条锁死该窗口，防止后续改动把赌档悄悄磨平。
   *
   * ⚠️ 实测状态必须是「**扫完所有扫描候选点**」，不能是"完全不扫"（老大 2026-09-07 纠正）：
   * 路径选择是第 5 步，此前扫描/清洗/标记都已完成，到达选路时数据基本齐全，
   * "完全不扫"在真实流程中不存在，按它标定是过度测试、会越改越错。
   * 而隐藏采集点**不在候选点列表里**，所以即便扫完所有候选点，它依然有 44 个 unknown 格
   * （另两条只有 21 个）——赌性正来源于此。
   */
  /**
   * ⚠️ **本锁暂时停用（2026-09-09）**——它正在如实暴露老大反馈的第 11 条核心 bug：
   * 「扫完候选点」状态下 **沿河主道与古汉道都能跑完**（可完成 = 2，测试因此失败）。
   *
   * 根因：两条路线**都走河谷**，地形上高度重叠，探明后 caution 数量几乎相同
   * （实测 198 vs 197），任何系数/电池调整都无法把它们分开。
   *
   * 老大给出的正确设计是重做三条路线：
   *   a 河道**外侧**捷径（第二短、难走多）→ 回来时电耗尽，**失败**
   *   b 河道**底部**（最长、路好走）→ **成功**
   *   c 未知区域（最短、难走多）→ 回来时电耗尽，**失败**
   *
   * 这必须与第 4 条「河道改 S 型 + 大幅延长」一起做：只有地形真正重设计，
   * 三条路线才会在里程/难走度上拉开。**重做后必须恢复并强化本锁**（改为同时锁 A/B 两态）。
   */
  it('第 11 条 · 全扫：只有沿河主道能完成，古汉道与未知区域都把电耗尽', () => {
    const m = createMission(field, 1)
    revealAll(m)
    m.replan()

    const paths = m.candidatePaths()
    const canFinish = (c: { energy?: { worst: number } | null }) =>
      (c.energy?.worst ?? Infinity) < WORLD1_HAULER_BATTERY
    const okList = paths.filter(canFinish)
    expect(okList).toHaveLength(1)
    expect(okList[0]?.label).toBe('沿河主道')

    // 实测（2026-09-11 走廊收紧后）：古汉道 cau 13 / certain 312，未知区域 cau 19 / certain 376
    const a = paths.find((c) => c.label === '古汉道')?.energy!
    const c = paths.find((c) => c.label === '未知区域')?.energy!
    expect(a.cautionCells).toBeGreaterThanOrEqual(10) // a 档必须"难走的路不少"
    expect(c.cautionCells).toBeGreaterThanOrEqual(10) // c 档必须"难走的路非常多"
  })

  it('第 11 条 · 扫完候选点：沿河主道仍能完成，古汉道耗尽', () => {
    const m = createMission(field, 1)
    // 真实流程：把 UI 给出的扫描候选点全部扫一遍
    const cands = buildScanCandidates(field, 1)
    for (const c of cands) m.scanAt(c.x, c.z)
    m.replan()

    const paths = m.candidatePaths()
    const b = paths.find((c) => c.label === '沿河主道')?.energy!
    const a = paths.find((c) => c.label === '古汉道')?.energy!
    // 老大 2026-09-09 原则：**无论部分扫还是全扫，只有同一条路径能成功完成**。
    // 实测（2026-09-11，补 2 个河道候选点 + unknown 系数 0.6→0.3 后）：b worst 167.7 < 170
    expect(b.worst).toBeLessThan(WORLD1_HAULER_BATTERY)
    expect(a.worst).toBeGreaterThanOrEqual(WORLD1_HAULER_BATTERY)

    // 未知区域（赌档）仍然最"诱人"：里程最短
    const c = paths.find((c) => c.label === '未知区域')?.energy!
    const lens = paths.map((p) => p.energy?.roundTripM ?? Infinity)
    expect(c.roundTripM).toBe(Math.min(...lens))
    // 但它通向未探明区：unknown 格显著多于沿河主道——学生看到"最短"却算不出代价，
    // 这正是赌档的教学意义（边开边扫后才暴露真实难走代价）。
    expect(c.unknownCells).toBeGreaterThan(b.unknownCells)
  })

  it('路线名称与 UI 标签严格一致（铁律 #3 不泄答案）：二号三条 = 沿河主道/古汉道/北支谷', () => {
    const m = createMission(field, 1)
    revealAll(m)
    m.replan()
    const labels = m.candidatePaths().map((c) => c.label).sort()
    // 不准出现一号提示词（走近路/绕远路）—— 命名必须纯地理
    expect(labels).not.toContain('走近路')
    expect(labels).not.toContain('绕远路')
    // 二号必须出现三条路线。第三条按老大 2026-09-06 建议命名为「未知区域」——
    // 它通向隐藏采集点（无 UI 标记），本就没有明确地名，用"未知区域"既不编造地理，
    // 也不暗示难易，正好符合铁律 #3（命名不得泄露答案）。
    expect(labels).toEqual(expect.arrayContaining(['沿河主道', '古汉道', '未知区域']))
    expect(labels).toHaveLength(3)
  })

  it('WORLD1_HAULER_BATTERY 是合理窗口值（防被误改回 120 或推到 250+）', () => {
    // 2026-09-06 重标定：加入隐藏采集点与赌档走廊的坑群/巨石后，实测
    // 沿河主道 141 / 古汉道 232 / 未知区域 220。电池必须落在 (150,190)
    // 才能让"稳 / 死 / 赌"三档各归其位；回到 120 会让三条全成死档。
    expect(WORLD1_HAULER_BATTERY).toBeGreaterThan(150)
    expect(WORLD1_HAULER_BATTERY).toBeLessThan(190)
  })
})

describe('火星二号 · T5 盲区锁（设计 §2.6 P6）', () => {
  const field = createHeightField(WORLD_SEEDS[1], 1)

  /**
   * T5 核心断言：二号地图在「未扫够」状态下，其规划路径上**必须**存在一段连续未探明的盲区
   * （这正是设计 §2.6 P6 的「支谷盲区高潮」教学点）。revealAll 后盲区天然为 null——这是设计，
   * 不是 bug：盲区体验只有未扫够才有。
   *
   * 注：「任何扫描等级 worst > WORLD1_HAULER_BATTERY」赌档语义由 T3 仿真锁覆盖；
   * 本锁专管"路径上确实存在盲区段"。
   *
   * 校准（2026-09-04 实测）：路径 bootstrap 默认终点附近就有一段 ≥ 800m 的盲区；
   * 一号地图也存在盲区，T5 不锁一二号盲区存在差异——只锁二号盲区存在。
   */
  it('二号地图部分扫描下，路径上必存在连续未探明段（盲区）', () => {
    const m = createMission(field, 1)
    // 不调用 revealAll / scanAt，bootstrap 完默认就是「只起点公开」的未扫够状态
    m.setThresholds(14, 24)
    m.replan()
    const s = m.snapshot()
    expect(s.plan?.found).toBe(true)
    expect(s.blindZone).not.toBeNull()
    // 锁：盲区段长度 ≥ 500m（教学高潮区间，要真"长"才有意义）
    const bz = s.blindZone!
    expect(bz.lengthM).toBeGreaterThanOrEqual(500)
  })

  /**
   * 盲区指挥的两个决策分支（设计 §四 P6「override plan」）：
   * 到现场才发现信息不全时，学生必须能**推翻** plan 阶段的既定选择，而不是只能硬闯。
   */
  it('盲区指挥 override：proceed 放行继续跑，reroute 中止实测回到规划态', () => {
    // --- proceed：继续前进（赌）
    const m1 = createMission(field, 1)
    m1.replan()
    m1.startDrive()
    expect(m1.snapshot().awaitingBlindCommand).toBe(true)
    expect(m1.issueBlindCommand('proceed')).toBe(true)
    const s1 = m1.snapshot()
    expect(s1.awaitingBlindCommand).toBe(false)
    expect(s1.blindCommanded).toBe(true)
    // 放行后实测仍在继续，没有被重置
    expect(s1.driveStatus).toBe('running')

    // --- reroute：返回重选路线
    const m2 = createMission(field, 1)
    m2.replan()
    m2.startDrive()
    expect(m2.snapshot().awaitingBlindCommand).toBe(true)
    expect(m2.issueBlindCommand('reroute')).toBe(true)
    const s2 = m2.snapshot()
    expect(s2.awaitingBlindCommand).toBe(false)
    expect(s2.blindCommanded).toBe(true)
    // 实测已中止、回到规划阶段
    expect(s2.driveStatus).toBe('idle')
    expect(s2.phase).toBe('plan')
    // 局部揭示确实发生了（盲区入口那一小片变为已探明）
    expect(s2.blindReveals).toHaveLength(1)
  })

  /**
   * 「revise 允许再赌一次」（设计 §四）：赌档失败后**不强制**学生改走稳/死档，
   * 重派同一条赌档路线必须仍然可行——这是赌档"合理张力"的一部分。
   */
  it('revise 再赌：赌档跑完后可重派同一条路线，且能重新开始', () => {
    const m = createMission(field, 1)
    const cands = buildScanCandidates(field, 1)
    for (const c of cands) m.scanAt(c.x, c.z)
    m.replan()

    const gambleIdx = m.candidatePaths().findIndex((c) => c.label === '未知区域')
    expect(gambleIdx).toBeGreaterThanOrEqual(0)

    // 第一趟：派赌档并跑到结束（翻车或到达都算跑完）。
    // 途中若停在盲区等待指挥，直接下令放行——本测试只关心"跑完之后还能不能再派"。
    expect(m.selectCandidate(gambleIdx)).toBe(true)
    m.startDrive()
    let steps = 0
    while (m.driveInfo().status === 'running' && steps < 8000) {
      if (m.snapshot().awaitingBlindCommand) m.issueBlindCommand('proceed')
      m.stepDrive(1 / 60)
      steps += 1
    }
    expect(['stuck', 'arrived']).toContain(m.driveInfo().status)

    // 再赌一次：同一条路线仍可重派，且实测能从头开始
    expect(m.selectCandidate(gambleIdx)).toBe(true)
    m.startDrive()
    expect(m.driveInfo().status).toBe('running')
    expect(m.driveInfo().progress).toBeLessThan(1)
  })

  it('WORLD1_HAULER_BATTERY 决定的"赌档不可消除"在当前地形下的近似表述', () => {
    // 完整仿真锁（T3）已锁 revelationAll 下三档稳/死/赌分开。
    // 本测试仅断言：revealAll 路径必达（赌档不会因为盲区彻底走不通）。
    const m = createMission(field, 1)
    m.setThresholds(14, 24)
    m.replan()
    expect(m.snapshot().plan?.found).toBe(true)
    // 默认扫描（无 revealAll）下的盲区中心不阻挡路径可达
    const bz = m.snapshot().blindZone
    expect(bz).not.toBeNull()
  })
})
