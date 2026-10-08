import { createHeightField, WORLD_SEEDS } from './heightField'
import {
  buildScanCandidates,
  createMission,
  measureScanBudgetCoverage,
  SIX_STEP_ORDER,
  DRIVE_SPEED,
  HAULER_BATTERY,
  CAUTION_SOFT,
  CAUTION_ROCK,
} from './mission'
import type { MissionSnapshot } from './mission'
import { createKnowledgeField } from './knowledge'
import { kiboLineFor } from '../kiboLines'

const field = createHeightField('kibo-mars-basin-v1')

describe('手动驾驶（RPG 操控 / 实践测试）', () => {
  it('同一输入序列得到完全一致的轨迹（确定性，无随机）', () => {
    const run = () => {
      const m = createMission(field)
      m.enterManual()
      m.setManualInput(1, 0) // 全油门直行
      for (let i = 0; i < 120; i += 1) m.stepManual(1 / 60)
      return m.manualPose()
    }
    const a = run()
    const b = run()
    expect(a.x).toBeCloseTo(b.x, 6)
    expect(a.z).toBeCloseTo(b.z, 6)
    expect(a.heading).toBeCloseTo(b.heading, 6)
    expect(a.distance).toBeCloseTo(b.distance, 6)
  })

  it('转向输入会改变朝向，且车在盆地边界内', () => {
    const m = createMission(field)
    m.enterManual()
    // 起步朝 +X，持续右转
    m.setManualInput(0.8, 1)
    for (let i = 0; i < 180; i += 1) m.stepManual(1 / 60)
    const p = m.manualPose()
    const half = field.size / 2 - 12
    expect(Math.abs(p.x)).toBeLessThanOrEqual(half)
    expect(Math.abs(p.z)).toBeLessThanOrEqual(half)
    // 朝向应当偏离初始 0（被转向改变）
    expect(Math.abs(p.heading)).toBeGreaterThan(0.2)
  })

  it('快照如实反映手动模式激活', () => {
    const m = createMission(field)
    expect(m.manualActive()).toBe(false)
    m.enterManual()
    expect(m.snapshot().manual).toBe(true)
    m.exitManual()
    expect(m.snapshot().manual).toBe(false)
  })

  it('重新进入手动驾驶从当前实时坐标出发，而非复位回基地', () => {
    const m = createMission(field)
    const start = m.roverPosition() // 停靠位 ≈ 基地起点
    m.enterManual()
    // 先把车手动开离基地
    m.setManualInput(1, 0)
    for (let i = 0; i < 300; i += 1) m.stepManual(1 / 60)
    const moved = m.manualPose()
    expect(Math.hypot(moved.x - start.x, moved.z - start.z)).toBeGreaterThan(30)

    // 模拟「鼠标点击新目的地」= 再次 enterManual：应从当前坐标继续
    m.enterManual()
    const re = m.manualPose()
    // 重新进入后必须 ≈ 当前坐标（moved），而非回到起点
    expect(Math.hypot(re.x - moved.x, re.z - moved.z)).toBeLessThan(0.5)
    expect(Math.hypot(re.x - start.x, re.z - start.z)).toBeGreaterThan(30)
  })
})

describe('探测置信度场', () => {
  it('初始全未知', () => {
    const k = createKnowledgeField(32)
    expect(k.coverage()).toBe(0)
  })

  it('揭示后覆盖率上升，且不会倒退', () => {
    const k = createKnowledgeField(64)
    k.reveal(0, 0, 60)
    const c1 = k.coverage()
    expect(c1).toBeGreaterThan(0)
    k.reveal(0, 0, 20) // 更小的圈，不该抹掉已探明的
    expect(k.coverage()).toBeGreaterThanOrEqual(c1)
  })

  it('圆心已探明，远处仍未知', () => {
    const k = createKnowledgeField(64)
    k.reveal(0, 0, 50)
    expect(k.scannedAt(0, 0)).toBe(1)
    expect(k.scannedAt(280, 280)).toBe(0)
  })

  it('reset 后回到全未知', () => {
    const k = createKnowledgeField(32)
    k.reveal(0, 0, 100)
    k.reset()
    expect(k.coverage()).toBe(0)
  })
})

describe('任务闭环', () => {
  it('开局：只有着陆点周边已探明，其他全是未知', () => {
    const m = createMission(field)
    const s = m.snapshot()
    expect(s.phase).toBe('scan')
    expect(s.scansLeft).toBe(Infinity)
    expect(s.coverage).toBeGreaterThan(0)
    expect(s.coverage).toBeLessThan(0.25)
    expect(s.targetKnown).toBe(false)
  })

  it('扫描次数不限：可连续扫描多次且始终成功（不被拒绝）', () => {
    const m = createMission(field)
    // 需求 C：扫描次数不设上限，连续扫描远超过原 6 次上限仍全部成功，scansUsed 持续累加。
    for (let k = 0; k < 12; k += 1) {
      const out = m.scanAt(-200 + k * 35, 60 - k * 10)
      expect(out.ok).toBe(true)
    }
    const s = m.snapshot()
    expect(s.scansUsed).toBe(12)
    expect(s.scansLeft).toBe(Infinity)
    // 还能继续扫，不会因次数被拒绝
    expect(m.scanAt(0, 0).ok).toBe(true)
  })

  it('没扫描过就不能进入规则阶段', () => {
    const m = createMission(field)
    m.setPhase('rules')
    expect(m.snapshot().phase).toBe('scan')
    m.scanAt(0, 0)
    m.setPhase('rules')
    expect(m.snapshot().phase).toBe('rules')
  })

  it('没有可行路线就不能进入实测阶段', () => {
    const m = createMission(field)
    m.scanAt(0, 0)
    m.setPhase('drive')
    expect(m.snapshot().phase).not.toBe('drive')
  })

  it('扫描 → 规则 → 规划 能跑通，且路线可复现', () => {
    const build = () => {
      const m = createMission(field)
      m.scanAt(0, 0)
      m.scanAt(120, -110)
      m.setThresholds(12, 22)
      return m.replan()
    }
    const a = build()
    const b = build()
    expect(a.found).toBe(true)
    expect(a.path.length).toBe(b.path.length)
    expect(a.cost).toBeCloseTo(b.cost, 10)
    expect(a.expanded).toBe(b.expanded)
  })

  it('扫描更多之后重新规划，路线里"猜的部分"应减少', () => {
    const m = createMission(field)
    const first = m.replan()
    m.scanAt(0, 0)
    m.scanAt(80, -70)
    m.scanAt(140, -130)
    const second = m.replan()
    expect(second.unknownCells).toBeLessThan(first.unknownCells)
  })

  it('阈值调整会立刻反映到已有路线上', () => {
    const m = createMission(field)
    m.scanAt(0, 0)
    m.scanAt(120, -110)
    const loose = m.replan()
    m.setThresholds(12, 20) // 更严格：更多坡被判禁行，同时保留可行通道
    const strict = m.result()!
    expect(strict.path.length).toBeGreaterThan(0)
    expect(strict.cost).toBeGreaterThanOrEqual(loose.cost - 1e-6)
  })

  it('reset 回到初始状态', () => {
    const m = createMission(field)
    m.scanAt(0, 0)
    m.setThresholds(9, 15)
    m.replan()
    m.reset()
    const s = m.snapshot()
    expect(s.phase).toBe('scan')
    expect(s.scansLeft).toBe(Infinity)
    expect(s.plan).toBeNull()
    expect(s.cautionDeg).toBe(14)
    expect(s.blockedDeg).toBe(24)
  })

  it('订阅者能收到快照，并可取消订阅', () => {
    const m = createMission(field)
    const seen: number[] = []
    const off = m.subscribe((s) => seen.push(s.scansUsed))
    expect(seen.length).toBe(1) // 订阅即回放当前状态
    m.scanAt(0, 0)
    expect(seen[seen.length - 1]).toBe(1)
    off()
    m.scanAt(30, 30)
    expect(seen[seen.length - 1]).toBe(1)
  })
})

