/**
 * R-7 火星漫游车：纯程序化建模（无外部 glTF）。
 *
 * 二次提质（2026-08-07）：对照 `docs/视觉基准图/三视图/R7-火星漫游车-三视图.png`
 * 显著提升细节密度与造型可信度：
 * - 加大车轮（R 0.5）+ 内凹辐条轮毂 + 加密人字胎纹
 * - 车身：楔形斜面鼻头 + 仪表甲板（设备缝 / 圆盖 / 数据线）+ 车尾 RTG 格栅
 * - 太阳能板：加厚折叠花瓣（18°~22° 上折）+ 蜂窝栅格 + 铰链缝 + 中心鼓包
 * - 桅杆相机：细立柱 + 白色球形头舱 + 单黑色圆形镜头（对齐三视图）
 * - 保留必要 greebles，避免遮挡主体轮廓
 * - 摇臂-转向架保留并加粗
 *
 * 所有部件统一套用 `createCelMaterial` 赛璐珞材质 + `addOutlines` 反向描边。
 * 运动学仍由 `core/simulation.ts` 驱动，`setPose` 只负责视觉呈现。
 */
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  SphereGeometry,
  TorusGeometry,
  type Texture,
} from 'three'
import { PALETTE } from './palette'
import { addSilhouetteOutline, createBlobShadow, createCelMaterial, noOutline, type CelSpecular } from './celMaterial'
import { localYawToward, worldToLocalDir } from './orientation'
import { setLayerRecursive, NO_EDGE_LAYER, NO_SOBEL_LAYER } from './postfx'

export type RoverPose = {
  x: number
  y: number
  z: number
  heading: number
  pitch: number
  roll: number
  wheelCompression: [number, number, number, number, number, number]
  wheelSpin: number
  arm: number
  lookAt?: { x: number; y: number; z: number }
  armAction?: 'idle' | 'scan' | 'stuck'
  battery?: number
}

const WHEEL_R = 0.5
const WHEEL_W = 0.34
// 顺序：0 前左 1 前右 2 中左 3 中右 4 后左 5 后右
const WHEEL_POS: [number, number, number][] = [
  [0.95, WHEEL_R, -1.02],
  [0.95, WHEEL_R, 1.02],
  [0.0, WHEEL_R, -1.08],
  [0.0, WHEEL_R, 1.08],
  [-0.95, WHEEL_R, -1.02],
  [-0.95, WHEEL_R, 1.02],
]

/** 金属部件的硬边高光（车顶甲板、桅杆、轮毂等）。 */
const METAL_SPEC: CelSpecular = { color: '#ffffff', strength: 0.4, shininess: 28 }
/** 悬挂金属（深一点，弱一点）。 */
const BOGIE_SPEC: CelSpecular = { color: '#ffffff', strength: 0.18, shininess: 20 }
/** 镜头玻璃的强高光（外观上的"亮点"）。 */
const GLASS_SPEC: CelSpecular = { color: '#ffffff', strength: 1.0, shininess: 64 }

function mat(hex: string, ramp: Texture, emissive = 0, specular?: CelSpecular) {
  return createCelMaterial(hex, ramp, { emissive, specular })
}

function box(w: number, h: number, d: number, hex: string, ramp: Texture, emissive = 0, specular?: CelSpecular): Mesh {
  const m = new Mesh(new BoxGeometry(w, h, d), mat(hex, ramp, emissive, specular))
  m.name = 'box'
  return m
}

function cyl(r: number, h: number, hex: string, ramp: Texture, seg = 20, emissive = 0, specular?: CelSpecular): Mesh {
  const m = new Mesh(new CylinderGeometry(r, r, h, seg), mat(hex, ramp, emissive, specular))
  m.name = 'cyl'
  return m
}

/** 沿 Box 四条竖边贴细条，营造"硬边高光/接缝"。 */
function edgeTrim(parent: Group, w: number, h: number, d: number, hex: string, ramp: Texture, thickness = 0.03) {
  const hh = h + thickness * 0.1
  const corners = [
    [w / 2, d / 2],
    [w / 2, -d / 2],
    [-w / 2, d / 2],
    [-w / 2, -d / 2],
  ]
  for (const [x, z] of corners) {
    const e = box(thickness, hh, thickness, hex, ramp)
    e.position.set(x, 0, z)
    parent.add(noOutline(e))
  }
}

