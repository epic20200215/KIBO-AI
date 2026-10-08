/**
 * 教学地标与视觉边界（高品质版 · 二次提质 2026-08-07）。
 *
 * 按 `docs/视觉基准图/三视图/` 进一步拉齐细节密度：
 * - 主基地：曲面放射肋穹顶 + 曲面舷窗 + 更精细格架通讯塔（平台/碟形天线/塔基格栅）+ 蜂窝太阳能翼 + 分层基座 + 楔形着陆箭头
 * - 任务点 A：更多不规则层 + 唇边 + 弯曲裂纹 + 更多崩落碎石
 * - 任务点 B：更多重叠椭球融合 + 更密瘤状结壳（成片带）+ 弯曲水蚀痕 + 加深凹陷
 * - 任务点 C：更自然风蚀沙丘 + 三角旗 + 放大警示牌 + 半埋轮 + 推起沙脊
 *
 * 地标只影响画面，不参与路径规划或物理。
 */
import {
  BoxGeometry,
  BufferGeometry,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  Mesh,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  TorusGeometry,
  Texture,
  Vector2,
  Vector3,
} from 'three'
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore —— three 的 examples/jsm 未附带 .d.ts
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { BASIN_SIZE, CHANNEL_SPINE, HIDDEN_SAMPLE, type HeightField } from '../core/heightField'
import { PALETTE, SUN_DIRECTION, hexToLinearRgb } from './palette'
import { addSilhouetteOutline, createCelMaterial, noOutline } from './celMaterial'
import { createRampTexture } from './ramp'
import { setLayerRecursive, NO_EDGE_LAYER, NO_SOBEL_LAYER } from './postfx'

const HALF = BASIN_SIZE / 2

function mat(hex: string, ramp: Texture, emissive = 0) {
  const m = createCelMaterial(hex, ramp)
  if (emissive) m.uniforms.uEmissive.value = emissive
  return m
}

function box(w: number, h: number, d: number, hex: string, ramp: Texture, emissive = 0): Mesh {
  const m = new Mesh(new BoxGeometry(w, h, d), mat(hex, ramp, emissive))
  m.castShadow = false
  m.receiveShadow = false
  return m
}

function cyl(rTop: number, rBot: number, h: number, hex: string, ramp: Texture, seg = 12): Mesh {
  const m = new Mesh(new CylinderGeometry(rTop, rBot, h, seg), mat(hex, ramp))
  m.castShadow = false
  m.receiveShadow = false
  return m
}

function cone(r: number, h: number, hex: string, ramp: Texture, seg = 12): Mesh {
  const m = new Mesh(new ConeGeometry(r, h, seg), mat(hex, ramp))
  m.castShadow = false
  m.receiveShadow = false
  return m
}

function sphere(r: number, hex: string, ramp: Texture, wSeg = 12, hSeg = 8): Mesh {
  const m = new Mesh(new SphereGeometry(r, wSeg, hSeg), mat(hex, ramp))
  m.castShadow = false
  m.receiveShadow = false
  return m
}

/** 蜂窝栅格线（用于太阳能翼表面）。 */
function honeycombGrid(parent: Group, w: number, l: number, hex: string, ramp: Texture, nx = 3, nz = 5) {
  for (let i = 1; i < nx; i++) {
    const line = box(0.02, 0.02, l * 0.9, hex, ramp)
    line.position.set((i / nx - 0.5) * w, 0.08, 0)
    parent.add(line)
  }
  for (let j = 1; j < nz; j++) {
    const line = box(w * 0.9, 0.02, 0.02, hex, ramp)
    line.position.set(0, 0.08, (j / nz - 0.5) * l)
    parent.add(line)
  }
}