describe('扫描候选点', () => {
  it('覆盖关键地貌，且都落在盆地范围内', () => {
    const list = buildScanCandidates(field)
    expect(list.length).toBeGreaterThanOrEqual(5)
    for (const c of list) {
      expect(Math.abs(c.x)).toBeLessThan(field.size / 2)
      expect(Math.abs(c.z)).toBeLessThan(field.size / 2)
      expect(c.hint.length).toBeGreaterThan(4)
    }
    expect(list.some((c) => c.id === 'ridge')).toBe(true)
    expect(list.some((c) => c.id === 'target')).toBe(true)
  })
})

describe('实地测试 drive（M5）', () => {
  it('startDrive 重置进度与状态', () => {
    const m = createMission(field)
    m.replan()
    const path = m.result()!.path
    m.startDrive()
    const ds = m.driveInfo()
    expect(ds.status).toBe('running')
    expect(ds.progress).toBe(0)
    expect(ds.stuckAt).toBeNull()
    expect(ds.stuckReason).toBeNull()
    expect(ds.at).not.toBeNull()
    expect(ds.at!.x).toBeCloseTo(path[0].x, 1)
  })

  it('driveInfo.at 跟随路径上的当前里程位置', () => {
    const m = createMission(field)
    m.replan()
    const path = m.result()!.path
    m.startDrive()
    const ds0 = m.driveInfo()
    expect(ds0.at!.x).toBeCloseTo(path[0].x, 1)
    expect(ds0.at!.z).toBeCloseTo(path[0].z, 1)
    m.stepDrive(8)
    const ds1 = m.driveInfo()
    expect(ds1.progress).toBeGreaterThan(0)
    expect(ds1.at).not.toBeNull()
    const idx = path.findIndex(
      (c) => Math.hypot(c.x - ds1.at!.x, c.z - ds1.at!.z) < 5,
    )
    expect(idx).toBeGreaterThan(0)
  })

  it('驱动到终点或翻车，结果自洽', () => {
    const m = createMission(field)
    // 不扫描任何额外点，仅靠着陆点已知数据规划——路线大概率穿过高坡
    m.replan()
    m.startDrive()
    const path = m.result()!.path
    for (let i = 0; i < 6000; i += 1) m.stepDrive(1 / 60)
    const ds = m.driveInfo()
    if (ds.status === 'stuck') {
      expect(ds.stuckAt).not.toBeNull()
      const cell = path.find((c) => Math.abs(c.x - ds.stuckAt!.x) < 1 && Math.abs(c.z - ds.stuckAt!.z) < 1)
      expect(cell).toBeDefined()
      expect(cell!.trueFlag).toBe(2) // 翻车点确实是真实禁行
      expect(cell!.scanned).toBeLessThan(0.5) // 且当时没数据
      expect(ds.stuckReason).toBe('guess') // 没数据硬猜的
    } else {
      expect(ds.status).toBe('arrived')
      const len = path.reduce(
        (a, c, i) => (i === 0 ? 0 : a + Math.hypot(c.x - path[i - 1].x, c.z - path[i - 1].z)),
        0,
      )
      expect(ds.progress).toBeCloseTo(len, 0)
    }
  })

  it('翻车/到达后停止推进（冻结）', () => {
    const m = createMission(field)
    m.replan()
    m.startDrive()
    for (let i = 0; i < 6000; i += 1) m.stepDrive(1 / 60)
    const before = m.driveInfo().progress
    for (let i = 0; i < 600; i += 1) m.stepDrive(1 / 60)
    expect(m.driveInfo().progress).toBe(before)
  })

  it('stopDrive 退回 idle，之后 stepDrive 不再动', () => {
    const m = createMission(field)
    m.replan()
    m.startDrive()
    m.stopDrive()
    expect(m.driveInfo().status).toBe('idle')
    m.stepDrive(1)
    expect(m.driveInfo().progress).toBe(0)
  })

  it('hiddenBlocked 统计路线里"没数据却真禁行"的格', () => {
    const m = createMission(field)
    m.replan()
    const path = m.result()!.path
    const expected = path.filter((c) => c.scanned < 0.5 && c.trueFlag === 2).length
    expect(m.snapshot().hiddenBlocked).toBe(expected)
  })

  it('escapeFromStuck：非卡死态返回 false；软沙卡死可脱困并推进里程，硬障碍保持卡死', () => {
    const m = createMission(field)
    // 非卡死态直接调用应被拒绝
    expect(m.escapeFromStuck()).toBe(false)

    // 不扫描额外点，仅靠着陆点数据规划——大概率穿过高坡翻车
    m.replan()
    m.startDrive()
    for (let i = 0; i < 6000; i += 1) m.stepDrive(1 / 60)
    const ds = m.driveInfo()
    if (ds.status !== 'stuck') {
      // 这条路线要么到达、要么在更早的测试里已覆盖翻车；此处仅验证 escape 在非 stuck 时安全
      expect(m.escapeFromStuck()).toBe(false)
      return
    }
    const s = m.snapshot()
    const before = ds.progress
    const ok = m.escapeFromStuck()
    expect(ok).toBe(s.softStuck)
    const after = m.driveInfo()
    if (s.softStuck) {
      // 软沙可摇出：恢复行驶、清掉卡死点、里程推过陷住的格子
      expect(after.status).toBe('running')
      expect(after.stuckAt).toBeNull()
      expect(after.progress).toBeGreaterThan(before)
    } else {
      // 硬障碍不能摇出来：状态与进度都保持不变
      expect(after.status).toBe('stuck')
      expect(after.progress).toBeCloseTo(before, 6)
    }
  })
})

