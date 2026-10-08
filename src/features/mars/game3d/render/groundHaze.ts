/**
 * 近地面尘霭平面（M6-b）。
 *
 * 在距离相机一定远处铺一层半透明白色/暖灰雾，用来：
 * - 掩盖远处低 LOD 地形与天空的硬接缝。
 * - 给火星地表增加"低空悬浮尘"的氛围。
 * - 与地面闪光、尘魔统一，强化景深。
 *
 * 实现：一个巨大的水平圆盘，略高于地面，径向透明度从中心透明到边缘浓。
 * 随相机移动，保证边缘雾永远在远处。
 */
import {
  CircleGeometry,
  Color,
  Mesh,
  NormalBlending,
  ShaderMaterial,
} from 'three'
import { PALETTE } from './palette'

export type GroundHaze = {
  mesh: Mesh
  setTime: (t: number) => void
  setQuality: (level: 'high' | 'medium' | 'low') => void
  dispose: () => void
}

export function createGroundHaze(): GroundHaze {
  const geometry = new CircleGeometry(1200, 64)
  geometry.rotateX(-Math.PI / 2)

  const material = new ShaderMaterial({
    uniforms: {
      uColor: { value: new Color(PALETTE.skyHorizon) },
      uTime: { value: 0 },
      uDensity: { value: 0.55 },
    },
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
    vertexShader: /* glsl */ `
      varying vec2 vWorldXZ;
      varying float vDist;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorldXZ = world.xz;
        vDist = length(world.xz);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uDensity;
      varying float vDist;

      void main() {
        // 内圈完全透明，从 180m 开始逐渐变浓，到 900m 达到最大
        float rim = smoothstep(180.0, 900.0, vDist);
        // 缓慢呼吸，让尘霭有轻微动态
        float breathe = 0.92 + 0.08 * sin(uTime * 0.35 + vDist * 0.01);
        float alpha = rim * uDensity * breathe;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(uColor, alpha);
        #include <colorspace_fragment>
      }
    `,
  })

  const mesh = new Mesh(geometry, material)
  mesh.name = 'GroundHaze'
  mesh.frustumCulled = false
  mesh.renderOrder = -3
  mesh.position.y = 18 // 略高于大部分地表，不会近处穿帮

  return {
    mesh,
    setTime: (t) => {
      material.uniforms.uTime.value = t
    },
    setQuality: (level) => {
      material.uniforms.uDensity.value = level === 'high' ? 0.55 : level === 'medium' ? 0.40 : 0.25
    },
    dispose: () => {
      geometry.dispose()
      material.dispose()
    },
  }
}
