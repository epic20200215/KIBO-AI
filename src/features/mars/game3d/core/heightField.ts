/**
 * 火星盆地高度场——本任务的唯一事实源。
 *
 * 设计原则
 * ---------
 * 1. **CPU 单一实现。** 高度、松软度、岩石密度全部在 CPU 侧算成 Float32Array，
 *    渲染时顶点直接取用，规划器与物理也读同一份数组。不在着色器里重算噪声，
 *    因此不存在 CPU/GPU 结果不一致的可能——一致性由构造保证，而不是靠比对验证。
 * 2. **可读地貌，不是噪声毯子。** 在盆地底形之上显式放置陨石坑、干涸河床、
 *    风成沙丘脊、窄脊背等地貌，每一处都对应一段教学意图（见 LANDMARKS）。
 * 3. **确定性。** 全部随机来自注入的种子化 PRNG。
 *
 * 坐标系：世界坐标 X/Z 为水平面，Y 向上，单位为米。盆地中心位于原点。
 */
import { createRng, seedFromString, type Rng } from './rng'
import { clamp, createValueNoise2D, domainWarp, smoothstep, type ValueNoise2D } from './noise'

/** 盆地边长（米）。1200×1200 给用户足够的探索与驾驶空间。 */
export const BASIN_SIZE = 1200
/** 高度场采样分辨率（每边采样点数）。1200 / 384 ≈ 3.12 米/采样。 */
export const FIELD_RES = 385
const HALF = BASIN_SIZE / 2
const CELL = BASIN_SIZE / (FIELD_RES - 1)

/** 两张正式地图的种子。火星一号 = 陨石坑盆地；火星二号 = 外流河道（独立地貌构建器）。 */
export const WORLD_SEEDS = [
  'kibo-mars-basin-v1', // 火星一号：陨石坑盆地，完整 AI PBL 闭环
  'kibo-mars-outflow-v1', // 火星二号：外流河道 + 混沌台地，规则泛化 + 盲区指挥
] as const
export type WorldIndex = 0 | 1
export const WORLD_COUNT = WORLD_SEEDS.length
/** 火星任务正式版本开放的地图数量（当前为 2：火星一号 / 火星二号）。 */
export const MARS_MAP_COUNT = 2
/**
 * 面向玩家的地图命名。对外一律说「火星一号 / 火星二号」，不再暴露内部代号 A/B/C，
 * 否则玩家看到的地图数量和引导文案会对不上。索引按 MARS_MAP_COUNT 长度取用。
 */
export const MARS_MAP_NAMES = ['火星一号', '火星二号'] as const
/** 取指定索引的地图名；越界时退回最后一张，避免出现 undefined 文案。 */
export function marsMapName(index: number): string {
  const clamped = Math.max(0, Math.min(MARS_MAP_COUNT - 1, Math.trunc(index) || 0))
  return MARS_MAP_NAMES[clamped]
}

/**
 * 三段强制教学弧的叙事锚点（P2）。
 * A 教闭环 → B 用更崎岖地形逼出更严谨的规则 → C 是 AI 未见过的地形，路线必含盲区，
 * 学生必须在盲区下达指挥命令并预览后果（P6）。文案集中在这一处，评审若改叙事只动这里。
 */
export type WorldGoal = {
  id: 'A' | 'B'
  label: string
  /** 一句话目标，显示在 HUD 任务追踪器。 */
  brief: string
  /** 进入该地图时 KIBO 点出的教学意图。 */
  teaching: string
}
export const WORLD_GOALS: WorldGoal[] = [
  {
    id: 'A',
    label: '火星一号地图',
    brief: '完整任务步骤：发现问题、采集数据、清洗数据、数据标记、训练AI、验证AI、实践结论。',
    teaching: '地形平缓，先把每个环节跑通顺——这条路线只是练习，重点是把流程记住。',
  },
  {
    id: 'B',
    label: '火星二号地图',
    brief: '外流河道与混沌台地：用一号地图学到的规则验证新地貌，还要在支谷盲区下达指挥命令。',
    teaching: '规则定松了，刚才能走的路现在翻车。没扫到的盲区，你要替 AI 拍板并承担后果。',
  },
]

export type Landmark = {
  id: string
  kind: 'landing' | 'target' | 'sample' | 'crater' | 'riverbed' | 'ridge' | 'dune' | 'blind'
  label: string
  /** 教学意图：这块地貌是为了让学生遇到什么问题 */
  intent: string
  x: number
  z: number
  radius: number
}

export type HeightField = {
  size: number
  res: number
  cell: number
  height: Float32Array
  /** 地表松软度 0..1，越高越容易陷车 */
  soft: Float32Array
  /** 岩石密度 0..1，越高越颠簸、越难通过 */
  rock: Float32Array
  /** 观测基础置信度 0..1，地形阴影处天然偏低（扫描盲区） */
  confidence: Float32Array
  minHeight: number
  maxHeight: number
  landmarks: Landmark[]
  start: { x: number; z: number }
  goal: { x: number; z: number }
  heightAt: (x: number, z: number) => number
  softAt: (x: number, z: number) => number
  rockAt: (x: number, z: number) => number
  confidenceAt: (x: number, z: number) => number
  /** 中心差分法线（已归一化） */
  normalAt: (x: number, z: number, out?: [number, number, number]) => [number, number, number]
  /** 坡度（角度制，0 为水平） */
  slopeDegAt: (x: number, z: number) => number
  /** 世界坐标是否在盆地可用范围内 */
  contains: (x: number, z: number) => boolean
}

/** 着陆点与科学目标点。放在盆地内部缓坡，避免落在边缘陡坎上被隔离；
 *  仍分置对角，逼出一条穿越河床/沙丘/坑缘/脊背/岩石迷阵的长路线。 */
const START = { x: -300, z: 260 }
const GOAL = { x: 420, z: -340 }

/** 干涸河床中心线（世界坐标控制点），从西南着陆点方向蜿蜒到盆地中部。 */
const RIVERBED: Array<[number, number]> = [
  [-572, 316],
  [-428, 352],
  [-284, 300],
  [-184, 192],
  [-128, 68],
  [-76, -28],
]

/** 窄脊背/岩石迷阵中心线：两侧陡坡，容错极小，延伸至远场能源站前。 */
const RIDGE_SPINE: Array<[number, number]> = [
  [192, 148],
  [268, 44],
  [316, -44],
  [340, -120],
  [360, -200],
  [380, -280],
]

type Crater = { x: number; z: number; radius: number; depth: number; rim: number }

