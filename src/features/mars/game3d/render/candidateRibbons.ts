/**
 * 候选路线丝带对比（任务体验高潮 #167 — Part A）。
 *
 * 路径选择台打开时，把 AI 生成的候选路线（走近路 / 绕远路）同时画在 3D 场景里，
 * 用三种明显不同的颜色区分，并在每条路线旁浮一个文字标签，让学生能直接在盆地里比较
 * "同一问题可以有几种走法、各自绕多远 / 冒多大险"。选定某条后，其余两条淡出，
 * 选定的那条升为亮色——和主丝带（routeRibbon）语义衔接。
 */
import {
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  type Texture,
} from 'three'
import type { HeightField } from '../core/heightField'
import type { GridCell } from '../core/grid'
import { hexToLinearRgb } from './palette'

export type CandidateRoute = {
  id: string
  label: string
  cells: GridCell[]
  /** 该路线丝带颜色（线性 RGB 友好，用 #RRGGBB）。 */
  color: string
}

const RIBBON_WIDTH = 4.2
const LIFT = 0.8

export type CandidateRibbons = {
  group: Group
  /** 设置要对比的候选路线（0~3 条）。会清空旧丝带重建。 */
  setRoutes: (routes: CandidateRoute[]) => void
  /** 高亮某条（index）；传 null 表示全部等亮（选择台打开、尚未决定时）。 */
  setActive: (index: number | null) => void
  /** 流动动画时间（秒）。 */
  setTime: (t: number) => void
  /** 清掉所有候选丝带（关闭选择台时调用）。 */
  clear: () => void
  dispose: () => void
}

function makeLabelSprite(text: string, color: string): Sprite {
  const pad = 16
  const font = 48
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  ctx.font = `bold ${font}px system-ui, "Segoe UI", sans-serif`
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2
  const h = font + pad * 2
  canvas.width = w
  canvas.height = h
  const c = ctx
  c.clearRect(0, 0, w, h)
  // 背板
  c.fillStyle = 'rgba(12,14,18,0.82)'
  c.beginPath()
  const r = 14
  c.moveTo(r, 0)
  c.arcTo(w, 0, w, h, r)
  c.arcTo(w, h, 0, h, r)
  c.arcTo(0, h, 0, 0, r)
  c.arcTo(0, 0, w, 0, r)
  c.closePath()
  c.fill()
  // 左侧色条
  c.fillStyle = color
  c.fillRect(0, 0, 10, h)
  // 文字
  c.font = `bold ${font}px system-ui, "Segoe UI", sans-serif`
  c.textBaseline = 'middle'
  c.fillStyle = '#ffffff'
  c.fillText(text, 10 + pad, h / 2)
  const tex = new CanvasTexture(canvas)
  tex.needsUpdate = true
  const mat = new SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false })
  const sprite = new Sprite(mat)
  const scale = 0.06
  sprite.scale.set((w * scale), (h * scale), 1)
  sprite.renderOrder = 999
  return sprite
}

