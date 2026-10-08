import { BASIN_SIZE, LANDMARKS, createHeightField } from './heightField'
import { createRng, seedFromString } from './rng'

describe('rng', () => {
  it('同种子产出同序列', () => {
    const a = createRng(seedFromString('kibo'))
    const b = createRng(seedFromString('kibo'))
    const seqA = Array.from({ length: 32 }, () => a.next())
    const seqB = Array.from({ length: 32 }, () => b.next())
    expect(seqA).toEqual(seqB)
  })

  it('fork 出的子流互不干扰', () => {
    const parent = createRng(1234)
    const first = parent.fork(7)
    // 父流被额外消费若干次后，同 salt 派生的子流仍应一致
    parent.next()
    parent.next()
    const second = createRng(1234).fork(7)
    expect(first.next()).toBe(second.next())
  })

  it('分布落在 [0,1)', () => {
    const rng = createRng(99)
    for (let i = 0; i < 500; i += 1) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('heightField', () => {
  const field = createHeightField('kibo-mars-basin-v1')

  it('同种子生成逐点一致的高度场', () => {
    const again = createHeightField('kibo-mars-basin-v1')
    expect(again.height.length).toBe(field.height.length)
    let maxDiff = 0
    for (let i = 0; i < field.height.length; i += 7) {
      maxDiff = Math.max(maxDiff, Math.abs(field.height[i] - again.height[i]))
    }
    expect(maxDiff).toBe(0)
  })

  it('不同种子产生不同地形', () => {
    const other = createHeightField('kibo-mars-basin-v2')
    let diff = 0
    for (let i = 0; i < field.height.length; i += 101) {
      diff += Math.abs(field.height[i] - other.height[i])
    }
    expect(diff).toBeGreaterThan(0)
  })

  it('着陆平台与目标点是水平的（坡度低于 3 度）', () => {
    for (const id of ['landing', 'target']) {
      const lm = LANDMARKS.find((l) => l.id === id)!
      expect(field.slopeDegAt(lm.x, lm.z)).toBeLessThan(3)
    }
  })

  it('窄脊背明显高于其两侧', () => {
    const ridge = LANDMARKS.find((l) => l.id === 'ridge')!
    const onRidge = field.heightAt(ridge.x, ridge.z)
    const offA = field.heightAt(ridge.x - 46, ridge.z - 34)
    const offB = field.heightAt(ridge.x + 46, ridge.z + 34)
    expect(onRidge).toBeGreaterThan(Math.max(offA, offB) + 6)
  })

  it('主陨石坑中心低于其坑缘', () => {
    const crater = LANDMARKS.find((l) => l.id === 'crater')!
    const center = field.heightAt(crater.x, crater.z)
    const rim = field.heightAt(crater.x + crater.radius * 0.92, crater.z)
    expect(rim).toBeGreaterThan(center + 8)
  })

  it('干涸河床低于其两侧河岸', () => {
    const bedX = -142
    const bedZ = 150
    const bed = field.heightAt(bedX, bedZ)
    const bank = field.heightAt(bedX + 4, bedZ + 74)
    expect(bank).toBeGreaterThan(bed + 2)
  })

  it('沙丘带的松软度显著高于河床', () => {
    const dune = LANDMARKS.find((l) => l.id === 'dune')!
    expect(field.softAt(dune.x, dune.z)).toBeGreaterThan(field.softAt(-142, 150) + 0.1)
  })

  it('盲区置信度显著偏低', () => {
    const blind = LANDMARKS.find((l) => l.id === 'blind')!
    expect(field.confidenceAt(blind.x, blind.z)).toBeLessThan(0.3)
    expect(field.confidenceAt(0, 0)).toBeGreaterThan(0.9)
  })

  it('盆地边缘抬升形成自然边界（而非一堵墙）', () => {
    const edge = field.heightAt(BASIN_SIZE / 2 - 6, 0)
    const middle = field.heightAt(0, 0)
    // 边缘相对中心抬升，但整体缓于 24° 禁行阈值，避免把大半盆地判成禁行
    expect(edge).toBeGreaterThan(middle + 8)
    expect(edge).toBeLessThan(middle + 40)
  })

  it('法线为单位向量且朝上', () => {
    const n = field.normalAt(30, -40)
    expect(Math.hypot(n[0], n[1], n[2])).toBeCloseTo(1, 5)
    expect(n[1]).toBeGreaterThan(0)
  })

  it('采样越界时钳制而不是产生 NaN', () => {
    expect(Number.isFinite(field.heightAt(-9999, 9999))).toBe(true)
    expect(Number.isFinite(field.slopeDegAt(9999, -9999))).toBe(true)
  })
})