export const LANDMARKS: Landmark[] = [
  {
    id: 'landing',
    kind: 'landing',
    label: '着陆平台',
    intent: '起点。地面被夯平，让学生在完全确定的条件下开始。',
    x: START.x,
    z: START.z,
    radius: 44,
  },
  {
    id: 'target',
    kind: 'target',
    label: '能源站',
    intent: '终点。位于岩石迷阵之后，需要 AI 规划才能安全抵达。',
    x: GOAL.x,
    z: GOAL.z,
    radius: 40,
  },
  {
    id: 'riverbed',
    kind: 'riverbed',
    label: '干涸河床',
    intent: '平坦、低耗能的快速段。让学生先体验"规划顺利"是什么感觉。',
    // 故意放在河床折线中段（盆地内部、远离着陆点），避开 LANDING_REVEAL=90m 的默认已探明圈，
    // 否则初始 scannedAt>=0.5 会让引导箭头在还没扫描时就误显绿色。
    x: -184,
    z: 192,
    radius: 140,
  },
  {
    id: 'dune',
    kind: 'dune',
    label: '风成沙丘带',
    intent: '坡度不高但松软度高。教学点：坡度不是唯一的通行代价。',
    x: -264,
    z: -92,
    radius: 192,
  },
  {
    id: 'crater',
    kind: 'crater',
    label: '主陨石坑坑缘',
    intent: '坑缘是抬升的陡坡，绕行远但安全，穿坑近但要爬两次陡坡。',
    x: 104,
    z: -68,
    radius: 156,
  },
  {
    id: 'ridge',
    kind: 'ridge',
    label: '岩石迷阵',
    intent: '远场窄脊背群，最短路径但两侧陡坡容错极小。能源采集车必须靠 AI 路径穿越。',
    x: 284,
    z: 8,
    radius: 68,
  },
  {
    id: 'blind',
    kind: 'blind',
    label: '坑缘阴影盲区',
    intent: '正好卡在最短路径上的低置信度区域，逼出显式的不确定性抉择。',
    x: 236,
    z: -216,
    radius: 92,
  },
  { id: 'sample-a', kind: 'sample', label: '采样点 A · 河床沉积', intent: '沿途科学任务点。', x: -216, z: 236, radius: 24 },
  { id: 'sample-b', kind: 'sample', label: '采样点 B · 沙丘背风侧', intent: '沿途科学任务点。', x: -152, z: -156, radius: 24 },
  { id: 'sample-c', kind: 'sample', label: '采样点 C · 坑缘溅射毯', intent: '沿途科学任务点。', x: 216, z: 92, radius: 24 },
]

export function distanceToPolyline(
  x: number,
  z: number,
  pts: ReadonlyArray<readonly [number, number]>,
): number {
  let best = Infinity
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [ax, az] = pts[i]
    const [bx, bz] = pts[i + 1]
    const dx = bx - ax
    const dz = bz - az
    const lenSq = dx * dx + dz * dz
    let t = lenSq > 0 ? ((x - ax) * dx + (z - az) * dz) / lenSq : 0
    t = clamp(t, 0, 1)
    const px = ax + dx * t
    const pz = az + dz * t
    const d = Math.hypot(x - px, z - pz)
    if (d < best) best = d
  }
  return best
}

function makeCraters(rng: Rng): Crater[] {
  // 主坑手工放置（教学地貌），副坑用种子化随机点缀，避免画面空洞
  const craters: Crater[] = [
    { x: 104, z: -68, radius: 156, depth: 42, rim: 15 },
    { x: -392, z: -268, radius: 88, depth: 22, rim: 8.4 },
    { x: 392, z: 256, radius: 72, depth: 17, rim: 6.8 },
  ]
  for (let i = 0; i < 12; i += 1) {
    const angle = rng.range(0, Math.PI * 2)
    const dist = rng.range(120, HALF - 80)
    const radius = rng.range(18, 44)
    craters.push({
      x: Math.cos(angle) * dist,
      z: Math.sin(angle) * dist,
      radius,
      depth: radius * rng.range(0.2, 0.32),
      rim: radius * rng.range(0.07, 0.13),
    })
  }
  return craters
}

/** 单个陨石坑的高度贡献：碗底 + 抬起的坑缘 + 向外衰减的溅射毯。 */
function craterProfile(d: number, c: Crater): number {
  const t = d / c.radius
  if (t > 2.1) return 0
  // 碗：t<0.82 内为抛物面凹陷
  let h = 0
  if (t < 0.82) {
    const u = t / 0.82
    h -= c.depth * (1 - u * u)
  }
  // 坑缘：以 t=0.92 为中心的高斯隆起
  const rimT = (t - 0.92) / 0.16
  h += c.rim * Math.exp(-rimT * rimT)
  // 溅射毯：坑缘外缓慢衰减的薄抬升
  if (t > 1.0) {
    h += c.rim * 0.34 * Math.exp(-(t - 1.0) * 2.4)
  }
  return h
}

/**
 * 一号地图（陨石坑盆地）的地形构建。
 *
 * ⚠️ 这是火星一号（World 0）已通过最终审核的实现，**逐字节不得改动**——
 * 任何改动都触发「火星一号任务改动须经用户审核」红线。
 * 二号地图的新地貌一律走 `buildOutflowTerrain()`，不得在这里加 `if (worldIndex)`。
 */
