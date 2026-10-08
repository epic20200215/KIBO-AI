/**
 * 车辙轨迹遮罩（M6）。
 *
 * 火星表面几乎没有流水与植被，漫游车压出的辙痕能保留数十年——
 * 所以这里**不做淡出**，只做累积。这既符合真实，也让学生在复盘阶段
 * 能一眼看出"R-7 到底走过哪里"，与规划路线的丝带形成对照。
 *
 * 实现：一张覆盖整个盆地的单通道遮罩（用 Canvas2D 画，转 CanvasTexture），
 * 地形着色器采样后压暗地表并叠两道平行轮压线。
 *
 * 性能：只在车实际移动时画一小段线段，不做全画布操作；
 * 纹理上传通过脏标记合并到每帧最多一次。
 */
import { CanvasTexture, LinearFilter, ClampToEdgeWrapping, type Texture } from 'three'
import { rightVector } from './orientation'

export type TrackMask = {
  texture: Texture
  /**
   * 记录漫游车当前位姿压出的辙痕。
   * @param x 世界 X
   * @param z 世界 Z
   * @param heading 车头朝向（弧度，绕 Y 轴），用于算左右轮的偏移
   */
  stamp: (x: number, z: number, heading: number) => void
  /** 把本帧累积的绘制推送到 GPU。每帧调一次即可。 */
  flush: () => void
  /** 清空辙痕（任务重置时调用）。 */
  clear: () => void
  dispose: () => void
}

/** 遮罩分辨率。1024 覆盖 600m 盆地 ≈ 每像素 0.59m，足够画清两道轮压。 */
const MASK_RES = 1024
/** R-7 左右轮距的一半（米）。 */
const HALF_TRACK_WIDTH = 1.15

export function createTrackMask(basinSize: number): TrackMask {
  const canvas = document.createElement('canvas')
  canvas.width = MASK_RES
  canvas.height = MASK_RES
  const ctx = canvas.getContext('2d')

  if (ctx) {
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, MASK_RES, MASK_RES)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#ffffff'
  }

  const texture = new CanvasTexture(canvas)
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.generateMipmaps = false

  const pxPerMeter = MASK_RES / basinSize
  /** 世界坐标 → 遮罩像素坐标。与地形着色器 `vWorld.xz / uBasinSize + 0.5` 保持同一映射。 */
  const toPx = (v: number) => (v / basinSize + 0.5) * MASK_RES

  let last: { lx: number; lz: number; rx: number; rz: number } | null = null
  let dirty = false

  const stamp = (x: number, z: number, heading: number) => {
    if (!ctx) return

    // 轮距沿车身右侧展开，必须垂直于行进方向。
    // 这里曾经误用了"正面向量"，只因为当时 heading 本身也偏了 90°才碰巧对上。
    const n = rightVector(heading)
    const lx = x + n.x * HALF_TRACK_WIDTH
    const lz = z + n.z * HALF_TRACK_WIDTH
    const rx = x - n.x * HALF_TRACK_WIDTH
    const rz = z - n.z * HALF_TRACK_WIDTH

    if (last) {
      // 移动距离太小就不画，避免同一位置反复叠加到死白
      const moved = Math.hypot(x - (last.lx + last.rx) / 2, z - (last.lz + last.rz) / 2)
      if (moved < 0.25) return

      ctx.lineWidth = Math.max(1.5, 0.55 * pxPerMeter)
      ctx.beginPath()
      ctx.moveTo(toPx(last.lx), toPx(last.lz))
      ctx.lineTo(toPx(lx), toPx(lz))
      ctx.moveTo(toPx(last.rx), toPx(last.rz))
      ctx.lineTo(toPx(rx), toPx(rz))
      ctx.stroke()
      dirty = true
    }

    last = { lx, lz, rx, rz }
  }

  const flush = () => {
    if (!dirty) return
    texture.needsUpdate = true
    dirty = false
  }

  const clear = () => {
    if (!ctx) return
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, MASK_RES, MASK_RES)
    ctx.strokeStyle = '#ffffff'
    last = null
    texture.needsUpdate = true
    dirty = false
  }

  return {
    texture,
    stamp,
    flush,
    clear,
    dispose: () => {
      texture.dispose()
    },
  }
}
