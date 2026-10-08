/**
 * 种子化伪随机数发生器。
 *
 * KIBO 纲领「3D 任务舞台准入条件」第 3 条要求：同种子加同输入必须得到同结果。
 * 因此本工程 3D 部分**禁止使用 `Math.random()`**，一切随机性都必须经由此处注入。
 *
 * 算法为 mulberry32：32 位状态，周期 2^32，分布质量足够场景生成与视觉抖动使用，
 * 且实现只用整数移位与乘法，跨平台逐位可复现。
 */
export type Rng = {
  /** [0, 1) 均匀分布 */
  next: () => number
  /** [min, max) 均匀分布 */
  range: (min: number, max: number) => number
  /** [min, max] 闭区间整数 */
  int: (min: number, max: number) => number
  /** 派生一个独立子流，避免不同子系统消费次数互相干扰 */
  fork: (salt: number) => Rng
}

/** 把任意字符串折叠成 32 位种子，便于用可读的字符串命名种子。 */
export function seedFromString(input: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const range = (min: number, max: number) => min + next() * (max - min)
  const int = (min: number, max: number) => Math.floor(range(min, max + 1))

  /**
   * 子流不复用父流状态，而是用父流的初始种子与 salt 重新派生，
   * 这样某个子系统多消费或少消费若干个随机数，都不会改变其他子系统的结果。
   */
  const fork = (salt: number) => createRng((Math.imul(seed >>> 0, 0x9e3779b1) ^ (salt >>> 0)) >>> 0)

  return { next, range, int, fork }
}
