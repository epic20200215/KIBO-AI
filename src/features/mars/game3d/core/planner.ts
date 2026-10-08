/**
 * 确定性 A* 路径规划。
 *
 * 这是 M4 的"任务大脑"。代价模型与 `model.ts` 同一口径（距离 / 安全 / 能耗三权重），
 * 但完全独立实现，不修改 `model.ts` 的已发布代价逻辑。
 *
 * 关键约束（对应 3D 准入条件 #3 确定性）：
 * - 不引入任何 `Math.random`，不引入时间戳。
 * - 同 (grid, start, target, 权重) → 同一条路径、同一代价。A* 本身在代价一致时即可复现，
 *   这里再显式固定 tie-break（按 i*n+j 升序），消除任何实现相关的歧义。
 *
 * 诚实边界
 * --------
 * 规划器只读 `cell.flag` 与 `cell.scanned`，**绝不读 `cell.trueFlag`**。
 * 没扫描过的格子，算法既不知道它陡不陡，也不知道它软不软——
 * 所以未探测区的地表惩罚一律按 0 计，只加一个"未知风险"惩罚。
 * 这样出来的路线才真实反映"数据不足时算法会怎么想"。
 */
import type { Grid, GridCell } from './grid'
import { distanceToPolyline } from './heightField'

/**
 * 地理走廊约束：让一条候选路线在**几何上真的走它自己的地物**。
 *
 * 为什么需要它（2026-09-05 实测教训）：
 * 只靠代价权重倍率的微小差异（古汉道 caution×0.06 vs 北支谷 ×0.05）区分路线是不够的——
 * A* 会收敛到同一条几何最短路，于是三张路线卡片实际只有两条不同的路。
 * 走廊把"这条路线沿哪条地物走"变成显式约束：偏离走廊越远代价越高。
 *
 * 火星一号不使用走廊（不传即关闭），零回归护栏。
 */
export type Corridor = {
  /** 走廊中心线（世界坐标折线） */
  spine: ReadonlyArray<readonly [number, number]>
  /** 走廊半宽（米）：落在此范围内不罚 */
  radius: number
  /** 超出走廊后每米的额外代价系数 */
  strength: number
}

/** 规划可选约束（两图共用，一号不传任何一项）。 */
export type PlanOptions = {
  /** 地理走廊约束 */
  corridor?: Corridor
  /**
   * 低置信度阈值：已扫描但 confidence 低于此值的格计入 `lowConfCells`。
   * 这是"未知风险不可通过扫描归零"的机制基础（铁律 #6 赌档不可消除）。
   */
  lowConfThreshold?: number
  /** 判定"软沙格"的 cell.soft 阈值。缺省 0.5（一号地图的历史行为）。 */
  softThreshold?: number
  /** 判定"岩石格"的 cell.rock 阈值。缺省 0.5（同上）。 */
  rockThreshold?: number
}

export type PlanWeights = {
  /** 距离权重（基准） */
  distance: number
  /** 谨慎坡度的额外代价系数 */
  caution: number
  /** 软沙打滑的额外代价系数 */
  soft: number
  /** 岩体颠簸的额外代价系数 */
  rock: number
  /** 爬升能耗系数（按高度差） */
  climb: number
  /** 穿越未探测区的风险系数。调高＝保守绕行，调低＝激进抄近路 */
  unknown: number
}

export const DEFAULT_WEIGHTS: PlanWeights = {
  distance: 1,
  caution: 2.4,
  soft: 1.6,
  rock: 1.2,
  climb: 0.8,
  unknown: 1.8,
}

