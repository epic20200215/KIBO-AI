/**
 * 火星扬尘系统（M6）。
 *
 * 设计约束：
 * - 风格化硬边尘团，不是写实烟雾；粒子内部纯色 + 一圈墨色描边，与全场 cel-shading 一致。
 * - 只在漫游车移动且接地时从六轮后方发射；翻车时改为缓慢落尘。
 * - 粒子生命周期：出生小 → 快速膨胀 → 收缩淡出，三段都用量化档位而非线性渐变。
 * - **确定性**：纲领准入条件第 3 条要求同种子同输入必得同结果，
 *   因此本文件禁止 `Math.random()`，全部随机走 `core/rng` 的 mulberry32。
 * - reduced-motion：降低发射率、重力与初速，保留静态尘迹。
 */
import {
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  NormalBlending,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three'
import { createRng, seedFromString, type Rng } from '../core/rng'
import { hexToLinearRgb, PALETTE } from './palette'

export type DustSystem = {
  group: Group
  setTime: (t: number) => void
  /** 在世界坐标处喷一簇尘。intensity 0..1，通常取归一化车速。 */
  emit: (worldPos: { x: number; y: number; z: number }, intensity: number) => void
  /** 在世界坐标数组处同时喷尘，共用同一次冷却。用于漫游车双后轮对称拖尾冒烟。 */
  emitBatch: (worldPositions: { x: number; y: number; z: number }[], intensity: number) => void
  setReducedMotion: (on: boolean) => void
  /** 同步渲染器像素比，保证不同 DPR 下尘团的**物理**大小一致。 */
  setPixelRatio: (r: number) => void
  /** 按画质限制有效粒子数，低端机减少开销。 */
  setParticleCap: (cap: number) => void
  /** 当前存活粒子数，供测试与性能面板读取。 */
  activeCount: () => number
  dispose: () => void
}

/** 粒子池上限。600 个 Points 在集成显卡上仍是一次 draw call，代价可忽略。 */
const MAX_PARTICLES = 600
/** 两次发射之间的最短间隔（秒），防止高帧率下瞬间打空粒子池。 */
const EMISSION_COOLDOWN = 0.035

export function createDustSystem(): DustSystem {
  const geometry = new BufferGeometry()
  const positions = new Float32Array(MAX_PARTICLES * 3)
  // aAttr = (size, age, lifetime, seed)
  const attrs = new Float32Array(MAX_PARTICLES * 4)

  for (let i = 0; i < MAX_PARTICLES; i += 1) {
    positions[i * 3 + 1] = -9999
  }

  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('aAttr', new Float32BufferAttribute(attrs, 4))
  // 粒子始终在相机附近，逐帧算包围盒不划算，直接关剔除
  geometry.boundingSphere = null

  const material = new ShaderMaterial({
    uniforms: {
      uCore: { value: new Vector3(...hexToLinearRgb(PALETTE.cloudLight)) },
      uShade: { value: new Vector3(...hexToLinearRgb(PALETTE.rockOutcrop)) },
      uInk: { value: new Vector3(...hexToLinearRgb(PALETTE.ink)) },
      uPixelRatio: { value: 1 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aAttr;
      uniform float uPixelRatio;
      varying float vAlpha;
      varying float vAge;
      varying float vSeed;

      void main() {
        float size = aAttr.x;
        float age = aAttr.y;
        float life = max(aAttr.z, 1e-4);
        vSeed = aAttr.w;
        float p = clamp(age / life, 0.0, 1.0);
        vAge = p;

        // 出生 0.25 倍 → 0.2 处冲到 1.55 倍 → 0.55 处维持 → 末尾收到 0.85 倍
        float grow = p < 0.20
          ? mix(0.25, 1.55, p / 0.20)
          : (p < 0.55 ? mix(1.55, 1.15, (p - 0.20) / 0.35)
                      : mix(1.15, 0.85, (p - 0.55) / 0.45));

        // 透明度按三档量化，避免出现写实的连续羽化
        float a = 1.0 - p;
        vAlpha = a > 0.66 ? 1.0 : (a > 0.33 ? 0.72 : 0.38);

        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * grow * uPixelRatio * (300.0 / max(-mv.z, 0.001));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      uniform vec3 uCore;
      uniform vec3 uShade;
      uniform vec3 uInk;
      varying float vAlpha;
      varying float vAge;
      varying float vSeed;

      void main() {
        vec2 c = gl_PointCoord - 0.5;
        float r = length(c);
        if (r > 0.5) discard;

        // 不规则外形：用 seed 相位的三阶波扰动半径，避免一片完美圆点
        float ang = atan(c.y, c.x);
        float wob = 0.045 * sin(ang * 3.0 + vSeed * 6.2831)
                  + 0.030 * sin(ang * 5.0 - vSeed * 3.7);
        float edge = 0.44 + wob;
        if (r > edge) discard;

        // 硬边赛璐珞：内芯亮、上缘受光、下缘暗、最外圈一道墨线
        float lit = step(-0.02, -c.y + wob * 0.5);
        float shade = step(0.10, c.y - wob * 0.4);
        vec3 col = mix(uShade, uCore, lit);
        col = mix(col, uShade, shade * 0.45);
        float inkBand = step(edge - 0.060, r);
        col = mix(col, uInk, inkBand * 0.60);

        gl_FragColor = vec4(col, vAlpha * 0.92);
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
  })

  const points = new Points(geometry, material)
  points.frustumCulled = false
  points.renderOrder = 6

  const group = new Group()
  group.add(points)

  type Particle = {
    x: number; y: number; z: number
    vx: number; vy: number; vz: number
    age: number; life: number; size: number; seed: number
    active: boolean
  }

  const particles: Particle[] = []
  for (let i = 0; i < MAX_PARTICLES; i += 1) {
    particles.push({
      x: 0, y: -9999, z: 0,
      vx: 0, vy: 0, vz: 0,
      age: 0, life: 0, size: 0, seed: i / MAX_PARTICLES,
      active: false,
    })
  }

  // 确定性随机：固定种子，粒子的抖动序列在任何机器上都一致
  const rng: Rng = createRng(seedFromString('kibo-mars-dust-v1'))

  let reducedMotion = false
  let writeHead = 0
  let cooldown = 0
  let time = 0
  let alive = 0
  let particleCap = MAX_PARTICLES

  const spawnOne = (x: number, y: number, z: number, intensity: number) => {
    // 低画质下有效粒子池受限；超过上限时优先回收最老的粒子
    const cap = Math.min(MAX_PARTICLES, particleCap)
    if (alive >= cap) {
      let oldest = -1
      let oldestAge = -1
      for (let i = 0; i < cap; i += 1) {
        const pp = particles[i]
        if (pp.active && pp.age > oldestAge) {
          oldestAge = pp.age
          oldest = i
        }
      }
      if (oldest >= 0) {
        particles[oldest].active = false
        alive -= 1
      }
    }

    const p = particles[writeHead % cap]
    if (!p.active) alive += 1
    writeHead = (writeHead + 1) % cap

    p.active = true
    p.x = x + rng.range(-0.18, 0.18)
    p.y = y + rng.range(0.02, 0.12)
    p.z = z + rng.range(-0.18, 0.18)

    // 同一批次粒子共享一个"团簇 seed"，让相邻粒子明暗/大小相近，形成团块而不是匀点
    const cluster = rng.next()
    const isBig = cluster > 0.78
    const isSmall = cluster < 0.35

    const spread = reducedMotion ? 0.25 : 0.55
    const trailing = reducedMotion ? 0.03 : 0.08
    // 给粒子加一辆车的"运动方向"偏移，尘团 trailing behind
    p.vx = rng.range(-spread, spread) - trailing
    p.vy = rng.range(0.35, 1.1) * (reducedMotion ? 0.3 : 1)
    p.vz = rng.range(-spread, spread)

    p.age = 0
    p.life = rng.range(0.65, 1.35) * (reducedMotion ? 1.7 : 1)
    // 尺寸三档分布：小扬尘 / 主尘团 / 偶尔大团，制造体积感
    const baseSize = isBig ? 1.25 : (isSmall ? 0.45 : 0.85)
    p.size = rng.range(0.85, 1.25) * baseSize * (0.65 + intensity * 1.05)
    p.seed = cluster
  }

  const emitBatch = (worldPositions: { x: number; y: number; z: number }[], intensity: number) => {
    if (cooldown > 0 || intensity <= 0.02 || worldPositions.length === 0) return
    cooldown = reducedMotion ? EMISSION_COOLDOWN * 2.5 : EMISSION_COOLDOWN
    // stuck 状态：模拟车轮空转刨沙，短时高密度喷发
    const count = reducedMotion ? 1 : (intensity > 0.9 ? 5 : 2 + Math.round(intensity * 2))
    for (const worldPos of worldPositions) {
      for (let k = 0; k < count; k += 1) spawnOne(worldPos.x, worldPos.y, worldPos.z, intensity)
    }
  }

  const emit = (worldPos: { x: number; y: number; z: number }, intensity: number) => {
    emitBatch([worldPos], intensity)
  }

  const posArr = geometry.attributes.position.array as Float32Array
  const attrArr = geometry.attributes.aAttr.array as Float32Array

  const setTime = (t: number) => {
    const dt = Math.min(0.05, t - time)
    time = t
    if (dt <= 0) return

    cooldown = Math.max(0, cooldown - dt)
    // 火星重力 3.72 m/s²，但美术上取更慢的下落让尘"飘"起来
    const gravity = reducedMotion ? 0.35 : 1.35
    const drag = reducedMotion ? 0.955 : 0.915
    // 恒定西风，让所有尘团往同一侧漂，读起来像有大气
    const wind = reducedMotion ? 0.04 : 0.12

    for (let i = 0; i < MAX_PARTICLES; i += 1) {
      const p = particles[i]
      if (!p.active) {
        attrArr[i * 4 + 2] = 0
        continue
      }

      p.age += dt
      if (p.age >= p.life) {
        p.active = false
        alive -= 1
        p.y = -9999
        posArr[i * 3 + 1] = -9999
        attrArr[i * 4 + 2] = 0
        continue
      }

      p.vy -= gravity * dt
      p.vx = p.vx * drag + wind * dt
      p.vz *= drag
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt

      posArr[i * 3] = p.x
      posArr[i * 3 + 1] = p.y
      posArr[i * 3 + 2] = p.z
      attrArr[i * 4] = p.size
      attrArr[i * 4 + 1] = p.age
      attrArr[i * 4 + 2] = p.life
      attrArr[i * 4 + 3] = p.seed
    }

    geometry.attributes.position.needsUpdate = true
    geometry.attributes.aAttr.needsUpdate = true
  }

  return {
    group,
    setTime,
    emit,
    emitBatch,
    setReducedMotion: (on: boolean) => {
      reducedMotion = on
    },
    setPixelRatio: (r: number) => {
      material.uniforms.uPixelRatio.value = Math.max(0.5, r)
    },
    setParticleCap: (cap: number) => {
      particleCap = Math.max(50, Math.min(MAX_PARTICLES, cap))
    },
    activeCount: () => alive,
    dispose: () => {
      geometry.dispose()
      material.dispose()
    },
  }
}