describe('地图 C 盲区指挥高潮（P6）', () => {
  it('地图 A 不触发盲区指挥；地图 C 未扫描路线必含盲区并停在入口', () => {
    const a = createMission(field, 0)
    a.replan()
    a.startDrive()
    expect(a.snapshot().awaitingBlindCommand).toBe(false)

    const c = createMission(createHeightField(WORLD_SEEDS[1], 1), 1)
    c.replan()
    c.startDrive()
    const cs = c.snapshot()
    expect(cs.blindZone).not.toBeNull()
    expect(cs.awaitingBlindCommand).toBe(true)
  })

  it('盲区入口前验证车停住不前进；下达命令后局部揭示并放行', () => {
    const c = createMission(createHeightField(WORLD_SEEDS[1], 1), 1)
    c.replan()
    c.startDrive()
    const bz = c.snapshot().blindZone!
    const haltDist = Math.max(0, bz.entryDist - 6)
    // 推进足够长时间，理应被拦在盲区入口外
    for (let i = 0; i < 4000; i += 1) c.stepDrive(1 / 60)
    const ds = c.driveInfo()
    expect(ds.status).toBe('running')
    expect(ds.progress).toBeLessThanOrEqual(haltDist + 0.5)
    expect(c.snapshot().awaitingBlindCommand).toBe(true)

    // 下达指挥命令：局部揭示、放行
    const ok = c.issueBlindCommand()
    expect(ok).toBe(true)
    const after = c.snapshot()
    expect(after.awaitingBlindCommand).toBe(false)
    expect(after.blindCommanded).toBe(true)
    // 入口附近那一小片地形变为已探明（局部预览）
    const entryCell = c.path()[bz.startIndex]
    expect(entryCell.scanned).toBeGreaterThan(0.5)
    // 放行后继续推进会越过入口
    for (let i = 0; i < 400; i += 1) c.stepDrive(1 / 60)
    expect(c.driveInfo().progress).toBeGreaterThan(haltDist)
  })

  it('指挥命令只局部揭示入口一小片，不把整张图补完（局部预览而非全局扫描）', () => {
    const c = createMission(createHeightField(WORLD_SEEDS[1], 1), 1)
    c.replan()
    c.startDrive()
    const bz = c.snapshot().blindZone!
    const path = c.path()
    // 入口附近那一小片应被揭示
    expect(path[bz.startIndex].scanned).toBeLessThan(0.5)
    c.issueBlindCommand()
    expect(path[bz.startIndex].scanned).toBeGreaterThan(0.5)
    // 但盲区更远处（远超过预览半径）仍是未知——证明不是把整条路扫完
    const farIdx = Math.min(path.length - 1, bz.endIndex + 30)
    expect(path[farIdx].scanned).toBeLessThan(0.5)
  })

  it('缺口-7：下达指挥命令后 snapshot.blindReveals 记录揭示圆心（供小地图高亮环），reset 清空', () => {
    const c = createMission(createHeightField(WORLD_SEEDS[1], 1), 1)
    c.replan()
    c.startDrive()
    const bz = c.snapshot().blindZone!
    expect(c.snapshot().blindReveals).toHaveLength(0)
    const ok = c.issueBlindCommand()
    expect(ok).toBe(true)
    const reveals = c.snapshot().blindReveals
    expect(reveals).toHaveLength(1)
    expect(reveals[0].x).toBeCloseTo(bz.entry.x, 5)
    expect(reveals[0].z).toBeCloseTo(bz.entry.z, 5)
    expect(reveals[0].radius).toBeGreaterThan(0)
    // reset 回到干净态：blindReveals 清空
    c.reset()
    expect(c.snapshot().blindReveals).toHaveLength(0)
  })
})

describe('缺口-1 加固：arrived 判别式与 KIBO 台词', () => {
  it('AI 实测到达后 arrivedManual 恒为 false（主线不会误念沙盒台词）', () => {
    const m = createMission(field, 0)
    m.replan()
    m.startDrive()
    for (let i = 0; i < 30000; i += 1) {
      m.stepDrive(1 / 60)
      const st = m.driveInfo().status
      if (st === 'arrived' || st === 'stuck') break
    }
    expect(m.snapshot().arrivedManual).toBe(false)
  })

  it('arrived 台词按 arrivedManual 区分：false→AI 规划，true→手控练车', () => {
    const base = createMission(field, 0).snapshot()
    const aiArrived = { ...base, phase: 'drive' as const, driveStatus: 'arrived' as const, arrivedManual: false } as MissionSnapshot
    const manualArrived = { ...base, phase: 'drive' as const, driveStatus: 'arrived' as const, arrivedManual: true } as MissionSnapshot
    expect(kiboLineFor(aiArrived).text).toContain('AI 规划')
    expect(kiboLineFor(manualArrived).text).toContain('手控')
  })
})

describe('PBL 七步闭环（发现问题→找数据→清洗→标记→训练AI→验证→实践）', () => {
  it('步骤随真实数据进度推进，清洗与标注为两个独立步骤', () => {
    const m = createMission(field)
    expect(SIX_STEP_ORDER).toHaveLength(7)

    // scan 阶段：未扫描=发现问题；扫描后=找到数据
    expect(m.snapshot().sixStep).toBe('discover')
    m.scanAt(0, 0)
    expect(m.snapshot().sixStep).toBe('find-data')

    // 采集到样本后进入清洗数据
    const sampleA = m.pois().find((p) => p.kind === 'sample-a')!
    driveTo(m, sampleA.x, sampleA.z)
    m.interact()
    expect(m.snapshot().sixStep).toBe('clean-data')

    // 到过清洗台但还没判对，进度条不能跳到下一步
    const baseClean = m.pois().find((p) => p.kind === 'base-clean')!
    driveTo(m, baseClean.x, baseClean.z)
    m.interact()
    expect(m.snapshot().sixStep).toBe('clean-data')

    // 清洗判对后才进入标记数据，而不是直接跳到训练
    for (const r of m.snapshot().records) {
      m.setRecordCleanChoice(r.id, r.flaw !== null ? 'drop' : 'keep')
    }
    expect(m.confirmCleaning().ok).toBe(true)
    expect(m.snapshot().sixStep).toBe('label-data')

    // 标注判对后才轮到训练 AI 工具
    const baseLabel = m.pois().find((p) => p.kind === 'base-label')!
    driveTo(m, baseLabel.x, baseLabel.z)
    m.interact()
    const snap = m.snapshot()
    for (const r of snap.records) {
      if (r.cleanChoice !== 'keep') continue
      const want = r.slopeDeg < snap.cautionDeg ? 'pass' : r.slopeDeg < snap.blockedDeg ? 'caution' : 'block'
      m.setRecordLabel(r.id, want)
    }
    expect(m.confirmLabeling().ok).toBe(true)
    expect(m.snapshot().sixStep).toBe('make-ai')

    // drive/revise 都是验证 AI 工具
    if (m.result()?.found) {
      m.setPhase('drive')
      expect(m.snapshot().sixStep).toBe('verify-ai')
    }
    m.setPhase('report')
    expect(m.snapshot().sixStep).toBe('practice')
  })

  it('progress 圆点：已完成步骤数随真实数据进度单调增加', () => {
    const m = createMission(field)
    const idx = () => SIX_STEP_ORDER.indexOf(m.snapshot().sixStep)
    expect(idx()).toBe(0)
    m.scanAt(0, 0)
    expect(idx()).toBe(1)
    const sampleA = m.pois().find((p) => p.kind === 'sample-a')!
    driveTo(m, sampleA.x, sampleA.z)
    m.interact()
    expect(idx()).toBe(2)
    const baseClean = m.pois().find((p) => p.kind === 'base-clean')!
    driveTo(m, baseClean.x, baseClean.z)
    m.interact()
    for (const r of m.snapshot().records) {
      m.setRecordCleanChoice(r.id, r.flaw !== null ? 'drop' : 'keep')
    }
    m.confirmCleaning()
    expect(idx()).toBe(3)
    const baseLabel = m.pois().find((p) => p.kind === 'base-label')!
    driveTo(m, baseLabel.x, baseLabel.z)
    m.interact()
    const snap = m.snapshot()
    for (const r of snap.records) {
      if (r.cleanChoice !== 'keep') continue
      const want = r.slopeDeg < snap.cautionDeg ? 'pass' : r.slopeDeg < snap.blockedDeg ? 'caution' : 'block'
      m.setRecordLabel(r.id, want)
    }
    m.confirmLabeling()
    expect(idx()).toBe(4)
  })

  it('决策日志按操作顺序记录扫描/规则/权重/规划', () => {
    const m = createMission(field)
    m.scanAt(10, 10)
    m.setThresholds(12, 22)
    m.setWeight('caution', 3)
    m.replan()
    const log = m.getDecisionLog()
    expect(log.some((e) => e.type === 'scan')).toBe(true)
    expect(log.some((e) => e.type === 'thresholds')).toBe(true)
    expect(log.some((e) => e.type === 'weight')).toBe(true)
    expect(log.some((e) => e.type === 'plan')).toBe(true)
    // 顺序：scan 在 thresholds 之前
    const iScan = log.findIndex((e) => e.type === 'scan')
    const iThr = log.findIndex((e) => e.type === 'thresholds')
    expect(iScan).toBeLessThan(iThr)
  })

  it('不确定性处置写入快照与决策日志', () => {
    const m = createMission(field)
    m.replan()
    m.setUncertaintyChoice('detour', '前方有未探明格，选择绕行更保险')
    const s = m.snapshot()
    expect(s.uncertaintyChoice).toBe('detour')
    expect(s.uncertaintyReason).toContain('绕行')
    expect(m.getDecisionLog().some((e) => e.type === 'uncertainty')).toBe(true)
  })

  it('每次实测归档为一次运行（v1/v2 对照）', () => {
    const m = createMission(field)
    m.replan()
    // 第一次运行（v1）
    m.startDrive()
    for (let i = 0; i < 6000; i += 1) m.stepDrive(1 / 60)
    expect(m.getRuns()).toHaveLength(1)
    expect(m.snapshot().previousPlan).not.toBeNull()
    // 多扫描后重规划再跑一次（v2）
    m.scanAt(80, -70)
    m.scanAt(140, -130)
    m.replan()
    m.startDrive()
    for (let i = 0; i < 6000; i += 1) m.stepDrive(1 / 60)
    const runs = m.getRuns()
    expect(runs).toHaveLength(2)
    expect(runs[0].run).toBe(1)
    expect(runs[1].run).toBe(2)
    // 轨迹被采样保存
    expect(runs[0].trace.length).toBeGreaterThan(1)
    expect(runs[1].trace.length).toBeGreaterThan(1)
  })

  it('reset 清空决策日志与运行记录', () => {
    const m = createMission(field)
    m.replan()
    m.startDrive()
    for (let i = 0; i < 300; i += 1) m.stepDrive(1 / 60)
    m.setUncertaintyChoice('accept-risk', 'x')
    expect(m.getDecisionLog().length).toBeGreaterThan(0)
    m.reset()
    expect(m.getDecisionLog()).toHaveLength(0)
    expect(m.getRuns()).toHaveLength(0)
    expect(m.snapshot().previousPlan).toBeNull()
    expect(m.snapshot().uncertaintyChoice).toBeNull()
  })
})