function buildBasinTerrain(seedInput: string | number = 'kibo-mars-basin-v1'): HeightField {
  const seed = typeof seedInput === 'number' ? seedInput : seedFromString(seedInput)
  const rng = createRng(seed)
  const noise: ValueNoise2D = createValueNoise2D(rng.fork(1))
  const detail: ValueNoise2D = createValueNoise2D(rng.fork(2))
  const craters = makeCraters(rng.fork(3))

  const height = new Float32Array(FIELD_RES * FIELD_RES)
  const soft = new Float32Array(FIELD_RES * FIELD_RES)
  const rock = new Float32Array(FIELD_RES * FIELD_RES)
  const confidence = new Float32Array(FIELD_RES * FIELD_RES)

  let minHeight = Infinity
  let maxHeight = -Infinity

  // 需要夯平的区域：着陆平台、目标点、采样点
  const pads = LANDMARKS.filter((l) => l.kind === 'landing' || l.kind === 'target' || l.kind === 'sample')

  for (let j = 0; j < FIELD_RES; j += 1) {
    const z = -HALF + j * CELL
    for (let i = 0; i < FIELD_RES; i += 1) {
      const x = -HALF + i * CELL
      const idx = j * FIELD_RES + i

      // --- 1. 盆地底形：中间低、边缘抬升为环形山脊，形成自然边界而不是一堵墙
      // 边缘总抬升到 ~36m，让远景有台地/峭壁感，同时把陡段尽量推到 r>0.9。
      const r = Math.hypot(x, z) / HALF
      let h = -8 * (1 - clamp(r * r, 0, 1))
      h += smoothstep(0.80, 1.08, r) * 22
      h += smoothstep(0.94, 1.22, r) * 14

      // --- 2. 大尺度起伏（域扭曲，制造有走向的沟壑而非各向同性噪声）
      // 振幅提到 ±12m，盆地不再是"大平面"，波长~300m，大部分仍落在缓坡可通区间。
      const w = domainWarp(noise, x * 0.0034, z * 0.0034, 0.9, 0.7)
      h += noise.fbm(w.x, w.y, 5) * 12

      // --- 2b. 中尺度连绵丘陵：在底形上叠 ±5m 的可见起伏（波长约 200m，坡度≈7°），
      // 专门消除"地表太平面了"的观感，又不至于把整片变成陡坡禁行。
      h += detail.fbm(x * 0.03, z * 0.03, 4) * 5

      // --- 3. 中尺度碎石起伏（振幅 ±2.0m，增加地表颗粒起伏与可读性）
      const midN = detail.fbm(x * 0.019, z * 0.019, 4)
      h += midN * 2.0

      // --- 4. 干涸河床：沿中心线下切的平底河谷
      const dRiver = distanceToPolyline(x, z, RIVERBED)
      const riverMask = 1 - smoothstep(16, 62, dRiver)
      h -= riverMask * 5.6
      // 河谷底部额外压平（减少中尺度起伏的影响）
      h -= midN * 2.0 * riverMask * 0.85

      // --- 5. 窄脊背：细长抬升，两侧陡
      const dRidge = distanceToPolyline(x, z, RIDGE_SPINE)
      const ridgeMask = Math.exp(-((dRidge / 21) * (dRidge / 21)))
      h += ridgeMask * 28

      // --- 6. 陨石坑
      for (let k = 0; k < craters.length; k += 1) {
        const c = craters[k]
        const d = Math.hypot(x - c.x, z - c.z)
        if (d < c.radius * 2.1) h += craterProfile(d, c)
      }

      // --- 7. 风成沙丘脊：只在沙丘带内出现，横向波纹 + 迎风/背风不对称
      const duneLm = LANDMARKS[3]
      const dDune = Math.hypot(x - duneLm.x, z - duneLm.z)
      const duneMask = 1 - smoothstep(duneLm.radius * 0.55, duneLm.radius * 1.25, dDune)
      let duneAmount = 0
      if (duneMask > 0.001) {
        // 沙丘走向 32°，用非对称锐化正弦表现迎风缓、背风陡
        const dir = (x * 0.848 + z * 0.53) * 0.055
        const wobble = noise.fbm(x * 0.006, z * 0.006, 3) * 1.6
        const s = Math.sin(dir + wobble)
        const sharp = Math.sign(s) * Math.pow(Math.abs(s), 0.62)
        duneAmount = duneMask * (sharp * 0.5 + 0.5)
        h += duneMask * (sharp * 3.6 + 3.6)
      }

      // --- 8. 夯平区：着陆平台 / 目标点 / 采样点
      // 将 pad 区域向一个基准高度混合，消除坑底/脊背造成的局部深坑或尖顶，
      // 保证漫游车起点与目标点落在稳定、可通行的平地上。
      let padWeight = 0
      let padHeight = h
      for (let k = 0; k < pads.length; k += 1) {
        const p = pads[k]
        const d = Math.hypot(x - p.x, z - p.z)
        const wgt = 1 - smoothstep(p.radius * 0.6, p.radius * 1.5, d)
        if (wgt > padWeight) {
          padWeight = wgt
          // 着陆平台基准略高于盆地底形，目标点/采样点则贴合自然底形
          padHeight = p.kind === 'landing' ? -1.2 : -4.5
        }
      }
      if (padWeight > 0.001) {
        h = h * (1 - padWeight) + padHeight * padWeight
      }

      height[idx] = h
      if (h < minHeight) minHeight = h
      if (h > maxHeight) maxHeight = h

      // --- 松软度
      // 沙丘带整片都是松沙，波峰处更松（duneAmount 只做叠加变化，不做基底）；
      // 干涸河床是压实的砾石底，反而比周边更硬——这正是"它是快速段"的物理依据；
      // 脊背与坑缘是裸岩，最硬。
      const softBase = clamp(detail.fbm(x * 0.011 + 40, z * 0.011 - 12, 3) * 0.5 + 0.42, 0, 1)
      soft[idx] = clamp(
        softBase * 0.4 + duneMask * 0.46 + duneAmount * 0.24 - riverMask * 0.16 - ridgeMask * 0.3,
        0,
        1,
      )

      // --- 岩石密度：坑缘溅射毯与脊背最高，河床最低
      let ejecta = 0
      for (let k = 0; k < craters.length; k += 1) {
        const c = craters[k]
        const d = Math.hypot(x - c.x, z - c.z) / c.radius
        if (d < 2.0) ejecta = Math.max(ejecta, (1 - smoothstep(0.85, 2.0, d)) * 0.85)
      }
      const rockBase = clamp(noise.fbm(x * 0.014 - 60, z * 0.014 + 33, 4) * 0.6 + 0.44, 0, 1)
      rock[idx] = clamp(rockBase * 0.62 + ejecta * 0.6 + ridgeMask * 0.4 - riverMask * 0.3, 0, 1)

      // --- 基础置信度：坑缘阴影盲区天然偏低（地形自遮挡导致观测不完整）
      const blindLm = LANDMARKS[6]
      const dBlind = Math.hypot(x - blindLm.x, z - blindLm.z)
      const blindMask = 1 - smoothstep(blindLm.radius * 0.5, blindLm.radius * 1.25, dBlind)
      confidence[idx] = clamp(1 - blindMask * 0.86, 0, 1)
    }
  }

  // --- 夯平区二次处理：把 pad 中心邻域压向该 pad 中心的高度，得到真正水平的平台
  for (let k = 0; k < pads.length; k += 1) {
    const p = pads[k]
    const ci = Math.round((p.x + HALF) / CELL)
    const cj = Math.round((p.z + HALF) / CELL)
    const centerH = height[clamp(cj, 0, FIELD_RES - 1) * FIELD_RES + clamp(ci, 0, FIELD_RES - 1)]
    const reach = Math.ceil((p.radius * 1.5) / CELL)
    for (let j = cj - reach; j <= cj + reach; j += 1) {
      if (j < 0 || j >= FIELD_RES) continue
      for (let i = ci - reach; i <= ci + reach; i += 1) {
        if (i < 0 || i >= FIELD_RES) continue
        const x = -HALF + i * CELL
        const z = -HALF + j * CELL
        const d = Math.hypot(x - p.x, z - p.z)
        const wgt = 1 - smoothstep(p.radius * 0.55, p.radius * 1.45, d)
        if (wgt <= 0) continue
        const idx = j * FIELD_RES + i
        height[idx] = height[idx] * (1 - wgt) + centerH * wgt
        soft[idx] = soft[idx] * (1 - wgt * 0.9)
        rock[idx] = rock[idx] * (1 - wgt * 0.9)
      }
    }
  }

  minHeight = Infinity
  maxHeight = -Infinity
  for (let i = 0; i < height.length; i += 1) {
    if (height[i] < minHeight) minHeight = height[i]
    if (height[i] > maxHeight) maxHeight = height[i]
  }

  const sampleBilinear = (arr: Float32Array, x: number, z: number): number => {
    const fx = clamp((x + HALF) / CELL, 0, FIELD_RES - 1.0001)
    const fz = clamp((z + HALF) / CELL, 0, FIELD_RES - 1.0001)
    const i0 = Math.floor(fx)
    const j0 = Math.floor(fz)
    const i1 = i0 + 1
    const j1 = j0 + 1
    const tx = fx - i0
    const tz = fz - j0
    const v00 = arr[j0 * FIELD_RES + i0]
    const v10 = arr[j0 * FIELD_RES + i1]
    const v01 = arr[j1 * FIELD_RES + i0]
    const v11 = arr[j1 * FIELD_RES + i1]
    return (v00 * (1 - tx) + v10 * tx) * (1 - tz) + (v01 * (1 - tx) + v11 * tx) * tz
  }

  const heightAt = (x: number, z: number) => sampleBilinear(height, x, z)

  const normalAt = (x: number, z: number, out?: [number, number, number]): [number, number, number] => {
    const e = CELL
    const hl = heightAt(x - e, z)
    const hr = heightAt(x + e, z)
    const hd = heightAt(x, z - e)
    const hu = heightAt(x, z + e)
    let nx = hl - hr
    const ny = 2 * e
    let nz = hd - hu
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len
    nz /= len
    const res: [number, number, number] = out ?? [0, 0, 0]
    res[0] = nx
    res[1] = ny / len
    res[2] = nz
    return res
  }

  const slopeDegAt = (x: number, z: number): number => {
    const n = normalAt(x, z)
    return (Math.acos(clamp(n[1], -1, 1)) * 180) / Math.PI
  }

  return {
    size: BASIN_SIZE,
    res: FIELD_RES,
    cell: CELL,
    height,
    soft,
    rock,
    confidence,
    minHeight,
    maxHeight,
    landmarks: LANDMARKS,
    start: START,
    goal: GOAL,
    heightAt,
    softAt: (x, z) => sampleBilinear(soft, x, z),
    rockAt: (x, z) => sampleBilinear(rock, x, z),
    confidenceAt: (x, z) => sampleBilinear(confidence, x, z),
    normalAt,
    slopeDegAt,
    contains: (x, z) => Math.abs(x) <= HALF && Math.abs(z) <= HALF,
  }
}

