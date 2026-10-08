import { createHeightField } from '../core/heightField'
import { createGrid, type GridCell } from '../core/grid'
import { createKnowledgeField, KNOW_RES } from '../core/knowledge'
import {
  MINI_UNKNOWN,
  sampleMinimap,
  worldToMini,
  cellGlyph,
  sampleGlyphs,
  phaseShowsRiskGlyphs,
  glyphScaleVisible,
  GLYPH_CODE,
} from './minimap'

const field = createHeightField('kibo-mars-basin-v1')

describe('小地图采样', () => {
  it('全未探测时整张底图都是"未知"色', () => {
    const grid = createGrid(field, KNOW_RES, 14, 24)
    const bmp = sampleMinimap(grid, 32)
    expect(bmp.length).toBe(32 * 32 * 4)
    // 抽查若干像素都等于未知色（res=32 共 1024 像素，索引须 < 1024）
    for (const idx of [0, 100, 500, 800, 1023]) {
      const o = idx * 4
      expect([bmp[o], bmp[o + 1], bmp[o + 2]]).toEqual([...MINI_UNKNOWN])
      expect(bmp[o + 3]).toBe(255)
    }
  })

  it('扫描后对应区域不再是未知色', () => {
    const grid = createGrid(field, KNOW_RES, 14, 24)
    const know = createKnowledgeField(KNOW_RES)
    know.reveal(field.start.x, field.start.z, 80)
    grid.syncKnowledge(know)
    const res = 48
    const bmp = sampleMinimap(grid, res)
    // 起点对应的小地图像素应当已被着色为非未知
    const { mx, my } = worldToMini(field.start.x, field.start.z, res)
    const i = Math.min(res - 1, Math.floor(mx))
    const j = Math.min(res - 1, Math.floor(my))
    const o = (j * res + i) * 4
    const isUnknown =
      bmp[o] === MINI_UNKNOWN[0] && bmp[o + 1] === MINI_UNKNOWN[1] && bmp[o + 2] === MINI_UNKNOWN[2]
    expect(isUnknown).toBe(false)
  })

  it('worldToMini 把盆地中心映射到画布中心，边角映射到边角', () => {
    const res = 100
    const c = worldToMini(0, 0, res)
    expect(c.mx).toBeCloseTo(50, 5)
    expect(c.my).toBeCloseTo(50, 5)
    const corner = worldToMini(-600, -600, res)
    expect(corner.mx).toBeCloseTo(0, 5)
    expect(corner.my).toBeCloseTo(0, 5)
  })
})

/** 构造一个最小 GridCell 用于字形单测（默认已探明、通行、无隐患）。 */
function mk(over: Partial<GridCell> = {}): GridCell {
  return {
    i: 0,
    j: 0,
    x: 0,
    z: 0,
    height: 0,
    slopeDeg: 5,
    soft: 0,
    rock: 0,
    confidence: 1,
    scanned: 1,
    flag: 0,
    trueFlag: 0,
    ...over,
  }
}

describe('逐格风险字形（A2）', () => {
  it('未探测格返回 unknown（无字形）', () => {
    expect(cellGlyph(mk({ scanned: 0 }))).toBe('unknown')
    expect(cellGlyph(null)).toBe('unknown')
  })

  it('坡度禁行优先于一切地表隐患', () => {
    expect(cellGlyph(mk({ flag: 2, rock: 0.9, soft: 0.9 }))).toBe('blocked')
  })

  it('岩石出露（rock ≥ 阈值）标 rock，压过坡度谨慎', () => {
    expect(cellGlyph(mk({ flag: 1, rock: 0.6 }))).toBe('rock')
  })

  it('软沙（soft ≥ 阈值）标 soft', () => {
    expect(cellGlyph(mk({ soft: 0.7 }))).toBe('soft')
  })

  it('仅坡度谨慎、无岩软时标 caution', () => {
    expect(cellGlyph(mk({ flag: 1, rock: 0.1, soft: 0.1 }))).toBe('caution')
  })

  it('已探明、通行、无隐患标 none', () => {
    expect(cellGlyph(mk({ flag: 0, rock: 0.1, soft: 0.1 }))).toBe('none')
  })

  it('未探明的岩石/软沙不标字形（诚实：没数据就不下结论）', () => {
    expect(cellGlyph(mk({ scanned: 0.3, rock: 0.9, soft: 0.9 }))).toBe('unknown')
  })

  it('sampleGlyphs 与 sampleMinimap 同映射：标记格在字形图里可见', () => {
    const grid = createGrid(field, KNOW_RES, 14, 24)
    const know = createKnowledgeField(KNOW_RES)
    know.reveal(field.start.x, field.start.z, 80)
    grid.syncKnowledge(know)
    const res = 32
    const glyphs = sampleGlyphs(grid, res)
    expect(glyphs.length).toBe(res * res)
    // 起点附近被探明：至少应出现一个非 unknown/none 的字形（坡度分档或岩软）
    const startGlyph = (() => {
      const { mx, my } = worldToMini(field.start.x, field.start.z, res)
      const i = Math.min(res - 1, Math.floor(mx))
      const j = Math.min(res - 1, Math.floor(my))
      return glyphs[j * res + i]
    })()
    expect(startGlyph).not.toBe(GLYPH_CODE.unknown)
  })
})

describe('风险字形阶段显隐（A4）', () => {
  it('plan/revise/report 显示字形', () => {
    expect(phaseShowsRiskGlyphs('plan')).toBe(true)
    expect(phaseShowsRiskGlyphs('revise')).toBe(true)
    expect(phaseShowsRiskGlyphs('report')).toBe(true)
  })
  it('scan/drive 淡出字形，避免跟车视图抢焦点', () => {
    expect(phaseShowsRiskGlyphs('scan')).toBe(false)
    expect(phaseShowsRiskGlyphs('drive')).toBe(false)
  })
})

describe('缺口-6：字形缩放门控', () => {
  it('每格像素 ≥2 才绘制逐格字形，亚像素小缩略图（scale≈1.5）靠颜色分档', () => {
    expect(glyphScaleVisible(1.5)).toBe(false) // 小缩略图 96/64
    expect(glyphScaleVisible(2)).toBe(true)
    expect(glyphScaleVisible(2.5)).toBe(true) // 放大/决策阶段 160/64
  })
})