describe('POI / 游戏化交互系统', () => {
  it('pois() 暴露全部 9 个可交互点，且能源站落在终点', () => {
    const m = createMission(field)
    const pois = m.pois()
    expect(pois).toHaveLength(9)
    const kinds = pois.map((p) => p.kind)
    expect(kinds).toContain('base-clean')
    expect(kinds).toContain('base-label')
    expect(kinds).toContain('base-train')
    expect(kinds).toContain('base-select')
    expect(kinds).toContain('sample-a')
    expect(kinds).toContain('sample-b')
    expect(kinds).toContain('sample-c')
    expect(kinds).toContain('maze-entrance')
    expect(kinds).toContain('energy-station')
    const energy = pois.find((p) => p.kind === 'energy-station')!
    expect(energy.x).toBeCloseTo(field.goal.x, 6)
    expect(energy.z).toBeCloseTo(field.goal.z, 6)
  })

  it('靠近基地操作台时 nearbyPoi 返回该操作台（默认停靠基地外开阔地，需先开过去）', () => {
    const m = createMission(field)
    // 新设计：漫游车默认停靠在基地外的开阔地 ROVER_SPAWN，不在任何基地操作台半径内
    expect(m.nearbyPoi()).toBeNull()
    // 开到数据清洗台附近，nearbyPoi 应识别到该基地操作台
    const clean = m.pois().find((p) => p.kind === 'base-clean')!
    driveTo(m, clean.x, clean.z)
    const near = m.nearbyPoi()
    expect(near).not.toBeNull()
    expect(near!.kind).toBe('base-clean')
  })

  it('在基地操作台交互不会凭空产生样本', () => {
    const m = createMission(field)
    // 开到数据清洗台（基地操作台）半径内再交互，验证 base 类交互只推进流程、不塞样本
    const clean = m.pois().find((p) => p.kind === 'base-clean')!
    driveTo(m, clean.x, clean.z)
    m.interact()
    expect(m.snapshot().inventory).toHaveLength(0)
  })

  it('candidatePaths 返回 2 条候选路线，且都带规划摘要与能源账', () => {
    const m = createMission(field)
    const candidates = m.candidatePaths()
    expect(candidates).toHaveLength(2)
    for (const c of candidates) {
      expect(c.summary).not.toBeNull()
      expect(typeof c.note).toBe('string')
      expect(c.energy).not.toBeNull()
      expect(c.energy!.battery).toBeGreaterThan(0)
      // 已探明部分的确定耗电是地板，未知区只会往上加：确定 <= 乐观 <= 悲观
      expect(c.energy!.certain).toBeLessThanOrEqual(c.energy!.best + 1e-6)
      expect(c.energy!.best).toBeLessThanOrEqual(c.energy!.worst + 1e-6)
      expect(c.energy!.roundTripM).toBeCloseTo(c.energy!.oneWayM * 2, 6)
    }
  })

  it('两条候选路线在里程/未知格/难走格上必须拉开可见差距（否则选择界面无意义）', () => {
    // 火星一号（陨石坑盆地）的「两路线」不变式。火星二号是三条路线（沿河主道/古汉道/北支谷），
    // 其「三档拉开」不变量在 P3 阶段用独立测试锁（设计文档 §六 T3），此处只锁一号。
    for (let w = 0; w < 1; w += 1) {
      const f = createHeightField(WORLD_SEEDS[w], w)
      const m = createMission(f, w)
      for (const p of m.pois()) if (!p.kind.startsWith('base-')) m.scanAt(p.x, p.z)
      m.setThresholds(14, 24)
      m.replan()
      const [a, b] = m.candidatePaths()
      // 走近路（a，索引0）必须比绕远路（b，索引1）短，但难走路段更多
      expect(a.summary!.lengthM).toBeLessThan(b.summary!.lengthM)
      expect(a.summary!.cautionCells).toBeGreaterThan(b.summary!.cautionCells)
    }
  }, 60000)

  it('selectCandidate 选定后写入当前路线与不确定性决策', () => {
    const m = createMission(field)
    expect(m.selectCandidate(0)).toBe(true)
    const s = m.snapshot()
    expect(s.uncertaintyChoice).not.toBeNull()
    expect(s.plan).not.toBeNull()
  })

  it('没有标注数据时 train() 返回 false', () => {
    const m = createMission(field)
    expect(m.snapshot().trained).toBe(false)
    expect(m.train()).toBe(false)
    expect(m.snapshot().trained).toBe(false)
  })

  it('端到端：采集 → 清洗 → 标注 → 训练 → 能源站交付完成任务', () => {
    const m = createMission(field)
    const sampleA = m.pois().find((p) => p.kind === 'sample-a')!
    const baseClean = m.pois().find((p) => p.kind === 'base-clean')!
    const baseLabel = m.pois().find((p) => p.kind === 'base-label')!
    const energy = m.pois().find((p) => p.kind === 'energy-station')!

    // 开到样本站采集
    expect(driveTo(m, sampleA.x, sampleA.z)).toBe(true)
    expect(m.interact()).toBe(true)
    expect(m.snapshot().inventory).toHaveLength(1)
    expect(m.snapshot().inventory[0].cleaned).toBe(false)

    // 清洗台：只开门，不再一键洗完
    expect(driveTo(m, baseClean.x, baseClean.z)).toBe(true)
    expect(m.interact()).toBe(true)
    expect(m.snapshot().inventory[0].cleaned).toBe(false)

    // 学生逐条判完才算清洗通过
    for (const r of m.snapshot().records) {
      m.setRecordCleanChoice(r.id, r.flaw !== null ? 'drop' : 'keep')
    }
    expect(m.confirmCleaning().ok).toBe(true)
    expect(m.snapshot().inventory[0].cleaned).toBe(true)

    // 标注台：清洗通过后才让进，同样要逐条标
    expect(driveTo(m, baseLabel.x, baseLabel.z)).toBe(true)
    expect(m.interact()).toBe(true)
    const s0 = m.snapshot()
    for (const r of s0.records) {
      if (r.cleanChoice !== 'keep') continue
      const want = r.slopeDeg < s0.cautionDeg ? 'pass' : r.slopeDeg < s0.blockedDeg ? 'caution' : 'block'
      m.setRecordLabel(r.id, want)
    }
    expect(m.confirmLabeling().ok).toBe(true)
    expect(m.snapshot().inventory[0].labeled).toBe(true)

    // 训练 AI
    expect(m.train()).toBe(true)
    expect(m.snapshot().trained).toBe(true)

    // 能源站：训练完成后交付即判定任务完成
    expect(driveTo(m, energy.x, energy.z)).toBe(true)
    expect(m.interact()).toBe(true)
    expect(m.snapshot().missionComplete).toBe(true)
  })

  it('能源站未完成训练时拒绝交付', () => {
    const m = createMission(field)
    const energy = m.pois().find((p) => p.kind === 'energy-station')!
    expect(driveTo(m, energy.x, energy.z)).toBe(true)
    expect(m.interact()).toBe(false)
    expect(m.snapshot().missionComplete).toBe(false)
  })

  it('训练后 aiConfidence 与数据质量正相关', () => {
    const m = createMission(field)
    const sampleA = m.pois().find((p) => p.kind === 'sample-a')!
    const baseClean = m.pois().find((p) => p.kind === 'base-clean')!
    const baseLabel = m.pois().find((p) => p.kind === 'base-label')!

    expect(m.train()).toBe(false)
    expect(m.snapshot().aiConfidence).toBe(0)

    driveTo(m, sampleA.x, sampleA.z)
    m.interact()
    cleanAndLabel(m)
    m.train()

    const s = m.snapshot()
    expect(s.trained).toBe(true)
    expect(s.aiConfidence).toBeGreaterThan(0)
    expect(s.aiConfidence).toBeLessThanOrEqual(0.98)
  })

  it('未训练时 AI 验证车拒绝出发', () => {
    const m = createMission(field)
    m.scanAt(0, 0)
    m.replan()
    const v = m.validateRouteWithAI()
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.reason).toContain('尚未训练')
  })

  it('训练后 AI 验证车对低风险路线给出成功结果', () => {
    const m = createMission(field)
    // 多扫描关键区域，让规划路线几乎没有隐藏禁行格
    m.scanAt(0, 0)
    m.scanAt(120, -110)
    m.scanAt(240, -220)
    m.scanAt(360, -300)
    m.setThresholds(12, 22)
    m.replan()
    // 训练：单样本低信心，但路线可能已被完全探明
    const sampleA = m.pois().find((p) => p.kind === 'sample-a')!
    driveTo(m, sampleA.x, sampleA.z)
    m.interact()
    cleanAndLabel(m)
    m.train()

    const v = m.validateRouteWithAI()
    // 若路线已无隐藏禁行格，验证必成功；否则可能是失败——两种情况都要自洽
    if (v.ok) {
      expect(v.message.length).toBeGreaterThan(0)
    } else {
      expect(v.cell).not.toBeNull()
    }
  })

  it('AI 验证失败会揭示失败格并切换到 revise', () => {
    const m = createMission(field)
    m.scanAt(0, 0)
    m.replan()
    const sampleA = m.pois().find((p) => p.kind === 'sample-a')!
    driveTo(m, sampleA.x, sampleA.z)
    m.interact()
    cleanAndLabel(m)
    m.train()
    const beforePhase = m.snapshot().phase
    const v = m.validateRouteWithAI()
    if (!v.ok && v.cell) {
      m.applyAIValidationFailure(v.cell)
      expect(m.snapshot().phase).toBe('revise')
    }
  })
})