function buildRibbonGeometry(field: HeightField, cells: GridCell[]): BufferGeometry {
  const geometry = new BufferGeometry()
  if (cells.length < 2) return geometry
  const positions: number[] = []
  const uvs: number[] = []
  const along: number[] = []
  let acc = 0
  const left: [number, number, number][] = []
  const right: [number, number, number][] = []
  for (let k = 0; k < cells.length; k += 1) {
    const c = cells[k]
    const y = field.heightAt(c.x, c.z) + LIFT
    const a = cells[Math.max(0, k - 1)]
    const b = cells[Math.min(cells.length - 1, k + 1)]
    const tx = b.x - a.x
    const tz = b.z - a.z
    const len = Math.hypot(tx, tz) || 1
    const nx = -tz / len
    const nz = tx / len
    left.push([c.x + nx * RIBBON_WIDTH * 0.5, y, c.z + nz * RIBBON_WIDTH * 0.5])
    right.push([c.x - nx * RIBBON_WIDTH * 0.5, y, c.z - nz * RIBBON_WIDTH * 0.5])
    if (k > 0) acc += Math.hypot(c.x - cells[k - 1].x, c.z - cells[k - 1].z)
    along.push(acc)
  }
  const maxAlong = acc || 1
  for (let k = 0; k < cells.length; k += 1) {
    const l = left[k]
    const r = right[k]
    positions.push(l[0], l[1], l[2], r[0], r[1], r[2])
    uvs.push(0, 0, 1, 0)
    along[k] = along[k] / maxAlong
    along.push(along[k])
  }
  const indices: number[] = []
  for (let k = 0; k < cells.length - 1; k += 1) {
    const a = k * 2
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
  }
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
  geometry.setAttribute('aAlong', new Float32BufferAttribute(along, 1))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

export function createCandidateRibbons(field: HeightField, _ramp: Texture): CandidateRibbons {
  const group = new Group()
  group.name = 'CandidateRibbons'
  group.visible = false

  let routes: CandidateRoute[] = []
  let meshes: Mesh[] = []
  let labels: Sprite[] = []
  let activeIndex: number | null = null

  const clearMeshes = () => {
    for (const m of meshes) {
      group.remove(m)
      m.geometry.dispose()
      ;(m.material as ShaderMaterial).dispose()
    }
    meshes = []
    for (const s of labels) {
      group.remove(s)
      const sm = s.material as SpriteMaterial
      sm.map?.dispose()
      sm.dispose()
    }
    labels = []
  }

  const setRoutes = (rs: CandidateRoute[]) => {
    clearMeshes()
    routes = rs.filter((r) => r.cells.length >= 2)
    for (const route of routes) {
      const geometry = buildRibbonGeometry(field, route.cells)
      const material = new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: DoubleSide,
        uniforms: {
          uColor: { value: new Color(...hexToLinearRgb(route.color)) },
          uTime: { value: 0 },
          uActive: { value: 1 },
        },
        vertexShader: /* glsl */ `
          attribute float aAlong;
          varying float vAlong;
          varying float vSide;
          void main() {
            vAlong = aAlong;
            vSide = uv.x;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          precision highp float;
          uniform vec3 uColor;
          uniform float uTime;
          uniform float uActive;
          varying float vAlong;
          varying float vSide;
          void main() {
            float edge = smoothstep(0.0, 0.2, vSide) * smoothstep(1.0, 0.8, vSide);
            float flow = 0.5 + 0.5 * sin(vAlong * 6.0 - uTime * 2.5);
            float baseA = 0.40 + 0.32 * flow;
            float alpha = edge * baseA * mix(0.32, 1.0, uActive);
            vec3 col = uColor * (mix(0.8, 1.25, uActive));
            gl_FragColor = vec4(col, alpha);
            #include <colorspace_fragment>
          }
        `,
      })
      const mesh = new Mesh(geometry, material)
      mesh.name = 'CandidateRibbon-' + route.id
      mesh.frustumCulled = false
      mesh.renderOrder = 6
      group.add(mesh)
      meshes.push(mesh)

      // 路线标签：放在路径中点上方，避免三条线在起/终点处重叠成一团
      const mid = route.cells[Math.floor(route.cells.length / 2)]
      const sprite = makeLabelSprite(route.label, route.color)
      sprite.position.set(mid.x, field.heightAt(mid.x, mid.z) + 14, mid.z)
      group.add(sprite)
      labels.push(sprite)
    }
    group.visible = routes.length > 0
  }

  const setActive = (index: number | null) => {
    activeIndex = index
    meshes.forEach((m, i) => {
      const mat = m.material as ShaderMaterial
      mat.uniforms.uActive.value = index === null || index === i ? 1 : 0
    })
    labels.forEach((s, i) => {
      s.material.opacity = index === null || index === i ? 1 : 0.35
    })
  }

  const setTime = (t: number) => {
    for (const m of meshes) {
      ;(m.material as ShaderMaterial).uniforms.uTime.value = t
    }
  }

  const clear = () => {
    clearMeshes()
    routes = []
    group.visible = false
  }

  const dispose = () => {
    clear()
  }

  return { group, setRoutes, setActive, setTime, clear, dispose }
}
