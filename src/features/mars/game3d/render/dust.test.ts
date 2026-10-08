import { createDustSystem } from './dust'

describe('dust', () => {
  it('emit 会增加存活粒子数', () => {
    const d = createDustSystem()
    expect(d.activeCount()).toBe(0)
    d.emit({ x: 0, y: 0, z: 0 }, 1)
    expect(d.activeCount()).toBeGreaterThan(0)
    d.dispose()
  })

  it('同强度、同时间推进后结果确定（mulberry32）', () => {
    const a = createDustSystem()
    const b = createDustSystem()
    for (let i = 0; i < 8; i += 1) {
      a.emit({ x: i * 0.1, y: 0, z: 0 }, 0.8)
      b.emit({ x: i * 0.1, y: 0, z: 0 }, 0.8)
      a.setTime(i * 0.05 + 0.05)
      b.setTime(i * 0.05 + 0.05)
    }
    expect(a.activeCount()).toBe(b.activeCount())
    a.dispose()
    b.dispose()
  })

  it('reducedMotion 降低粒子发射数量', () => {
    const normal = createDustSystem()
    const calm = createDustSystem()
    calm.setReducedMotion(true)

    for (let i = 0; i < 10; i += 1) {
      normal.emit({ x: 0, y: 0, z: 0 }, 1)
      calm.emit({ x: 0, y: 0, z: 0 }, 1)
      normal.setTime(i * 0.1 + 0.1)
      calm.setTime(i * 0.1 + 0.1)
    }

    expect(calm.activeCount()).toBeLessThan(normal.activeCount())
    normal.dispose()
    calm.dispose()
  })

  it('粒子生命周期结束后会回收', () => {
    const d = createDustSystem()
    d.emit({ x: 0, y: 0, z: 0 }, 1)
    d.setTime(0)
    const alive = d.activeCount()
    expect(alive).toBeGreaterThan(0)
    // setTime 内部把 dt 限制在 0.05，模拟逐帧推进 3 秒
    for (let f = 1; f <= 90; f += 1) d.setTime(f * 0.05)
    expect(d.activeCount()).toBe(0)
    d.dispose()
  })
})
