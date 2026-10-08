import { createPostFX, NO_EDGE_LAYER, setLayerRecursive } from './postfx'
import type { PerspectiveCamera, WebGLRenderer } from 'three'

/**
 * postfx 模块在 jsdom 下无法真正分配 WebGLRenderTarget，但它构造阶段被 try 包裹，
 * 会退回到"直连渲染"，接口保持可用。本测试验证降级后行为不崩、API 完整。
 */

describe('createPostFX', () => {
  it('在缺失 WebGL 环境时仍返回完整 API，low 画质或异常时退回到直连渲染', () => {
    const renderer = {
      getPixelRatio: () => 1,
      setRenderTarget: vi.fn(),
      setClearColor: vi.fn(),
      getClearColor: vi.fn(() => ({ copy: vi.fn() })),
      getClearAlpha: vi.fn(() => 1),
      clear: vi.fn(),
      render: vi.fn(),
      info: { render: { calls: 0 } },
    } as unknown as WebGLRenderer

    const fx = createPostFX(renderer, 3000)
    expect(typeof fx.render).toBe('function')
    expect(typeof fx.dispose).toBe('function')

    const scene = { overrideMaterial: null } as any
    const camera = { layers: { mask: 0xffffffff, set: vi.fn() }, far: 3000 } as unknown as PerspectiveCamera

    // 当 active() 返回 false 时，必须等价于 renderer.render(scene, camera)
    fx.setQuality('low')
    expect(fx.isActive()).toBe(false)

    fx.render(scene as any, camera)
    expect(renderer.render).toHaveBeenCalledWith(scene, camera)

    fx.setSize(640, 480)
    fx.dispose()
  })

  it('setLayerRecursive 会递归设定图层', () => {
    const root = {
      traverse: (cb: (o: any) => void) => {
        const a = { layers: { set: vi.fn() } }
        const b = { layers: { set: vi.fn() } }
        cb(a)
        cb(b)
      },
    } as any
    setLayerRecursive(root, NO_EDGE_LAYER)
  })
})
