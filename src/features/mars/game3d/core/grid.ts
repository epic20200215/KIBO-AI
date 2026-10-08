/**
 * 由连续高度场派生规划网格。
 *
 * 这是"模拟器是单一事实源"的落地：坡度不是手写常量，而是从 H(x,z) 的梯度算出。
 * 规划器只读这个网格，不碰渲染。纯逻辑、无 three 依赖、可在 node 下单测。
 *
 * 真相 vs 认知（M4 的核心结构）
 * -----------------------------
 * 每格同时保存两套判定：
 * - `trueFlag`：按真实坡度算出的通行性。**只有实测和复盘可以读**。
 * - `flag`：规划器实际看到的通行性。没扫描过的格子一律按"看起来能走"处理。
 *
 * 这样分开写，是为了让"扫描"成为真正的决策，而不是特效：
 * 学生不扫描就规划，算法照样给一条路线，但那条路线里有一段是猜的。
 * 这个落差正是 M5 实测环节要暴露的教学冲突。
 */
import { BASIN_SIZE, type HeightField } from './heightField'
import type { KnowledgeField } from './knowledge'

export type CellFlag = 0 | 1 | 2 // 0 通行 1 谨慎 2 禁行

/**
 * 软沙 / 岩石的「危险」阈值（0..1，取自 HeightField 的 soft / rock 通道）。
 *
 * 设计定位（诚实边界）：`flag` / `trueFlag` 仍**只由坡度**分档（见 `classify` 与
 * `planner.test.ts` 的显式断言）——坡度是「学生能调的规则」。软沙与岩石是**地表类型**，
 * 不进入坡度规则，而是：
 *   1. 规划器代价权重（planner.ts 的 `soft` / `rock`）——AI 会主动避让；
 *   2. 地表教学叠加（terrainMesh 的软/岩危险纹）——学生看得见「这段是松沙 / 岩石」；
 *   3. 自动实测的陷车判定（mission.ts 的 `stepDrive`）——深软沙会让 AI 验证车陷住、
 *      可用脱困小游戏摇出（hazard='soft'）；岩石/陡坡是硬障碍，不能摇出。
 * 这样「软沙陷车」「识别岩石」的叙事才与机制一致，又不破坏「flag 只反映坡度规则」的约束。
 */
export const SOFT_CAUTION = 0.55 // 软沙：谨慎（颠簸/陷车风险）
export const SOFT_BLOCK = 0.85 // 软沙：深软，自动实测会陷住（可脱困）
export const ROCK_CAUTION = 0.45 // 岩石：谨慎（颠簸）
export const ROCK_BLOCK = 0.72 // 岩石：裸岩出露，硬障碍

export type GridCell = {
  i: number
  j: number
  x: number
  z: number
  height: number
  slopeDeg: number
  soft: number
  rock: number
  /** 地形自身的成像置信度（坑缘阴影等），与扫描无关 */
  confidence: number
  /** 扫描覆盖度 0..1。0 表示这一格学生从没探测过 */
  scanned: number
  /** 规划器看到的通行性（未扫描区一律按 0 处理） */
  flag: CellFlag
  /** 真实通行性。仅供实测判定与复盘对比使用 */
  trueFlag: CellFlag
}

export type Grid = {
  n: number
  cell: number
  cautionDeg: number
  blockedDeg: number
  cells: GridCell[]
  /** i*N + j 取格 */
  at: (i: number, j: number) => GridCell | undefined
  worldToGrid: (x: number, z: number) => { i: number; j: number }
  gridToWorld: (i: number, j: number) => { x: number; z: number }
  /** 学生调整阈值后重新分档。不重建几何，只改分类。 */
  setThresholds: (cautionDeg: number, blockedDeg: number) => void
  /** 扫描后同步认知：把置信度场刷进每格的 scanned，并重算 flag。 */
  syncKnowledge: (knowledge: KnowledgeField) => void
}

