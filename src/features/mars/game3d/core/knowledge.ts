/**
 * 探测置信度场（学生"已经知道多少"的唯一记录）。
 *
 * 为什么单独建一个场，而不是直接读高度场
 * -------------------------------------
 * 高度场是**真相**：地形真的长什么样。
 * 置信度场是**认知**：学生通过扫描，目前掌握了多少真相。
 *
 * 这两者必须分开，否则规划器会"偷看"没扫描过的地形，
 * 扫描就退化成一个好看的特效，学生学不到"数据不足时 AI 会怎样"。
 *
 * 三档取值（硬边，符合赛璐珞风格，也便于无障碍下用图案区分）：
 * - 0    未探测：不知道坡度、不知道地表成分
 * - 0.55 低置信：扫到了边缘，数据粗糙
 * - 1    已探明：可以据此定规则
 *
 * 分辨率与规划网格一致（96×96），保证"地图上看到的已知区"
 * 就是"规划器知道的已知区"，不存在两套事实。
 */
import { BASIN_SIZE } from './heightField'

/** 与规划网格同分辨率。改这里必须同时改 createGrid 的 n。 */
export const KNOW_RES = 96

const HALF = BASIN_SIZE / 2

/** 已探明 / 低置信 的字节取值。用字节是为了直接喂 DataTexture。 */
const LEVEL_FULL = 255
const LEVEL_EDGE = 140

export type KnowledgeField = {
  res: number
  cell: number
  /** 长度 res*res，行主序 j*res+i，取值 0 / 140 / 255 */
  data: Uint8Array
  /** 每次揭示自增，渲染侧据此决定是否重传纹理 */
  version: number
  /** 以 (x,z) 为圆心揭示一片区域，返回本次新探明的格数 */
  reveal: (x: number, z: number, radius: number) => number
  /** 该点的扫描覆盖度 0..1（不含地形本身的低置信度） */
  scannedAt: (x: number, z: number) => number
  /** 已探明格数占比 0..1（低置信按 0.5 计） */
  coverage: () => number
  reset: () => void
}

export function createKnowledgeField(res = KNOW_RES): KnowledgeField {
  const cell = BASIN_SIZE / res
  const data = new Uint8Array(res * res)

  const state = { version: 0 }

  const clampIdx = (v: number) => Math.min(res - 1, Math.max(0, v))

  const reveal = (x: number, z: number, radius: number): number => {
    // 外圈按 1.18 倍半径给低置信，形成"中心清楚、边缘粗糙"的硬边两档
    const outer = radius * 1.18
    const i0 = clampIdx(Math.floor((x - outer + HALF) / cell))
    const i1 = clampIdx(Math.ceil((x + outer + HALF) / cell))
    const j0 = clampIdx(Math.floor((z - outer + HALF) / cell))
    const j1 = clampIdx(Math.ceil((z + outer + HALF) / cell))

    let gained = 0
    for (let j = j0; j <= j1; j += 1) {
      const cz = -HALF + (j + 0.5) * cell
      for (let i = i0; i <= i1; i += 1) {
        const cx = -HALF + (i + 0.5) * cell
        const d = Math.hypot(cx - x, cz - z)
        let level = 0
        if (d <= radius) level = LEVEL_FULL
        else if (d <= outer) level = LEVEL_EDGE
        if (level === 0) continue
        const k = j * res + i
        if (level > data[k]) {
          if (data[k] < LEVEL_FULL && level === LEVEL_FULL) gained += 1
          data[k] = level
        }
      }
    }
    if (gained > 0 || i1 >= i0) state.version += 1
    return gained
  }

  const scannedAt = (x: number, z: number): number => {
    const i = clampIdx(Math.floor((x + HALF) / cell))
    const j = clampIdx(Math.floor((z + HALF) / cell))
    return data[j * res + i] / 255
  }

  const coverage = (): number => {
    let sum = 0
    for (let k = 0; k < data.length; k += 1) {
      if (data[k] >= LEVEL_FULL) sum += 1
      else if (data[k] > 0) sum += 0.5
    }
    return sum / data.length
  }

  const reset = () => {
    data.fill(0)
    state.version += 1
  }

  return {
    res,
    cell,
    data,
    get version() {
      return state.version
    },
    reveal,
    scannedAt,
    coverage,
    reset,
  }
}