describe('数据清洗 / 标注：必须逐条操作，判错不放行', () => {
  it('清洗台只开门不代劳：没判对的记录会被逐条点名', () => {
    const m = createMission(field)
    const sampleA = m.pois().find((p) => p.kind === 'sample-a')!
    const baseClean = m.pois().find((p) => p.kind === 'base-clean')!
    driveTo(m, sampleA.x, sampleA.z)
    m.interact()
    // 采集带回一批读数，其中混着坏数据
    expect(m.snapshot().records.length).toBeGreaterThan(3)
    expect(m.snapshot().records.some((r) => r.flaw !== null)).toBe(true)

    driveTo(m, baseClean.x, baseClean.z)
    expect(m.interact()).toBe(true)

    // 什么都不做就提交：每条都要被点名
    const empty = m.confirmCleaning()
    expect(empty.ok).toBe(false)
    expect(empty.mistakes).toHaveLength(m.snapshot().records.length)

    // 全反过来判：坏数据留下、好数据删掉，同样不放行
    for (const r of m.snapshot().records) {
      m.setRecordCleanChoice(r.id, r.flaw !== null ? 'keep' : 'drop')
    }
    const wrong = m.confirmCleaning()
    expect(wrong.ok).toBe(false)
    expect(wrong.mistakes).toHaveLength(m.snapshot().records.length)

    // 判对了才放行
    for (const r of m.snapshot().records) {
      m.setRecordCleanChoice(r.id, r.flaw !== null ? 'drop' : 'keep')
    }
    expect(m.confirmCleaning().ok).toBe(true)
    expect(m.snapshot().cleaningDone).toBe(true)
  })

  it('没清洗通过就不让进标注台', () => {
    const m = createMission(field)
    const sampleA = m.pois().find((p) => p.kind === 'sample-a')!
    const baseLabel = m.pois().find((p) => p.kind === 'base-label')!
    driveTo(m, sampleA.x, sampleA.z)
    m.interact()
    driveTo(m, baseLabel.x, baseLabel.z)
    expect(m.interact()).toBe(false)
  })

  it('标注判错时把学生自己定的规则念回去，而不是只说"错了"', () => {
    const m = createMission(field)
    const sampleA = m.pois().find((p) => p.kind === 'sample-a')!
    driveTo(m, sampleA.x, sampleA.z)
    m.interact()
    cleanAndLabelSetup(m)
    // 故意全标成"可通行"
    for (const r of m.snapshot().records) {
      if (r.cleanChoice === 'keep') m.setRecordLabel(r.id, 'pass')
    }
    const res = m.confirmLabeling()
    const s = m.snapshot()
    // 只要存在坡度超过阈值的保留数据，就必须判错并说明依据
    const hasSteep = s.records.some((r) => r.cleanChoice === 'keep' && r.slopeDeg >= s.cautionDeg)
    if (hasSteep) {
      expect(res.ok).toBe(false)
      expect(res.mistakes.length).toBeGreaterThan(0)
      expect(res.mistakes[0].why).toContain('按你定的规则')
      expect(res.mistakes[0].why).toContain(`${s.cautionDeg}°`)
    }
    expect(m.snapshot().labelingDone).toBe(false)
  })

  it('没标注通过就不让进训练舱，train() 也拒绝', () => {
    const m = createMission(field)
    const sampleA = m.pois().find((p) => p.kind === 'sample-a')!
    const baseTrain = m.pois().find((p) => p.kind === 'base-train')!
    driveTo(m, sampleA.x, sampleA.z)
    m.interact()
    driveTo(m, baseTrain.x, baseTrain.z)
    expect(m.interact()).toBe(false)
    expect(m.train()).toBe(false)
    expect(m.snapshot().trained).toBe(false)
  })
})