/** 简单线性同余种子随机，保证刷新后视觉稳定。 */
export function makeRng(seed = 12345) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** 着陆平台标记：呼吸青色圆环。 */
export function createLandingPad(field: HeightField): Mesh {
  const y = field.heightAt(field.start.x, field.start.z) + 0.12

  const geometry = new RingGeometry(10, 18, 64)
  geometry.rotateX(-Math.PI / 2)
  geometry.translate(field.start.x, y, field.start.z)

  const color = new Color(PALETTE.accentCyan)

  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    uniforms: {
      uColor: { value: color },
      uTime: { value: 0 },
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
      varying vec2 vUv;
      void main() {
        float r = length(vUv - 0.5) * 2.0;
        float fill = 1.0 - step(0.72, r);
        float ring = step(0.86, r) - step(1.0, r);
        float pulse = 0.92 + 0.08 * sin(uTime * 2.5);
        float alpha = (fill * 0.18 + ring * 0.85) * pulse;
        gl_FragColor = vec4(uColor, alpha);
        #include <colorspace_fragment>
      }
    `,
  })

  const mesh = new Mesh(geometry, material)
  mesh.name = 'LandingPad'
  mesh.renderOrder = 10
  return mesh
}

/** 主基地：中央穹顶 + 通讯塔 + 四向太阳能翼 + 支撑腿，位于起始点。 */
export function createMainBase(field: HeightField, ramp: Texture): Group {
  const root = new Group()
  root.name = 'MainBase'
  const x = field.start.x
  const z = field.start.z
  const y0 = field.heightAt(x, z)
  const C = new Vector3(x, y0 + 5.6, z) // 穹顶中心

  // --- 着陆环（带厚度 + 青色内发光带） ---
  const ringOuter = cyl(17.5, 17.5, 0.35, '#3a3a42', ramp, 48)
  ringOuter.position.set(x, y0 + 0.18, z)
  root.add(ringOuter)
  const ringInner = cyl(15.8, 15.8, 0.38, PALETTE.sandFlat, ramp, 48)
  ringInner.position.set(x, y0 + 0.16, z)
  root.add(ringInner)
  // 青色发光环：用细 Torus 只做外缘一圈，避免整片平台泛青
  const ringGlow = new Mesh(new TorusGeometry(16.5, 0.15, 8, 96), mat(PALETTE.accentCyan, ramp, 0.35))
  ringGlow.rotation.x = Math.PI / 2
  ringGlow.position.set(x, y0 + 0.34, z)
  root.add(ringGlow)
  // 着陆平台同心圆结构线（README §3.2：平台表面应有同心圆结构线，3~4 道）
  for (const [rr, yy] of [[13.5, y0 + 0.40], [10.5, y0 + 0.44], [7.5, y0 + 0.48], [4.5, y0 + 0.52]] as const) {
    const structRing = new Mesh(new TorusGeometry(rr, 0.025, 6, 64), mat('#2c2c34', ramp))
    structRing.rotation.x = Math.PI / 2
    structRing.position.set(x, yy, z)
    root.add(noOutline(structRing))
  }
  // 环上 4 个方向楔形箭头
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2
    const arrow = cone(0.45, 1.3, PALETTE.accentCyan, ramp, 4)
    arrow.position.set(x + Math.sin(a) * 16.6, y0 + 0.5, z + Math.cos(a) * 16.6)
    arrow.rotation.z = -Math.PI / 2
    arrow.rotation.y = a
    arrow.material = mat(PALETTE.accentCyan, ramp, 0.25)
    root.add(noOutline(arrow))
  }

  // --- 中央基座（分层 + 舱门） ---
  const base = cyl(7, 7.8, 2.8, PALETTE.rockDark, ramp, 18)
  base.position.set(x, y0 + 1.4, z)
  root.add(base)
  for (let i = 0; i < 3; i++) {
    const tier = cyl(7.1 - i * 0.1, 7.1 - i * 0.1, 0.12, '#5a5a62', ramp, 18)
    tier.position.set(x, y0 + 0.4 + i * 0.9, z)
    root.add(tier)
  }
  // 舱门
  const door = box(1.6, 2.0, 0.2, '#4a4a52', ramp)
  door.position.set(x, y0 + 1.3, z + 7.7)
  root.add(door)
  const doorFrame = box(1.9, 2.3, 0.1, PALETTE.kiboAccent, ramp)
  doorFrame.position.set(x, y0 + 1.3, z + 7.6)
  root.add(noOutline(doorFrame))

  // 支撑腿（从基座底部斜向外撑到地面）
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    const leg = cyl(0.2, 0.2, 5.2, PALETTE.rockDark, ramp, 8)
    leg.position.set(x + Math.sin(a) * 6.2, y0 + 1.6, z + Math.cos(a) * 6.2)
    leg.rotation.z = 0.25
    leg.rotation.y = a
    root.add(leg)
    const padFoot = cyl(0.5, 0.5, 0.14, '#5a5a62', ramp, 12)
    padFoot.position.set(x + Math.sin(a) * 8.8, y0 + 0.06, z + Math.cos(a) * 8.8)
    root.add(padFoot)
  }

  // --- 穹顶（更接近半球，正面大圆窗，极 subtle 经线缝） ---
  const domeGroup = new Group()
  domeGroup.position.copy(C)
  domeGroup.scale.y = 0.85
  root.add(domeGroup)

  const dome = sphere(6.4, '#f4f0e8', ramp, 30, 20)
  domeGroup.add(dome)
  // 穹顶面板缝：参考图可见分段拼接线，6 条经线 + 2 条正确半径的纬线
  const ribMat = mat('#e8e4dc', ramp)
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    const rib = new Mesh(new TorusGeometry(6.45, 0.009, 6, 32, Math.PI), ribMat)
    rib.rotation.y = a
    domeGroup.add(noOutline(rib))
  }
  // 纬线：按球面截面半径精确计算
  const latBands: Array<[number, number]> = [
    [3.3, Math.sqrt(6.4 * 6.4 - 3.3 * 3.3)],
    [5.5, Math.sqrt(6.4 * 6.4 - 5.5 * 5.5)],
  ]
  for (const [yOff, rAtY] of latBands) {
    const lat = new Mesh(new TorusGeometry(rAtY, 0.008, 6, 48), ribMat)
    lat.rotation.x = Math.PI / 2
    lat.position.y = yOff
    domeGroup.add(noOutline(lat))
  }

  // 舷窗：玻璃盘 + 边框，朝向穹顶中心
  function makeWindow(w: number, h: number, emissive: number) {
    const g = new Group()
    const glass = noOutline(box(w, h, 0.25, PALETTE.accentCyan, ramp, emissive))
    g.add(glass)
    const fT = noOutline(box(w + 0.18, 0.1, 0.32, '#d8d4cc', ramp))
    fT.position.set(0, h / 2 + 0.02, 0)
    const fB = noOutline(fT.clone())
    fB.position.set(0, -h / 2 - 0.02, 0)
    const fL = noOutline(box(0.1, h + 0.18, 0.32, '#d8d4cc', ramp))
    fL.position.set(-w / 2 - 0.02, 0, 0)
    const fR = noOutline(fL.clone())
    fR.position.set(w / 2 + 0.02, 0, 0)
    g.add(fT, fB, fL, fR)
    return g
  }
  // 正面大圆形观察窗（穹顶 +z 面，朝向 -z 迎接正视相机）
  const bigWinGroup = new Group()
  bigWinGroup.position.set(x, y0 + 5.6, z + 6.55)
  bigWinGroup.rotation.y = 0
  root.add(bigWinGroup)

  // 正面大圆窗：深色玻璃 + 青色发光中心（winInner），避免整窗过亮
  const winGlass = new Mesh(
    new CylinderGeometry(1.35, 1.35, 0.22, 40),
    mat('#0e1a26', ramp, 0.12),
  )
  winGlass.rotation.x = Math.PI / 2
  bigWinGroup.add(noOutline(winGlass))

  const winFrame = new Mesh(new TorusGeometry(1.35, 0.12, 8, 40), mat('#d8d4cc', ramp))
  winFrame.rotation.x = Math.PI / 2
  bigWinGroup.add(noOutline(winFrame))

  // 内圈镜头/发光环，强化“大圆形观察窗”识别（降低发光避免过曝）
  const winInner = new Mesh(
    new CylinderGeometry(0.85, 0.85, 0.26, 32),
    mat(PALETTE.accentCyan, ramp, 0.55),
  )
  winInner.rotation.x = Math.PI / 2
  bigWinGroup.add(noOutline(winInner))

  // 窗周螺栓 8 颗
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    const bolt = new Mesh(new SphereGeometry(0.08, 8, 6), mat('#a0a0a8', ramp))
    bolt.position.set(Math.cos(a) * 1.42, Math.sin(a) * 1.42, 0.12)
    bigWinGroup.add(noOutline(bolt))
  }

  // 4 个小矩形深色舷窗：围绕大窗分布在前半球
  const smallPos = [
    [2.6, 6.4, 4.9],
    [-2.6, 6.4, 4.9],
    [2.2, 4.9, 5.2],
    [-2.2, 4.9, 5.2],
    [4.9, 6.2, 2.2],
    [-4.9, 6.2, 2.2],
    [4.5, 5.0, 3.0],
    [-4.5, 5.0, 3.0],
  ]
  for (const [dx, dy, dz] of smallPos) {
    const w = makeWindow(0.62, 0.5, 0.5)
    w.position.set(x + dx, y0 + dy, z + dz)
    w.lookAt(C)
    root.add(w)
  }

  // --- 通讯塔（简洁格架 + 青色长方体信标，对齐三视图） ---
  const towerX = x
  const towerZ = z
  const towerH = 14
  const towerBaseY = y0 + 6.0 // 从穹顶顶部开始
  const towerW = 1.2
  // 四根立柱
  for (const tx of [-1, 1]) {
    for (const tz of [-1, 1]) {
      const post = cyl(0.12, 0.12, towerH, '#4a4a52', ramp, 8)
      post.position.set(towerX + tx * towerW * 0.5, towerBaseY + towerH / 2, towerZ + tz * towerW * 0.5)
      root.add(noOutline(post))
    }
  }
  // 水平横梁 + 交叉斜撑（每 2.5 单位一层）
  for (let i = 0; i <= 5; i++) {
    const ly = towerBaseY + i * (towerH / 5)
    const braceX = box(towerW + 0.06, 0.1, 0.08, '#4a4a52', ramp)
    braceX.position.set(towerX, ly, towerZ)
    root.add(noOutline(braceX))
    const braceZ = box(0.08, 0.1, towerW + 0.06, '#4a4a52', ramp)
    braceZ.position.set(towerX, ly, towerZ)
    root.add(noOutline(braceZ))
    if (i < 5) {
      const ly2 = ly + (towerH / 5) * 0.5
      const diagLen = Math.hypot(towerW, towerH / 5)
      for (const [dx, dz, ry] of [[1, 1, 0], [1, -1, Math.PI / 2], [-1, -1, Math.PI], [-1, 1, -Math.PI / 2]] as const) {
        const diag = cyl(0.05, 0.05, diagLen, '#4a4a52', ramp, 6)
        diag.position.set(towerX + dx * towerW * 0.35, ly2, towerZ + dz * towerW * 0.35)
        diag.rotation.z = Math.atan2(towerW, towerH / 5)
        diag.rotation.y = ry
        root.add(noOutline(diag))
      }
    }
  }
  // 塔顶青色长方体信标 + 顶部发光球
  const beacon = box(0.6, 1.0, 0.6, PALETTE.accentCyan, ramp, 1.4)
  beacon.position.set(towerX, towerBaseY + towerH + 0.5, towerZ)
  root.add(beacon)
  const beaconTop = new Mesh(new SphereGeometry(0.32, 16, 12), mat(PALETTE.accentCyan, ramp, 1.6))
  beaconTop.position.set(towerX, towerBaseY + towerH + 1.1, towerZ)
  root.add(beaconTop)

  // --- 四向太阳能翼（蜂窝栅格 + 厚度边 + 银色转轴） ---
  const wingAngles = [0, Math.PI / 2, Math.PI, -Math.PI / 2]
  for (const a of wingAngles) {
    const arm = box(0.24, 0.24, 4.8, PALETTE.rockDark, ramp)
    arm.position.set(x + Math.sin(a) * 8.2, y0 + 1.0, z + Math.cos(a) * 8.2)
    arm.rotation.y = a
    root.add(arm)

    const panelW = 3.8
    const panelL = 5.8
    const panel = box(panelW, 0.14, panelL, PALETTE.solarDark, ramp)
    panel.position.set(x + Math.sin(a) * 11.8, y0 + 1.12, z + Math.cos(a) * 11.8)
    panel.rotation.y = a
    root.add(panel)
    // 矩形栅格线（主基地太阳能翼用深色矩形线，更易读）
    const grid = new Group()
    grid.position.copy(panel.position)
    grid.rotation.y = a
    const gx = 5
    const gz = 8
    for (let i = 1; i < gx; i++) {
      const line = box(0.03, 0.03, panelL * 0.92, '#0f1622', ramp)
      line.position.set((i / gx - 0.5) * panelW, 0.09, 0)
      grid.add(noOutline(line))
    }
    for (let j = 1; j < gz; j++) {
      const line = box(panelW * 0.92, 0.03, 0.03, '#0f1622', ramp)
      line.position.set(0, 0.09, (j / gz - 0.5) * panelL)
      grid.add(noOutline(line))
    }
    root.add(grid)
    // 厚度边
    const edge = box(panelW + 0.06, 0.02, panelL + 0.06, PALETTE.roverMetal, ramp)
    edge.position.set(x + Math.sin(a) * 11.8, y0 + 1.2, z + Math.cos(a) * 11.8)
    edge.rotation.y = a
    root.add(noOutline(edge))
    // 翼根银色转轴
    const pivot = cyl(0.18, 0.18, 0.34, PALETTE.roverMetal, ramp, 12)
    pivot.position.set(x + Math.sin(a) * 10.0, y0 + 1.06, z + Math.cos(a) * 10.0)
    pivot.rotation.y = a
    root.add(noOutline(pivot))
  }

  // --- 入口坡道 + 护栏 ---
  const rampMesh = box(2.8, 0.25, 6.5, '#c9c4bc', ramp)
  rampMesh.position.set(x, y0 + 0.12, z + 10.5)
  root.add(rampMesh)
  for (const side of [-1, 1]) {
    const rail = box(0.1, 0.5, 6.5, PALETTE.rockDark, ramp)
    rail.position.set(x + side * 1.4, y0 + 0.4, z + 10.5)
    root.add(noOutline(rail))
  }

  addSilhouetteOutline(root, { thickness: 0.5, skipSmall: 0.3 })
  // 主基地整组挪到 NO_EDGE_LAYER，避开 postfx 屏幕空间 Sobel：
  // 基地穹顶肋条/操作台面板/着陆台灯带等法线差大的地方会被勾出内部黑线。
  setLayerRecursive(root, NO_SOBEL_LAYER)
  return root
}

/** 任务点 A：三角洲沉积岩塔。
 * 参考：高锥形沉积岩，暖棕/橙褐/浅黄密集水平层理，表面有纵向裂纹与崩落缺角，顶部钝圆。
 * 用单张 CylinderGeometry 做主体，顶点按高度递减半径并叠加噪声，避免堆叠圆台的“人工唇边”。
 */
export function createDeltaSpire(x: number, z: number, field: HeightField, ramp: Texture): Group {
  const root = new Group()
  root.name = 'DeltaSpire'
  const y0 = field.heightAt(x, z)
  const rng = makeRng(8899)

  const H = 13.5
  const baseR = 4.6
  const topR = 0.55
  const radialSeg = 72
  const heightSeg = 64

  // 主体：单圆锥台，顶点位移出不规则轮廓与钝圆顶
  const geo = new CylinderGeometry(topR, baseR, H, radialSeg, heightSeg, true)
  const pos = geo.attributes.position
  const colors: number[] = []
  const palette = ['#d8b07a', '#a9743f', '#e6c490', '#945f33', '#c79460', '#b3743f', '#ecc79a', '#8c5a32']

  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i)
    const vy = pos.getY(i)
    const vz = pos.getZ(i)
    // 归一化高度 0(底) ~ 1(顶)
    const ny = (vy + H / 2) / H
    // 基础半径按高度线性收缩
    const baseRad = baseR * (1.0 - ny * (1.0 - topR / baseR))
    // 水平角
    const ang = Math.atan2(vx, vz)
    // 轮廓噪声：低频大起伏 + 中频瘤状 + 高频粗糙
    const low = Math.sin(ang * 3.0 + ny * 4.0) * Math.cos(ny * 2.5) * 0.28
    const mid = Math.sin(ang * 7.0 - ny * 6.0) * Math.cos(ang * 5.0 + ny * 3.0) * 0.14
    const high = Math.sin(ang * 14.0 + ny * 11.0) * 0.06
    const micro = (rng() - 0.5) * 0.05
    // 顶部钝圆：越靠近顶部越抑制径向凸起，同时把顶点往中心收
    const topDamp = 1.0 - Math.pow(ny, 3.0)
    const rScale = 1.0 + (low + mid + high + micro) * topDamp
    // 当前水平半径
    const curR = Math.sqrt(vx * vx + vz * vz)
    if (curR > 0.001) {
      const newR = baseRad * rScale
      const k = newR / curR
      pos.setX(i, vx * k)
      pos.setZ(i, vz * k)
    }
    // 竖向也加少量弯曲，让塔身微倾
    const bend = Math.sin(ang * 2.0) * ny * 0.15
    pos.setY(i, vy + bend)

    // 按高度给顶点色（层理）
    const band = Math.floor(ny * 30) % palette.length
    const c = new Color(palette[band])
    colors.push(c.r, c.g, c.b)
  }
  geo.computeVertexNormals()
  geo.setAttribute('color', new Float32BufferAttribute(colors, 3))

  // 自包含 cel + 顶点色材质：避免 clone/replace 着色器的脆弱性，保证塔身必定可见；
  // 水平层理由顶点色（暖棕/土黄交替）承载，再叠加显式脊环加强可读性。
  const spireMat = new ShaderMaterial({
    side: DoubleSide,
    // 标记为「赛璐珞受光材质」：`applySunDirection()` 凭此标记统一改写 uSunDir，
    // 无需给本函数逐层透传 worldIndex 参数。
    userData: { celSun: true },
    uniforms: {
      uSunDir: { value: new Vector3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z).normalize() },
    },
    vertexShader: `
      attribute vec3 color;
      varying vec3 vNormalW;
      varying vec3 vColor;
      void main() {
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vColor = color;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform vec3 uSunDir;
      varying vec3 vNormalW;
      varying vec3 vColor;
      void main() {
        float ndl = dot(normalize(vNormalW), normalize(uSunDir));
        float shade = ndl > 0.55 ? 1.0 : (ndl > 0.1 ? 0.8 : 0.6);
        gl_FragColor = vec4(vColor * shade, 1.0);
        #include <colorspace_fragment>
      }
    `,
  })

  const tower = new Mesh(geo, spireMat)
  tower.position.set(x, y0 + H / 2, z)
  root.add(tower)

  // 显式水平层理脊（深色/浅色交替细环），参考图为有机手绘层理，加入半径抖动、局部缺口与轻微错位
  const ringCount = 16
  for (let i = 1; i < ringCount; i++) {
    const ny = i / ringCount
    const rr = baseR * (1.0 - ny * (1.0 - topR / baseR)) + 0.04
    const dark = i % 2 === 0
    // 半径轻微抖动
    const rJitter = (rng() - 0.5) * 0.25
    // 高度轻微错位
    const yJitter = (rng() - 0.5) * 0.35
    // 约 30% 的环带缺口，模拟崩落/侵蚀
    const hasGap = rng() > 0.7
    const arc = hasGap ? Math.PI * (1.2 + rng() * 0.6) : Math.PI * 2
    const ring = new Mesh(new TorusGeometry(rr + rJitter, 0.05, 6, 48, arc), mat(dark ? '#7a4e2c' : '#ecd0a0', ramp))
    ring.rotation.x = Math.PI / 2
    ring.rotation.z = rng() * Math.PI * 2
    ring.position.set(x, y0 + ny * H + yJitter, z)
    // 内部层理脊不参与整体外轮廓描边，避免"一条条钢条"全勾黑线。
    ring.userData.outline = false
    root.add(ring)
  }

  // 顶部钝圆盖
  const cap = new Mesh(new SphereGeometry(topR * 1.25, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), mat('#a86b3f', ramp))
  cap.position.set(x, y0 + H, z)
  root.add(cap)

  // 低矮圆形基座，与底层自然过渡
  const baseDisc = new Mesh(new CylinderGeometry(baseR * 0.92, baseR * 1.15, 0.6, 48), mat('#a87a52', ramp))
  baseDisc.position.set(x, y0 + 0.3, z)
  root.add(baseDisc)

  // 底部崩落碎石（错落，避免规则环）
  for (let i = 0; i < 32; i++) {
    const a = rng() * Math.PI * 2
    const r = 3.6 + rng() * 2.8
    const s = 0.25 + rng() * 0.65
    const rock = box(s, s * 0.8, s, i % 3 === 0 ? '#8f5a36' : '#9e6b48', ramp)
    rock.position.set(x + Math.sin(a) * r, y0 + s * 0.3, z + Math.cos(a) * r)
    rock.rotation.set(rng(), rng(), rng())
    root.add(rock)
  }

  // 采样标记杆（带底座 + 顶灯）
  const poleBase = cyl(0.3, 0.4, 0.2, PALETTE.rockDark, ramp, 12)
  poleBase.position.set(x + 3.2, y0 + 0.1, z + 1.8)
  root.add(poleBase)
  const pole = cyl(0.07, 0.07, 2.4, PALETTE.accentCyan, ramp, 6)
  pole.position.set(x + 3.2, y0 + 1.3, z + 1.8)
  pole.material = mat(PALETTE.accentCyan, ramp, 0.6)
  root.add(pole)
  const poleLight = new Mesh(new SphereGeometry(0.12, 10, 8), mat(PALETTE.accentCyan, ramp, 0.9))
  poleLight.position.set(x + 3.2, y0 + 2.5, z + 1.8)
  root.add(poleLight)

  addSilhouetteOutline(root, { thickness: 0.5, skipSmall: 0.3 })
  // 与矿石同理：沉积塔由 16 条层理脊（Torus）+ 高分段塔身组成，Sobel 屏幕空间描边
  // 会把每条脊、每个分段面都勾成墨线，视觉上"线条太多"。挪到 NO_EDGE_LAYER 让
  // Sobel 完全跳过，只保留 addSilhouetteOutline 的单一外轮廓。
  setLayerRecursive(root, NO_SOBEL_LAYER)
  return root
}

/** 创建顶点位移的圆润半球，用于含水穹丘主体。
 * 用高细分 SphereGeometry 做底保证光滑法线，再叠加小幅低频/中频噪声，
 * 让表面有自然起伏而不出现锐利角面，贴合参考图的有机馒头形。
 */
function createNoisyDome(radius: number, color: string, ramp: Texture, rng: () => number): Mesh {
  const geo = new SphereGeometry(radius, 72, 56, 0, Math.PI * 2, 0, Math.PI / 2)
  const pos = geo.attributes.position
  // 少量柔和的大块起伏方向
  const facets = Array.from({ length: 12 }, () => ({
    dir: new Vector3(rng() - 0.5, rng() - 0.5, rng() - 0.5).normalize(),
    strength: 0.015 + rng() * 0.02,
    freq: 2 + rng() * 3,
  }))
  for (let i = 0; i < pos.count; i++) {
    const vx = pos.getX(i)
    const vy = pos.getY(i)
    const vz = pos.getZ(i)
    const len = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1
    const nx = vx / len
    const ny = vy / len
    const nz = vz / len
    // 底部（ny 负方向）保持完整，顶部（ny 正方向）是穹丘顶
    const topDamp = 1.0 - Math.pow(Math.max(0, ny), 3.5)
    // 低频大起伏 + 中频瘤状 + 高频粗糙，参考图为崎岖岩石表面
    const low = Math.sin(nx * 2.1 + ny * 1.4) * Math.cos(nz * 1.9 + nx * 1.1) * 0.07
    const mid = Math.sin(nx * 5.3 + nz * 4.1) * Math.cos(ny * 4.7 + nx * 3.2) * 0.04
    const high = Math.sin(nx * 11.0 + ny * 9.0) * Math.cos(nz * 12.0 + ny * 8.0) * 0.015
    // 大块柔和偏移
    let facetOff = 0
    const n = new Vector3(nx, ny, nz)
    for (const f of facets) {
      const d = n.dot(f.dir)
      facetOff += Math.max(0, d) ** 2 * f.strength * Math.sin(d * f.freq * Math.PI)
    }
    const micro = (rng() - 0.5) * 0.012
    const disp = 1.0 + (low + mid + high + facetOff + micro) * topDamp
    pos.setXYZ(i, vx * disp, vy * disp, vz * disp)
  }
  geo.computeVertexNormals()
  const m = new Mesh(geo, mat(color, ramp))
  m.castShadow = false
  m.receiveShadow = false
  return m
}

/** 任务点 B：含水硫酸盐穹丘。
 * 参考 `docs/视觉基准图/三视图/任务点B-含水矿物穹丘-三视图.png`：
 * 表面崎岖、布满瘤状结壳与棱角碎石的馒头形巨岩。
 */
export function createHydratedDome(x: number, z: number, field: HeightField, ramp: Texture): Group {
  const root = new Group()
  root.name = 'HydratedDome'
  const y0 = field.heightAt(x, z)
  const rng = makeRng(7788)

  // 更暖的橙褐主色板
  const palette = ['#b87a4f', '#a86b42', '#c68a5e', '#9c5f38', '#d69a72', '#8f5635']
  const crustLight = '#f5e8d4'
  const crustShadow = '#d4c2a0'

  // 主体：单一顶点扰动球体，压扁成穹丘；用 Icosahedron 底面带来角面感
  const mainDome = createNoisyDome(8.2, '#b07a52', ramp, rng)
  mainDome.scale.set(1.0, 0.72, 0.98)
  mainDome.position.set(x, y0 + 3.0, z)
  root.add(mainDome)

  // 表面瘤状结壳：密集、大小不一，贴合穹面；浅色结壳更突出
  for (let i = 0; i < 360; i++) {
    const a = rng() * Math.PI * 2
    const r = rng() * 7.6
    const dx = Math.sin(a) * r
    const dz = Math.cos(a) * r
    // 按穹面高度分布
    const h = Math.max(0.3, 5.0 - r * 0.42 + (rng() - 0.5) * 1.2)
    const s = 0.25 + rng() * 0.70
    // 结壳用光滑球体压扁，避免锐利角面，更贴近参考的瘤状结壳
    const bump = new Mesh(new SphereGeometry(s, 18, 14), mat(rng() > 0.35 ? crustLight : crustShadow, ramp))
    bump.scale.set(1.0, 0.30 + rng() * 0.30, 1.0)
    bump.position.set(x + dx, y0 + h, z + dz)
    bump.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI)
    root.add(bump)
    if (rng() > 0.45) {
      const satellite = new Mesh(new SphereGeometry(s * (0.35 + rng() * 0.30), 14, 10), mat(rng() > 0.35 ? '#efe4cf' : crustShadow, ramp))
      satellite.position.set(
        x + dx + (rng() - 0.5) * s,
        y0 + h + s * 0.22,
        z + dz + (rng() - 0.5) * s,
      )
      root.add(satellite)
    }
  }

  // 棱角碎石：散布表面，增加粗糙感；使用 box 保持锐利切面（少量，避免棱角过强）
  for (let i = 0; i < 18; i++) {
    const a = rng() * Math.PI * 2
    const r = 0.8 + rng() * 7.2
    const dx = Math.sin(a) * r
    const dz = Math.cos(a) * r
    const h = Math.max(0.2, 4.6 - r * 0.4 + (rng() - 0.5) * 1.0)
    const sx = 0.20 + rng() * 0.40
    const sy = 0.15 + rng() * 0.30
    const sz = 0.20 + rng() * 0.40
    // 棱角碎石改用圆角小石块（Icosahedron 低段数保留少量棱角但不尖锐）
    const chip = new Mesh(new IcosahedronGeometry(Math.max(sx, sy, sz) * 0.65, 0), mat(rng() > 0.5 ? '#e8d8c0' : '#a0704a', ramp))
    chip.scale.set(sx / Math.max(sx, sy, sz), sy / Math.max(sx, sy, sz), sz / Math.max(sx, sy, sz))
    chip.position.set(x + dx, y0 + h + sy * 0.3, z + dz)
    chip.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI)
    root.add(chip)
  }

  // 底部散落碎石：用不规则多面体替代方块，更自然
  for (let i = 0; i < 36; i++) {
    const a = rng() * Math.PI * 2
    const r = 6.2 + rng() * 4.8
    const s = 0.3 + rng() * 0.8
    const rock = new Mesh(new IcosahedronGeometry(s * 0.55, 0), mat(palette[Math.floor(rng() * palette.length)], ramp))
    rock.scale.set(1.0 + rng() * 0.5, 0.55 + rng() * 0.4, 0.8 + rng() * 0.5)
    rock.position.set(x + Math.sin(a) * r, y0 + s * 0.25, z + Math.cos(a) * r)
    rock.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI)
    root.add(rock)
  }

  addSilhouetteOutline(root, { thickness: 0.5, skipSmall: 0.3 })
  // 与矿石同理：穹丘表面散布大量碎石（IcosahedronGeometry 凸多面体），Sobel 会把
  // 每块碎石的每个面都勾成墨线。挪到 NO_EDGE_LAYER 让 Sobel 跳过，只留单一外轮廓。
  setLayerRecursive(root, NO_SOBEL_LAYER)
  return root
}

/** 带风动波纹的三角旗，网格细分后沿 x（飘动方向）做正弦起伏。 */
function createWavyTriangleFlag(w: number, h: number, color: string, ramp: Texture, side: number): Mesh {
  const cols = 7
  const rows = 5
  const positions: number[] = []
  const indices: number[] = []
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      const t = i / cols
      const pyNorm = j / rows
      const halfW = (1 - t) * h * 0.5
      const px = t * w - w * 0.5
      const py = (pyNorm - 0.5) * 2 * halfW
      const wave = Math.sin(pyNorm * Math.PI * 3 + t * Math.PI * 2.5) * 0.12 * t
      const pz = side * 0.03 + wave
      positions.push(px, py, pz)
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i
      const b = a + 1
      const c = a + (cols + 1)
      const d = c + 1
      if (side > 0) {
        indices.push(a, c, b, b, c, d)
      } else {
        indices.push(a, b, c, b, d, c)
      }
    }
  }
  const geo = new BufferGeometry()
  geo.setAttribute('position', new Float32BufferAttribute(new Float32Array(positions), 3))
  geo.setIndex(indices)
  geo.computeVertexNormals()
  return new Mesh(geo, mat(color, ramp, 0.55))
}

/** 任务点 C：软沙警示区。
 * 柔和流动的沙丘 + 3 面红色三角旗 + 黄黑 chevron 警示牌 + 半埋轮子。
 */
export function createSoftSandMarker(x: number, z: number, field: HeightField, ramp: Texture): Group {
  const root = new Group()
  root.name = 'SoftSandMarker'
  const y0 = field.heightAt(x, z)
  const rng = makeRng(3321)

  // 主沙丘：平滑馒头形，带几道柔和风蚀波纹（更暖的沙色，加宽降高更流动）
  const mainDune = createSmoothDune(24, 12, 4.2, '#e0a050', ramp, rng)
  mainDune.position.set(x, y0 + 0.2, z)
  mainDune.rotation.y = 0.25
  root.add(mainDune)

  // 次沙丘（丰富轮廓）
  const dune2 = createSmoothDune(15, 8, 2.8, '#cf8a50', ramp, rng)
  dune2.position.set(x - 8, y0 - 0.1, z + 6)
  dune2.rotation.y = -0.6
  root.add(dune2)

  const dune3 = createSmoothDune(11, 6, 1.9, '#e8b060', ramp, rng)
  dune3.position.set(x + 7, y0, z - 5)
  dune3.rotation.y = 1.0
  root.add(dune3)

  // 三角旗：中间最高，两侧略矮，旗面更大并朝前（+z）。
  // 全部前置到沙丘前坡（z+4.5~5.0）并加高，确保正视图能同时看到三面旗。
  const poleConfigs = [
    { px: x + 0.5, pz: z + 5.0, h: 7.0 },
    { px: x - 2.5, pz: z + 4.6, h: 5.8 },
    { px: x + 3.0, pz: z + 4.6, h: 5.2 },
  ]
  for (const cfg of poleConfigs) {
    const { px, pz, h } = cfg
    const pole = cyl(0.12, 0.12, h, '#d9382e', ramp, 10)
    pole.position.set(px, y0 + h / 2 + 0.3, pz)
    root.add(pole)

    const flagColor = '#ff4a3d'
    const flagW = 2.4
    const flagH = 1.6
    // 双面波纹三角旗
    for (const side of [1, -1]) {
      const flag = createWavyTriangleFlag(flagW, flagH, flagColor, ramp, side)
      flag.position.set(px + 0.10, y0 + h - 0.7, pz)
      root.add(flag)
    }
  }

  // 黄色警示牌：立在沙丘前侧，正对 +z
  const signX = x + 0.5
  const signZ = z + 8.5
  const signY = y0 + 3.8
  const signPost = box(0.22, 3.2, 0.16, '#5a5a62', ramp)
  signPost.position.set(signX, signY - 1.4, signZ)
  signPost.rotation.x = -0.08
  root.add(signPost)

  const boardW = 2.6
  const boardH = 1.8
  const boardD = 0.12
  const signBoard = box(boardW, boardH, boardD, '#f2c248', ramp)
  signBoard.position.set(signX, signY, signZ)
  signBoard.rotation.x = -0.08
  signBoard.material = mat('#f2c248', ramp, 0.35)
  root.add(signBoard)

  // 黑边
  for (const [ox, oy, ww, hh, dd] of [
    [0, boardH / 2 + 0.04, boardW + 0.16, 0.1, boardD + 0.04],
    [0, -boardH / 2 - 0.04, boardW + 0.16, 0.1, boardD + 0.04],
    [-boardW / 2 - 0.04, 0, 0.1, boardH + 0.16, boardD + 0.04],
    [boardW / 2 + 0.04, 0, 0.1, boardH + 0.16, boardD + 0.04],
  ] as const) {
    const fb = box(ww, hh, dd, '#1a1a1e', ramp)
    fb.position.set(signX + ox, signY + oy, signZ + 0.02)
    fb.rotation.x = -0.08
    root.add(fb)
  }

  // 黑色双 chevron >>（四段粗斜条组成两道 V 形）
  for (let i = 0; i < 2; i++) {
    const cx = signX - 0.45 + i * 0.65
    const cy = signY
    const cz = signZ + boardD / 2 + 0.08
    const upper = box(0.22, 0.75, 0.10, '#1a1a1e', ramp)
    upper.position.set(cx, cy + 0.28, cz)
    upper.rotation.z = 0.75
    root.add(upper)
    const lower = box(0.22, 0.75, 0.10, '#1a1a1e', ramp)
    lower.position.set(cx, cy - 0.28, cz)
    lower.rotation.z = -0.75
    root.add(lower)
  }

  // 半埋的废弃轮子：位于沙丘前下方、警示牌左侧，确保正视图可见
  const wheelGroup = new Group()
  const wheelR = 1.45
  const wheelRim = cyl(wheelR, wheelR, 0.55, '#2f2f36', ramp, 22)
  wheelRim.rotation.x = Math.PI / 2
  wheelGroup.add(wheelRim)
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2
    const tread = cyl(0.16, 0.16, 0.64, '#1a1a1e', ramp, 6)
    tread.position.set(Math.cos(a) * wheelR, Math.sin(a) * wheelR, 0)
    tread.rotation.x = Math.PI / 2
    tread.rotation.z = a
    wheelGroup.add(tread)
  }
  const hub = cyl(0.58, 0.58, 0.6, '#9a9aa4', ramp, 16)
  hub.rotation.x = Math.PI / 2
  wheelGroup.add(hub)
  // 埋入沙丘约 1/2，倾斜并前置到左侧，避免被警示牌遮挡
  const wheelX = x - 4.2
  const wheelZ = z + 6.8
  wheelGroup.position.set(wheelX, y0 + 0.18, wheelZ)
  wheelGroup.rotation.set(0.18, 0.45, 0.30)
  root.add(wheelGroup)

  // 轮子周围柔和沙丘过渡（覆盖硬切）
  for (let i = 0; i < 3; i++) {
    const cover = sphere(1.6 + i * 0.35, '#dca877', ramp, 16, 12)
    cover.scale.set(1.0, 0.22, 1.0)
    cover.position.set(wheelX + (rng() - 0.5) * 0.6, y0 + 0.05, wheelZ + (rng() - 0.5) * 0.6)
    root.add(cover)
  }

  addSilhouetteOutline(root, { thickness: 0.5, skipSmall: 0.3 })
  // 与矿石同理：松软沙地标记由多圈同心圆盘（sphere 压扁）叠成，Sobel 会把每圈的
  // 边界都勾成墨线，视觉上像密集的同心线。挪到 NO_EDGE_LAYER 让 Sobel 跳过。
  setLayerRecursive(root, NO_SOBEL_LAYER)
  return root
}

/** 平滑沙丘：基于 BoxGeometry 但做强烈边缘内收 + 风蚀波纹，使轮廓柔和有机。 */
function createSmoothDune(length: number, width: number, height: number, color: string, ramp: Texture, rng: () => number): Mesh {
  const segX = 56
  const segZ = 56
  const geo = new BoxGeometry(length, height, width, segX, 16, segZ)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i++) {
    let px = pos.getX(i)
    let pz = pos.getZ(i)
    const py = pos.getY(i)
    // 归一化坐标 [-1,1]
    const nx0 = px / (length * 0.5)
    const nz0 = pz / (width * 0.5)
    // 椭圆距离，带不对称（迎风/背风）
    const nx = nx0
    const nz = nz0 * 0.7
    const d = Math.hypot(nx, nz)
    // 边缘内收：越靠边 x/z 越往中心收，消除方块硬边
    const edgePow = 3.2
    const shrink = Math.max(0, Math.cos(d * Math.PI * 0.5)) ** edgePow
    px *= 0.25 + 0.75 * shrink
    pz *= 0.25 + 0.75 * shrink
    // 高度衰减：中心高、边缘低，cos^3.0 让肩部更圆润、流动
    let lift = Math.max(0, Math.cos(d * Math.PI * 0.5)) ** 3.0 * height
    // 底部也随中心轻微抬起，消除平底硬切
    const baseLift = Math.max(0, Math.cos(d * Math.PI * 0.5)) ** 1.8 * height * 0.28
    // 迎风/背风不对称：一侧更缓、一侧更陡（自然沙丘）
    if (nx0 > 0) lift *= 1.0 - nx0 * 0.28
    // 风蚀波纹：多道正弦叠加，沿沙丘表面流动（幅度收敛，避免块状）
    const ripple = (
      Math.sin((px / length) * Math.PI * 6 + nz0 * 2.5) * 0.08 +
      Math.sin((pz / width) * Math.PI * 5 + nx0 * 2.0) * 0.05 +
      Math.sin((px / length) * Math.PI * 11 + (pz / width) * Math.PI * 4) * 0.025
    ) * Math.max(0, 1 - d)
    // 圆润 crest（仅极顶部轻微压平）
    if (lift > height * 0.9) lift = height * 0.9 + (lift - height * 0.9) * 0.4
    pos.setX(i, px)
    pos.setZ(i, pz)
    pos.setY(i, py + lift + baseLift + ripple)
  }
  geo.computeVertexNormals()
  const m = new Mesh(geo, mat(color, ramp))
  m.castShadow = false
  m.receiveShadow = false
  return m
}

/** 盆地外围台地：遮挡远处地形硬边。 */
export function createBasinMesa(field: HeightField): Mesh {
  const outerRadius = 1100
  const segments = 64
  const innerY = field.heightAt(HALF, 0)
  const outerY = innerY - 120

  const positions: number[] = []
  const indices: number[] = []

  for (let i = 0; i <= segments; i += 1) {
    const theta = (i / segments) * Math.PI * 2
    const cos = Math.cos(theta)
    const sin = Math.sin(theta)
    positions.push(HALF * cos, innerY, HALF * sin)
    positions.push(outerRadius * cos, outerY, outerRadius * sin)
  }

  for (let i = 0; i < segments; i += 1) {
    const a = i * 2
    const b = a + 1
    const c = a + 2
    const d = a + 3
    indices.push(a, c, b, b, c, d)
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()

  const [lr, lg, lb] = hexToLinearRgb(PALETTE.sandFlat)
  const [hr, hg, hb] = hexToLinearRgb(PALETTE.hazeColor)

  const material = new ShaderMaterial({
    side: DoubleSide,
    depthWrite: true,
    // 标记为「赛璐珞受光材质」：`applySunDirection()` 凭此标记统一改写 uSunDir，
    // 无需给本函数逐层透传 worldIndex 参数。
    userData: { celSun: true },
    uniforms: {
      uInnerColor: { value: new Color(lr, lg, lb) },
      uOuterColor: { value: new Color(hr, hg, hb) },
      uSunDir: { value: new Vector3(SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z).normalize() },
      uFogRange: { value: new Vector2(400, 900) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main() {
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uInnerColor;
      uniform vec3 uOuterColor;
      uniform vec3 uSunDir;
      uniform vec2 uFogRange;
      varying vec3 vWorld;
      varying vec3 vNormal;
      void main() {
        float dist = length(vWorld.xz);
        float t = smoothstep(${HALF.toFixed(1)}, ${(HALF + 180).toFixed(1)}, dist);
        vec3 color = mix(uInnerColor, uOuterColor, t);
        float ndl = dot(normalize(vNormal), normalize(uSunDir));
        float shade = ndl > 0.0 ? 1.0 : 0.62;
        color *= shade;
        float fog = smoothstep(uFogRange.x, uFogRange.y, dist);
        color = mix(color, uOuterColor, fog * 0.9);
        gl_FragColor = vec4(color, 1.0);
        #include <colorspace_fragment>
      }
    `,
  })

  const mesh = new Mesh(geometry, material)
  mesh.name = 'BasinMesa'
  mesh.frustumCulled = false
  mesh.renderOrder = -5
  return mesh
}