/** 在 Box 顶面压深色面板线。 */
function panelLinesOnFace(parent: Group, w: number, d: number, hex: string, ramp: Texture, count = 2, dir: 'x' | 'z' = 'x') {
  const thick = 0.025
  for (let i = 1; i <= count; i++) {
    const t = (i / (count + 1)) - 0.5
    if (dir === 'x') {
      const line = box(w * 0.9, thick, thick, hex, ramp)
      line.position.set(0, 0, t * d)
      parent.add(noOutline(line))
    } else {
      const line = box(thick, thick, d * 0.9, hex, ramp)
      line.position.set(t * w, 0, 0)
      parent.add(noOutline(line))
    }
  }
}

/** 蜂窝栅格线（用于太阳能板表面）。 */
function honeycombGrid(parent: Group, w: number, l: number, hex: string, ramp: Texture, nx = 3, nz = 2) {
  for (let i = 1; i < nx; i++) {
    const line = box(0.02, 0.01, l * 0.92, hex, ramp)
    line.position.set((i / nx - 0.5) * w, 0.03, 0)
    parent.add(noOutline(line))
  }
  for (let j = 1; j < nz; j++) {
    const line = box(w * 0.92, 0.01, 0.02, hex, ramp)
    line.position.set(0, 0.03, (j / nz - 0.5) * l)
    parent.add(noOutline(line))
  }
}

/** 人字胎纹轮：轮胎 + 交错齿 + 内凹辐条轮毂 + 螺栓。 */
function createChevronWheel(ramp: Texture, side: number): Group {
  const g = new Group()
  g.name = 'wheel'

  // 主轮胎（不单独描边，靠轮缘和深色胎体表现轮廓）
  const tireGeo = new CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 30)
  tireGeo.rotateX(Math.PI / 2)
  const tire = new Mesh(tireGeo, mat(PALETTE.roverTire, ramp))
  tire.userData.outline = false
  g.add(tire)

  // Chevron 齿：20 个倾斜小盒绕外圈，左右镜像，加密加厚
  const toothCount = 24
  const toothW = 0.18
  const toothH = 0.16
  const toothD = 0.1
  for (let i = 0; i < toothCount; i++) {
    const a = (i / toothCount) * Math.PI * 2
    const dirs = i % 2 === 0 ? 1 : -1
    const tooth = box(toothW, toothH, toothD, PALETTE.roverDark, ramp)
    const rx = Math.cos(a) * (WHEEL_R + toothH * 0.5)
    const ry = Math.sin(a) * (WHEEL_R + toothH * 0.5)
    tooth.position.set(rx, ry, dirs * 0.05)
    tooth.rotation.z = a + (dirs * Math.PI / 5)
    g.add(noOutline(tooth))
  }

  // 内凹轮毂：外圈盘 + 6 辐条
  const hubOuter = new Mesh(
    new CylinderGeometry(WHEEL_R * 0.62, WHEEL_R * 0.62, WHEEL_W * 1.02, 18),
    mat(PALETTE.roverBogie, ramp),
  )
  hubOuter.rotation.x = Math.PI / 2
  hubOuter.position.z = side > 0 ? WHEEL_W * 0.5 : -WHEEL_W * 0.5
  g.add(noOutline(hubOuter))
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    const spoke = box(WHEEL_R * 0.54, 0.06, 0.1, PALETTE.roverMetal, ramp, 0, METAL_SPEC)
    spoke.position.set(Math.cos(a) * WHEEL_R * 0.3, Math.sin(a) * WHEEL_R * 0.3, side > 0 ? WHEEL_W * 0.56 : -WHEEL_W * 0.56)
    spoke.rotation.z = a
    g.add(noOutline(spoke))
  }
  // 中心盖
  const cap = new Mesh(new CylinderGeometry(WHEEL_R * 0.18, WHEEL_R * 0.18, WHEEL_W * 1.08, 12), mat(PALETTE.roverDark, ramp))
  cap.rotation.x = Math.PI / 2
  cap.position.z = side > 0 ? WHEEL_W * 0.56 : -WHEEL_W * 0.56
  g.add(noOutline(cap))

  // 橙缘环
  const rim = new Mesh(
    new CylinderGeometry(WHEEL_R * 1.02, WHEEL_R * 1.02, WHEEL_W * 1.04, 30, 1, true),
    mat(PALETTE.roverAccent, ramp),
  )
  rim.rotation.x = Math.PI / 2
  g.add(rim)

  return g
}