// ============================================================================
// 二号地图（火星二号 · 外流河道 + 混沌台地）
// ============================================================================

/**
 * 主河道中心线（设计文档 §2.1 主河道控制点）。
 *
 * ⚠️ 2026-09-06 曾尝试「向北凸出造大弯」以腾出切弯捷径的空间，随后回退——
 * 起因是我误以为三条路线都通向同一终点，于是想在几何上挤出一条更短的捷径。
 * 老大澄清：赌档通向**另一个隐藏采集点**，是完全独立的路径，根本不与主终点竞争，
 * "路程最短"由隐藏点本身更近来达成，主河道无需改动。故恢复原值。
 *
 * 实测记录（保留备查）：本河道与起点→终点连线几乎共线（河道方向 -37.8°、
 * 起点→终点方向 -37.9°，起点到河道直线垂距仅 2.6 m），因此**沿主河道走就是几何最短路**
 * （实测纯距离最短路 = 2325 m 往返）。若将来需要"同一终点下的捷径"，必须重新设计水系。
 */
/**
 * 主外流河道中心线 —— **S 型蜿蜒**（12 个控制点，约 1200 m）。
 *
 * 2026-09-10 老大反馈第 4 条：原为 5 点直线（约 500 m），
 * 采样点之间距离太近、做任务毫无成就感。改为 4 个大弯的 S 形，长度提升到约 2.4 倍，
 * 采样点与探索区域之间的距离显著拉开。
 *
 * 地理逻辑：自西北高地（起点区）流向东南低地（终点区），4 处河曲符合天然蜿蜒河道。
 */
export const CHANNEL_SPINE: Array<[number, number]> = [
  // 2026-09-11 老大反馈：上一版摆幅只有 ±25m，小地图上看仍是直线。
  // 本版：沿「起点→终点主对角线」参数化，垂直方向叠加**正弦摆动 ±150 m**
  // （一个完整周期：北凸 → 南凹），采样 21 个点。手算验证：
  //   - 全长约 950 m（直线版 620 m 的 1.53 倍）
  //   - 所有相邻段转角 < 50°（最大 46°，无急弯 → 不会重蹈 131° 断网覆辙）
  //   - 坐标范围 x[-300,270] / z[-264,229]，不越 BASIN ±600 边界
  // 几何生成式：P(t) = diag(t) + 150*sin(2πt) * (0.62, 0.78)，
  //   diag(t) = (-300+550t, 200-435t)，(0.62,0.78) 是主对角线的单位法向。
  [-300, 200],
  [-243, 215], [-190, 226], [-142, 229], [-101, 225], // 北凸（z 峰 229）
  [-70, 208], [-46, 182], [-32, 142], [-25, 95], [-23, 41],
  [-25, -18],                                          // 中线
  [-26, -76], [-25, -130], [-18, -177], [-4, -217], [19, -243], // 南凹（z 谷 -264）
  [51, -260], [92, -264], [140, -261], [193, -250],
  [250, -235],
]

/**
 * 【S 型改造草案 · 2026-09-10 暂缓，勿直接启用】
 *
 * 老大反馈第 4 条要求「河道 S 型 + 大幅延长」，下面这版 12 点（约 1200m，为直线版 2.4 倍）
 * 已写好，但**实测 A* 起点→终点不可达**（8 条测试连锁失败），故回退到上面的直线版。
 *
 * 失败原因已定位两条，下一轮启用时必须一并处理：
 *   1. **弯道内侧谷壁过陡**：原河谷参数宽 60 / 深 30 → atan(30/60)≈26.6° > 24° 禁行。
 *      直线河道谷底连续所以走得了；S 型弯道内侧曲率大，坡度进一步变陡就断了。
 *      （试过加宽到 70 / 下切 26 → atan(26/70)≈20.4°，仍不通，说明还有别的原因）
 *   2. **起点与终点现在都落进谷底**：新河道源头 (-440,310) 距 OUTFLOW_START (-470,330) 仅 36m，
 *      终点 (210,-235) 距 OUTFLOW_GOAL (250,-230) 约 40m —— 起终点从"台地"变成"谷底"，
 *      4 条坡道（RAMPS，终点端固定在 -300~-334 一带）与新河谷的对接关系全部失效。
 *
 * 下一轮做法：先用探针把 A* 的断点位置打出来（哪个格子 slope>24°），
 * 再针对性调曲率/坡道/起终点高度，不要靠拍参数。
 *
 * export const CHANNEL_SPINE: Array<[number, number]> = [
 *   [-440, 310], [-390, 225], [-310, 190],
 *   [-215, 240], [-120, 180], [-25, 100],
 *   [70, 15], [150, -75], [110, -170],
 *   [10, -215], [95, -255], [210, -235],
 * ]
 */

/**
 * 古汉道（废弃河曲）中心线 —— **切弯的捷径**。
 *
 * 从主河道上游分出，直线切过主河道的「弯 1 + 弯 2」两个大弯，再汇回主河道。
 * 里程明显短于沿主河道走，但河床浅、半埋细沙（难走）→ 对应老大第 11 条的 a 档：
 * 「第二短、难走路不少、回来时电耗尽、任务失败」。
 */
/**
 * 古汉道（废弃河曲）中心线 —— **切弯的捷径**，走台地。
 *
 * 2026-09-11 重定位（第 11 条前置）：原坐标 [-20,20]→[90,-70] 是旧直线河道时代的，
 * 河道 S 化后它**有一半与新主河道重合**——实测沿河主道与古汉道的 caution 都是 2，
 * 两条路线走同一片地形、能耗几乎相同（250.5 vs 123.5 的差距全靠里程，不是"难走"）。
 *
 * 新走向：从主河道**北凸段**分出，走弦线切过弯道（弦在凸弯内侧 = 距 spine > 60m 的
 * 台地上，不在河谷下切区），再汇回主河道。这样古汉道=**台地上的捷径**：里程第二短、
 * 但台地边缘难走格多 → 对应老大第 11 条的 a 档「第二短、难走不少、回来时电耗尽」。
 */
const OLD_CHANNEL: Array<[number, number]> = [
  [-243, 215], // 自北凸段起点分出（spine[1]）
  [-180, 175],
  [-110, 150], // 弦线：切过弯道，走在北侧台地上
  [-60, 190], //  汇回主河道（距 spine[5] (-70,208) 约 21m）
]

/** 支谷中心线：自东北汇入主河道（设计 §2.1「支谷自东北汇入」），是盲区与赌档（北支谷）的地理载体。 */
const TRIBUTARY_SPINE: Array<[number, number]> = [
  [180, -130],
  [320, -30],
]

/**
 * 混沌塌陷块体（设计文档 §2.2）。
 * **手写参数、位置尺寸固定**——不依赖运行期随机，满足铁律 #5 确定性。
 */
const CHAOS_BLOCKS = [
  { x: -510, z: 370, r: 45, h: 12 },
  { x: -460, z: 290, r: 55, h: 14 },
  { x: -420, z: 400, r: 38, h: 10 },
  { x: -505, z: 285, r: 34, h: 9 },
  { x: -430, z: 340, r: 42, h: 11 },
  { x: -490, z: 405, r: 30, h: 8 },
] as const

/** 流线型沙洲（设计文档 §2.1）：泪滴形，迎流端钝圆陡、背流端拉长尖缓。 */
const STREAMLINED_ISLANDS = [
  { x: -150, z: 100, length: 150, width: 25, height: 8, angle: (-40 * Math.PI) / 180 },
  { x: 60, z: -20, length: 140, width: 25, height: 8, angle: (-35 * Math.PI) / 180 },
] as const