/** 能源站资源矿石：任务终点散落的发光能量晶体簇，强化"这里是能源采集目的地"。纯装饰。 */
// ============================================================================
// 火星二号专属样本站（设计文档 §3.2）
//
// 一号（陨石坑盆地）的三个站点是三角洲岩塔 / 含水硫酸盐穹丘 / 软沙警示区，
// 放到外流河道环境里全部不成立（湖泊与风成沙丘地貌）。二号改为此处三个新站，
// 坐标由 `field.landmarks`（OUTFLOW_LANDMARKS）提供，不再硬编码。
// ============================================================================

/**
 * 样本站 A · 洪水搬运巨砾（设计 §3.2）
 *
 * 11 × 8.5 × 9 m 磨圆巨石，埋深 2 m；3 条水平风蚀槽；背风侧 6 m 沙尾。
 * 教学点："这么大的石头，风搬不动，只有洪水能搬。"
 */
export function createFloodBoulder(x: number, z: number, field: HeightField, ramp: Texture): Group {
  const root = new Group()
  root.name = 'FloodBoulder'
  const y0 = field.heightAt(x, z)
  // 站点坐标由 group 承载，子 mesh 一律用**局部**坐标（P-2 规范化）
  root.position.set(x, y0, z)
  const rng = makeRng(4471)

  // 主体：球体顶点位移成磨圆不规则巨石（低频磨圆 + 中频碰撞棱角 + 高频粗糙）
  const geo = new SphereGeometry(1, 40, 28)
  const pos = geo.attributes.position
  for (let i = 0; i < pos.count; i += 1) {
    const vx = pos.getX(i)
    const vy = pos.getY(i)
    const vz = pos.getZ(i)
    const ang = Math.atan2(vx, vz)
    // A-1：低频大起伏加大到 0.18 + 加相位偏移 1.3（打破对称），中频瘤状 0.12，
    // 高频粗糙 0.04。让"磨圆不规则巨石"真的不规则——之前 0.10+0.07 看起来太对称。
    const low = Math.sin(ang * 2.2 + vy * 3.0 + 1.3) * 0.18
    const mid = Math.sin(ang * 5.0 - vy * 4.0 + 0.7) * Math.cos(vy * 2.0) * 0.12
    const micro = (rng() - 0.5) * 0.04
    const k = 1 + low + mid + micro
    pos.setX(i, vx * k * 5.5) // 11 m 宽
    pos.setY(i, vy * k * 4.25) // 8.5 m 高
    pos.setZ(i, vz * k * 4.5) //  9 m 长
  }
  geo.computeVertexNormals()

  // A-6：把 rockOutcrop #7a3a26 提到 #a86040（+30% 亮度、+15% 饱和度），
  // 暖橙天空（skyPaletteFor(1) 的地平线色）背景下不再糊成黑块。
  // 这是 createFloodBoulder 专属（createDeltaSpire 不调本函数、一号不调），
  // 不需要按世界分叉。
  const rock = new Mesh(geo, mat('#a86040', ramp))
  rock.position.set(0, 4.25 - 2, 0) // 埋深 2 m
  root.add(rock)

  // 3 条水平风蚀槽：深色细环，沿巨石腰部等距分布
  for (let i = 0; i < 3; i += 1) {
    const ny = -0.25 + i * 0.28
    // A-3：凹槽半径 5.5 → 4.5（岩体基础半径 5.5，凹槽收 1.0 嵌入），
    // 之前 +0.15 是贴在表面外，相机看不到任何明暗变化。
    const rr = 5.5 * Math.sqrt(Math.max(0.05, 1 - ny * ny)) - 0.5
    const groove = new Mesh(new TorusGeometry(rr, 0.13, 6, 40), mat(PALETTE.strataDark, ramp))
    groove.rotation.x = Math.PI / 2
    groove.position.set(0, 2.25 + ny * 4.25, 0)
    groove.userData.outline = false // 内部细节不参与外轮廓描边
    root.add(groove)
  }

  // 背风侧 6 m 沙尾：迎流端钝圆、背流端拉长尖缓
  const tail = createSmoothDune(6, 4.6, 1.5, PALETTE.duneCrest, ramp, rng)
  tail.position.set(0, -0.1, -6.5)
  tail.rotation.y = Math.PI
  root.add(tail)

  return root
}