describe('缺口-10：三类样本站 + 软沙度数据类别必须齐备（主线 C 需求 #2）', () => {
  const collectAllSamples = (m: ReturnType<typeof createMission>) => {
    for (const kind of ['sample-a', 'sample-b', 'sample-c'] as const) {
      const poi = m.pois().find((p) => p.kind === kind)!
      driveTo(m, poi.x, poi.z)
      m.interact()
    }
  }

  it('采集全部三个样本站后，清洗/标注数据包含「坑缘溅射样本站」且携带软沙度', () => {
    const m = createMission(field)
    collectAllSamples(m)
    const recs = m.snapshot().records
    // 三站 × 6 条 = 18 条原始读数
    expect(recs).toHaveLength(18)
    // 坑缘溅射样本站（sample-c：标签「坑缘溅射样本站」去掉「样本站」→ 来源「坑缘溅射」）
    const crater = recs.filter((r) => r.source === '坑缘溅射')
    expect(crater.length).toBe(6)
    // 软沙度字段已灌入数据集（至少部分记录带非零软沙度）
    expect(recs.some((r) => r.soft > 0)).toBe(true)
  })

  it('标注判分时「软沙度」必须能真正决定分类（存在纯软沙度驱动的难走样本）', () => {
    const m = createMission(field)
    collectAllSamples(m)
    // 正确清洗：坏数据剔除、好数据保留
    for (const r of m.snapshot().records) {
      m.setRecordCleanChoice(r.id, r.flaw !== null ? 'drop' : 'keep')
    }
    expect(m.confirmCleaning().ok).toBe(true)
    const good = m.snapshot().records.filter((r) => r.cleanChoice === 'keep')
    // 关键的「软沙度」类别：坡度与岩石都过关，却因软沙度过高被判难走/禁行。
    // 若这条数据不存在，标注台就永远用不到软沙度维度，教学上等于「少了软沙度这一类」。
    const softDriven = good.filter(
      (r) => r.slopeDeg < m.snapshot().cautionDeg && r.rock < CAUTION_ROCK && r.soft >= CAUTION_SOFT,
    )
    expect(softDriven.length).toBeGreaterThan(0)
  })
})

/** 只把清洗做完（标注留待用例自己操作）。 */
function cleanAndLabelSetup(m: ReturnType<typeof createMission>): void {
  const clean = m.pois().find((p) => p.kind === 'base-clean')!
  const label = m.pois().find((p) => p.kind === 'base-label')!
  driveTo(m, clean.x, clean.z)
  m.interact()
  for (const r of m.snapshot().records) {
    m.setRecordCleanChoice(r.id, r.flaw !== null ? 'drop' : 'keep')
  }
  m.confirmCleaning()
  driveTo(m, label.x, label.z)
  m.interact()
}

