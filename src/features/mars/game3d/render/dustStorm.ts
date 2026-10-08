/**
 * 区域沙尘暴（用户反馈：火星地貌部分区域可出现巨型沙尘暴，且"太简陋"，需按参考图重做）。
 *
 * 二次重做（2026-08-07）：从"单张竖纹广告牌"升级为**多层体积感尘墙 + 碎屑粒子**：
 * - 尘墙本体：每个区域 3 张不同深度/尺度/速度的 billboard，各自用 **domain-warped fbm 湍流噪声**
 *   生成高大红褐色尘墙，内部可见**卷曲层理**；底部浓、顶部羽化、两端收口；红褐色两级~三级硬边量化（保留 cel 语言）。
 * - 碎屑粒子：`THREE.Points` 系统，数百个红褐色飞沙在墙体内湍流漂移 + 近地富集，强化"飞沙走石"体积感。
 * - 区域强度：保留 STORM_ZONES 逻辑（rover 进入升起、离开回落），强度同时驱动尘墙显隐/不透明度、
 *   粒子密度，以及 `sky.setStorm` 的天空泛黄压暗与太阳遮蔽（已由 stage 联动）。
 * - 确定性：种子化随机，无 Math.random；reduced-motion 下尘墙与粒子保持静态姿态。
 */
import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  Vector3,
} from 'three'
import { createRng, seedFromString, type Rng } from '../core/rng'
import { hexToLinearRgb, PALETTE } from './palette'

export type StormZone = { x: number; z: number; radius: number }

/**
 * 盆地内可触发巨型沙尘暴的区域（world 坐标，盆地半幅 ±600）。
 * 两个区域都落在任务主路线「沙丘带 → 坑缘/岩石迷阵」之间，玩家推进时可能撞上。
 */
export const STORM_ZONES: StormZone[] = [
  { x: -88, z: -116, radius: 192 },
  { x: 256, z: 48, radius: 164 },
]

const WALL_HEIGHT = 360
const WALL_WIDTH_FACTOR = 2.5
const LAYERS = 4
const PARTICLES_PER_ZONE = 3600
/** 强度平滑跟随系数（每帧），避免进出区域时突变。 */
const SMOOTH = 0.1

export type DustStorm = {
  group: Group
  /** 给定世界坐标处的风暴强度 0..1（取各区域最大值，已平滑）。 */
  intensityAt: (x: number, z: number) => number
  /** 当前平滑后的全局强度，供 stage 驱动天空与扬尘。 */
  currentIntensity: () => number
  setTime: (t: number) => void
  setReducedMotion: (on: boolean) => void
  /** 截图/预览用：锁定全局强度（null = 跟随 rover 位置动态计算）。 */
  setOverride: (v: number | null) => void
  dispose: () => void
}

type ZoneState = {
  zone: StormZone
  target: number
  cur: number
  wallMats: ShaderMaterial[]
  particleMat: ShaderMaterial
}

// 共享的湍流 fbm 着色器块（GLSL）
const TURB_GLSL = /* glsl */ `
  float hash21(vec2 p){
    p = fract(p * vec2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return fract(p.x * p.y);
  }
  float vnoise(vec2 p){
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
  float fbm(vec2 p){
    float v = 0.0;
    float amp = 0.5;
    for (int i = 0; i < 5; i++) {
      v += amp * vnoise(p);
      p *= 2.03;
      amp *= 0.5;
    }
    return v;
  }
`

