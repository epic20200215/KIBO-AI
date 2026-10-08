/**
 * 小地图采样：把 96×96 的规划网格降采样成一张 res×res 的 RGBA 位图。
 *
 * 纯函数，不依赖 three / canvas，可在 node 下单测。
 * 颜色口径与 HUD 的坡度色带一致：
 *   未探测 → 暗紫灰（和大地图的影线区同义）
 *   通行   → 沙褐
 *   谨慎   → 橙
 *   禁行   → 暗红
 * 这样学生扫一眼小地图就能对上大地图里的颜色，不引入第二套语义。
 */
import type { Grid, GridCell } from '../core/grid'
import { SOFT_CAUTION, ROCK_CAUTION } from '../core/grid'
import { BASIN_SIZE } from '../core/heightField'

export type MiniColor = readonly [number, number, number]

export const MINI_UNKNOWN: MiniColor = [44, 38, 52]
export const MINI_PASS: MiniColor = [176, 118, 80]
export const MINI_CAUTION: MiniColor = [216, 132, 50]
export const MINI_BLOCKED: MiniColor = [124, 42, 42]

/**
 * 逐格风险字形（A2）：把每个规划格的「学生已探明、规划器可见」的风险压成一个字形代号，
 * 让学生不靠颜色也能读出这一格能不能走 / 有什么隐患。纯函数、可单测。
 *
 * 字形优先级（与 terrainMesh 教学叠加、minimap 底色口径一致）：
 *   unknown 未探测（无字形，底色即暗紫灰）
 *   blocked 坡度禁行（flag === 2）
 *   rock    岩石出露（rock ≥ ROCK_CAUTION）
 *   soft    软沙（soft ≥ SOFT_CAUTION）
 *   caution 坡度谨慎（flag === 1）
 *   none    已探明且通行
 * 岩石 / 软沙优先于「坡度谨慎」显示——地表隐患比单纯坡度更值得标注，也和地形叠加的软/岩纹对应。
 */
export type MiniGlyph = 'unknown' | 'blocked' | 'rock' | 'soft' | 'caution' | 'none'

export const GLYPH_CODE: Record<MiniGlyph, number> = {
  unknown: 0,
  blocked: 1,
  rock: 2,
  soft: 3,
  caution: 4,
  none: 5,
}

/** 单个格子的字形（仅看学生已探明、规划器实际可见的风险）。 */
export function cellGlyph(c: GridCell | null): MiniGlyph {
  if (!c || c.scanned < 0.5) return 'unknown'
  if (c.flag === 2) return 'blocked'
  if (c.rock >= ROCK_CAUTION) return 'rock'
  if (c.soft >= SOFT_CAUTION) return 'soft'
  if (c.flag === 1) return 'caution'
  return 'none'
}

/**
 * 与 `sampleMinimap` 同分辨率、同映射地把每格字形压成 res×res 的 Uint8Array。
 * HUD 画字形时和画底图用同一套坐标，字形正好压在对应底色格上。
 */
export function sampleGlyphs(grid: Grid, res: number): Uint8Array {
  const out = new Uint8Array(res * res)
  const n = grid.n
  for (let my = 0; my < res; my += 1) {
    for (let mx = 0; mx < res; mx += 1) {
      const i = Math.min(n - 1, Math.floor((mx / res) * n))
      const j = Math.min(n - 1, Math.floor((my / res) * n))
      out[my * res + mx] = GLYPH_CODE[cellGlyph(grid.at(i, j) ?? null)]
    }
  }
  return out
}

/** A4：风险字形只在「做决策」的阶段显示（plan/revise/report），scan/drive 阶段淡出，避免跟车视图抢焦点。 */
export function phaseShowsRiskGlyphs(phase: string): boolean {
  return phase === 'plan' || phase === 'revise' || phase === 'report'
}

/**
 * 缺口-6：字形绘制的最小每格像素阈值。小于此值（小缩略图 scale≈1.5）逐格字形是亚像素级、
 * 会糊成噪点，此时只靠颜色分档表达；放大/决策阶段（scale≈2.5）才画字形保证可读。
 */
export const MIN_GLYPH_SCALE = 2

/** 缺口-6：当前小地图每格像素是否足够大、可以清晰绘制逐格风险字形。 */
export function glyphScaleVisible(scale: number): boolean {
  return scale >= MIN_GLYPH_SCALE
}

/**
 * 把网格降采样成 res×res 的 RGBA 位图（terrain 底图）。
 * @param grid 规划网格（含 scanned / flag）
 * @param res  小地图边长像素数（如 64）
 */
export function sampleMinimap(grid: Grid, res: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(res * res * 4)
  const n = grid.n
  for (let my = 0; my < res; my += 1) {
    for (let mx = 0; mx < res; mx += 1) {
      // 小地图像素 → 网格下标（mx→x→i，my→z→j）
      const i = Math.min(n - 1, Math.floor((mx / res) * n))
      const j = Math.min(n - 1, Math.floor((my / res) * n))
      const c = grid.at(i, j)
      let col: MiniColor = MINI_UNKNOWN
      if (c && c.scanned >= 0.5) {
        col = c.flag === 2 ? MINI_BLOCKED : c.flag === 1 ? MINI_CAUTION : MINI_PASS
      }
      const o = (my * res + mx) * 4
      out[o] = col[0]
      out[o + 1] = col[1]
      out[o + 2] = col[2]
      out[o + 3] = 255
    }
  }
  return out
}

/** 世界坐标 → 小地图像素坐标（0..res）。 */
export function worldToMini(x: number, z: number, res: number): { mx: number; my: number } {
  const mx = ((x + BASIN_SIZE / 2) / BASIN_SIZE) * res
  const my = ((z + BASIN_SIZE / 2) / BASIN_SIZE) * res
  return { mx, my }
}