/**
 * 样本站 B · 河道层理剖面（设计 §3.2）
 *
 * 20 × 14 m 崖壁剖面，外凸 2–3 m；6 层水平层理，底 3 m 粗砾层；前方 5 m 崩落碎石堆。
 * 教学点："一层一层是不同时期的洪水留下的，最底层最粗。"
 */
/**
 * 样本站 B · 河道层理剖面（设计 §3.2）
 *
 * 2026-09-10 老大反馈第 7 条：原实现把它做成"一个独立的红砖"立在地面——
 * 但剖面的语义应该是"**整段河床表面露出的地层**"，不是孤立建筑。
 *
 * **新设计**：不再做独立大块，改为沿 `spine`（河道脊柱，可选）**每隔 ~50 m 撒一段
 * 小层理断面**（10 × 4 m / 段），让河床沿线"到处都有层理"，符合"整段河床表面"的语义。
 *
 * 一号不传 spine → 退化为单点（位置在 (x, z)），原零回归行为不变。
 */
export function createChannelSection(
  x: number,
  z: number,
  field: HeightField,
  ramp: Texture,
  /** 河道脊柱点列表（如 CHANNEL_SPINE）。传了就沿脊柱撒断面；不传就单点。 */
  spine?: Array<[number, number]>,
): Group {
  const root = new Group()
  root.name = 'ChannelSection'
  const y0 = field.heightAt(x, z)
  // 站点坐标由 group 承载，子 mesh 一律用**局部**坐标（P-2 规范化）
  root.position.set(x, y0, z)
  const rng = makeRng(5187)

  // 【主程序 QA 2026-09-12】（旧的 const W = 20 / H = 14 是"单点大剖面"用的，
  // 那段已改为沿脊柱撒断面，两个常量无人引用，删除避免与下面的 W 重名）

  // 沿脊柱撒断面（每段 10 × 6 层）。`spine` 缺省退化为单点（一号零回归）。
  const placements: Array<[number, number]> =
    spine && spine.length >= 2 ? spine : [[x, z]]
  // 【主程序 QA 2026-09-12】沿脊柱撒断面 = 21 点 × 6 层 = **126 个独立 Mesh**，
  // 126 个 draw call 只为一个样本站，直接威胁 AGENTS.md 的 60fps 底线。
  // 改为**按颜色分组合并几何**：6 层只有 3 种颜色，合并后最多 3 个 Mesh。
  // 变换（位置/旋转）必须**烘焙进几何**（translate/rotateY），否则合并后位置全丢。
  const byColor = new Map<string, BufferGeometry[]>()
  const W = 10 // 单段剖面宽（覆盖上面同名的 W=20，它是旧单点剖面用的）
  const LAYERS = [
    { yBase: -1, h: 1.5, color: PALETTE.strataLight }, // 粗砾层
    { yBase: 0.5, h: 1, color: PALETTE.strataMid },
    { yBase: 1.5, h: 1, color: PALETTE.strataDark },
    { yBase: 2.5, h: 1, color: PALETTE.strataMid },
    { yBase: 3.5, h: 1, color: PALETTE.strataDark },
    { yBase: 4.5, h: 0.5, color: PALETTE.strataMid },
  ]
  for (const [px, pz] of placements) {
    const pY0 = field.heightAt(px, pz)
    for (const L of LAYERS) {
      const g = new BoxGeometry(W, L.h, 1)
      g.rotateY(-0.26) // 剖面与崖壁成 75°
      g.translate(px, pY0 + L.yBase + L.h / 2, pz)
      const key = L.color
      const arr = byColor.get(key)
      if (arr) arr.push(g)
      else byColor.set(key, [g])
    }
  }
  for (const [color, geos] of byColor) {
    const merged = mergeGeometries(geos)
    if (!merged) continue
    const m = new Mesh(merged, mat(color, ramp))
    m.userData.outline = false // 内部细节不要描边
    root.add(m)
    for (const g of geos) g.dispose() // 合并后源几何可释放
  }

  return root
}