export type PlanResult = {
  /** 路径格序列（含起点与终点） */
  path: GridCell[]
  /** 规划展开格数（用于"计算量"可视化/教学） */
  expanded: number
  /** 总代价 */
  cost: number
  /** 是否找到可行路径 */
  found: boolean
  /** 路线实际里程（米） */
  lengthM: number
  /** 路线经过的谨慎格数（学生规划时可见） */
  cautionCells: number
  /** 路线经过的未探测格数（学生规划时可见，这是"猜的部分"） */
  unknownCells: number
  /**
   * 路线里实际会撞上禁行坡、但因为没扫描所以规划时看不见的格数。
   * **只允许在实测/复盘阶段展示**，规划阶段展示等于替学生作弊。
   */
  hiddenBlocked: number
  /**
   * 路线经过的软沙格数（仅已扫描格计数，cell.soft>0.5；未扫描格归 unknownCells 不重算）。
   * 这是火星二号（world 1）能源账要把"软沙"计入 certain 的依据（设计 §2.6）。
   * 火星一号（world 0）此字段恒为 0——地形里没有软沙，不污染一号能源账。
   * 不暴露给 UI，只是能源账内部维度（铁律 #3 UI 不泄答案）。
   */
  softCells: number
  /** 路线经过的岩石格数（仅已扫描格计数，cell.rock>0.5）。同 softCells 语义。 */
  rockCells: number
  /**
   * 路线经过的**低置信度**格数：已扫描（scanned≥0.5）但 confidence 低于阈值的格。
   *
   * 这些格"扫过了但没看清"——被崖壁遮挡的支谷深处即属此类。它们的不确定性
   * **不可通过继续扫描消除**（置信度有物理上限），因此只计入 worst、不计入 best，
   * 这是赌档「best < B < worst」能够成立的机制基础（铁律 #6）。
   * 火星一号（world 0）不传阈值，此字段恒为 0。
   */
  lowConfCells: number
}

const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

/** 八方向距离：对角 ×√2。 */
function stepDist(di: number, dj: number): number {
  return Math.hypot(di, dj)
}

/** 单格进入代价：距离基准 ×（1 + 各类惩罚）。 */
function enterCost(cell: GridCell, w: PlanWeights): number {
  const base = 1 // 归一化基准，方向系数在外面乘
  let penalty = 0
  if (cell.scanned >= 0.5) {
    // 已探测：按真实读数罚
    if (cell.flag === 1) penalty += w.caution
    else if (cell.flag === 2) penalty += 1e6 // 禁行，A* 不会选；双保险
    penalty += cell.soft * w.soft
    penalty += cell.rock * w.rock
    // 低置信成像（坑缘阴影）即使扫描过也要打个折扣
    penalty += (1 - cell.confidence) * w.unknown * 0.5
  } else {
    // 未探测：算法对地表一无所知，只能加一个统一的未知风险
    penalty += w.unknown
  }
  return base * (1 + penalty)
}

/**
 * 确定性 A*。
 * @param grid 规划网格
 * @param start 起点格 (i,j)
 * @param target 终点格 (i,j)
 * @param weights 代价权重
 */
