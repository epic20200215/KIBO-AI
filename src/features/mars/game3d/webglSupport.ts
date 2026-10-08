/**
 * WebGL 能力检测。
 *
 * 从原 `scene3d/flags.ts` 迁移而来：2.5D 盆地层（MarsBasinLayer）已删除，
 * 但 3D 主舞台仍需要在初始化前判断浏览器是否能创建 WebGL 上下文。
 * 该函数不依赖任何 2.5D 代码，独立保留在 game3d 下。
 */

export function canCreateWebGLContext(): boolean {
  if (typeof document === 'undefined') return false
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}