/**
 * 样本站 C · 浅层水冰探测点（设计 §3.2）
 *
 * 直径 30 m 圆形区域；冰楔多边形地面；中心挖掘坑（深 1.5 m）；4 根青色标记杆（高 2 m）。
 * 教学点："地下有水冰是真的（Phoenix 2008 挖到过），但埋在土里，不是河里的水。"
 */
export function createIceProbe(x: number, z: number, field: HeightField, ramp: Texture): Group {
  const root = new Group()
  root.name = 'IceProbe'
  const y0 = field.heightAt(x, z)
  // 站点坐标由 group 承载，子 mesh 一律用**局部**坐标（P-2 规范化）
  root.position.set(x, y0, z)
  const rng = makeRng(6607)
  const R = 15 // 直径 30 m

  // 冰楔多边形地面：贴地圆盘 + 冷灰褐冰土色
  const ground = new Mesh(new CircleGeometry(R, 48), mat(PALETTE.iceGround, ramp))
  ground.rotation.x = -Math.PI / 2
  ground.position.set(0, 0.06, 0)
  ground.receiveShadow = true
  root.add(ground)

  // 冰楔裂缝：多边形网格（同心 + 放射，模拟冰楔多边形）
  for (let ring = 1; ring <= 2; ring += 1) {
    const rr = (R / 2.4) * ring
    const seg = 6 + ring * 3
    for (let i = 0; i < seg; i += 1) {
      const a0 = (i / seg) * Math.PI * 2
      const a1 = ((i + 1) / seg) * Math.PI * 2
      const len = Math.hypot(
        Math.cos(a1) * rr - Math.cos(a0) * rr,
        Math.sin(a1) * rr - Math.sin(a0) * rr,
      )
      const crack = new Mesh(new BoxGeometry(len * 0.92, 0.04, 0.3), mat(PALETTE.iceCrack, ramp))
      crack.position.set(
        ((Math.cos(a0) + Math.cos(a1)) / 2) * rr,
        0.1,
        ((Math.sin(a0) + Math.sin(a1)) / 2) * rr,
      )
      crack.rotation.y = -Math.atan2(
        Math.sin(a1) * rr - Math.sin(a0) * rr,
        Math.cos(a1) * rr - Math.cos(a0) * rr,
      )
      crack.userData.outline = false
      root.add(crack)
    }
  }
  for (let i = 0; i < 6; i += 1) {
    const a = (i / 6) * Math.PI * 2 + 0.3
    const spoke = new Mesh(new BoxGeometry(R * 0.9, 0.04, 0.3), mat(PALETTE.iceCrack, ramp))
    spoke.position.set((Math.cos(a) * R) / 2.2, 0.1, (Math.sin(a) * R) / 2.2)
    spoke.rotation.y = -a
    spoke.userData.outline = false
    root.add(spoke)
  }

  // 中心挖掘坑：深 1.5 m，新鲜断面用最亮的 iceExcavated
  // A-5：把坑整体上移 0.15 m，让顶圈露在地面（y0+0.06）之上，
  // 否则被圆形地面的 z-order 完全遮住、看上去根本不存在。
  const pit = new Mesh(
    new CylinderGeometry(2.6, 2.1, 1.5, 20, 1, true),
    mat(PALETTE.iceExcavated, ramp),
  )
  pit.position.set(0, -0.45, 0) // 原 -0.6；上移 0.15 → 顶 y=+0.30（地面 +0.06 之上 0.24m）
  pit.userData.outline = false
  root.add(pit)
  const pitFloor = new Mesh(new CircleGeometry(2.1, 20), mat(PALETTE.iceExcavated, ramp))
  pitFloor.rotation.x = -Math.PI / 2
  pitFloor.position.set(0, -1.17, 0) // 同步上移
  pitFloor.userData.outline = false
  root.add(pitFloor)

  // 4 根青色标记杆（高 2 m），围在坑边
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4
    const pole = new Mesh(new CylinderGeometry(0.09, 0.09, 2, 8), mat('#4fd0c8', ramp))
    pole.position.set(Math.cos(a) * 3.4, 1, Math.sin(a) * 3.4)
    pole.userData.outline = false // A-4：细杆（半径 0.09m）不能加 cel 描边，否则描边比杆还粗
    root.add(pole)
    const tip = new Mesh(new SphereGeometry(0.22, 10, 8), mat('#8ff0e6', ramp))
    tip.position.set(Math.cos(a) * 3.4, 2.05, Math.sin(a) * 3.4)
    tip.userData.outline = false // A-4：顶端小球同理
    root.add(tip)
  }

  return root
}



