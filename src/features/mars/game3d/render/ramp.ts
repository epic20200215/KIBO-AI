/**
 * 光照量化 ramp 贴图。
 *
 * 赛璐珞外观的核心：把连续的 N·L 映射成 3–4 个硬边档位。
 * 使用 `NearestFilter` 且 `generateMipmaps: false`，确保档位之间**没有任何插值**——
 * 一旦让 GPU 做线性过滤，硬边就会糊掉，整个外观就会掉回半 PBR 的观感。
 */
import { ClampToEdgeWrapping, DataTexture, LinearSRGBColorSpace, NearestFilter, RGBAFormat, UnsignedByteType } from 'three'
import { RAMP_BANDS, RAMP_THRESHOLDS, hexToLinearRgb } from './palette'

/** ramp 贴图宽度。64 足以精确表达三个阈值的位置，且体积可忽略。 */
const RAMP_WIDTH = 64

export type RampTexture = DataTexture & { dispose: () => void }

/**
 * 生成 ramp 贴图。每个档位输出「明度 + 染色」两组信息：
 * - RGB 通道存该档位的最终乘算色（明度已乘进去）
 * - A 通道存档位序号 / 255，供着色器判断当前处于第几档（用于分档高光等）
 */
export function createRampTexture(): RampTexture {
  const data = new Uint8Array(RAMP_WIDTH * 4)

  for (let i = 0; i < RAMP_WIDTH; i += 1) {
    const t = i / (RAMP_WIDTH - 1)

    // 硬查表：落在哪个档位就取哪个档位，不做任何插值
    let band = 0
    for (let b = 0; b < RAMP_THRESHOLDS.length; b += 1) {
      if (t >= RAMP_THRESHOLDS[b]) band = b + 1
    }

    const spec = RAMP_BANDS[band]
    const [tr, tg, tb] = hexToLinearRgb(spec.tint)
    const a = spec.tintAmount

    // 乘算色 = 明度 × (1 - 染色量) + 染色 × 染色量
    const r = spec.brightness * (1 - a) + tr * a
    const g = spec.brightness * (1 - a) + tg * a
    const bch = spec.brightness * (1 - a) + tb * a

    data[i * 4] = Math.round(Math.min(1, r) * 255)
    data[i * 4 + 1] = Math.round(Math.min(1, g) * 255)
    data[i * 4 + 2] = Math.round(Math.min(1, bch) * 255)
    data[i * 4 + 3] = Math.round((band / 255) * 255)
  }

  const texture = new DataTexture(data, RAMP_WIDTH, 1, RGBAFormat, UnsignedByteType)
  texture.magFilter = NearestFilter
  texture.minFilter = NearestFilter
  texture.generateMipmaps = false
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.colorSpace = LinearSRGBColorSpace
  texture.needsUpdate = true
  return texture as RampTexture
}

/**
 * KIBO 专用的更白 ramp（2026-09-01）。
 *
 * 与全局 ramp 用同一套阈值/档位结构，但每档的明度和染色量都大幅往"白"偏：
 * - 暗档 brightness 从 0.34 提到 0.62（不再压成深紫）
 * - 染色量从 0.50/0.38 降到 0.10/0.06（不再被紫灰阴影吞掉白）
 * - 亮档保持 1.00 接近纯白
 *
 * 原因：KIBO 是教学 NPC，必须明显读作"白为主、橘+青点缀"；
 * 但全局 ramp 的暗档太深/染色太重（专为火星地表红褐 + 紫色阴影设计），
 * 用在白色身体上会把整个 KIBO 压成灰紫色。用户连续 3 次反馈"KIBO 是灰色的"。
 */
const KIBO_BANDS = [
  // 暗档：明度从 0.62 再提到 0.85，染色去掉冷灰换成极淡暖白 (#fdfaf4) 染色量 0.05
  { brightness: 0.85, tint: '#fdfaf4', tintAmount: 0.05 },
  // 中暗档：明度 0.78→0.92 暖白
  { brightness: 0.92, tint: '#fdfaf4', tintAmount: 0.03 },
  // 亮档：明度 0.95→0.98
  { brightness: 0.98, tint: '#fff8e8', tintAmount: 0.02 },
  // 最亮档：纯白
  { brightness: 1.00, tint: '#ffffff', tintAmount: 0.00 },
] as const

export function createKiboRampTexture(): RampTexture {
  const data = new Uint8Array(RAMP_WIDTH * 4)

  for (let i = 0; i < RAMP_WIDTH; i += 1) {
    const t = i / (RAMP_WIDTH - 1)

    let band = 0
    for (let b = 0; b < RAMP_THRESHOLDS.length; b += 1) {
      if (t >= RAMP_THRESHOLDS[b]) band = b + 1
    }

    const spec = KIBO_BANDS[band]
    const [tr, tg, tb] = hexToLinearRgb(spec.tint)
    const a = spec.tintAmount

    const r = spec.brightness * (1 - a) + tr * a
    const g = spec.brightness * (1 - a) + tg * a
    const bch = spec.brightness * (1 - a) + tb * a

    data[i * 4] = Math.round(Math.min(1, r) * 255)
    data[i * 4 + 1] = Math.round(Math.min(1, g) * 255)
    data[i * 4 + 2] = Math.round(Math.min(1, bch) * 255)
    data[i * 4 + 3] = Math.round((band / 255) * 255)
  }

  const texture = new DataTexture(data, RAMP_WIDTH, 1, RGBAFormat, UnsignedByteType)
  texture.magFilter = NearestFilter
  texture.minFilter = NearestFilter
  texture.generateMipmaps = false
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.colorSpace = LinearSRGBColorSpace
  texture.needsUpdate = true
  return texture as RampTexture
}

/**
 * 可复用的 GLSL 片段：从 ramp 贴图取量化光照。
 * 各材质共享同一段代码，保证全场光照分档口径完全一致。
 */
export const RAMP_GLSL = /* glsl */ `
uniform sampler2D uRamp;

vec3 rampShade(float ndl) {
  // 把 [-1,1] 的 N·L 重映射到 [0,1]，保留一点环境回弹光避免暗部死黑
  float t = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
  return texture(uRamp, vec2(t, 0.5)).rgb;
}

float rampBand(float ndl) {
  float t = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
  return texture(uRamp, vec2(t, 0.5)).a * 255.0;
}
`
