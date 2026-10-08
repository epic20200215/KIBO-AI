/**
 * 扫描波：从漫游车周期发出的硬边扩散环，可视化"扫描配额"与未知区被点亮的过程。
 *
 * 这是 M4 把"扫描"变成可见动作的关键。环用一张平铺在地形上方的圆盘 + 径向 shader 实现，
 * 不依赖任何外部贴图。教学上配合"未知区图案编码"使用（未知区在后续里程碑接入地形 shader）。
 */
import { Color, DoubleSide, Mesh, RingGeometry, ShaderMaterial, type Texture } from 'three'
import { PALETTE, hexToLinearRgb } from './palette'

export type ScanWave = {
  group: Mesh
  /** 触发一次扫描脉冲，中心在 (x,z)，最大半径 radius（米） */
  pulse: (x: number, z: number, radius: number) => void
  setTime: (t: number) => void
  dispose: () => void
}

const MAX_R = 160

export function createScanWave(_ramp: Texture): ScanWave {
  // 用一张大圆盘，shader 里按到中心距离画扩散环；中心可移动
  const geometry = new RingGeometry(0.1, MAX_R, 96, 1)
  geometry.rotateX(-Math.PI / 2)

  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uCenter: { value: new Color(0, 0, 0) },
      uColor: { value: new Color(...hexToLinearRgb(PALETTE.accentCyan)) },
      uTime: { value: 0 },
      uActive: { value: 0 },
      uRadius: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocal;
      void main() {
        vLocal = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uCenter;
      uniform vec3 uColor;
      uniform float uTime;
      uniform float uActive;
      uniform float uRadius;
      varying vec3 vLocal;
      void main() {
        float d = length(vLocal.xz - uCenter.xy);
        // 硬边扩散环：半径随时间从 0 推到 uRadius，环本身是一段窄亮带
        float front = uRadius;
        float ring = smoothstep(3.0, 0.0, abs(d - front));
        // 已扫过的内部轻微提亮（"被看见"）
        float inside = step(d, front) * 0.12;
        float a = (ring * 0.8 + inside) * uActive;
        if (a < 0.001) discard;
        gl_FragColor = vec4(uColor, a);
        #include <colorspace_fragment>
      }
    `,
  })

  const mesh = new Mesh(geometry, material)
  mesh.name = 'ScanWave'
  mesh.frustumCulled = false
  mesh.renderOrder = 4

  let centerX = 0
  let centerZ = 0
  let active = 0
  let radius = 0
  let timer = 0

  const pulse = (x: number, z: number, r: number) => {
    centerX = x
    centerZ = z
    radius = r
    active = 1
    timer = 0
    material.uniforms.uCenter.value.set(x, 0, z)
  }

  const setTime = (t: number) => {
    material.uniforms.uTime.value = t
    // 脉冲在 ~2.5s 内把环推到最大半径，之后淡出
    const dur = 2.5
    if (active > 0) {
      timer += 1 / 60
      const k = Math.min(1, timer / dur)
      material.uniforms.uRadius.value = radius * k
      if (k >= 1) {
        active = Math.max(0, active - 0.02)
        material.uniforms.uActive.value = active
      }
    }
  }

  const dispose = () => {
    geometry.dispose()
    material.dispose()
  }

  return { group: mesh, pulse, setTime, dispose }
}