/**
 * 火星二号专属：主基地周围撒 50 块有几何细节的岩石（2026-09-10 老大反馈"主基地
 * 周围岩石品质较低"——原只有程序化 heightfield 的 rock 顶点色，无几何细节）。
 *
 * 用 IcosahedronGeometry + 多频噪声位移做出有棱角/风化的真实观感，避开基地
 * 4 个 base-* POI 位置 ±5 m 的点击区。
 */
export function createBaseRocks(field: HeightField, ramp: Texture): Group {
  const root = new Group()
  root.name = 'BaseRocks'
  const cx = field.start.x
  const cz = field.start.z
  const rng = makeRng(7923)
  // 基地 4 个 POI 位置（任务流程点，**不能被岩石挡**）
  const basePos = [
    { x: cx - 18, z: cz + 12 },
    { x: cx + 12, z: cz + 18 },
    { x: cx - 8, z: cz - 16 },
    { x: cx + 16, z: cz - 10 },
  ]
  const farFromBase = (x: number, z: number) =>
    basePos.every((b) => Math.hypot(x - b.x, z - b.z) > 6)

  const byColor = new Map<string, BufferGeometry[]>()
  for (let i = 0; i < 50; i += 1) {
    // 在着陆平台外 10–45 m 环形
    const ang = rng() * Math.PI * 2
    const dist = 10 + rng() * 35
    const x = cx + Math.cos(ang) * dist
    const z = cz + Math.sin(ang) * dist
    if (!farFromBase(x, z)) continue

    const y0 = field.heightAt(x, z)
    // 70% 普通、30% 大块，模拟风化差异
    const s = (rng() < 0.7 ? 0.4 : 1.0) + rng() * 0.6

    // 【主程序 QA 2026-09-12】原来每块石头一个 Mesh（50 个 draw call），
    // 改为按颜色合并成 2 个（rockOutcrop / gravel），变换烘焙进几何。
    const color = rng() < 0.9 ? PALETTE.rockOutcrop : PALETTE.gravel
    const g = new IcosahedronGeometry(s, 1)
    const pos = g.attributes.position
    for (let v = 0; v < pos.count; v += 1) {
      const vx = pos.getX(v)
      const vy = pos.getY(v)
      const vz = pos.getZ(v)
      const n = (Math.sin(vx * 4 + vy * 3) + Math.cos(vy * 5 + vz * 4)) * 0.12
      const k = 1 + n
      pos.setX(v, vx * k)
      pos.setY(v, vy * k)
      pos.setZ(v, vz * k)
    }
    g.computeVertexNormals()
    g.rotateX(rng() * Math.PI)
    g.rotateY(rng() * Math.PI)
    g.rotateZ(rng() * Math.PI)
    g.translate(x, y0 + s * 0.4, z)
    const arr = byColor.get(color)
    if (arr) arr.push(g)
    else byColor.set(color, [g])
  }
  for (const [color, geos] of byColor) {
    const merged = mergeGeometries(geos)
    if (!merged) continue
    const m = new Mesh(merged, mat(color, ramp))
    m.userData.outline = false // 细石描边会变脏线
    root.add(m)
    for (const g of geos) g.dispose()
  }
  return root
}