export function createDustStorm(rng: Rng = createRng(seedFromString('kibo-dust-storm'))): DustStorm {
  const group = new Group()
  group.name = 'DustStorm'
  const zones: ZoneState[] = []

  for (const zone of STORM_ZONES) {
    const width = zone.radius * WALL_WIDTH_FACTOR
    const angle = Math.atan2(0 - zone.x, 0 - zone.z)
    const wallMats: ShaderMaterial[] = []

    // 3 张叠加尘墙层
    for (let li = 0; li < LAYERS; li++) {
      const scale = 1.0 + li * 0.12
      const depth = (li - 1) * 14 // 错开深度，制造体积感
      const material = new ShaderMaterial({
        uniforms: {
          uTime: { value: 0 },
          uIntensity: { value: 0 },
          uColorA: { value: new Vector3(...hexToLinearRgb(PALETTE.stormWallLight)) },
          uColorB: { value: new Vector3(...hexToLinearRgb(PALETTE.stormWallDark)) },
          uColorDust: { value: new Vector3(...hexToLinearRgb(PALETTE.stormWallMid)) },
          uInk: { value: new Vector3(...hexToLinearRgb('#2a0c08')) },
          uReduced: { value: 0 },
          uSeed: { value: rng.next() * 10 },
          uScale: { value: scale },
          uLayer: { value: li },
        },
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          precision highp float;
          ${TURB_GLSL}
          uniform float uTime;
          uniform float uIntensity;
          uniform vec3 uColorA;
          uniform vec3 uColorB;
          uniform vec3 uColorDust;
          uniform vec3 uInk;
          uniform float uReduced;
          uniform float uSeed;
          uniform float uScale;
          uniform float uLayer;
          varying vec2 vUv;

          void main() {
            float t = (uReduced > 0.5 ? 0.0 : uTime);
            vec2 uv = vUv;
            uv.x *= uScale;
            // 提速：尘墙整体滚动更快，制造"压过来的速度感"（反馈：太慢没压迫感）
            float scroll = t * (0.45 + uLayer * 0.12) + uSeed;

            // domain warp：先偏移再采样，制造翻卷的尘卷
            vec2 p = vec2(uv.x * 3.0 + scroll, uv.y * 2.2);
            float w1 = fbm(p * 0.7 + uSeed);
            float w2 = fbm(p * 1.4 - w1 * 2.8 + 5.0);
            float w3 = fbm(p * 2.6 + w2 * 1.5 - scroll * 0.5);
            float density = fbm(p + w2 * 2.0 + w3 * 0.8);

            // 卷曲层理：多层水平条带，带 domain-warp 扭曲，更像“移动尘墙”
            // 提速：层理横向滚动更快，尘墙翻卷更剧烈（反馈：太慢没压迫感）
            float band1 = 0.5 + 0.5 * sin((uv.y * 14.0) + w2 * 16.0 + scroll * 11.0);
            float band2 = 0.5 + 0.5 * sin((uv.y * 26.0) - w3 * 22.0 + scroll * 15.0);
            float bands = mix(band1, band2, 0.45);
            density = mix(density, density * 0.35 + bands * 0.85, 0.88);

            // 竖直包络：底浓顶淡 + 两端收口
            float vgrad = (1.0 - smoothstep(0.72, 1.0, uv.y)) * smoothstep(0.0, 0.10, uv.y);
            float edgeFade = smoothstep(0.0, 0.14, uv.x) * (1.0 - smoothstep(0.86, 1.0, uv.x));
            density *= vgrad * edgeFade;

            // 赛璐珞：四级硬边（暗底 / 红褐主体 / 亮面 / 墨线），阈值下调让墙更实更厚
            float b0 = step(0.06, density);
            float b1 = step(0.15, density);
            float b2 = step(0.28, density);
            vec3 col = mix(uColorB, uColorDust, b0);
            col = mix(col, uColorA, b1);
            col = mix(col, uColorA * 1.12, b2);
            // 最外缘一道墨线勾边（减弱，避免风沙出现卡通黑边）
            float ink = step(0.48, density);
            col = mix(col, uInk, ink * 0.22);

            // 二次强化：不透明度再上调（6.5→7.6），配合更深的红褐配色，
            // 让尘墙从"稀薄"彻底变成"压顶"，强化压迫感（反馈：太淡 / 没压迫感）。
            // 颜色仍由层理/域扭曲调制，不会变成死板实块。
            float alpha = density * uIntensity * 7.6;
            if (alpha < 0.01) discard;
            gl_FragColor = vec4(col, alpha);
            #include <colorspace_fragment>
          }
        `,
      })

      const geo = new PlaneGeometry(width * scale, WALL_HEIGHT, 1, 1)
      const mesh = new Mesh(geo, material)
      mesh.rotation.y = angle
      mesh.position.set(zone.x, WALL_HEIGHT * 0.5 - 14 + depth * 0.3, zone.z)
      mesh.position.x += Math.sin(angle) * depth
      mesh.position.z += Math.cos(angle) * depth
      mesh.frustumCulled = false
      mesh.renderOrder = 2 + li
      group.add(mesh)
      wallMats.push(material)
    }

    // 碎屑粒子系统
    const pCount = PARTICLES_PER_ZONE
    const positions = new Float32Array(pCount * 3)
    const rands = new Float32Array(pCount)
    for (let i = 0; i < pCount; i++) {
      positions[i * 3] = (rng.next() - 0.5) * width
      positions[i * 3 + 1] = rng.next() * WALL_HEIGHT
      positions[i * 3 + 2] = (rng.next() - 0.5) * 60
      rands[i] = rng.next()
    }
    const pGeo = new BufferGeometry()
    pGeo.setAttribute('position', new Float32BufferAttribute(positions, 3))
    pGeo.setAttribute('aRand', new Float32BufferAttribute(rands, 1))

    const particleMat = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uSize: { value: 260 },
        uColor: { value: new Vector3(...hexToLinearRgb(PALETTE.stormTint)) },
        uReduced: { value: 0 },
      },
      transparent: true,
      depthWrite: false,
      // 不使用加法混合，让飞沙呈现不透明的土石颗粒感
      vertexShader: /* glsl */ `
        attribute float aRand;
        uniform float uTime;
        uniform float uIntensity;
        uniform float uSize;
        varying float vA;
        void main() {
          vec3 p = position;
          float t = uTime * (0.9 + aRand * 0.7) + aRand * 40.0;
          // 提速：飞沙横向/纵向漂移更快，制造"飞沙走石"的扑面感
          p.x += sin(t * 3.0 + aRand * 6.28) * 6.0;
          p.y += mod(t * 26.0, 80.0) - 30.0;
          p.z += cos(t * 2.6 + aRand * 6.28) * 6.0;
          // 近地富集
          float groundFade = smoothstep(0.0, 0.25, p.y / 300.0);
          vA = uIntensity * (0.4 + 0.6 * groundFade);
          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = uSize * (0.4 + aRand) * (1.0 / max(1.0, -mv.z)) * 30.0;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec3 uColor;
        varying float vA;
        void main() {
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          if (d > 0.5) discard;
          float a = (1.0 - d * 2.0) * vA * 2.6;
          if (a < 0.01) discard;
          gl_FragColor = vec4(uColor, a);
          #include <colorspace_fragment>
        }
      `,
    })
    const points = new Points(pGeo, particleMat)
    points.position.set(zone.x, 0, zone.z)
    points.frustumCulled = false
    points.renderOrder = 5
    group.add(points)

    zones.push({ zone, target: 0, cur: 0, wallMats, particleMat })
  }

  let global = 0
  /** 截图/预览锁定强度：非 null 时绕过 rover 位置计算，直接以该值驱动显隐。 */
  let override: number | null = null

  const intensityAt = (x: number, z: number): number => {
    if (override !== null) {
      global = override
      return override
    }
    let g = 0
    for (const zs of zones) {
      const d = Math.hypot(x - zs.zone.x, z - zs.zone.z)
      const t = Math.max(0, 1 - d / zs.zone.radius)
      zs.target = t * t
      zs.cur += (zs.target - zs.cur) * SMOOTH
      g = Math.max(g, zs.cur)
    }
    global = g
    return g
  }

  return {
    group,
    intensityAt,
    currentIntensity: () => (override !== null ? override : global),
    setTime: (t) => {
      for (const zs of zones) {
        const val = override !== null ? override : zs.cur
        for (const m of zs.wallMats) {
          m.uniforms.uTime.value = t
          m.uniforms.uIntensity.value = val
        }
        zs.particleMat.uniforms.uTime.value = t
        zs.particleMat.uniforms.uIntensity.value = val
      }
    },
    setOverride: (v) => {
      override = v
    },
    setReducedMotion: (on) => {
      for (const zs of zones) {
        for (const m of zs.wallMats) m.uniforms.uReduced.value = on ? 1 : 0
        zs.particleMat.uniforms.uReduced.value = on ? 1 : 0
      }
    },
    dispose: () => {
      for (const zs of zones) {
        for (const m of zs.wallMats) {
          m.dispose()
        }
        zs.particleMat.dispose()
      }
      group.traverse((o) => {
        const mesh = o as Mesh
        if (mesh.geometry) mesh.geometry.dispose()
      })
    },
  }
}