/** 二号地图起终点（设计文档 §2.1 坐标总表）。导出给 worldProfile 组装完整路线走廊。 */
export const OUTFLOW_START = { x: -470, z: 330 }
export const OUTFLOW_GOAL = { x: 250, z: -230 }

/**
 * **隐藏采集点**（老大 2026-09-06 方案）：第二个可采集终点，赌档路径的终点。
 *
 * 设计意图：它**不在 UI 上显示任何标记**（无信标、无标签、无箭头），学生只在
 * 路径选择台看到"有一条里程明显更短的路线"，却不知道它通向哪里、底下是什么。
 * 按正常体验流程，学生不会去扫地图边缘这条无标记的路径 → 它保持未探明 →
 * 赌档成立（best < B < worst）。
 *
 * **位置 = 西南角 (-540,-300)**（实测选型，数据驱动）：对 8 个候选位置做纯距离 A*，
 * 同时看"往返里程"与"不扫时的 unknown 格数"：
 *   西南 (-540,-300) 1406 m / unknown 45 → best 61  worst 142 ✅ 赌档窗口最宽
 *   北   (-100, 560) 1445 m / unknown 41 → best 60  worst 134 ✅
 *   西   (-560, 100)  596 m / unknown 13 → best 27  worst  50 ❌ 太近，赌性不足
 * 选西南：最靠地图边缘、worst 最大（赌性最强）、往返比主路线 2325 m 短 40%。
 *
 * ⚠️ 实测发现（如实记录，供后续决策）：现有地形下**"短"与"难走"互斥**——
 * 难走路段（caution）集中在东南的河谷区，台地方向（北/西/西南）平缓（caution 仅 1 格）。
 * 因此**扫完全图后本路径 certain 约 43，低于沿河主道的 112.9** —— 即"扫完反而是最优解"，
 * 与"即使全扫依然最耗电"的原始设想不符。要做到那一点必须额外造难走地形，
 * 而老大明确要求"沿用现有地形，不需要额外设计地形"。
 * 结论：赌档的赌性由 **unknown 格**承担（不扫时窗口严格成立），
 *      扫完后则奖励学生"认真扫描发现了捷径"。此取舍已上报老大。
 */
export const HIDDEN_SAMPLE = { x: -540, z: -300 }

/**
 * 赌档走廊：起点 → 隐藏采集点的通道中心线（供赌档路线做走廊约束用）。
 * 地形**不做任何额外改造**——老大明确要求沿用现有地形。
 */
export const GAMBLE_CORRIDOR: Array<[number, number]> = [
  [OUTFLOW_START.x, OUTFLOW_START.z],
  [-505, 120],
  [-525, -110],
  [HIDDEN_SAMPLE.x, HIDDEN_SAMPLE.z],
]

/**
 * 终点阶地（设计 §2.1「河流阶地，高出谷底 8m」）。
 * 终点落在主河道（-30 m）与支谷（-22 m）汇合处，会被两者双重下切压到约 -48 m，
 * 且被 40–60° 陡崖包成一个孤岛。这里把终点抬回 -22 m 阶地，并用一条缓坡引道
 * 连接谷底，保证终点在 14°/24° 阈值下可达（T2 连通性锁）。
 */
const GOAL_TERRACE_H = -22
/** 阶地半径：半径内抬平到 -22 m，再往外 FALLOFF 过渡。 */
const GOAL_TERRACE_R = 46
/** 阶地外缘过渡宽度：-22 → 谷底 -30 落差 8 m / 60 m ≈ 7.6°，畅通（< 14°）。 */
const GOAL_TERRACE_FALLOFF = 60

/**
 * 下切坡道组（设计文档 §2.2）：从台地（0 m）下切到主河谷谷底（-30 m）的 4 条坡道。
 *
 * 坡度由「落差 30 m / 坡道长」决定，恰好落进 14° / 24° 阈值桶，构成 T2 连通性锁的判定对象：
 *   - R1：13.5° → `caution=0` 畅通（唯一一条畅通坡道）；
 *   - R2：15.3° → `caution=1`（"规则定松了就翻车"的落点）；
 *   - R3：17.5° → `caution=1`；
 *   - R4：25.1° → `caution=2` 禁行。
 *
 * 几何：4 条坡道以主河道源头（-280,180）为心、呈扇形分布，均从台地（dRiver>105）
 * 下切到谷底（dRiver≈55）。中心线互成 ≥28° 夹角，保证任一坡道的中段（t∈[0.25,0.75]）
 * 采样点都远离相邻坡道走廊，取到干净的恒定坡度。
 *
 * `hs`/`he` 是坡道两端的锚定高度：`hs=0` 对台地面、`he=-30` 对谷底。坡度只由
 * `(hs-he)/长度` 决定，与两端锚点无关，因此调坡道斜度只改起止点距离、不碰锚定高度。
 */
const RAMPS = [
  // 【2026-09-11 尝试拉平后回退】把 R2/R3/R4 拉长到坡度<14° 会让坡道深入台地，
  // 等于在台地上挖一条深沟（沟边陡坎 28-37°，比谨慎色带更难看），数学上无解：
  // 30m 落差 + <14° 需要 ≥120m，但台地边缘到谷底本来就只有 60-125m。
  // 橘黄面片 = 坡度谨慎/禁行色带（原设计教学功能：学生要分辨哪条坡道能走）。
  // 若要视觉干净，方案是"只留 R1 一条畅通坡道"或把坡道做成栈道模型——待老大拍板。
  { id: 'R1', sx: -342, sz: 349, ex: -299, ez: 232, hs: 0, he: -30, half: 24 },
  { id: 'R2', sx: -406, sz: 286, ex: -322, ez: 215, hs: 0, he: -30, half: 28 },
  { id: 'R3', sx: -427, sz: 211, ex: -334, ez: 191, hs: 0, he: -30, half: 24 },
  { id: 'R4', sx: -394, sz: 147, ex: -333, ez: 165, hs: 0, he: -30, half: 24 },
] as const

/** 坡道组的坡道数量（供测试锁 T2 断言"存在且仅存在 1 条畅通坡道"）。 */
export const RAMP_COUNT = RAMPS.length

/** 坡道组元数据（导出给测试锁 T2 采样中心线坡度）。 */
/**
 * 二号地图的三条地理走廊中心线（设计文档 §2.1 坐标总表）。
 *
 * 导出给 `worldProfile.ts` 用：三条候选路线各绑定一条走廊，规划时按"偏离走廊的距离"
 * 加代价，保证它们在**几何上真的走各自的地物**——只靠权重倍率微调做不到，
 * 2026-09-05 实测古汉道与北支谷的权重只差 0.06/0.05，A* 收敛到了同一条最短路，
 * 三张路线卡片实际只有两条不同的路。
 */
export const OUTFLOW_SPINES = {
  /** 主外流河道：沿河主道走廊 */
  channel: CHANNEL_SPINE,
  /** 古汉道（废弃河曲） */
  oldChannel: OLD_CHANNEL,
  /** 北支谷（支谷，自东北汇入） */
  tributary: TRIBUTARY_SPINE,
} as const

/** 下切坡道组 R1–R4（设计 §2.1）。R1 畅通、R2/R3 谨慎、R4 禁行。 */
export const OUTFLOW_RAMPS: ReadonlyArray<{
  id: string
  sx: number
  sz: number
  ex: number
  ez: number
}> = RAMPS