export function createEnergyOres(field: HeightField, ramp: Texture): Group {
  const root = new Group()
  root.name = 'EnergyOres'
  const gx = field.goal.x
  const gz = field.goal.z
  const rng = makeRng(4242)

  const crystalColors = [PALETTE.accentCyan, '#7fe9ff', '#bafcff']
  const makeCrystal = (size: number, color: string) => {
    const geo = new IcosahedronGeometry(size, 0)
    const m = new Mesh(geo, mat(color, ramp, 0.7))
    // 拉长成晶柱，带轻微随机倾斜，避免像规整宝石
    m.scale.set(0.7, 1.6 + rng() * 0.8, 0.7)
    return m
  }
  const makeRock = (s: number) => {
    const r = new Mesh(new IcosahedronGeometry(s, 0), mat(PALETTE.rockDark, ramp))
    r.scale.set(1, 0.6, 1)
    return r
  }

  // 3 种真实火星能源矿石（玄武岩/赤铁矿/橄榄石），按比例混合。
  // 玄武岩（basalt）：灰色，最常见，火星地表主要岩石
  // 赤铁矿（hematite）：红棕色，含铁，氧化铁染红火星表面
  // 橄榄石（olivine）：绿色，火星陨石中常见硅酸盐
  type OreType = 'basalt' | 'hematite' | 'olivine'
  const ORE_TYPES: { kind: OreType; color: string; size: [number, number]; count: number }[] = [
    { kind: 'basalt',   color: '#5a5048', size: [0.45, 1.10], count: 68 },
    { kind: 'hematite', color: '#8a3a1a', size: [0.40, 0.90], count: 56 },
    { kind: 'olivine',  color: '#5a6a3a', size: [0.35, 0.80], count: 46 },
  ]
  // 不规则矿脉区域：拉长椭圆（长轴 56m / 短轴 30m、旋转 0.7 rad）+ 角度噪声扰动边界，
  // 让矿石带呈天然矿脉的不规则轮廓，而不是规整圆环。
  const LODE_A = 56
  const LODE_B = 30
  const LODE_ROT = 0.7
  const LODE_INNER = 5 // 中心留空，给采集车停靠
  const lodeRadius = (a: number): number => {
    const ca = Math.cos(a - LODE_ROT)
    const sa = Math.sin(a - LODE_ROT)
    const r = 1 / Math.sqrt((ca / LODE_A) ** 2 + (sa / LODE_B) ** 2)
    // 多频噪声叠加扰动边界，形成凹凸不规则的矿脉轮廓
    const noise = 0.74 + 0.26 * Math.sin(a * 3.1 + 1.2) * Math.cos(a * 1.7) + 0.1 * Math.sin(a * 5.3)
    return r * noise
  }

  /** 一个矿簇 = 主石（大小/高矮随机）+ 1~2 块附石 + 底部基岩，堆叠出真实矿石堆的层次感。 */
  const placeCluster = (x: number, z: number, t: typeof ORE_TYPES[number]) => {
    const y = field.heightAt(x, z)
    const size = t.size[0] + rng() * (t.size[1] - t.size[0])
    // 主石：高矮不一（sy 0.5~1.6）、横宽不一，破除非等比缩放的"规整宝石"感
    const sy = 0.5 + rng() * 1.1
    const main = new Mesh(new IcosahedronGeometry(size, 0), mat(t.color, ramp, 0.15))
    main.scale.set(0.8 + rng() * 0.6, sy, 0.8 + rng() * 0.6)
    main.position.set(x, y + size * sy * 0.45, z)
    main.rotation.set(rng() * 0.35, rng() * Math.PI * 2, rng() * 0.35)
    root.add(main)
    // 附石 1~2 块：更小、贴着主石散布
    const extra = 1 + Math.floor(rng() * 2)
    for (let e = 0; e < extra; e++) {
      const es = size * (0.35 + rng() * 0.35)
      const ea = rng() * Math.PI * 2
      const ed = size * (0.6 + rng() * 0.6)
      const rock = new Mesh(new IcosahedronGeometry(es, 0), mat(t.color, ramp, 0.12))
      rock.scale.set(0.9 + rng() * 0.5, 0.4 + rng() * 0.7, 0.9 + rng() * 0.5)
      rock.position.set(x + Math.cos(ea) * ed, y + es * 0.35, z + Math.sin(ea) * ed)
      rock.rotation.set(rng() * 0.4, rng() * Math.PI * 2, rng() * 0.4)
      root.add(rock)
    }
    // 底部基岩（更暗的承托岩盘）
    const base = new Mesh(new IcosahedronGeometry(size * 0.85, 0), mat(PALETTE.rockDark, ramp))
    base.scale.set(1.2, 0.32, 1.2)
    base.position.set(x, y + size * 0.05, z)
    base.rotation.set(0, rng() * Math.PI * 2, 0)
    root.add(base)
  }

  // 沿不规则矿脉区域密集撒矿（约 170 个矿簇 / 400+ 块石头）
  for (const t of ORE_TYPES) {
    for (let i = 0; i < t.count; i++) {
      const a = rng() * Math.PI * 2
      const rMax = lodeRadius(a)
      const r = LODE_INNER + rng() * Math.max(0.1, rMax - LODE_INNER)
      const x = gx + Math.cos(a) * r
      const z = gz + Math.sin(a) * r
      placeCluster(x, z, t)
    }
  }

  // 把整个矿石 group 挪到 NO_EDGE_LAYER，让后处理 Sobel 跳过它们。
  // 原因：IcosahedronGeometry 是 20 面凸多面体，相邻面法线差很大；Sobel 屏幕空间边缘
  // 检测会把每个面都识别成"边缘"勾出墨线，视觉上像矿石表面被网格化。把矿石放到 layer 1
  // 后主渲染仍正常（相机看所有 layer），但 Sobel pass（只读 layer 0）完全跳过，矿石表面干净。
  // 矿石和地面的接触缝也不会画线——本来 cel-shading 的明暗对比 + 接触阴影已经够区分。
  setLayerRecursive(root, NO_SOBEL_LAYER)
  return root
}