/** 按坡度和阈值分档。抽出来是为了阈值变化和扫描变化都走同一份规则。 */
function classify(slopeDeg: number, cautionDeg: number, blockedDeg: number): CellFlag {
  if (slopeDeg >= blockedDeg) return 2
  if (slopeDeg >= cautionDeg) return 1
  return 0
}

/**
 * @param field 高度场（唯一事实源）
 * @param n 网格分辨率（每边格数）。必须与 KNOW_RES 一致。
 * @param cautionDeg 谨慎坡度阈值（与地形分档、HUD 数值严格对齐）
 * @param blockedDeg 禁行坡度阈值
 */
export function createGrid(
  field: HeightField,
  n = 96,
  cautionDeg = 14,
  blockedDeg = 24,
): Grid {
  const cell = BASIN_SIZE / n
  const cells: GridCell[] = new Array(n * n)

  const state = { cautionDeg, blockedDeg }

  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const x = -BASIN_SIZE / 2 + (i + 0.5) * cell
      const z = -BASIN_SIZE / 2 + (j + 0.5) * cell
      const height = field.heightAt(x, z)
      const slopeDeg = field.slopeDegAt(x, z)
      const soft = field.softAt(x, z)
      const rock = field.rockAt(x, z)
      const confidence = field.confidenceAt(x, z)
      const trueFlag = classify(slopeDeg, cautionDeg, blockedDeg)
      cells[i * n + j] = {
        i,
        j,
        x,
        z,
        height,
        slopeDeg,
        soft,
        rock,
        confidence,
        // 默认全未探测：一开始学生什么都不知道
        scanned: 0,
        flag: 0,
        trueFlag,
      }
    }
  }

  /** 规划器看到的分档：扫描不足的格子，坡度信息不可用，按"看起来能走"处理。 */
  const reclassify = () => {
    for (let k = 0; k < cells.length; k += 1) {
      const c = cells[k]
      c.trueFlag = classify(c.slopeDeg, state.cautionDeg, state.blockedDeg)
      c.flag = c.scanned >= 0.5 ? c.trueFlag : 0
    }
  }

  const at = (i: number, j: number): GridCell | undefined => {
    if (i < 0 || j < 0 || i >= n || j >= n) return undefined
    return cells[i * n + j]
  }
  const worldToGrid = (x: number, z: number) => ({
    i: Math.min(n - 1, Math.max(0, Math.floor((x + BASIN_SIZE / 2) / cell))),
    j: Math.min(n - 1, Math.max(0, Math.floor((z + BASIN_SIZE / 2) / cell))),
  })
  const gridToWorld = (i: number, j: number) => ({
    x: -BASIN_SIZE / 2 + (i + 0.5) * cell,
    z: -BASIN_SIZE / 2 + (j + 0.5) * cell,
  })

  const syncKnowledge = (knowledge: KnowledgeField) => {
    for (let j = 0; j < n; j += 1) {
      for (let i = 0; i < n; i += 1) {
        const c = cells[i * n + j]
        // 认知网格与规划网格同分辨率，可直接按下标取，不必再做空间插值
        c.scanned = knowledge.res === n ? knowledge.data[j * n + i] / 255 : knowledge.scannedAt(c.x, c.z)
      }
    }
    reclassify()
  }

  return {
    n,
    cell,
    get cautionDeg() {
      return state.cautionDeg
    },
    get blockedDeg() {
      return state.blockedDeg
    },
    cells,
    at,
    worldToGrid,
    gridToWorld,
    setThresholds: (nextCaution, nextBlocked) => {
      state.cautionDeg = nextCaution
      state.blockedDeg = nextBlocked
      reclassify()
    },
    syncKnowledge,
  }
}

/** 把世界坐标点对齐到最近格中心的世界坐标（用于路径点贴地）。 */
export function snapToCellCenter(grid: Grid, x: number, z: number): { x: number; z: number } {
  const { i, j } = grid.worldToGrid(x, z)
  return grid.gridToWorld(i, j)
}