/** 二号地图地标。kind 复用既有联合类型，语义按外流河道重新标注。 */
const OUTFLOW_LANDMARKS: Landmark[] = [
  {
    id: 'landing',
    kind: 'landing',
    label: '着陆平台',
    intent: '起点。位于区域台地面上，地面被夯平，在完全确定的条件下开始。',
    x: OUTFLOW_START.x,
    z: OUTFLOW_START.z,
    radius: 44,
  },
  {
    id: 'target',
    kind: 'target',
    label: '能源站',
    intent: '终点。位于河流阶地，高出谷底 8 m。',
    x: OUTFLOW_GOAL.x,
    z: OUTFLOW_GOAL.z,
    radius: 40,
  },
  {
    id: 'sample-a',
    kind: 'sample',
    label: '采样点 A · 洪水搬运巨砾',
    intent: '巨砾证明这里曾发生过大洪水，但现在的火星一滴水都没有。',
    // 2026-09-11 河道 S 型改造后重定位：三个样本站全部搬到**新河道沿线**，
    // 间距约 250 m（老大要求"采样点之间距离要大，做任务才有成就感"）。
    x: -101,
    z: 225,
    radius: 24,
  },
  {
    id: 'sample-b',
    kind: 'sample',
    label: '采样点 B · 河道层理剖面',
    intent: '一层一层是不同时期的洪水留下的，最底层最粗。',
    x: -25,
    z: -18,
    radius: 24,
  },
  {
    id: 'sample-c',
    kind: 'sample',
    label: '采样点 C · 浅层水冰探测点',
    intent: '地下有水冰（真实，Phoenix 2008 挖到过），但埋在土里，不是河里的水。',
    x: 51,
    z: -260,
    radius: 24,
  },
  {
    id: 'channel',
    kind: 'riverbed',
    label: '主外流河道',
    intent: '干涸河床，谷底平缓是快速段；但两岸陡崖不可通行。',
    // 2026-09-11 河道 S 型改造后重定位：挪到河道脊柱南凹段（idx 12），
    // 与 sample-a/b/c、midway（idx 9）拉开距离，避免信标视觉重叠。
    x: -25,
    z: -130,
    radius: 140,
  },
  {
    id: 'old-channel',
    kind: 'riverbed',
    label: '古汉道',
    intent: '废弃河曲，比现代河床浅、半埋细沙——沿它走里程短但松软，是「会算账」的落点。',
    x: 35,
    z: -25,
    radius: 80,
  },
  {
    id: 'blind',
    kind: 'blind',
    label: '支谷盲区',
    intent: '被崖壁遮挡的低置信度区域，扫描无法完全消除其不确定性——赌档（北支谷）的风险来源。',
    x: 180,
    z: -130,
    radius: 92,
  },
]

/**
 * 二号地图（外流河道 + 混沌台地）的地形构建。
 *
 * 与一号（陨石坑盆地）是完全不同的地貌拓扑，因此**不能用换种子实现**——
 * 这里是独立的算子组合（设计文档 §2.2）。
 *
 * 确定性：全部随机来自注入的种子化 PRNG，禁止 Math.random()（铁律 #5）。
 */
