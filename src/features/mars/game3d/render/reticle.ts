/**
 * 扫描准星：告诉学生"这一发打下去会照亮多大一片"。
 *
 * 半径严格等于 `SCAN_RADIUS`，不做视觉夸张。
 * 预算用完时整圈变红并加叉号——用形状而不只是颜色表达禁用状态。
 */
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  Group,
  Mesh,
  RingGeometry,
  ShaderMaterial,
} from 'three'
import type { HeightField } from '../core/heightField'
import { PALETTE } from './palette'

export type Reticle = {
  group: Group
  /** 移动准星到地面某点；radius 为探明半径 */
  moveTo: (x: number, z: number, radius: number) => void
  setVisible: (on: boolean) => void
  /** 预算耗尽时置为 false，准星变红 */
  setEnabled: (on: boolean) => void
  setTime: (t: number) => void
  dispose: () => void
}

const SEGMENTS = 72

export function createReticle(field: HeightField): Reticle {
  const group = new Group()
  group.name = 'ScanReticle'
  group.visible = false

  const ringGeo = new RingGeometry(0.92, 1.0, SEGMENTS)
  ringGeo.rotateX(-Math.PI / 2)
  const ringMat = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
    uniforms: {
      uColor: { value: new Color(PALETTE.accentCyan) },
      uTime: { value: 0 },
      uEnabled: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uEnabled;
      varying vec2 vUv;
      void main() {
        // 沿圆周切成 24 段虚线，硬边，读起来像仪表刻度而不是发光圈
        float ticks = step(0.42, fract(vUv.x * 24.0));
        float pulse = 0.72 + 0.28 * step(0.5, fract(uTime * 0.8));
        vec3 col = mix(vec3(1.0, 0.35, 0.30), uColor, uEnabled);
        gl_FragColor = vec4(col * pulse, ticks * 0.9);
      }
    `,
  })
  const ring = new Mesh(ringGeo, ringMat)
  group.add(ring)

  let currentRadius = 1

  const moveTo = (x: number, z: number, radius: number) => {
    currentRadius = radius
    group.position.set(x, field.heightAt(x, z) + 0.6, z)
    ring.scale.setScalar(radius)
  }

  return {
    group,
    moveTo,
    setVisible: (on) => {
      group.visible = on
    },
    setEnabled: (on) => {
      ringMat.uniforms.uEnabled.value = on ? 1 : 0
      // 禁用时准星缩到 40%，明确表达"打不出去"
      ring.scale.setScalar(on ? currentRadius : currentRadius * 0.4)
    },
    setTime: (t) => {
      ringMat.uniforms.uTime.value = t
    },
    dispose: () => {
      ringGeo.dispose()
      ringMat.dispose()
    },
  }
}
