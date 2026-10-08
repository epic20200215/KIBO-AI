/**
 * 贴地路线丝带：把 A* 规划出的路径画成一条浮在地形表面的发光带。
 *
 * 这是 M4 把"规划器输出"变成学生看得见的决策的关键。丝带用三角带沿路径点生成，
 * 每个顶点 Y = 地形高度 + 小抬升，保证贴地不穿模。颜色用 `accentGhost`（规划器建议路线），
 * 并带轻微流动动画提示"这是建议，不是已走"。
 */
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Mesh,
  ShaderMaterial,
  type Texture,
} from 'three'
import type { HeightField } from '../core/heightField'
import type { GridCell } from '../core/grid'
import { PALETTE, hexToLinearRgb } from './palette'

export type RouteRibbon = {
  mesh: Mesh
  setPath: (cells: GridCell[]) => void
  setProgress: (t: number) => void
  setTime: (t: number) => void
  /** 复盘/修改阶段才揭示"没数据却真禁行"的隐藏段（红色） */
  setShowHidden: (on: boolean) => void
  dispose: () => void
}

const RIBBON_WIDTH = 5.5
const LIFT = 0.7

export function createRouteRibbon(field: HeightField, ramp: Texture): RouteRibbon {
  const geometry = new BufferGeometry()
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uColor: { value: new Color(...hexToLinearRgb(PALETTE.accentRoute)) },
      uGuessColor: { value: new Color(...hexToLinearRgb(PALETTE.accentGuess)) },
      uHiddenColor: { value: new Color(...hexToLinearRgb(PALETTE.accentDanger)) },
      uEdgeColor: { value: new Color(...hexToLinearRgb(PALETTE.ink)) },
      uTime: { value: 0 },
      uProgress: { value: 0 },
      uShowHidden: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aAlong;
      attribute float aScanned;
      attribute float aTrueFlag;
      varying float vAlong;
      varying float vSide;
      varying float vScanned;
      varying float vTrueFlag;
      void main() {
        vAlong = aAlong;
        vSide = uv.x; // 0 左 1 右
        vScanned = aScanned;
        vTrueFlag = aTrueFlag;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uColor;
      uniform vec3 uGuessColor;
      uniform vec3 uHiddenColor;
      uniform vec3 uEdgeColor;
      uniform float uTime;
      uniform float uProgress;
      uniform float uShowHidden;
      varying float vAlong;
      varying float vSide;
      varying float vScanned;
      varying float vTrueFlag;
      void main() {
        // 两侧羽化 + 细墨线内边，让丝带在复杂地表上有清晰轮廓但不显脏
        float edge = smoothstep(0.0, 0.18, vSide) * smoothstep(1.0, 0.82, vSide);
        float inkEdge = smoothstep(0.0, 0.06, vSide) + smoothstep(1.0, 0.94, vSide);
        // 已探明段：青绿实线 + 慢流动；猜测段：暖橙虚线 + 快流动（视觉上明显不同）
        float known = step(0.5, vScanned);
        float flowKnown = 0.5 + 0.5 * sin(vAlong * 0.7 - uTime * 2.2);
        float flowGuess = step(0.5, fract(vAlong * 1.4 - uTime * 0.5));
        float flow = mix(flowGuess, flowKnown, known);
        float baseA = mix(0.55, 0.42, known) + mix(0.30, 0.48, known) * flow;
        float done = step(vAlong, uProgress);
        float alpha = edge * baseA * (done > 0.5 ? 1.0 : 0.72);
        vec3 lit = mix(uGuessColor, uColor, known) * (done > 0.5 ? 1.25 : 1.0);
        vec3 col = mix(lit, uEdgeColor, inkEdge * 0.28);
        // 隐藏禁行段：没数据却真实禁行。默认不揭示（避免规划阶段作弊），
        // 只有复盘/修改阶段 uShowHidden=1 才以红色虚线暴露——这就是 drive 翻车的真相
        float hidden = step(0.5, vTrueFlag) * (1.0 - step(0.5, vScanned));
        float flowHidden = step(0.5, fract(vAlong * 1.8 - uTime * 0.8));
        col = mix(col, uHiddenColor * (0.7 + 0.5 * flowHidden), uShowHidden * hidden);
        gl_FragColor = vec4(col, alpha);
        #include <colorspace_fragment>
      }
    `,
  })

  const mesh = new Mesh(geometry, material)
  mesh.name = 'RouteRibbon'
  mesh.frustumCulled = false
  mesh.renderOrder = 5

  const setPath = (cells: GridCell[]) => {
    if (cells.length < 2) {
      geometry.setAttribute('position', new Float32BufferAttribute([], 3))
      return
    }
    const positions: number[] = []
    const uvs: number[] = []
    const along: number[] = []
    const scanned: number[] = []
    const trueFlag: number[] = []
    let acc = 0
    const left: [number, number, number][] = []
    const right: [number, number, number][] = []
    for (let k = 0; k < cells.length; k += 1) {
      const c = cells[k]
      const y = field.heightAt(c.x, c.z) + LIFT
      // 切线方向（指向下一个点或上一个点）
      const a = cells[Math.max(0, k - 1)]
      const b = cells[Math.min(cells.length - 1, k + 1)]
      const tx = b.x - a.x
      const tz = b.z - a.z
      const len = Math.hypot(tx, tz) || 1
      // 水平法线（垂直于切线）
      const nx = -tz / len
      const nz = tx / len
      left.push([c.x + nx * RIBBON_WIDTH * 0.5, y, c.z + nz * RIBBON_WIDTH * 0.5])
      right.push([c.x - nx * RIBBON_WIDTH * 0.5, y, c.z - nz * RIBBON_WIDTH * 0.5])
      if (k > 0) acc += Math.hypot(c.x - cells[k - 1].x, c.z - cells[k - 1].z)
      along.push(acc)
      scanned.push(c.scanned)
      trueFlag.push(c.trueFlag)
    }
    const maxAlong = acc || 1
    for (let k = 0; k < cells.length; k += 1) {
      const l = left[k]
      const r = right[k]
      positions.push(l[0], l[1], l[2], r[0], r[1], r[2])
      uvs.push(0, 0, 1, 0)
      along[k] = along[k] / maxAlong
      along.push(along[k])
      scanned.push(scanned[k])
      trueFlag.push(trueFlag[k])
    }
    const indices: number[] = []
    for (let k = 0; k < cells.length - 1; k += 1) {
      const a = k * 2
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
    geometry.setAttribute('aAlong', new Float32BufferAttribute(along, 1))
    geometry.setAttribute('aScanned', new Float32BufferAttribute(scanned, 1))
    geometry.setAttribute('aTrueFlag', new Float32BufferAttribute(trueFlag, 1))
    geometry.setIndex(indices)
    geometry.computeBoundingSphere()
  }

  const setProgress = (t: number) => {
    material.uniforms.uProgress.value = t
  }
  const setTime = (t: number) => {
    material.uniforms.uTime.value = t
  }
  const setShowHidden = (on: boolean) => {
    material.uniforms.uShowHidden.value = on ? 1 : 0
  }
  const dispose = () => {
    geometry.dispose()
    material.dispose()
  }

  return { mesh, setPath, setProgress, setTime, setShowHidden, dispose }
}
