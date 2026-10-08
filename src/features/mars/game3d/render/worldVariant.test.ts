/**
 * worldIndex 分叉契约（火星二号 · P0 架构底座）
 *
 * 这些断言锁住的是**地基本身**，不是美术观感：
 * - 一号（worldIndex 0）的每一项取值必须与改动前**逐值相等**——这是「火星一号
 *   改动须经用户审核」红线的自动化护栏，任何人改了二号却顺手碰了一号，这里会红。
 * - 二号（worldIndex 1）必须在光环境上与一号**真的不同**——否则视觉差异化就是空话。
 *
 * skill 铁律 #7：被反复推翻的设计不变量必须落成自动化测试，防止后续迭代悄悄退化。
 */
import { WORLD_SEEDS, createHeightField, type HeightField } from '../core/heightField'
import { PALETTE, SUN_DIRECTION, skyPaletteFor, sunDirectionFor } from './palette'

/** 太阳仰角（角度制）：方向与水平面的夹角。 */
function elevationDeg(dir: { x: number; y: number; z: number }): number {
  const len = Math.hypot(dir.x, dir.y, dir.z)
  return (Math.asin(dir.y / len) * 180) / Math.PI
}

/**
 * 高度场摘要。完整 height 数组有 385² ≈ 14.8 万个元素，直接 toEqual 会让测试慢到不可用，
 * 因此取极值 + 固定抽样点做指纹——足以捕捉"换种子/改算子"这类结构性变化。
 */
function summarize(f: HeightField) {
  const last = f.height.length - 1
  return {
    min: f.minHeight,
    max: f.maxHeight,
    sample: [0, 1024, 40_000, 90_000, last].map((i) => f.height[i]),
  }
}

/**
 * 两个高度场的 Pearson 相关系数（抽样计算）。
 * 步长取质数以均匀覆盖全场；完整 385² ≈ 14.8 万点逐点计算太慢，
 * 抽样足以区分"换了个种子的同一张图"与"真的换了地貌"。
 */
function correlation(a: Float32Array, b: Float32Array): number {
  const step = 37
  const n = Math.floor(Math.min(a.length, b.length) / step)
  let sa = 0
  let sb = 0
  for (let k = 0; k < n; k += 1) {
    sa += a[k * step]
    sb += b[k * step]
  }
  const ma = sa / n
  const mb = sb / n
  let num = 0
  let da = 0
  let db = 0
  for (let k = 0; k < n; k += 1) {
    const va = a[k * step] - ma
    const vb = b[k * step] - mb
    num += va * vb
    da += va * va
    db += vb * vb
  }
  if (da === 0 || db === 0) return 0
  return num / Math.sqrt(da * db)
}

describe('worldIndex 分叉契约', () => {
  describe('主光方向', () => {
    it('一号（索引 0）与改动前常量逐值相等——零回归红线', () => {
      const sun0 = sunDirectionFor(0)
      expect(sun0.x).toBe(SUN_DIRECTION.x)
      expect(sun0.y).toBe(SUN_DIRECTION.y)
      expect(sun0.z).toBe(SUN_DIRECTION.z)
    })

    it('二号（索引 1）太阳仰角显著低于一号——黄昏差异化成立', () => {
      const e0 = elevationDeg(sunDirectionFor(0))
      const e1 = elevationDeg(sunDirectionFor(1))
      // 一号约 33°，二号约 11°。这里只锁"低 15° 以上"这个量级，
      // 不锁死具体角度，给主美后续微调留余地。
      expect(e1).toBeLessThan(e0 - 15)
    })

    it('两图太阳水平方位一致——只降仰角，不改来光方向', () => {
      const s0 = sunDirectionFor(0)
      const s1 = sunDirectionFor(1)
      expect(s1.x / s1.z).toBeCloseTo(s0.x / s0.z, 6)
    })

    it('索引越界退回合法值，不产生 undefined / NaN 光照', () => {
      for (const bad of [-1, 2, 99, NaN, 1.7]) {
        const s = sunDirectionFor(bad)
        expect(Number.isFinite(s.x)).toBe(true)
        expect(Number.isFinite(s.y)).toBe(true)
        expect(Number.isFinite(s.z)).toBe(true)
      }
    })
  })

  describe('天穹配色', () => {
    it('一号与 PALETTE 现值逐字段相等——零回归红线', () => {
      const p0 = skyPaletteFor(0)
      expect(p0.zenith).toBe(PALETTE.skyZenith)
      expect(p0.mid).toBe(PALETTE.skyMid)
      expect(p0.horizon).toBe(PALETTE.skyHorizon)
      expect(p0.haze).toBe(PALETTE.hazeColor)
    })

    it('二号与一号不同——黄昏差异化成立', () => {
      const p0 = skyPaletteFor(0)
      const p1 = skyPaletteFor(1)
      expect(p1.horizon).not.toBe(p0.horizon)
      expect(p1.haze).not.toBe(p0.haze)
    })

    it('索引越界退回最后一个合法图（火星二号），不产生 undefined 配色', () => {
      expect(skyPaletteFor(99).horizon).toBe(skyPaletteFor(1).horizon)
      expect(skyPaletteFor(99).haze).toBe(skyPaletteFor(1).haze)
    })
  })

  describe('高度场分叉', () => {
    it('索引 0 与不传参完全等价——零回归红线', () => {
      const a = createHeightField('kibo-mars-basin-v1')
      const b = createHeightField('kibo-mars-basin-v1', 0)
      expect(summarize(b)).toEqual(summarize(a))
    })

    it('T1 骨架差异锁：二号地形与一号显著不同（高度场相关系数 < 0.6）', () => {
      const a = createHeightField(WORLD_SEEDS[0], 0)
      const b = createHeightField(WORLD_SEEDS[1], 1)
      const corr = correlation(a.height, b.height)
      // 设计文档 §六 T1：两图高度场相关系数 < 0.6，确保不是"换了个种子的同一张图"。
      expect(corr).toBeLessThan(0.6)
    })

    it('T1 骨架差异锁：两图起终点与地标集合不同', () => {
      const a = createHeightField(WORLD_SEEDS[0], 0)
      const b = createHeightField(WORLD_SEEDS[1], 1)
      expect(b.start).not.toEqual(a.start)
      expect(b.goal).not.toEqual(a.goal)
      const ids = (f: HeightField) =>
        f.landmarks
          .map((l) => l.id)
          .sort()
          .join(',')
      expect(ids(b)).not.toBe(ids(a))
    })

    it('二号地形确定性：同种子两次生成完全一致（铁律 #5）', () => {
      const a = createHeightField(WORLD_SEEDS[1], 1)
      const b = createHeightField(WORLD_SEEDS[1], 1)
      expect(summarize(b)).toEqual(summarize(a))
      expect(Array.from(b.height.slice(0, 4096))).toEqual(Array.from(a.height.slice(0, 4096)))
    })

    it('越界索引不抛错', () => {
      expect(() => createHeightField('kibo-mars-basin-v1', 99)).not.toThrow()
    })
  })
})