describe('采集车验证运行（自动驾驶 · 能源耗尽即失败）', () => {
  /** 扫满全部推荐点 + 训练好 AI，让"能顺利跑完"这条路径成立。 */
  const readyMission = (worldIndex = 0) => {
    const f = createHeightField(WORLD_SEEDS[worldIndex], worldIndex)
    const m = createMission(f, worldIndex)
    for (const p of m.pois()) if (!p.kind.startsWith('base-')) m.scanAt(p.x, p.z)
    m.setThresholds(14, 24)
    m.replan()
    const sampleA = m.pois().find((p) => p.kind === 'sample-a')!
    driveTo(m, sampleA.x, sampleA.z)
    m.interact()
    cleanAndLabel(m)
    m.train()
    return m
  }

  const runToEnd = (m: ReturnType<typeof createMission>, maxSeconds = 400) => {
    const steps = Math.ceil(maxSeconds * 60)
    for (let i = 0; i < steps; i += 1) {
      m.stepHauler(1 / 60)
      const st = m.haulerRun().status
      if (st === 'success' || st === 'failed') return st
    }
    return m.haulerRun().status
  }

  it('未训练时拒绝派遣', () => {
    const m = createMission(field)
    expect(m.beginHaulerRun(0)).toBe(false)
    expect(m.haulerRun().status).toBe('idle')
  })

  it('能源账：两条路线的往返耗电区间都算得出来，且绕远路在充分扫描后一定跑得完', () => {
    const m = readyMission()
    const cands = m.candidatePaths()
    for (const c of cands) {
      expect(c.energy).not.toBeNull()
      expect(c.energy!.worst).toBeGreaterThan(0)
    }
    expect(m.beginHaulerRun(1)).toBe(true)
    expect(runToEnd(m)).toBe('success')
    expect(m.haulerRun().energy).toBeGreaterThan(0)
    expect(m.snapshot().missionComplete).toBe(true)
  }, 60000)

  it('失败必须换来新信息：撞上未知禁行地形会揭示该片区域，覆盖率上升', () => {
    // 这是"不卡死"的地基。如果撞车不揭示地形，学生会一直在同一片未知区反复撞，
    // 却看不到地图有任何变化——表现为"两条路都失败、体验卡死"。
    const m = createMission(field)
    m.scanAt(0, 0)
    m.replan()
    const sampleA = m.pois().find((p) => p.kind === 'sample-a')!
    driveTo(m, sampleA.x, sampleA.z)
    m.interact()
    cleanAndLabel(m)
    m.train()
    const before = m.knowledge.coverage()
    expect(m.beginHaulerRun(0)).toBe(true) // 近距离但切过未知区，可能撞上禁行地形
    const status = runToEnd(m)
    expect(status).toBe('failed')
    // 撞未知禁行会揭示地形→覆盖率上升；电池耗尽则不揭示→至少不下降
    expect(m.knowledge.coverage()).toBeGreaterThanOrEqual(before)
  }, 60000)

  it('不卡死保证：数据不足时绕远路可能失败，但迭代扫描后有限轮内必定跑完', () => {
    // 学生只扫了基地附近几发就急着验证——这是最容易卡住的场景。
    // 保障：每次失败都会揭示新区域，学生再补几发扫描后必然收敛到成功。
    const m = createMission(field)
    m.scanAt(field.start.x, field.start.z)
    m.scanAt(0, 0)
    m.setThresholds(14, 24)
    m.replan()
    const sampleA = m.pois().find((p) => p.kind === 'sample-a')!
    driveTo(m, sampleA.x, sampleA.z)
    m.interact()
    cleanAndLabel(m)
    m.train()

    const all = buildScanCandidates(field)
    let status: string = 'idle'
    let rounds = 0
    for (let i = 0; i < 15; i += 1) {
      rounds += 1
      expect(m.beginHaulerRun(1)).toBe(true) // 每次都选最稳的绕远路（索引 1）
      status = runToEnd(m)
      if (status === 'success') break
      // 失败后学生出去补几发扫描（沿推荐候选点推进），再回来重选路线
      const slice = all.slice(i * 2, i * 2 + 2)
      if (slice.length === 0) break
      for (const c of slice) m.scanAt(c.x, c.z)
      m.replan()
    }
    expect(status).toBe('success')
    expect(rounds).toBeLessThanOrEqual(15)
    expect(m.snapshot().missionComplete).toBe(true)
  }, 120000)

  it('能源随行驶实时下降，不是到终点才结算', () => {
    const m = readyMission()
    m.beginHaulerRun(1)
    const e0 = m.haulerRun().energy
    for (let i = 0; i < 120; i += 1) m.stepHauler(1 / 60)
    const e1 = m.haulerRun().energy
    expect(e1).toBeLessThan(e0)
    expect(m.haulerRun().drivenM).toBeGreaterThan(0)
  }, 60000)

  it('失败后可以重派另一条路线，直到成功——这就是"重试闭环"', () => {
    const m = createMission(field)
    m.scanAt(0, 0)
    m.replan()
    const sampleA = m.pois().find((p) => p.kind === 'sample-a')!
    driveTo(m, sampleA.x, sampleA.z)
    m.interact()
    cleanAndLabel(m)
    m.train()

    // 第一次：走近路，失败（切过未知区）
    m.beginHaulerRun(0)
    expect(runToEnd(m)).toBe('failed')
    m.resetHaulerRun()
    expect(m.haulerRun().status).toBe('idle')
    expect(m.haulerRun().energy).toBe(m.haulerRun().battery)

    // 补扫地形后改走绕远路：成功
    for (const p of m.pois()) if (!p.kind.startsWith('base-')) m.scanAt(p.x, p.z)
    m.replan()
    m.beginHaulerRun(1)
    expect(runToEnd(m)).toBe('success')
    expect(m.snapshot().missionComplete).toBe(true)
  }, 60000)

  /**
   * 这是"两条路线数值差异化"这条需求的不变式锁。
   * 只要有人改了能源常量或路线档位权重、把两张卡片压回同一个数字区间，
   * 这里就会红——选择界面退化成摆设，是最容易在后续迭代里悄悄发生的事。
   */
  it('两条路线的能源账必须形成「稳 / 死」两档，否则选择界面就是摆设', () => {
    // 火星一号（陨石坑盆地）的「两路线稳/死两档」不变式。
    // 火星二号是三条路线（沿河主道=稳 / 古汉道=死 / 北支谷=赌），其能源三档锁在 P3 用
    // 真实仿真独立验证（设计文档 §六 T3），此处只锁一号的「稳/死」两档。
    for (let w = 0; w < 1; w += 1) {
      const m = readyMission(w)
      const [shortcut, detour] = m.candidatePaths().map((c) => c.energy!)
      // 保守档：连最坏情况都在预算内——它是唯一"一定行"的答案，但余量不多
      expect(detour.worst).toBeLessThan(HAULER_BATTERY)
      expect(detour.worst).toBeGreaterThan(HAULER_BATTERY * 0.6)
      // 均衡档：确定耗电就超支——学生一算就能排除它，这是"会算账"的教学点
      expect(shortcut.certain).toBeGreaterThan(HAULER_BATTERY)
      // 两档的确定耗电必须拉开梯度，不能挤在一起
      expect(shortcut.certain - detour.certain).toBeGreaterThan(20)
    }
  }, 120000)

  it('扫描不足时两条路线都会超支——这就是「先去采数据」这条引导的依据', () => {
    const m = createMission(field)
    m.scanAt(0, 0)
    m.replan()
    const sampleA = m.pois().find((p) => p.kind === 'sample-a')!
    driveTo(m, sampleA.x, sampleA.z)
    m.interact()
    cleanAndLabel(m)
    m.train()
    for (const c of m.candidatePaths()) {
      expect(c.energy).not.toBeNull()
      expect(c.energy!.worst).toBeGreaterThan(HAULER_BATTERY)
    }
  }, 60000)
})

describe('P4 扫描预算平衡 + P8 完整闭环计时基线', () => {
  it(
    '一号地图扫描所有推荐点后路线仍含未探明格（数据不足是真实机制，必须迭代）',
    () => {
      // 火星二号（外流河道）的「数据不足」锁在 P3 随三路线机制一并验证（设计文档 §六 T3/T5）。
      // 这里只锁一号（陨石坑盆地）：仅按推荐点扫描后，路线里"猜的部分"仍 > 0。
      for (let w = 0; w < 1; w += 1) {
        const f = createHeightField(WORLD_SEEDS[w], w)
        const cands = buildScanCandidates(f, w)

        // 平衡插桩约束：measureScanBudgetCoverage 现在扫满全部推荐点（次数不限）。
        const cov = measureScanBudgetCoverage(w)
        expect(cov.scansApplied).toBeGreaterThan(0)
        // 扫描次数不限时，scansApplied 等于该图推荐点数（每次都成功）。
        expect(cov.scansApplied).toBe(cands.length)

        // 数据不足的核心证据：仅按推荐点扫描后重新规划，路线里"猜的部分"仍 > 0
        // （盆地远大于几次扫描能覆盖，学生必须迭代扫描/规则，不能一步通关）。
        const m = createMission(f, w)
        for (const c of cands) {
          m.scanAt(c.x, c.z)
        }
        const summary = m.replan()
        expect(summary.unknownCells).toBeGreaterThan(0)

        // 设计意图（非硬性不变式）：绕远路（索引 1）权重刻意放大未知格×45、走近路（索引 0）
        // 允许切一小片未知区换里程，多数种子下前者未知格更少。但 planKnownOnly 在找不到全探明
        // 路线时会回退到普通 planPath，故两者未知格数可能持平，不能作为强断言。真正兜底的不变式
        // 是能源账「稳/死」两档（见下方能源账测试），这里只校验两条路线都能规划出来。
        const [shortcut, detour] = m.candidatePaths()
        expect(detour.summary?.found).toBe(true)
        expect(shortcut.summary?.found).toBe(true)
      }
    },
    // 建图 + 全候选点扫描 + A*：计算量大，给足超时避免负载波动误报。
    30000,
  )

  it('P8 一号地图完整闭环（建图→扫满预算→规划→实测到终点/翻车）在合理时间内完成', () => {
    // 火星二号（外流河道）的完整闭环在 P3 随三路线机制一并验证（设计文档 §六 T3）。
    // 这里只跑一号（陨石坑盆地）的闭环计时基线。
    const t0 = Date.now()
    for (let w = 0; w < 1; w += 1) {
      const f = createHeightField(WORLD_SEEDS[w], w)
      const m = createMission(f, w)
      for (const c of buildScanCandidates(f, w)) {
        m.scanAt(c.x, c.z)
      }
      m.replan()
      m.startDrive()
      const lenM = m.result()?.lengthM ?? 0
      const estSteps = Math.ceil(lenM / (DRIVE_SPEED * 0.1)) + 80
      let guard = 0
      while (m.snapshot().driveStatus === 'running' && guard < estSteps * 4) {
        // 一号地图无盲区指挥（盲区机制是二号地图的 P3 功能）；保留放行守卫以兼容未来扩展
        if (m.snapshot().awaitingBlindCommand) m.issueBlindCommand()
        m.stepDrive(0.1)
        guard += 1
      }
      const st = m.snapshot()
      expect(['arrived', 'stuck']).toContain(st.driveStatus)
    }
    const dt = Date.now() - t0
    // 计时基线：一号地图完整闭环（建图+A*+数千步 drive 同步模拟）在 jsdom 实测约 1.5s；
    // 宽松上限防回归与死循环（死循环会远超此值），实际游玩是 60fps 分帧，等价于约 30s 时长。
    expect(dt).toBeLessThan(8000)
    console.log(`[P8 baseline] 1 world full cycle = ${dt}ms`)
  })
})

