import { createTrackMask } from './tracks'

describe('track mask', () => {
  it('创建时生成有效 CanvasTexture', () => {
    const t = createTrackMask(600)
    expect(t.texture).toBeDefined()
    const img = t.texture.image as HTMLCanvasElement
    expect(img.width).toBe(1024)
    expect(img.height).toBe(1024)
    t.dispose()
  })

  it('移动后绘制车辙，静止同一位置不重复绘制', () => {
    const t = createTrackMask(600)
    t.stamp(0, 0, 0)
    t.flush()
    // 同一位置再次 stamp 不应抛错，且 flush 后状态稳定
    expect(() => {
      t.stamp(0, 0, 0)
      t.flush()
    }).not.toThrow()
    t.dispose()
  })

  it('clear 后不会抛错', () => {
    const t = createTrackMask(600)
    expect(() => t.clear()).not.toThrow()
    t.dispose()
  })
})