export function planPath(
  grid: Grid,
  start: { i: number; j: number },
  target: { i: number; j: number },
  weights: PlanWeights = DEFAULT_WEIGHTS,
  opts: PlanOptions = {},
): PlanResult {
  const n = grid.n
  const total = n * n
  const idx = (i: number, j: number) => i * n + j

  const gScore = new Float64Array(total).fill(Infinity)
  const cameFrom = new Int32Array(total).fill(-1)
  const closed = new Uint8Array(total)
  // 开放集：用简单数组 + 线性取最小（网格小，足够；确定性强）
  const open: number[] = []

  const sIdx = idx(start.i, start.j)
  const tIdx = idx(target.i, target.j)
  gScore[sIdx] = 0
  open.push(sIdx)

  const heuristic = (i: number, j: number) => {
    const di = Math.abs(i - target.i)
    const dj = Math.abs(j - target.j)
    // 八方向 octile 启发
    return (di + dj) + (Math.SQRT2 - 2) * Math.min(di, dj)
  }

  let expanded = 0

  while (open.length > 0) {
    // 取 g+h 最小；tie-break 用索引升序保证确定性
    let bestK = 0
    for (let k = 1; k < open.length; k += 1) {
      const a = open[k]
      const b = open[bestK]
      const fa = gScore[a] + heuristic(Math.floor(a / n), a % n)
      const fb = gScore[b] + heuristic(Math.floor(b / n), b % n)
      if (fa < fb || (fa === fb && a < b)) bestK = k
    }
    const current = open.splice(bestK, 1)[0]
    if (closed[current]) continue
    closed[current] = 1
    expanded += 1

    if (current === tIdx) break

    const ci = Math.floor(current / n)
    const cj = current % n
    const curCell = grid.at(ci, cj)
    if (!curCell) continue

    for (const [di, dj] of NEIGHBORS) {
      const ni = ci + di
      const nj = cj + dj
      const nb = grid.at(ni, nj)
      if (!nb) continue
      if (nb.flag === 2) continue // 规划器看到的禁行
      const nIdx = idx(ni, nj)
      if (closed[nIdx]) continue
      // 对角移动不允许"擦禁行角"
      if (di !== 0 && dj !== 0) {
        const a = grid.at(ci + di, cj)
        const b = grid.at(ci, cj + dj)
        if (a?.flag === 2 || b?.flag === 2) continue
      }
      const step = enterCost(nb, weights) * stepDist(di, dj) * weights.distance
      // 爬升能耗：上坡才加，下坡略减（重力助力）。未探测区高度同样未知，不计。
      let climbCost = 0
      if (nb.scanned >= 0.5 && curCell.scanned >= 0.5) {
        const dh = nb.height - curCell.height
        climbCost = dh > 0 ? dh * weights.climb : dh * weights.climb * 0.3
      }
      // 地理走廊：偏离走廊越远代价越高（每进入一格罚一次，不随步长缩放，
      // 否则对角移动的惩罚会凭空多出 41%，扭曲八方向的实际选择）。
      let corridorCost = 0
      if (opts.corridor) {
        const c = opts.corridor
        const excess = Math.max(0, distanceToPolyline(nb.x, nb.z, c.spine) - c.radius)
        corridorCost = excess * c.strength
      }
      const tentative = gScore[current] + step + climbCost + corridorCost
      if (tentative < gScore[nIdx]) {
        gScore[nIdx] = tentative
        cameFrom[nIdx] = current
        open.push(nIdx)
      }
    }
  }

  if (cameFrom[tIdx] === -1 && tIdx !== sIdx) {
    return {
      path: [],
      expanded,
      cost: Infinity,
      found: false,
      lengthM: 0,
      cautionCells: 0,
      unknownCells: 0,
      hiddenBlocked: 0,
      softCells: 0,
      rockCells: 0,
      lowConfCells: 0,
    }
  }

  // 回溯
  const path: GridCell[] = []
  let cur = tIdx
  while (cur !== -1) {
    const c = grid.at(Math.floor(cur / n), cur % n)
    if (c) path.push(c)
    if (cur === sIdx) break
    cur = cameFrom[cur]
  }
  path.reverse()

  let lengthM = 0
  let cautionCells = 0
  let unknownCells = 0
  let hiddenBlocked = 0
  let softCells = 0
  let rockCells = 0
  let lowConfCells = 0
  const lowConfT = opts.lowConfThreshold ?? -1 // 负值 = 关闭（一号地图不传）
  const softT = opts.softThreshold ?? 0.5 // 缺省 0.5 = 改动前的行为，一号零回归
  const rockT = opts.rockThreshold ?? 0.5
  for (let k = 0; k < path.length; k += 1) {
    const c = path[k]
    if (k > 0) lengthM += Math.hypot(c.x - path[k - 1].x, c.z - path[k - 1].z)
    if (c.scanned < 0.5) {
      unknownCells += 1
      if (c.trueFlag === 2) hiddenBlocked += 1
    } else {
      // 已扫描：caution/soft/rock 各自独立计数（地表软硬不算 caution 也不互相覆盖）。
      if (c.flag === 1) cautionCells += 1
      if (c.soft > softT) softCells += 1
      if (c.rock > rockT) rockCells += 1
      // 扫过了但没看清：置信度低于阈值的格，其风险不可继续扫描消除（只进 worst）。
      if (c.confidence < lowConfT) lowConfCells += 1
    }
  }

  return {
    path,
    expanded,
    cost: gScore[tIdx],
    found: path.length > 0,
    lengthM,
    cautionCells,
    unknownCells,
    hiddenBlocked,
    softCells,
    rockCells,
    lowConfCells,
  }
}