/** 关节球。 */
function hingeJoint(r: number, hex: string, ramp: Texture): Mesh {
  return new Mesh(new SphereGeometry(r, 14, 12), mat(hex, ramp))
}

export type Rover = {
  group: Group
  setPose: (p: RoverPose) => void
  setTime: (t: number) => void
  getWheelWorldPositions: (p: RoverPose) => Array<{ x: number; y: number; z: number }>
  dispose: () => void
}

export function createRover(ramp: Texture): Rover {
  const root = new Group()
  root.name = 'R7Rover'

  // ========== 底盘 ==========
  const chassis = new Group()
  chassis.name = 'chassis'
  root.add(chassis)

  // 主车体（更低趴）
  const mainBody = box(2.0, 0.38, 1.9, PALETTE.roverBody, ramp)
  mainBody.position.set(-0.1, 0.72, 0)
  chassis.add(mainBody)

  // 前斜面鼻头（楔形）
  const nose = box(0.6, 0.30, 1.8, PALETTE.roverBody, ramp)
  nose.position.set(1.1, 0.60, 0)
  nose.rotation.z = -0.3
  chassis.add(nose)

  // 车尾 RTG 格栅舱
  const rtg = new Mesh(new CylinderGeometry(0.32, 0.32, 1.05, 16), mat(PALETTE.roverDark, ramp))
  rtg.rotation.z = Math.PI / 2
  rtg.position.set(-1.35, 0.82, 0)
  chassis.add(rtg)
  for (let i = 0; i < 9; i++) {
    const fin = new Mesh(new TorusGeometry(0.33, 0.015, 6, 18), mat(PALETTE.roverBogie, ramp))
    fin.rotation.y = Math.PI / 2
    fin.position.set(-1.35 - 0.45 + i * 0.11, 0.82, 0)
    chassis.add(noOutline(fin))
  }

  // 侧面加强筋（每侧 2 条竖筋）
  for (const side of [-1, 1]) {
    for (let i = 0; i < 2; i++) {
      const rib = box(1.2, 0.05, 0.05, PALETTE.roverDark, ramp)
      rib.position.set(-0.1, 0.72 + i * 0.18, side * 0.86)
      chassis.add(noOutline(rib))
    }
    // 散热缝
    for (let i = 0; i < 3; i++) {
      const vent = box(0.9, 0.06, 0.04, PALETTE.roverDark, ramp)
      vent.position.set(-0.05, 0.68 + (i - 1) * 0.12, side * 0.74)
      chassis.add(noOutline(vent))
    }
  }

  // 顶面仪表甲板
  const deck = box(1.6, 0.12, 1.6, PALETTE.roverMetal, ramp, 0, METAL_SPEC)
  deck.position.set(-0.1, 0.95, 0)
  chassis.add(deck)
  // 甲板设备缝
  panelLinesOnFace(chassis, 1.4, 1.3, PALETTE.roverDark, ramp, 3, 'x')
  // 甲板圆设备盖
  for (const [dx, dz] of [[-0.5, 0.4], [0.4, -0.4], [-0.3, -0.45]]) {
    const cover = new Mesh(new CylinderGeometry(0.16, 0.16, 0.18, 14), mat(PALETTE.roverBogie, ramp))
    cover.position.set(-0.1 + dx, 1.10, dz)
    chassis.add(noOutline(cover))
  }
  // 橙色数据线弧
  const dataLine = new Mesh(new TorusGeometry(0.5, 0.03, 6, 20, Math.PI), mat(PALETTE.roverAccent, ramp))
  dataLine.rotation.set(Math.PI / 2, 0, 0)
  dataLine.position.set(0.3, 1.08, 0.5)
  chassis.add(noOutline(dataLine))

  // 顶面两条深色结构线 + 橙饰条
  const topLine1 = box(1.5, 0.03, 0.06, PALETTE.roverDark, ramp)
  topLine1.position.set(-0.1, 1.08, 0)
  chassis.add(noOutline(topLine1))
  const accentStripe = box(1.2, 0.05, 0.08, PALETTE.roverAccent, ramp)
  accentStripe.position.set(0.2, 0.52, 0.88)
  chassis.add(noOutline(accentStripe))
  const accentStripe2 = accentStripe.clone()
  accentStripe2.position.set(0.2, 0.52, -0.88)
  chassis.add(noOutline(accentStripe2))

  edgeTrim(chassis, 1.8, 0.62, 1.7, PALETTE.roverDark, ramp, 0.03)

  // ========== 太阳能板（单块扁平六边形 + 三角镶嵌） ==========
  const panelGroup = new Group()
  panelGroup.position.set(-0.1, 1.08, 0)
  root.add(panelGroup)

  const panelMat = mat(PALETTE.roverPanel, ramp)
  const panelLight = '#3a527e' // 同色系浅蓝，用于三角格深浅变化

  // 主六边形板（6 边棱柱，更扁平）
  const HEX_R = 1.15
  const panelPlate = new Mesh(new CylinderGeometry(HEX_R, HEX_R, 0.04, 6), panelMat)
  panelPlate.position.y = 0.02
  panelGroup.add(panelPlate)

  // 平面三角瓦（中心→两相邻外顶点），同色系深浅交替，制造几何镶嵌感
  function flatTri(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, hex: string): Mesh {
    const g = new BufferGeometry()
    g.setAttribute('position', new Float32BufferAttribute(new Float32Array([ax, 0, az, bx, 0, bz, cx, 0, cz]), 3))
    g.setIndex([0, 1, 2])
    g.computeVertexNormals()
    const m = new Mesh(g, mat(hex, ramp))
    m.position.y = 0.045
    return m
  }
  const outerVerts: Array<[number, number]> = []
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    outerVerts.push([Math.cos(a) * HEX_R, Math.sin(a) * HEX_R])
  }
  for (let i = 0; i < 6; i++) {
    const [ax, az] = outerVerts[i]
    const [bx, bz] = outerVerts[(i + 1) % 6]
    panelGroup.add(noOutline(flatTri(0, 0, ax, az, bx, bz, i % 2 === 0 ? PALETTE.roverPanel : panelLight)))
  }

  // 三角镶嵌网格线：6 条放射脊 + 2 圈同心六边形
  for (let i = 0; i < 6; i++) {
    const [ax, az] = outerVerts[i]
    const len = Math.hypot(ax, az)
    const spokeBox = box(len, 0.02, 0.03, PALETTE.roverDark, ramp)
    spokeBox.position.set(ax / 2, 0.05, az / 2)
    spokeBox.rotation.y = -Math.atan2(az, ax)
    panelGroup.add(noOutline(spokeBox))
  }
  for (const ringR of [0.55, 0.85]) {
    const ring = new Mesh(new TorusGeometry(ringR, 0.02, 6, 6), mat(PALETTE.roverDark, ramp))
    ring.rotation.x = Math.PI / 2
    ring.position.y = 0.05
    panelGroup.add(noOutline(ring))
  }

  // 中央纵向结构带（沿车体前后，把六边形分成左右两半）
  const spine = box(HEX_R * 1.9, 0.03, 0.1, PALETTE.roverDark, ramp)
  spine.position.set(0, 0.05, 0)
  panelGroup.add(noOutline(spine))
  // 中央接口盘
  const centerHub = new Mesh(new CylinderGeometry(0.18, 0.18, 0.06, 14), mat(PALETTE.roverMetal, ramp, 0, METAL_SPEC))
  centerHub.rotation.x = Math.PI / 2
  centerHub.position.y = 0.055
  panelGroup.add(noOutline(centerHub))

  // 电池低电量时 panelGroup 会下折
  let panelPivot = panelGroup

  // ========== 桅杆相机（球形单镜头，对齐三视图） ==========
  const mastGroup = new Group()
  mastGroup.position.set(0.55, 1.05, 0)
  root.add(mastGroup)

  const mastPost = cyl(0.07, 1.0, PALETTE.roverMetal, ramp, 10, 0, METAL_SPEC)
  mastPost.position.y = 0.5
  mastGroup.add(mastPost)

  // 头舱（可转向）：白色球头 + 单黑色圆形镜头
  const headGroup = new Group()
  headGroup.position.set(0.55, 2.05, 0)
  headGroup.rotation.order = 'YZX'
  root.add(headGroup)

  const headSphere = new Mesh(new SphereGeometry(0.28, 20, 18), mat(PALETTE.roverBody, ramp))
  headGroup.add(headSphere)

  const lensMat = mat(PALETTE.roverGlass, ramp, 0.95, GLASS_SPEC)
  const lens = new Mesh(new SphereGeometry(0.08, 16, 14), lensMat)
  lens.scale.set(0.4, 1, 1)
  lens.position.set(0.18, 0, 0)
  headGroup.add(noOutline(lens))

  const lensRim = new Mesh(new TorusGeometry(0.075, 0.02, 8, 18), mat(PALETTE.roverDark, ramp))
  lensRim.rotation.y = Math.PI / 2
  lensRim.position.set(0.17, 0, 0)
  headGroup.add(noOutline(lensRim))

  // ========== 机械臂（肩/肘/腕 + 双爪钳，位于车体左侧 -x） ==========
  const armRoot = new Group()
  armRoot.position.set(-0.75, 0.68, -0.78)
  root.add(armRoot)

  const shoulder = hingeJoint(0.15, PALETTE.roverBogie, ramp)
  armRoot.add(shoulder)

  const armA = box(0.72, 0.14, 0.14, PALETTE.roverBody, ramp)
  armA.position.set(0.36, 0, 0)
  armRoot.add(armA)
  // 臂上橙色点缀线
  const armAStripe = box(0.7, 0.04, 0.16, PALETTE.roverAccent, ramp)
  armAStripe.position.set(0.36, 0.02, 0)
  armRoot.add(noOutline(armAStripe))

  const elbowGroup = new Group()
  elbowGroup.position.set(0.72, 0, 0)
  armRoot.add(elbowGroup)
  const elbow = hingeJoint(0.13, PALETTE.roverBogie, ramp)
  elbowGroup.add(elbow)
  const armB = box(0.62, 0.12, 0.12, PALETTE.roverMetal, ramp)
  armB.position.set(0.31, 0, 0)
  elbowGroup.add(armB)

  const wristGroup = new Group()
  wristGroup.position.set(0.62, 0, 0)
  elbowGroup.add(wristGroup)
  const wrist = hingeJoint(0.11, PALETTE.roverBogie, ramp)
  wristGroup.add(wrist)
  const clawBase = box(0.22, 0.14, 0.14, PALETTE.roverAccent, ramp)
  wristGroup.add(clawBase)
  // 双爪钳
  for (const side of [-1, 1]) {
    const finger = box(0.34, 0.07, 0.06, PALETTE.roverDark, ramp)
    finger.position.set(0.24, side * 0.1, 0)
    finger.rotation.z = side * 0.35
    wristGroup.add(noOutline(finger))
  }

  // 默认姿态：臂向前下方伸出，与三视图收纳状态一致
  armRoot.rotation.z = -0.25
  elbowGroup.rotation.z = 0.55
  wristGroup.rotation.z = -0.25

  // ========== 摇臂-转向架悬架 ==========
  const suspensionGroup = new Group()
  root.add(suspensionGroup)

  const rockerBars: Mesh[] = []
  const bogieBars: Mesh[] = []
  const diffJoints: Mesh[] = []

  for (const side of [-1, 1]) {
    const diffJoint = hingeJoint(0.17, PALETTE.roverBogie, ramp)
    diffJoint.position.set(0.5, 0.58, side * 0.42)
    suspensionGroup.add(noOutline(diffJoint))
    diffJoints.push(diffJoint)

    const rocker = cyl(0.06, 1.0, PALETTE.roverBogie, ramp, 8, 0, BOGIE_SPEC)
    rocker.geometry.rotateZ(Math.PI / 2)
    rocker.position.set(0.5, 0.52, side * 1.0)
    rocker.rotation.z = 0.2
    suspensionGroup.add(noOutline(rocker))
    rockerBars.push(rocker)

    const bogie = cyl(0.05, 0.95, PALETTE.roverBogie, ramp, 8, 0, BOGIE_SPEC)
    bogie.geometry.rotateZ(Math.PI / 2)
    bogie.position.set(-0.45, 0.52, side * 1.02)
    bogie.rotation.z = -0.1
    suspensionGroup.add(noOutline(bogie))
    bogieBars.push(bogie)

    for (const [px, pz] of [[0.95, side * 1.0], [0.0, side * 1.05], [-0.95, side * 1.0]]) {
      const j = hingeJoint(0.09, PALETTE.roverBogie, ramp)
      j.position.set(px, 0.50, pz)
      suspensionGroup.add(noOutline(j))
    }
  }

  // 差速杆
  const diffBar = cyl(0.055, 1.9, PALETTE.roverMetal, ramp, 10, 0, METAL_SPEC)
  diffBar.geometry.rotateZ(Math.PI / 2)
  diffBar.position.set(0.5, 0.58, 0)
  suspensionGroup.add(noOutline(diffBar))

  // ========== 6 个轮子 ==========
  const wheels: Group[] = []
  for (let i = 0; i < 6; i++) {
    const side = i % 2 === 1 ? 1 : -1
    const w = createChevronWheel(ramp, side)
    const [px, py, pz] = WHEEL_POS[i]
    w.position.set(px, py, pz)
    w.name = `wheel${i}`
    root.add(w)
    wheels.push(w)
  }

  // ========== 车尾天线 ==========
  const antennaBase = box(0.14, 0.12, 0.14, PALETTE.roverMetal, ramp)
  antennaBase.position.set(-1.3, 0.90, -0.5)
  root.add(antennaBase)
  const antenna = cyl(0.018, 0.6, PALETTE.roverMetal, ramp, 6, 0, METAL_SPEC)
  antenna.position.set(-1.3, 1.20, -0.5)
  root.add(antenna)
  const antennaTip = new Mesh(new SphereGeometry(0.05, 10, 8), mat(PALETTE.roverAccent, ramp))
  antennaTip.position.set(-1.3, 1.52, -0.5)
  root.add(noOutline(antennaTip))

  // ========== 描边 ==========
  // 用整体外部轮廓描边：把所有可见零件合并成一份几何，再生成单一 BackSide 外壳。
  // 这样只保留 R-7 最外层剪影，不会出现零件交界处的内部黑线；胎齿、辐条、螺栓、
  // 纹饰线已通过 noOutline / userData.outline=false 排除。
  addSilhouetteOutline(root, {
    thickness: (r) => Math.max(0.14, Math.min(0.42, r * 0.17)),
    skipSmall: 0.22,
  })
  // R-7 整组挪到 NO_EDGE_LAYER，避开 postfx 屏幕空间 Sobel：
  // 胎纹/螺栓/焊缝/面板拼接的法线差大，Sobel 会勾出密集内部黑线。
  // 只保留 addSilhouetteOutline 单一外轮廓。
  setLayerRecursive(root, NO_SOBEL_LAYER)

  // ========== 接触阴影 ==========
  // 贴地软影，跟随车体，不参与 Sobel 墨线。车轮最低点在本地 y=0，
  // root 又被抬到 groundY+~0.05，故略下沉 0.04 让它正好贴地。
  const roverShadow = createBlobShadow({ radius: 1.7, strength: 0.5 })
  roverShadow.position.y = -0.04
  root.add(roverShadow)

  // ========== 状态 ==========
  let curArm = 0
  let curMastYaw = 0
  let curMastPitch = 0

  const setPose = (p: RoverPose) => {
    root.position.set(p.x, p.y, p.z)
    root.rotation.set(p.pitch, p.heading, p.roll)

    for (let i = 0; i < 6; i++) {
      const [px, py, pz] = WHEEL_POS[i]
      wheels[i].position.set(px, py - p.wheelCompression[i], pz)
      wheels[i].rotation.z = -p.wheelSpin
    }

    const avgFront = (p.wheelCompression[0] + p.wheelCompression[1]) / 2
    const avgMid = (p.wheelCompression[2] + p.wheelCompression[3]) / 2
    const avgRear = (p.wheelCompression[4] + p.wheelCompression[5]) / 2
    for (let i = 0; i < rockerBars.length; i++) {
      rockerBars[i].rotation.z = 0.2 + (avgFront - avgMid) * 0.15
    }
    for (let i = 0; i < bogieBars.length; i++) {
      bogieBars[i].rotation.z = -0.1 + (avgMid - avgRear) * 0.12
    }

    const targetArm = p.armAction === 'stuck' ? 0.05 : p.armAction === 'scan' ? 1 : p.arm
    curArm += (targetArm - curArm) * 0.12
    // 基础姿态 + 动画偏移
    armRoot.rotation.y = -curArm * 0.7
    armRoot.rotation.z = -0.25 + curArm * 0.1
    armRoot.position.y = 0.92 - curArm * 0.08
    elbowGroup.rotation.z = 0.55 + curArm * 0.2
    wristGroup.rotation.z = -0.25 - curArm * 0.15

    let targetYaw = 0
    let targetPitch = 0
    if (p.lookAt) {
      const dx = p.lookAt.x - p.x
      const dy = p.lookAt.y - p.y - 2.5
      const dz = p.lookAt.z - p.z
      const { lx, lz } = worldToLocalDir(dx, dz, p.heading)
      targetYaw = localYawToward(lx, lz)
      targetPitch = Math.atan2(dy, Math.hypot(lx, lz))
    }
    targetYaw = Math.max(-0.9, Math.min(0.9, targetYaw))
    targetPitch = Math.max(-0.5, Math.min(0.5, targetPitch))
    curMastYaw += (targetYaw - curMastYaw) * 0.08
    curMastPitch += (targetPitch - curMastPitch) * 0.08
    headGroup.rotation.y = curMastYaw
    headGroup.rotation.z = curMastPitch

    const bat = p.battery ?? 1
    panelPivot.rotation.x = -0.55 * Math.max(0, 1 - bat)
    if (panelMat.uniforms) {
      panelMat.uniforms.uEmissive.value = bat < 0.3 ? 0.55 : 0
    }
  }

  const setTime = (t: number) => {
    const breathe = 0.82 + 0.18 * Math.sin(t * 2.0)
    lensMat.uniforms.uEmissive.value = breathe
  }

  const getWheelWorldPositions = (p: RoverPose) => {
    const cp = Math.cos(p.pitch)
    const sp = Math.sin(p.pitch)
    const cr = Math.cos(p.roll)
    const sr = Math.sin(p.roll)
    const ch = Math.cos(p.heading)
    const sh = Math.sin(p.heading)
    return WHEEL_POS.map(([lx, ly, lz]) => {
      const y1 = ly * cp - lx * sp
      const x1 = ly * sp + lx * cp
      const z1 = lz * cr + y1 * sr
      const y2 = -lz * sr + y1 * cr
      const x2 = x1 * ch + z1 * sh
      const z2 = -x1 * sh + z1 * ch
      return {
        x: p.x + x2,
        y: p.y + y2 - 0.05,
        z: p.z + z2,
      }
    })
  }

  const dispose = () => {
    root.traverse((o) => {
      const m = o as Mesh
      if (m.isMesh) {
        m.geometry.dispose()
        const material = m.material
        if (Array.isArray(material)) material.forEach((x) => x.dispose())
        else material.dispose()
      }
    })
  }

  return { group: root, setPose, setTime, getWheelWorldPositions, dispose }
}
