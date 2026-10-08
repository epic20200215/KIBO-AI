/**
 * 值噪声与分形叠加。
 *
 * 刻意不使用 `fract(sin(...))` 式的解析哈希：那类哈希在 CPU（float64）与 GPU（float32）
 * 上会在整数边界附近发生跳变，无法满足确定性要求。这里改用由种子化 PRNG 生成的
 * 置换表，纯查表 + 平滑插值，结果只取决于种子。
 *
 * 本模块只在 CPU 侧运行。地形高度一律由 CPU 计算成数组后交给 GPU，
 * 不在着色器里重算噪声，一致性由构造保证。
 */
import type { Rng } from './rng'

const TABLE_SIZE = 256
const TABLE_MASK = TABLE_SIZE - 1

export type ValueNoise2D = {
  /** 单倍频值噪声，返回 [-1, 1] */
  noise: (x: number, y: number) => number
  /** 分形叠加，返回约 [-1, 1] */
  fbm: (x: number, y: number, octaves?: number, lacunarity?: number, gain?: number) => number
  /** 脊状噪声，用于沙丘脊与山脊，返回 [0, 1] */
  ridged: (x: number, y: number, octaves?: number) => number
}

/** 五次平滑插值（Perlin 的 quintic fade），一阶与二阶导数在格点处连续，避免出现网格状棱线。 */
function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function createValueNoise2D(rng: Rng): ValueNoise2D {
  const perm = new Uint8Array(TABLE_SIZE * 2)
  const values = new Float32Array(TABLE_SIZE)

  for (let i = 0; i < TABLE_SIZE; i += 1) perm[i] = i
  // Fisher–Yates，使用注入的 rng，保证可复现
  for (let i = TABLE_SIZE - 1; i > 0; i -= 1) {
    const j = rng.int(0, i)
    const tmp = perm[i]
    perm[i] = perm[j]
    perm[j] = tmp
  }
  for (let i = 0; i < TABLE_SIZE; i += 1) {
    perm[i + TABLE_SIZE] = perm[i]
    values[i] = rng.next() * 2 - 1
  }

  const latticeValue = (ix: number, iy: number): number => {
    const xi = ix & TABLE_MASK
    const yi = iy & TABLE_MASK
    return values[perm[perm[xi] + yi] & TABLE_MASK]
  }

  const noise = (x: number, y: number): number => {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const tx = fade(x - x0)
    const ty = fade(y - y0)
    const v00 = latticeValue(x0, y0)
    const v10 = latticeValue(x0 + 1, y0)
    const v01 = latticeValue(x0, y0 + 1)
    const v11 = latticeValue(x0 + 1, y0 + 1)
    return lerp(lerp(v00, v10, tx), lerp(v01, v11, tx), ty)
  }

  const fbm = (x: number, y: number, octaves = 5, lacunarity = 2.02, gain = 0.5): number => {
    let amplitude = 1
    let frequency = 1
    let sum = 0
    let norm = 0
    for (let i = 0; i < octaves; i += 1) {
      // 每一倍频旋转 0.7 弧度，打散不同倍频之间的轴向对齐，消除可见的方格重复
      const c = Math.cos(0.7 * i)
      const s = Math.sin(0.7 * i)
      const rx = (x * c - y * s) * frequency
      const ry = (x * s + y * c) * frequency
      sum += noise(rx, ry) * amplitude
      norm += amplitude
      amplitude *= gain
      frequency *= lacunarity
    }
    return sum / norm
  }

  const ridged = (x: number, y: number, octaves = 4): number => {
    let amplitude = 1
    let frequency = 1
    let sum = 0
    let norm = 0
    for (let i = 0; i < octaves; i += 1) {
      const n = 1 - Math.abs(noise(x * frequency, y * frequency))
      sum += n * n * amplitude
      norm += amplitude
      amplitude *= 0.5
      frequency *= 2.03
    }
    return sum / norm
  }

  return { noise, fbm, ridged }
}

/**
 * 域扭曲：先用一层噪声偏移采样坐标，再采样主噪声。
 * 这是让地貌"有走向、有沟壑"而不是一张柏林毯子的关键手段。
 */
export function domainWarp(
  n: ValueNoise2D,
  x: number,
  y: number,
  strength: number,
  frequency: number,
): { x: number; y: number } {
  const wx = n.fbm(x * frequency + 11.7, y * frequency - 4.3, 3)
  const wy = n.fbm(x * frequency - 8.1, y * frequency + 19.5, 3)
  return { x: x + wx * strength, y: y + wy * strength }
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}