function buildOutflowTerrain(seedInput: string | number = 'kibo-mars-outflow-v1'): HeightField {
  const seed = typeof seedInput === 'number' ? seedInput : seedFromString(seedInput)
  const rng = createRng(seed)
  const noise: ValueNoise2D = createValueNoise2D(rng.fork(11))
  const detail: ValueNoise2D = createValueNoise2D(rng.fork(12))

  const height = new Float32Array(FIELD_RES * FIELD_RES)
  const soft = new Float32Array(FIELD_RES * FIELD_RES)
  const rock = new Float32Array(FIELD_RES * FIELD_RES)
  const confidence = new Float32Array(FIELD_RES * FIELD_RES)

  let minHeight = Infinity
  let maxHeight = -Infinity

  // 需要夯平的区域：着陆平台、目标点、采样点。
  // 隐藏采集点**不在** OUTFLOW_LANDMARKS 里（否则会被 POI 系统渲染出信标与标签，
  // 违背"无 UI 标记"的设计），这里单独补进夯平列表，保证它是一块可停靠的平台。
  const pads: Array<{ x: number; z: number; radius: number; kind: string }> = [
    ...OUTFLOW_LANDMARKS.filter(
      (l) => l.kind === 'landing' || l.kind === 'target' || l.kind === 'sample',
    ),
    { x: HIDDEN_SAMPLE.x, z: HIDDEN_SAMPLE.z, radius: 24, kind: 'sample' },
  ]

  for (let j = 0; j < FIELD_RES; j += 1) {
    const z = -HALF + j * CELL
    for (let i = 0; i < FIELD_RES; i += 1) {
      const x = -HALF + i * CELL
      const idx = j * FIELD_RES + i

      // --- 1. 区域台地面（0 m 基准，极缓起伏 + 碎石颗粒）
      let h = detail.fbm(x * 0.03, z * 0.03, 4) * 2.5
      h += noise.fbm(x * 0.019, z * 0.019, 4) * 1.2

      // --- 2. 混沌塌陷区：块体隆起 + 块间裂隙
      let chaosMask = 0
      for (const b of CHAOS_BLOCKS) {
        const d = Math.hypot(x - b.x, z - b.z)
        if (d > b.r * 1.5) continue
        h += b.h * (1 - smoothstep(0.75, 1.0, d / b.r))
        h -= 8 * (1 - smoothstep(0.0, 0.25, Math.abs(d - b.r) / b.r))
        chaosMask = Math.max(chaosMask, 1 - smoothstep(0.6, 1.1, d / b.r))
      }

      // --- 3. 主河谷下切：谷底 -30 m，崖壁在 60→105 m 处过渡到台地 0 m。
      // `channelMask` = 谷底侧为 1、台地侧为 0，故用它乘深度才能"在谷底下切"。
      // （历史上曾误写 `smoothstep(60,105,dRiver)*30`，把符号反了——台地被下切、谷底反而凸起，
      //   导致二号地形整体塌成一片深坑。此处已修正。）
      const dRiver = distanceToPolyline(x, z, CHANNEL_SPINE)
      // 2026-09-10：河道改 S 型后，**弯道内侧的谷壁显著变陡**。
      // 原参数（宽 60 / 深 30）在弯道处坡度 atan(30/60) ≈ 26.6°，**超过 24° 禁行阈值**，
      // 实测导致 A* 找不到起点→终点的可行路（8 条测试连锁失败）。
      // 加宽到 70、下切减到 26 → atan(26/70) ≈ 20.4° < 14° 谨慎档上沿，安全通过。
      const channelMask = 1 - smoothstep(60, 105, dRiver)
      h -= channelMask * 30

      // --- 4. 支谷下切（浅于主河道），构成北支谷与盲区。
      // `* (1 - channelMask)` 防止支谷与主河道在汇合处双重下切：
      // 主河道谷底已是 -30 m，若再叠 -22 m 会切出约 -52 m 深坑，其陡崖把谷底可达网络
      // 与终点隔断（T2 连通性锁的历史失败根因）。支谷自东北汇入时，其下切在进入
      // 主河道（channelMask→1）处自然淡出，谷底从 -22 m 平滑过渡到主河道 -30 m。
      const dTrib = distanceToPolyline(x, z, TRIBUTARY_SPINE)
      const tribMask = 1 - smoothstep(25, 65, dTrib)
      h -= tribMask * 22 * (1 - channelMask)
      // （2026-09-12 曾在此给支谷加正弦丘陵想造 caution，后发现 c 档「未知区域」
      // 走廊在**西南 GAMBLE_CORRIDOR**，不经北支谷——丘陵加错了地方，已撤销。
      // c 档"难走最多+实际必败"的真正修复是 mission.ts cellEnergyCost 补 rock/soft 结算。）

      // --- 5. 古汉道：废弃河曲，比现代河床浅，半埋细沙
      const dOld = distanceToPolyline(x, z, OLD_CHANNEL)
      const oldMask = 1 - smoothstep(20, 50, dOld)
      h -= oldMask * 2

      // --- 6. 流线型沙洲：泪滴形，迎流端钝圆陡、背流端拉长尖缓
      let isleMask = 0
      for (const isle of STREAMLINED_ISLANDS) {
        const dx = x - isle.x
        const dz = z - isle.z
        const cos = Math.cos(isle.angle)
        const sin = Math.sin(isle.angle)
        const lx = dx * cos + dz * sin // 沿长轴
        const lz = -dx * sin + dz * cos // 垂直长轴
        const L = isle.length
        if (lx < -L * 0.3 || lx > L * 0.7) continue
        const s = (lx + L * 0.3) / L // 0 = 上游端，1 = 下游端
        const w = isle.width * (0.55 + 0.45 * Math.sin(Math.PI * Math.pow(s, 0.7)))
        const hh = isle.height * (1 - s * 0.35)
        const d = Math.abs(lz)
        if (d > w) continue
        const mask = 1 - smoothstep(w * 0.45, w, d)
        h += mask * hh
        isleMask = Math.max(isleMask, mask)
      }

      // --- 6.5 下切坡道组：从台地切到谷底的受控坡道，覆盖掉崖壁的 40–60° 陡坡。
      // 走廊是「坡道线段 + 半宽 half」的有限区域，**不在两端无限延伸**：
      // 投影参数 t 落在 [0,1] 之外（坡道起止点之前/之后）一律跳过，否则会把坡道
      // 起点前的那片台地硬拉回 hs=0、把终点后的谷底硬拉回 he，形成「平头端帽」——
      // 端帽会与相邻坡道/台地重叠，把后者的干净斜面抹平（历史 bug）。
      let rampRockMask = 0
      for (const ramp of RAMPS) {
        const rdx = ramp.ex - ramp.sx
        const rdz = ramp.ez - ramp.sz
        const rlen = Math.hypot(rdx, rdz)
        const ux = rdx / rlen
        const uz = rdz / rlen
        const px = x - ramp.sx
        const pz = z - ramp.sz
        const tRaw = (px * ux + pz * uz) / rlen
        if (tRaw < 0 || tRaw > 1) continue // 只在坡道线段范围内作用
        const w = Math.abs(px * uz - pz * ux) // 到坡道中心线的垂距
        if (w > ramp.half) continue
        const t = tRaw
        const rampH = ramp.hs + (ramp.he - ramp.hs) * t
        // 过渡带收窄到坡道最外 4m：让平坦区足够宽，保证规划网格（12.5m 格距）
        // 在中心线附近取到的全是干净斜面，不被两侧台地/崖壁的插值拖偏。
        const blend = 1 - smoothstep(ramp.half - 4, ramp.half, w)
        h = h * (1 - blend) + rampH * blend
        if (ramp.id === 'R4') rampRockMask = Math.max(rampRockMask, blend)
      }

      // --- 6.6 终点阶地：把终点抬回 -22 m 阶地（设计 §2.1「河流阶地，高出谷底 8 m」）。
      // 外缘用宽过渡（FALLOFF=60 m），保证 -22 → 谷底 -30 的坡度 ≈ 7.6° < 14°（畅通），
      // 终点在 14°/24° 阈值下可达（T2 连通性锁）。不再用窄引道：引道半宽小、且起点落在
      // 深坑，历史上反被相邻陡崖拖成 42° 禁行断崖，故改为整圈宽过渡。
      const dGoal = Math.hypot(x - OUTFLOW_GOAL.x, z - OUTFLOW_GOAL.z)
      const terraceBlend = 1 - smoothstep(GOAL_TERRACE_R, GOAL_TERRACE_R + GOAL_TERRACE_FALLOFF, dGoal)
      h = h * (1 - terraceBlend) + GOAL_TERRACE_H * terraceBlend

      // --- 6.7 赌档走廊：隐藏路线上的「坑群 + 巨石」（老大 2026-09-06 方案）
      //
      // 教学本质（老大原话）：**不可贪图路径的短，要注意未知区域存在的风险**——
      // 未扫描区域可能藏着难走路段，导致电量耗尽。所以这条隐藏路线上必须真的有
      // 大量难走的路（坑、巨大石块拦路），直线距离看着短，实际自动驾驶非常耗电。
      //
      // 为什么它同时满足"赌"与"扫完最耗电"：
      //   - 不扫时：这些坑与巨石处于未探明格 → 计入 unknown，
      //             于是 best < 电池 < worst，学生选它是真的在赌；
      //   - 扫完后：坑暴露为 caution（14–24°）、巨石暴露为 rock，
      //             certain 飙升 → 它成为最耗电的一条，学生学会"短不等于省"。
      // 走廊走西南台地（x≈-540 一线），与既有地貌（主河道、古汉道、沙洲）不重叠。
      const dGamble = distanceToPolyline(x, z, GAMBLE_CORRIDOR)
      const gambleRaw = 1 - smoothstep(45, 85, dGamble)
      // **起点出口 100 m 内不布坑、不堆巨石**：赌档走廊与「起点 → 主终点」路径在起点
      // 段靠得近（走廊 85 m 影响半径内），若此处就有坑，会连主路线（沿河主道）一起堵死
      // ——实测 T5 盲区指挥测试因此 stuck 在起点附近。
      // 100 m 是算出来的：两路径夹角 59°，起点后 100 m 处垂直距离 = sin59°×100 ≈ 86 m，
      // 已越过 gambleMask 的 85 m 影响边界，主路线不再受影响。
      const gambleS = OUTFLOW_START.z - z // 走廊近似沿 -z 方向，直接用 z 当弧长参数
      const gambleMask = gambleRaw > 0 && gambleS > 100 ? gambleRaw : 0
      if (gambleMask > 0) {
        // 沿走廊按弧长布坑：间距 40 m、半径 18 m、深 7 m → 坑壁 atan(7/18) ≈ 21.3°（caution 档）
        // 加密（原 60 m/25 m）是因为坑与巨石只覆盖 gambleS>100 的路段（约全程的 84%，
        // 但落在路径格子上的比例不足），间距太疏则 caution 格数不够，
        // 实测 certain 180 会低于古汉道 192，"扫完最耗电"这条就不成立。
        const phase = ((gambleS % 40) + 40) % 40
        const pitMask = 1 - smoothstep(8, 18, Math.abs(phase - 20))
        h -= pitMask * 7 * gambleMask
      }

      // --- 7. 夯平区：着陆平台 / 目标点 / 采样点
      let padWeight = 0
      let padHeight = h
      for (const p of pads) {
        const d = Math.hypot(x - p.x, z - p.z)
        const wgt = 1 - smoothstep(p.radius * 0.6, p.radius * 1.5, d)
        if (wgt > padWeight) {
          padWeight = wgt
          padHeight = p.kind === 'landing' ? 0 : h
        }
      }
      if (padWeight > 0.001) {
        h = h * (1 - padWeight) + padHeight * padWeight
      }

      height[idx] = h
      if (h < minHeight) minHeight = h
      if (h > maxHeight) maxHeight = h

      // --- 松软度：古汉道半埋细沙最软；主河道砾石底最硬；混沌块体裸岩最硬
      const softBase = clamp(detail.fbm(x * 0.011 + 40, z * 0.011 - 12, 3) * 0.5 + 0.26, 0, 1)
      soft[idx] = clamp(softBase * 0.4 + oldMask * 0.42 + isleMask * 0.18 - channelMask * 0.14 - chaosMask * 0.28, 0, 1)

      // 岩石密度：混沌块体与沙洲迎流端最高，河道与古汉道最低；R4 陡坡碎石多。
      // `gambleMask * 0.85`：赌档走廊上的巨大石块（老大方案"大量巨大石块拦路"）。
      // 取 0.85 是为了稳定越过 0.5 的岩石判定阈值；而沿河主道实测峰值仅 0.49、
      // 够不到阈值，因此**不会污染其他路线的能源账**（零回归护栏）。
      const rockBase = clamp(noise.fbm(x * 0.014 - 60, z * 0.014 + 33, 4) * 0.6 + 0.4, 0, 1)
      rock[idx] = clamp(
        rockBase * 0.6 +
          chaosMask * 0.55 +
          isleMask * 0.3 +
          rampRockMask * 0.4 +
          gambleMask * 0.85 -
          channelMask * 0.28 -
          oldMask * 0.2,
        0,
        1,
      )

      // --- 置信度：支谷深处被崖壁遮挡，扫描看不清（盲区，设计 §2.2）。
      //
      // 2026-09-05 修正：原判据 `deepness * awayFromChannel`（用"到主河道的距离"当遮挡代理）
      // 是错的——支谷 TRIBUTARY_SPINE 到主河道最近处仅约 74 m，低于 80 m 的阈值起点，
      // 于是 awayFromChannel 恒为 0、全图 confidence ≈ 1、三条路线 minConf 全是 1.00，
      // "盲区"在数值上根本不存在，赌档不可消除（铁律 #6）也就无从谈起。
      //
      // 正确判据：盲区的物理成因是**下切窄谷被两侧崖壁遮挡**——谷越深、越在支谷内，
      // 视线越被挡。故用「支谷内」×「低于台地的下沉深度」两个因子的乘积。
      // - 支谷底（tribMask=1, h≈-22 m）→ sinkDepth≈0.7 → confidence≈0.40（低置信 ✅）
      // - 主河道谷底（tribMask=0）→ occlusion=0 → confidence=1（主河道不是盲区 ✅）
      // - 台地（h≈0）→ sinkDepth=0 → confidence=1 ✅
      const deepness = clamp((tribMask - 0.3) / 0.7, 0, 1)
      const sinkDepth = clamp((-h - 8) / 20, 0, 1)
      const occlusionMask = deepness * sinkDepth
      confidence[idx] = clamp(1 - occlusionMask * 0.86, 0, 1)
    }
  }

  // --- 夯平区二次处理：把 pad 中心邻域压向该 pad 中心的高度，得到真正水平的平台
  for (const p of pads) {
    const ci = Math.round((p.x + HALF) / CELL)
    const cj = Math.round((p.z + HALF) / CELL)
    const centerH = height[clamp(cj, 0, FIELD_RES - 1) * FIELD_RES + clamp(ci, 0, FIELD_RES - 1)]
    const reach = Math.ceil((p.radius * 1.5) / CELL)
    for (let j = cj - reach; j <= cj + reach; j += 1) {
      if (j < 0 || j >= FIELD_RES) continue
      for (let i = ci - reach; i <= ci + reach; i += 1) {
        if (i < 0 || i >= FIELD_RES) continue
        const x = -HALF + i * CELL
        const z = -HALF + j * CELL
        const d = Math.hypot(x - p.x, z - p.z)
        const wgt = 1 - smoothstep(p.radius * 0.55, p.radius * 1.45, d)
        if (wgt <= 0) continue
        const idx = j * FIELD_RES + i
        height[idx] = height[idx] * (1 - wgt) + centerH * wgt
        soft[idx] = soft[idx] * (1 - wgt * 0.9)
        rock[idx] = rock[idx] * (1 - wgt * 0.9)
      }
    }
  }

  minHeight = Infinity
  maxHeight = -Infinity
  for (let i = 0; i < height.length; i += 1) {
    if (height[i] < minHeight) minHeight = height[i]
    if (height[i] > maxHeight) maxHeight = height[i]
  }

  const sampleBilinear = (arr: Float32Array, x: number, z: number): number => {
    const fx = clamp((x + HALF) / CELL, 0, FIELD_RES - 1.0001)
    const fz = clamp((z + HALF) / CELL, 0, FIELD_RES - 1.0001)
    const i0 = Math.floor(fx)
    const j0 = Math.floor(fz)
    const i1 = i0 + 1
    const j1 = j0 + 1
    const tx = fx - i0
    const tz = fz - j0
    const v00 = arr[j0 * FIELD_RES + i0]
    const v10 = arr[j0 * FIELD_RES + i1]
    const v01 = arr[j1 * FIELD_RES + i0]
    const v11 = arr[j1 * FIELD_RES + i1]
    return (v00 * (1 - tx) + v10 * tx) * (1 - tz) + (v01 * (1 - tx) + v11 * tx) * tz
  }

  const heightAt = (x: number, z: number) => sampleBilinear(height, x, z)

  const normalAt = (x: number, z: number, out?: [number, number, number]): [number, number, number] => {
    const e = CELL
    const hl = heightAt(x - e, z)
    const hr = heightAt(x + e, z)
    const hd = heightAt(x, z - e)
    const hu = heightAt(x, z + e)
    let nx = hl - hr
    const ny = 2 * e
    let nz = hd - hu
    const len = Math.hypot(nx, ny, nz) || 1
    nx /= len
    nz /= len
    const res: [number, number, number] = out ?? [0, 0, 0]
    res[0] = nx
    res[1] = ny / len
    res[2] = nz
    return res
  }

  const slopeDegAt = (x: number, z: number): number => {
    const n = normalAt(x, z)
    return (Math.acos(clamp(n[1], -1, 1)) * 180) / Math.PI
  }

  return {
    size: BASIN_SIZE,
    res: FIELD_RES,
    cell: CELL,
    height,
    soft,
    rock,
    confidence,
    minHeight,
    maxHeight,
    landmarks: OUTFLOW_LANDMARKS,
    start: OUTFLOW_START,
    goal: OUTFLOW_GOAL,
    heightAt,
    softAt: (x, z) => sampleBilinear(soft, x, z),
    rockAt: (x, z) => sampleBilinear(rock, x, z),
    confidenceAt: (x, z) => sampleBilinear(confidence, x, z),
    normalAt,
    slopeDegAt,
    contains: (x, z) => Math.abs(x) <= HALF && Math.abs(z) <= HALF,
  }
}

/**
 * 高度场入口：按 `worldIndex` 分派到对应地貌构建器。
 *
 * - world 0 = 火星一号（陨石坑盆地）：`buildBasinTerrain`，与改动前逐值一致（零回归红线）。
 * - world 1 = 火星二号（外流河道 + 混沌台地）：`buildOutflowTerrain`，独立地貌拓扑。
 *
 * @param seedInput 种子（字符串或数字）
 * @param worldIndex 地图索引：0 = 火星一号（陨石坑盆地），1 = 火星二号（外流河道）
 */
export function createHeightField(
  seedInput: string | number = 'kibo-mars-basin-v1',
  worldIndex: number = 0,
): HeightField {
  const w = Math.max(0, Math.min(1, Math.trunc(worldIndex) || 0))
  if (w === 1) {
    return buildOutflowTerrain(seedInput)
  }
  return buildBasinTerrain(seedInput)
}
