/**
 * 远处尘魔（M6-b）。
 *
 * 火星尘魔可高达数公里，这里作为远景氛围元素：
 * - 固定在世界远处几个位置，不跟随相机。
 * - 风格化半透明锥/螺旋，用 sin 扰动做出旋转上升感。
 * - 只在远景出现，不遮挡玩法区域。
 * - reducedMotion：停止旋转动画，保留静态柱体。
 */
import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector3,
} from 'three'
import { createRng, seedFromString, type Rng } from '../core/rng'
import { hexToLinearRgb, PALETTE } from './palette'

export type DustDevilSet = {
  group: Group
  setTime: (t: number) => void
  setReducedMotion: (on: boolean) => void
  dispose: () => void
}

/** 尘魔实例数据：x, z, 半径, 高度 */
/** 一号（陨石坑盆地）尘卷风布点。原样保留，零回归。 */
const DEVILS: Array<{ x: number; z: number; r: number; h: number }> = [
  { x: -180, z: -120, r: 14, h: 110 },
  { x: 220, z: 80, r: 18, h: 140 },
  { x: -90, z: 190, r: 10, h: 85 },
  { x: 160, z: -210, r: 12, h: 95 },
]

/**
 * 二号（外流河道）尘卷风布点（P2-5）：沿**主河谷谷底**布置。
 *
 * 与一号的区别不只是位置——河谷是下切的窄谷，两侧崖壁夹出一条风道，
 * 尘卷风在谷底更易成形也更显眼。坐标贴 `CHANNEL_SPINE` 的控制点。
 * 高度略高于一号（谷底到台地的落差让尘柱有"从谷里升起"的观感）。
 */
const OUTFLOW_DEVILS: Array<{ x: number; z: number; r: number; h: number }> = [
  { x: -170, z: 90, r: 12, h: 120 },
  { x: -50, z: 0, r: 16, h: 150 },
  { x: 80, z: -100, r: 11, h: 100 },
  { x: 180, z: -150, r: 14, h: 130 },
]

function buildDevilGeometry(r: number, h: number, phase: number): BufferGeometry {
  const geometry = new BufferGeometry()
  const positions: number[] = []
  const attrs: number[] = [] // (radius, height, phase, yNorm)
  const indices: number[] = []
  const segments = 24
  const rings = 16

  for (let j = 0; j <= rings; j += 1) {
    const t = j / rings
    const y = t * h
    const radius = r * (1.0 - t * 0.55)
    for (let i = 0; i <= segments; i += 1) {
      const a = (i / segments) * Math.PI * 2
      positions.push(Math.cos(a) * radius, y, Math.sin(a) * radius)
      attrs.push(r, h, phase, t)
    }
  }

  for (let j = 0; j < rings; j += 1) {
    for (let i = 0; i < segments; i += 1) {
      const a = j * (segments + 1) + i
      const b = a + segments + 1
      indices.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }

  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('aAttr', new Float32BufferAttribute(attrs, 4))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

export function createDustDevils(
  rng: Rng = createRng(seedFromString('kibo-dust-devils')),
  worldIndex = 0,
): DustDevilSet {
  const group = new Group()
  const meshes: Mesh[] = []
  // 2026-09-09 老大反馈：二号场景不应和一号一样，**尘卷风全部去掉**。
  // 一号保留原 DEVILS（零回归）；二号传空数组 → 0 颗尘卷风。
  const devils = worldIndex === 1 ? [] : DEVILS

  const material = new ShaderMaterial({
    uniforms: {
      uBottom: { value: new Color(PALETTE.hazeColor) },
      uTop: { value: new Color(PALETTE.skyHorizon) },
      uInk: { value: new Vector3(...hexToLinearRgb(PALETTE.ink)) },
      uTime: { value: 0 },
      uReduced: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    side: 2, // DoubleSide
    blending: NormalBlending,
    vertexShader: /* glsl */ `
      attribute vec4 aAttr;
      uniform float uTime;
      uniform float uReduced;
      varying float vY;
      varying float vAlpha;
      varying float vEdge;

      void main() {
        float r = aAttr.x;
        float h = aAttr.y;
        float phase = aAttr.z;
        float t = aAttr.w;
        vec3 pos = position;

        float spin = uReduced > 0.5 ? 0.0 : uTime * 1.2 + t * 5.0 + phase;
        // 腰部收紧、顶部外扩的鼓包：中部半径*0.75，顶部*1.15
        float bulge = 1.0 - 0.35 * sin(t * 3.1416) + 0.25 * sin(t * 3.1416 * 0.5);
        pos.x *= bulge;
        pos.z *= bulge;

        float wobble = sin(spin) * r * 0.22 * (1.0 - t * 0.2) * bulge;
        pos.x += wobble * cos(spin * 0.7);
        pos.z += wobble * sin(spin * 0.7);

        vY = t;
        vAlpha = (1.0 - t * t) * 0.55;
        // 螺旋暗纹：随高度旋转的斜纹
        vEdge = abs(fract(float(gl_VertexID) * 0.13 + t * 2.5 + spin * 0.08) - 0.5) * 2.0;

        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      uniform vec3 uBottom;
      uniform vec3 uTop;
      uniform vec3 uInk;
      varying float vY;
      varying float vAlpha;
      varying float vEdge;

      void main() {
        vec3 col = mix(uBottom, uTop, vY * vY);
        float band = step(0.68, fract(vY * 7.0 + vEdge * 0.55));
        col = mix(col, uInk * 0.5, band * 0.40);
        float alpha = vAlpha * (0.62 + band * 0.18);
        if (alpha < 0.02) discard;
        gl_FragColor = vec4(col, alpha);
        #include <colorspace_fragment>
      }
    `,
  })

  for (const d of devils) {
    const geo = buildDevilGeometry(d.r, d.h, rng.next() * Math.PI * 2)
    const pos = geo.attributes.position.array as Float32Array
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] += d.x
      pos[i + 2] += d.z
    }
    geo.attributes.position.needsUpdate = true

    const mat = material.clone()
    const mesh = new Mesh(geo, mat)
    mesh.frustumCulled = false
    mesh.renderOrder = -2
    group.add(mesh)
    meshes.push(mesh)
  }

  return {
    group,
    setTime: (t) => {
      meshes.forEach((m) => {
        const mat = m.material as ShaderMaterial
        mat.uniforms.uTime.value = t
      })
    },
    setReducedMotion: (on) => {
      meshes.forEach((m) => {
        const mat = m.material as ShaderMaterial
        mat.uniforms.uReduced.value = on ? 1 : 0
      })
    },
    dispose: () => {
      material.dispose()
      meshes.forEach((m) => {
        m.geometry.dispose()
        const mat = m.material as ShaderMaterial
        mat.dispose()
      })
    },
  }
}