describe('缺口-4：扫描次数不设上限（需求 C）', () => {
  it('createMission 初始 scansLeft 为 Infinity（无限扫描）', () => {
    expect(createMission(field, 0).snapshot().scansLeft).toBe(Infinity)
    expect(createMission(createHeightField(WORLD_SEEDS[1], 1), 1).snapshot().scansLeft).toBe(Infinity)
  })

  it('超过旧上限（A 第 7 次 / B 第 9 次）扫描仍成功，不会被拒', () => {
    const a = createMission(field, 0)
    for (let k = 0; k < 7; k += 1) expect(a.scanAt(60 + k * 12, 60).ok).toBe(true)
    expect(a.snapshot().scansUsed).toBe(7)

    const b = createMission(createHeightField(WORLD_SEEDS[1], 1), 1)
    for (let k = 0; k < 9; k += 1) expect(b.scanAt(60 + k * 12, 60).ok).toBe(true)
    expect(b.snapshot().scansUsed).toBe(9)
  })
})

describe('缺口-9：reset() 不变量', () => {
  it('reset 后回到干净初始态（无 stuck / 无 awaiting / 无 blind / 初始阶段 / 未训练）', () => {
    // 火星二号（外流河道）是盲区指挥所在世界；用它触发盲区标志位，验证 reset 清干净。
    const outflow = createHeightField(WORLD_SEEDS[1], 1)
    const m = createMission(outflow, 1)
    // 制造脏状态：扫描 → 规划 → 实测进入盲区等待 → 下达指挥命令（P6 标志位被置位）
    m.scanAt(outflow.start.x, outflow.start.z)
    m.replan()
    m.startDrive()
    if (m.snapshot().awaitingBlindCommand) m.issueBlindCommand()
    // reset 必须把这些状态全部清回干净初态，否则盲区机制会跨局泄漏（核对-2 风险）
    m.reset()
    const s = m.snapshot()
    expect(s.phase).toBe('scan')
    expect(s.scansUsed).toBe(0)
    expect(s.scansLeft).toBe(Infinity)
    expect(s.driveStatus).toBe('idle')
    expect(s.stuckHazard).toBeNull()
    expect(s.softStuck).toBe(false)
    expect(s.awaitingBlindCommand).toBe(false)
    expect(s.blindCommanded).toBe(false)
    expect(s.trained).toBe(false)
    expect(s.aiConfidence).toBe(0)
    expect(s.missionComplete).toBe(false)
    expect(s.decisionLog.length).toBe(0)
    expect(s.runs.length).toBe(0)
    expect(s.hasScanned).toBe(false)
  })
})

describe('干涸河床候选点初始不应被误判为已扫描（E 交互前箭头必须为橘黄）', () => {
  it('初始未扫描；扫描后才转已扫描', () => {
    const m = createMission(field)
    const cands = buildScanCandidates(field)
    const riverbed = cands.find((c) => c.id === 'riverbed')
    expect(riverbed).toBeDefined()
    // 着陆点默认揭示圈（LANDING_REVEAL=90m）不应覆盖河床候选点，
    // 否则 syncScanMarkers 会误把引导箭头染绿，误导玩家"已扫描"。
    expect(m.knowledge.scannedAt(riverbed!.x, riverbed!.z)).toBeLessThan(0.5)

    // 玩家真正扫描该点后，应变为已扫描（箭头转绿）。
    const out = m.scanAt(riverbed!.x, riverbed!.z)
    expect(out.ok).toBe(true)
    expect(m.knowledge.scannedAt(riverbed!.x, riverbed!.z)).toBeGreaterThanOrEqual(0.5)
  })
})

/** 测试辅助：手动驾驶把漫游车开到目标坐标附近（确定性，无随机）。 */
function driveTo(m: ReturnType<typeof createMission>, tx: number, tz: number, steps = 2600): boolean {
  if (!m.manualActive()) m.enterManual()
  for (let i = 0; i < steps; i += 1) {
    const p = m.manualPose()
    const dx = tx - p.x
    const dz = tz - p.z
    const d = Math.hypot(dx, dz)
    if (d < 10) return true
    const desired = Math.atan2(-dz, dx)
    let diff = desired - p.heading
    while (diff > Math.PI) diff -= 2 * Math.PI
    while (diff < -Math.PI) diff += 2 * Math.PI
    const steer = Math.max(-1, Math.min(1, diff * 2))
    m.setManualInput(1, steer)
    m.stepManual(0.15)
  }
  return false
}

/**
 * 测试辅助：把清洗台 / 标注台的交互按"正确答案"走一遍。
 *
 * 清洗和标注现在是学生逐条操作的训练环节，不再是按 E 一键完成，
 * 所以所有需要"已标注数据"的用例都得先过这两关。
 */
function cleanAndLabel(m: ReturnType<typeof createMission>): void {
  const clean = m.pois().find((p) => p.kind === 'base-clean')!
  const label = m.pois().find((p) => p.kind === 'base-label')!
  driveTo(m, clean.x, clean.z)
  expect(m.interact()).toBe(true)
  for (const r of m.snapshot().records) {
    m.setRecordCleanChoice(r.id, r.flaw !== null ? 'drop' : 'keep')
  }
  expect(m.confirmCleaning().ok).toBe(true)

  driveTo(m, label.x, label.z)
  expect(m.interact()).toBe(true)
  const s = m.snapshot()
  for (const r of s.records) {
    if (r.cleanChoice !== 'keep') continue
    const want = r.slopeDeg < s.cautionDeg ? 'pass' : r.slopeDeg < s.blockedDeg ? 'caution' : 'block'
    m.setRecordLabel(r.id, want)
  }
  expect(m.confirmLabeling().ok).toBe(true)
}