/**
 * 隐藏采集点的矿石簇（火星二号专属）：未知区域路径的终点（HIDDEN_SAMPLE）。
 *
 * 2026-09-12 老大反馈：c 路线终点处没有矿石，采集车到了"无矿可采"。
 * 按能源站矿石的三色配方（玄武岩/赤铁矿/橄榄石）缩小规模撒一簇（约 42 块），
 * **刻意不放信标与标签**——"隐藏采集点"的教学语义就是：路线最短、看起来诱人，
 * 但 UI 上不告诉你这里有什么，只有真开过去才知道。
 */
export function createHiddenOres(field: HeightField, ramp: Texture): Group {
  const root = new Group()
  root.name = 'HiddenOres'
  const rng = makeRng(9311)
  const ORE = [
    { color: '#5a5048', size: [0.45, 1.0], count: 18 },
    { color: '#8a3a1a', size: [0.4, 0.85], count: 14 },
    { color: '#5a6a3a', size: [0.35, 0.75], count: 10 },
  ]
  for (const t of ORE) {
    for (let i = 0; i < t.count; i += 1) {
      const ang = rng() * Math.PI * 2
      const d = 4 + rng() * 16
      const x = HIDDEN_SAMPLE.x + Math.cos(ang) * d
      const z = HIDDEN_SAMPLE.z + Math.sin(ang) * d
      const size = t.size[0] + rng() * (t.size[1] - t.size[0])
      const m = new Mesh(new IcosahedronGeometry(size, 0), mat(t.color, ramp, 0.7))
      m.scale.set(0.8, 1.2 + rng() * 0.6, 0.8)
      m.position.set(x, field.heightAt(x, z) + size * 0.5, z)
      m.rotation.y = rng() * Math.PI
      m.userData.outline = false // 远景小物件，描边会成脏线
      root.add(m)
    }
  }
  return root
}

export type Landmarks = {
  group: Group
  setTime: (t: number) => void
  dispose: () => void
}

const MISSION_A = { x: -216, z: 236 }
const MISSION_B = { x: -152, z: -156 }
const MISSION_C = { x: 216, z: 92 }

/** 从 `field.landmarks` 按 id 取坐标；取不到时回退到一号硬编码坐标（不应发生）。 */
function outflowSample(
  field: HeightField,
  id: string,
  fallback: { x: number; z: number },
): { x: number; z: number } {
  const l = field.landmarks.find((m) => m.id === id)
  return l ? { x: l.x, z: l.z } : fallback
}

/**
 * @param worldIndex 0 = 火星一号（陨石坑盆地，三个旧站点），1 = 火星二号（外流河道，三个新站点）。
 *   **一号路径逐字节不变**：走同一批工厂函数、同一组硬编码坐标（MISSION_A/B/C）。
 */
export function createLandmarks(field: HeightField, worldIndex = 0): Landmarks {
  const ramp = createRampTexture()
  const group = new Group()
  group.name = 'Landmarks'

  const mesa = createBasinMesa(field)
  const pad = createLandingPad(field)
  const mainBase = createMainBase(field, ramp)

  // 二号（外流河道）换三个环境自洽的样本站；坐标从 field.landmarks 取（OUTFLOW_LANDMARKS）。
  // 一号继续用硬编码的 MISSION_A/B/C 与旧模型 —— 零回归护栏。
  const isOutflow = worldIndex === 1
  const aPos = isOutflow ? outflowSample(field, 'sample-a', MISSION_A) : MISSION_A
  const bPos = isOutflow ? outflowSample(field, 'sample-b', MISSION_B) : MISSION_B
  const cPos = isOutflow ? outflowSample(field, 'sample-c', MISSION_C) : MISSION_C

  const deltaSpire = isOutflow
    ? createFloodBoulder(aPos.x, aPos.z, field, ramp)
    : createDeltaSpire(aPos.x, aPos.z, field, ramp)
  const hydratedDome = isOutflow
    // 沿河道脊柱撒断面（第 7 条：剖面 = 整段河床表面，不是孤立建筑）。
    // 一号不传 → 退化为单点原行为（零回归）。
    ? createChannelSection(bPos.x, bPos.z, field, ramp, isOutflow ? CHANNEL_SPINE : undefined)
    : createHydratedDome(bPos.x, bPos.z, field, ramp)
  const softSandMarker = isOutflow
    ? createIceProbe(cPos.x, cPos.z, field, ramp)
    : createSoftSandMarker(cPos.x, cPos.z, field, ramp)
  const energyOres = createEnergyOres(field, ramp)
  // 隐藏采集点矿石簇：二号专属（c 路线终点，无 UI 标记）
  const hiddenOres = isOutflow ? createHiddenOres(field, ramp) : null
  // 主基地周围散落岩石：二号专属（老大 2026-09-10 反馈主基地周围岩石品质较低）
  // 一号视野开阔，不需要这个补强；不污染一号。
  const baseRocks = isOutflow ? createBaseRocks(field, ramp) : null

  group.add(mesa)
  group.add(pad)
  group.add(mainBase)
  group.add(deltaSpire)
  group.add(hydratedDome)
  group.add(softSandMarker)
  group.add(energyOres)
  if (baseRocks) group.add(baseRocks)
  if (hiddenOres) group.add(hiddenOres)

  const disposables: Array<{ dispose: () => void }> = []
  group.traverse((o) => {
    const mesh = o as Mesh
    if (mesh.geometry) disposables.push(mesh.geometry)
    if (mesh.material) {
      if (Array.isArray(mesh.material)) {
        disposables.push(...mesh.material)
      } else {
        disposables.push(mesh.material)
      }
    }
  })
  disposables.push(ramp)

  return {
    group,
    setTime: (t) => {
      const mat = pad.material as ShaderMaterial
      mat.uniforms.uTime.value = t
    },
    dispose: () => {
      for (const d of disposables) d.dispose()
    },
  }
}
