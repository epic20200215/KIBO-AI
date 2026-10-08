/**
 * 能源采集车（自动驾驶验证任务的载体）。
 *
 * 和玩家操控的 R-7 漫游车是两辆不同的车，造型上必须一眼分得清：
 *   - R-7：车顶是**桅杆球形相机头**（单镜头），机械臂挂在车身侧面；
 *   - 采集车：车顶正中是一台**机械臂**（基座 + 大臂 + 小臂 + 双爪夹钳），
 *     没有球形相机头——它的活儿是抓资源，不是看地形。
 *
 * 采集车不接受玩家操控：它按学生在路径选择台拍板的路线自动驾驶，
 * 去程到能源站抓取资源，再原路返回主基地。位置由 mission 的确定性仿真驱动
 * （stage 每帧把 leg/t 传进来），本模块只负责把车摆到位、做装饰动画。
 */
import { BoxGeometry, CylinderGeometry, Group, IcosahedronGeometry, Mesh, SphereGeometry, TorusGeometry, type Texture, Vector3 } from 'three'
import type { HeightField } from '../core/heightField'
import type { GridCell } from '../core/grid'
import { makeRng } from './landmarks'
import { addSilhouetteOutline, createBlobShadow, createCelMaterial, noOutline, type CelSpecular } from './celMaterial'
import { PALETTE } from './palette'
import { setLayerRecursive, NO_EDGE_LAYER, NO_SOBEL_LAYER } from './postfx'

const LIFT = 0.0 // 采集车贴地行驶（不再悬空）。整体缩放后轮子刚好落在地表上。

/** 机械臂动作：idle=收起待命 / reach=放下手臂 / grab=夹爪闭合抓取 / carry=夹着资源抬起 */
export type HaulerArmAction = 'idle' | 'reach' | 'grab' | 'carry'

export type Hauler = {
  group: Group
  /** 设置往返两段路径。两段都以主基地为起点/终点，段内顺序即行驶方向。 */
  setPath: (outbound: GridCell[], back: GridCell[]) => void
  /** 把车摆到指定段的指定进度（t ∈ [0,1]）。'collect' 段停在终点做抓取动作。 */
  setLeg: (leg: 'outbound' | 'collect' | 'return', t: number) => void
  /** 机械臂动作。collecting 阶段由 stage 依次切 reach → grab → carry。 */
  setArmAction: (a: HaulerArmAction) => void
  /** 显示/隐藏（未出发时隐藏）。 */
  show: (v: boolean) => void
  /** 当前车体的世界坐标（相机跟随时用）。 */
  position: () => { x: number; y: number; z: number }
  /**
   * 取 6 个轮子的世界坐标（按 sx/wz 创建顺序：左后[0]/左中[1]/左前[2]/右后[3]/右中[4]/右前[5]）。
   * 仿 R-7 的 getWheelWorldPositions 用于让扬尘从指定轮子底部喷出，不再从车体中心。
   */
  getWheelWorldPositions: () => Array<{ x: number; y: number; z: number }>
  /** 路径起/终点（截图工装用来构图）。 */
  endpoints: () => { start: { x: number; z: number }; goal: { x: number; z: number } } | null
  /** 只推进装饰动画（核心脉动、夹爪开合）。dt 秒。 */
  update: (dt: number) => void
  dispose: () => void
  /** 2026-09-03：触发渐隐（~0.8s），完成后回调 onHidden。 */
  fadeOut: (onHidden?: () => void) => void
}

export function createHauler(field: HeightField, ramp: Texture): Hauler {
  const group = new Group()
  group.name = 'EnergyHauler'
  group.visible = false
  // 2026-09-02 用户反馈"现在有点小"：scale 0.5→1.0（放大 100%），整体贴地（LIFT=0），
  // 轮子刚好落在地表上。基础几何约 6.7×8.7m，缩放 1.0 即原尺寸，约为 R-7 的 3 倍。
  group.scale.set(1.0, 1.0, 1.0)

  /** 采集车金属部件的硬边高光。 */
  const H_METAL: CelSpecular = { color: '#ffffff', strength: 0.35, shininess: 24 }

  /** 赛璐珞材质 + 自发光（与 landmarks.ts 的 mat 等价，独立一份避免循环依赖）。 */
  const mat = (hex: string, emissive = 0, specular?: CelSpecular) =>
    createCelMaterial(hex, ramp, { emissive, specular })
  const box = (w: number, h: number, d: number, hex: string, emissive = 0, specular?: CelSpecular): Mesh => {
    const m = new Mesh(new BoxGeometry(w, h, d), mat(hex, emissive, specular))
    m.castShadow = false
    m.receiveShadow = false
    return m
  }
  const cyl = (r: number, h: number, hex: string, seg = 12, specular?: CelSpecular): Mesh => {
    const m = new Mesh(new CylinderGeometry(r, r, h, seg), mat(hex, 0, specular))
    m.castShadow = false
    m.receiveShadow = false
    return m
  }

  // 履带平板底盘
  const chassis = box(5.2, 1.0, 8.4, PALETTE.roverBody)
  chassis.position.y = 1.1
  group.add(chassis)
  // 细长结构条（替代之前的高大方块"履带"），贴轮子内侧，宽度刚好藏在轮子后面
  for (const sx of [-1, 1]) {
    const track = box(0.30, 0.6, 9.0, PALETTE.roverDark)
    track.position.set(sx * 2.55, 0.45, 0)
    group.add(noOutline(track))
  }

  // ========== 顶面仪表甲板（R-7 同款：金属板 + 设备缝 + 圆设备盖 + 橙数据线） ==========
  const deck = box(4.8, 0.12, 7.6, PALETTE.roverMetal, 0, H_METAL)
  deck.position.set(0, 1.66, 0)
  group.add(deck)
  // 设备缝：3 条沿 z 方向 + 2 条沿 x 方向
  for (let i = 1; i <= 3; i++) {
    const t = (i / 4) - 0.5
    const line = box(0.05, 0.03, 7.0, PALETTE.roverDark)
    line.position.set(t * 4.2, 1.73, 0)
    group.add(noOutline(line))
  }
  for (let i = 1; i <= 2; i++) {
    const t = (i / 3) - 0.5
    const line = box(4.2, 0.03, 0.05, PALETTE.roverDark)
    line.position.set(0, 1.73, t * 7.0)
    group.add(noOutline(line))
  }
  // 圆设备盖（5 个，错落排布）
  for (const [dx, dz, r] of [[-1.6, 1.8, 0.32], [1.6, 1.8, 0.32], [-1.4, -1.6, 0.28], [1.4, -1.6, 0.28], [0.0, 0.2, 0.42]]) {
    const cover = new Mesh(new CylinderGeometry(r, r, 0.22, 16), mat(PALETTE.roverBogie, 0, H_METAL))
    cover.position.set(dx, 1.83, dz)
    group.add(noOutline(cover))
    const knob = new Mesh(new CylinderGeometry(r * 0.25, r * 0.25, 0.05, 10), mat(PALETTE.roverDark))
    knob.position.set(dx, 1.95, dz)
    group.add(noOutline(knob))
  }
  // 橙色数据线弧（R-7 同款装饰条，强化工程载具气质）
  const dataLine = new Mesh(new TorusGeometry(0.9, 0.05, 6, 20, Math.PI), mat(PALETTE.roverAccent, 0, H_METAL))
  dataLine.rotation.set(Math.PI / 2, 0, 0)
  dataLine.position.set(-0.8, 1.78, -0.6)
  group.add(noOutline(dataLine))
  const dataLine2 = new Mesh(new TorusGeometry(0.7, 0.05, 6, 20, Math.PI), mat(PALETTE.roverAccent, 0, H_METAL))
  dataLine2.rotation.set(Math.PI / 2, 0, 0)
  dataLine2.position.set(1.2, 1.78, 1.0)
  group.add(noOutline(dataLine2))

  // ========== 侧面加强筋 + 散热缝（R-7 同款：每侧 3 筋 + 4 缝） ==========
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const rib = box(1.6, 0.12, 0.10, PALETTE.roverDark)
      rib.position.set(0, 0.95 + (i - 1) * 0.30, side * 2.61)
      group.add(noOutline(rib))
    }
    for (let i = 0; i < 4; i++) {
      const vent = box(0.4, 0.10, 0.04, PALETTE.roverDark)
      vent.position.set(-1.6 + i * 1.05, 1.50, side * 2.61)
      group.add(noOutline(vent))
    }
    // 侧面橙饰条
    const accentStripe = box(5.2, 0.10, 0.06, PALETTE.roverAccent)
    accentStripe.position.set(0, 1.18, side * 2.61)
    group.add(noOutline(accentStripe))
  }

  // ========== 边缘镶条（甲板四条边） ==========
  for (const dx of [-2.45, 2.45]) {
    const e = box(0.06, 0.18, 7.6, PALETTE.roverDark)
    e.position.set(dx, 1.66, 0)
    group.add(noOutline(e))
  }
  for (const dz of [-3.8, 3.8]) {
    const e = box(5.0, 0.18, 0.06, PALETTE.roverDark)
    e.position.set(0, 1.66, dz)
    group.add(noOutline(e))
  }

  // ========== 车头：楔形鼻头 + 头灯 + 散热格栅 ==========
  const nose = box(4.4, 0.6, 0.5, PALETTE.roverMetal, 0, H_METAL)
  nose.position.set(0, 1.35, 4.4)
  nose.rotation.x = -0.32
  group.add(nose)
  // 鼻头下面的小挡板
  const noseSkirt = box(3.6, 0.18, 0.7, PALETTE.roverDark)
  noseSkirt.position.set(0, 0.95, 4.2)
  group.add(noOutline(noseSkirt))
  // 头灯：左右各一，暖白发光
  for (const sx of [-1.6, 1.6]) {
    const hl = new Mesh(new CylinderGeometry(0.22, 0.22, 0.10, 14), mat('#fff2c2', 0.85, H_METAL))
    hl.rotation.x = Math.PI / 2
    hl.position.set(sx, 1.45, 4.62)
    group.add(noOutline(hl))
    const hlRim = new Mesh(new TorusGeometry(0.24, 0.03, 6, 16), mat(PALETTE.roverDark))
    hlRim.rotation.y = Math.PI / 2
    hlRim.position.set(sx, 1.45, 4.65)
    group.add(noOutline(hlRim))
  }
  // 前格栅（小型 RTG 风格）
  const frontGrille = new Mesh(new CylinderGeometry(0.55, 0.55, 0.20, 18), mat(PALETTE.roverDark))
  frontGrille.rotation.x = Math.PI / 2
  frontGrille.position.set(0, 1.40, 4.62)
  group.add(noOutline(frontGrille))
  for (let i = 0; i < 6; i++) {
    const fin = new Mesh(new TorusGeometry(0.56, 0.025, 6, 18), mat(PALETTE.roverBogie, 0, H_METAL))
    fin.rotation.y = Math.PI / 2
    fin.position.set(0, 1.40, 4.52 + i * 0.04)
    group.add(noOutline(fin))
  }

  // ========== 车尾：RTG 风格大格栅舱（视觉上对称，提示这是个能量相关载具） ==========
  const rearGrille = new Mesh(new CylinderGeometry(0.65, 0.65, 1.5, 18), mat(PALETTE.roverDark))
  rearGrille.rotation.x = Math.PI / 2
  rearGrille.position.set(0, 1.50, -4.55)
  group.add(noOutline(rearGrille))
  for (let i = 0; i < 11; i++) {
    const fin = new Mesh(new TorusGeometry(0.66, 0.025, 6, 18), mat(PALETTE.roverBogie, 0, H_METAL))
    fin.rotation.y = Math.PI / 2
    fin.position.set(0, 1.50, -5.05 + i * 0.12)
    group.add(noOutline(fin))
  }
  // 尾端护盖
  const rearCap = new Mesh(new CylinderGeometry(0.66, 0.66, 0.16, 18), mat(PALETTE.roverMetal, 0, H_METAL))
  rearCap.rotation.x = Math.PI / 2
  rearCap.position.set(0, 1.50, -5.36)
  group.add(noOutline(rearCap))

  // ========== 车尾天线（车体左侧 -x，斜后向） ==========
  const antennaBase = box(0.20, 0.16, 0.20, PALETTE.roverMetal, 0, H_METAL)
  antennaBase.position.set(-1.9, 1.85, -3.6)
  group.add(antennaBase)
  const antenna = cyl(0.04, 1.1, PALETTE.roverMetal, 6, H_METAL)
  antenna.position.set(-1.9, 2.40, -3.6)
  group.add(noOutline(antenna))
  const antennaTip = new Mesh(new SphereGeometry(0.09, 12, 10), mat(PALETTE.roverAccent, 0.4))
  antennaTip.position.set(-1.9, 3.00, -3.6)
  group.add(noOutline(antennaTip))

  // ========== 小型传感器舱（甲板后部 +z 负方向，区别于 R-7 的桅杆球头） ==========
  const sensorBase = box(0.50, 0.20, 0.50, PALETTE.roverDark)
  sensorBase.position.set(1.6, 1.82, -2.6)
  group.add(noOutline(sensorBase))
  const sensorPod = box(0.36, 0.30, 0.36, PALETTE.roverBody, 0, H_METAL)
  sensorPod.position.set(1.6, 2.07, -2.6)
  group.add(sensorPod)
  // 三个小镜头（前向 + 两侧）—— 区别于 R-7 的单镜头
  const sensorLensMat = mat(PALETTE.accentCyan, 0.9, H_METAL)
  const sensorLensMain = new Mesh(new SphereGeometry(0.08, 14, 10), sensorLensMat)
  sensorLensMain.scale.set(0.5, 1, 1)
  sensorLensMain.position.set(1.6, 2.07, -2.42)
  group.add(noOutline(sensorLensMain))
  for (const dx of [-0.18, 0.18]) {
    const sl = new Mesh(new SphereGeometry(0.05, 12, 10), sensorLensMat)
    sl.scale.set(0.4, 1, 1)
    sl.position.set(1.6 + dx, 2.07, -2.42)
    group.add(noOutline(sl))
  }

  // ========== R-7 同款 chevron 胎纹轮：轮胎 + 24 齿 + 6 辐条 + 中心盖 + 橙缘环 ==========
  // 沿用 rover.ts 中 createChevronWheel 的结构，仅按采集车尺寸放大（HR=1.5, HW=1.0）。
  // 齿在 X 轴周围排布，辐条/盖在轮外侧面，方向与 R-7 一致。
  const HR = 1.5
  const HW = 1.0
  function createHaulerWheel(side: number): Group {
    const g = new Group()
    g.name = 'wheel'
    // 主轮胎：圆柱体沿 X 轴
    const tireGeo = new CylinderGeometry(HR, HR, HW, 30)
    tireGeo.rotateZ(Math.PI / 2)
    const tire = new Mesh(tireGeo, mat(PALETTE.roverTire))
    tire.userData.outline = false
    g.add(tire)
    // Chevron 齿：24 颗，绕 X 轴分布（比 R-7 略小一圈，避免大轮子上齿太尖）
    const toothCount = 24
    const toothAxial = 0.30
    const toothRadial = 0.38
    const toothTangential = 0.36
    for (let i = 0; i < toothCount; i++) {
      const a = (i / toothCount) * Math.PI * 2
      const dirs = i % 2 === 0 ? 1 : -1
      const tooth = box(toothAxial, toothRadial, toothTangential, PALETTE.roverDark, 0, H_METAL)
      const r = HR + toothRadial * 0.5
      tooth.position.set(dirs * 0.18, Math.cos(a) * r, Math.sin(a) * r)
      tooth.rotation.x = a + (dirs * Math.PI / 5)
      g.add(noOutline(tooth))
    }
    // 内凹轮毂
    const hubOuter = new Mesh(
      new CylinderGeometry(HR * 0.62, HR * 0.62, HW * 1.02, 18),
      mat(PALETTE.roverBogie, 0, H_METAL),
    )
    hubOuter.rotation.z = Math.PI / 2
    hubOuter.position.x = side > 0 ? HW * 0.5 : -HW * 0.5
    g.add(noOutline(hubOuter))
    // 6 辐条
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      const spoke = box(0.18, HR * 0.54, 0.30, PALETTE.roverMetal, 0, H_METAL)
      spoke.position.set(
        side * HW * 0.55,
        Math.cos(a) * HR * 0.3,
        Math.sin(a) * HR * 0.3,
      )
      spoke.rotation.x = a
      g.add(noOutline(spoke))
    }
    // 中心盖
    const cap = new Mesh(
      new CylinderGeometry(HR * 0.18, HR * 0.18, HW * 1.08, 12),
      mat(PALETTE.roverDark),
    )
    cap.rotation.z = Math.PI / 2
    cap.position.x = side > 0 ? HW * 0.56 : -HW * 0.56
    g.add(noOutline(cap))
    // 橙缘环
    const rim = new Mesh(
      new CylinderGeometry(HR * 1.02, HR * 1.02, HW * 1.04, 30, 1, true),
      mat(PALETTE.roverAccent, 0, H_METAL),
    )
    rim.rotation.z = Math.PI / 2
    g.add(rim)
    return g
  }
  // 6 个大轮子（每侧 3 个）：轮底贴地。
  // 同时记录每个轮子的本地坐标，方便 getWheelWorldPositions 把它们换算到世界系；
  // 顺序：左后[0]/左中[1]/左前[2]/右后[3]/右中[4]/右前[5]。
  const wheels: Group[] = [];
  const WHEEL_LOCAL: Array<[number, number, number]> = [];
  for (const sx of [-1, 1]) {
    for (const wz of [-3.6, 0, 3.6]) {
      const w = createHaulerWheel(sx)
      const lx = sx * 2.7
      const ly = HR
      const lz = wz
      w.position.set(lx, ly, lz)
      group.add(w); wheels.push(w); WHEEL_LOCAL.push([lx, ly, lz])
    }
  }
  // 后部货斗（装抓回来的资源）
  const bed = box(4.4, 0.7, 3.0, '#3a3a42')
  bed.position.set(0, 2.0, -2.6)
  group.add(bed)
  for (const sx of [-1, 1]) {
    const rail = box(0.22, 0.9, 3.0, '#2a2a30')
    rail.position.set(sx * 2.1, 2.4, -2.6)
    group.add(rail)
  }
  // 抓回来的能源矿石：采集完成后才显形（一小堆真实矿石，不是一个方块）
  const oreCrate: Group = new Group();
  oreCrate.position.set(0, 2.4, -2.6);
  oreCrate.visible = false;
  const oreColors = ['#5a5048', '#8a3a1a', '#5a6a3a'];
  const oreRng = makeRng(7777);
  for (let k = 0; k < 5; k += 1) {
    const sz = 0.4 + oreRng() * 0.35;
    const ore = new Mesh(new IcosahedronGeometry(sz, 0), mat(oreColors[k % oreColors.length]));
    // 2026-09-03 用户反馈：采集车在还没采集到矿石之前，车身上就会出现矿石的黑色描边。
    // 原因：addSilhouetteOutline 会遍历 group 内所有 mesh 合并成单一外壳，
    // oreCrate.visible=false 拦不住合并后的 BackSide 外壳——外壳在 group 顶层，
    // 并不随 oreCrate 一起隐藏。
    // 修法：给每个 ore mesh 设 userData.outline = false，让 addSilhouetteOutline 跳过它们。
    ore.userData.outline = false;
    const ang = (k / 5) * Math.PI * 2 + oreRng() * 0.5;
    const r = k === 0 ? 0 : 0.4 + oreRng() * 0.2;
    ore.position.set(Math.cos(ang) * r, sz * 0.5, Math.sin(ang) * r);
    ore.rotation.set(oreRng() * Math.PI, oreRng() * Math.PI, oreRng() * Math.PI);
    ore.scale.set(0.9 + oreRng() * 0.3, 0.6 + oreRng() * 0.3, 0.9 + oreRng() * 3.0);
    oreCrate.add(ore);
  }
  group.add(oreCrate);

  // ================= 车顶机械臂（采集车的身份标识）=================
  // 整条臂挂在一个可转向的转台上：基座 → 大臂 → 肘 → 小臂 → 双爪夹钳。
  const armRoot = new Group()
  armRoot.position.set(0, 1.6, 1.4)
  group.add(armRoot)

  // 转台
  const turret = cyl(0.85, 0.42, '#4a4a52', 14, H_METAL)
  turret.position.y = 0.21
  armRoot.add(turret)
  const turretRing = new Mesh(new CylinderGeometry(0.9, 0.9, 0.12, 14), mat(PALETTE.kiboAccent))
  turretRing.position.y = 0.44
  armRoot.add(noOutline(turretRing))

  // 肩关节（大臂绕它俯仰）
  const shoulder = new Group()
  shoulder.position.set(0, 0.52, 0)
  armRoot.add(shoulder)
  const shoulderPin = cyl(0.26, 0.7, PALETTE.rockDark, 10)
  shoulderPin.rotation.z = Math.PI / 2
  shoulder.add(shoulderPin)

  // 大臂
  const upperArm = box(0.46, 2.5, 0.46, PALETTE.roverBody ?? '#d8d8dc', 0, H_METAL)
  upperArm.position.set(0, 1.25, 0)
  shoulder.add(upperArm)
  const upperStripe = box(0.5, 0.14, 0.5, PALETTE.kiboAccent)
  upperStripe.position.set(0, 1.5, 0)
  shoulder.add(noOutline(upperStripe))

  // 肘关节
  const elbow = new Group()
  elbow.position.set(0, 2.5, 0)
  shoulder.add(elbow)
  const elbowPin = cyl(0.2, 0.62, PALETTE.rockDark, 10)
  elbowPin.rotation.z = Math.PI / 2
  elbow.add(elbowPin)

  // 小臂
  const foreArm = box(0.36, 1.9, 0.36, '#cfd2d8', 0, H_METAL)
  foreArm.position.set(0, 0.95, 0)
  elbow.add(foreArm)
  const foreStripe = box(0.4, 0.12, 0.4, PALETTE.kiboAccent)
  foreStripe.position.set(0, 1.3, 0)
  elbow.add(noOutline(foreStripe))

  // 腕 + 双爪夹钳
  const wrist = new Group()
  wrist.position.set(0, 1.9, 0)
  elbow.add(wrist)
  const wristPin = cyl(0.16, 0.5, PALETTE.rockDark, 10)
  wristPin.rotation.z = Math.PI / 2
  wrist.add(wristPin)

  const jawL = new Group()
  const jawR = new Group()
  wrist.add(jawL, jawR)
  for (const [g, sx] of [[jawL, -1], [jawR, 1]] as const) {
    const knuckle = cyl(0.11, 0.34, '#4a4a52', 8, H_METAL)
    knuckle.rotation.z = Math.PI / 2
    knuckle.position.set(sx * 0.2, 0.3, 0)
    g.add(knuckle)
    const finger = box(0.16, 1.0, 0.2, '#dfe2e8', 0, H_METAL)
    finger.position.set(sx * 0.2, 0.9, 0)
    g.add(finger)
    const tip = box(0.2, 0.24, 0.24, PALETTE.kiboAccent)
    tip.position.set(sx * 0.2, 1.42, 0)
    g.add(noOutline(tip))
  }

  // ========== 能源采集载具身份细节（主线 C 需求 #7：更像「采集能源的载具」）==========
  // 两侧横置能源储存罐（cyan 发光），一眼看出这是运能源的车，不是普通货车
  for (const sx of [-1, 1]) {
    const tank = cyl(0.55, 4.4, PALETTE.accentCyan, 16, H_METAL)
    tank.material = mat(PALETTE.accentCyan, 0.25, H_METAL)
    tank.rotation.x = Math.PI / 2
    tank.position.set(sx * 2.15, 1.5, -0.4)
    group.add(noOutline(tank))
    const capL = cyl(0.58, 0.22, '#4a4a52', 16, H_METAL)
    capL.rotation.x = Math.PI / 2
    capL.position.set(sx * 2.15, 1.5, -2.65)
    group.add(noOutline(capL))
    const capR = cyl(0.58, 0.22, '#4a4a52', 16, H_METAL)
    capR.rotation.x = Math.PI / 2
    capR.position.set(sx * 2.15, 1.5, 1.85)
    group.add(noOutline(capR))
  }

  // 车尾货斗护栏上的警示斜纹（橙黑），强化工程车辆气质
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const stripe = box(0.5, 0.12, 0.22, i % 2 === 0 ? PALETTE.kiboAccent : '#1a1a1e', 0, H_METAL)
      stripe.position.set(sx * 2.1, 2.5, -3.4 + i * 0.7)
      stripe.rotation.z = sx * 0.5
      group.add(noOutline(stripe))
    }
  }

  // 腕部钻头（采集能源的核心执行器）：采集/抓取时旋转
  const drill = new Group()
  drill.position.set(0, 0.15, 0.14)
  wrist.add(drill)
  const drillShaft = cyl(0.1, 0.6, '#6a6a72', 10, H_METAL)
  drillShaft.position.y = 0.3
  drill.add(drillShaft)
  const drillBit = cyl(0.12, 0.7, PALETTE.kiboAccent, 12, H_METAL)
  drillBit.material = mat(PALETTE.kiboAccent, 0.4, H_METAL)
  drillBit.position.y = 0.85
  drill.add(drillBit)

  // 车头方向指示已由车头楔形鼻头 + 头灯 + 格栅替代（见上方"车头"段）

  // 整体外部轮廓描边：参照 R-7 的设置，函数式 thickness 随合并几何大小自适应，
  // 并跳过小零件，避免无数细线把车身糊成黑色。
  addSilhouetteOutline(group, {
    thickness: (r) => Math.max(0.14, Math.min(0.42, r * 0.17)),
    skipSmall: 0.22,
  })
  // 采集车整组挪到 NO_EDGE_LAYER，避开 postfx 屏幕空间 Sobel：
  // 否则侧筋/散热缝/头灯环/楔形鼻头/天线/传感器舱等法线差大的地方会被勾出内部黑线。
  setLayerRecursive(group, NO_SOBEL_LAYER)

  // ========== 接触阴影 ==========
  // 采集车贴地行驶（LIFT=0），阴影直接落在地表（局部 y=0）。
  const haulerShadow = createBlobShadow({ radius: 3.0, strength: 0.35 })
  haulerShadow.position.y = -LIFT / 2
  group.add(haulerShadow)

  type Leg = 'outbound' | 'collect' | 'return'
  let outPts: Vector3[] = []
  let backPts: Vector3[] = []
  let outCum: number[] = []
  let backCum: number[] = []
  let outLen = 0
  let backLen = 0
  let startXZ: { x: number; z: number } | null = null
  let goalXZ: { x: number; z: number } | null = null

  let armAction: HaulerArmAction = 'idle'
  let armTime = 0
  let time = 0

  const build = (cells: GridCell[]) => {
    const pts: Vector3[] = []
    const cum = [0]
    for (let k = 0; k < cells.length; k += 1) {
      const c = cells[k]
      pts.push(new Vector3(c.x, field.heightAt(c.x, c.z) + LIFT, c.z))
    }
    for (let k = 1; k < pts.length; k += 1) cum.push(cum[k - 1] + pts[k].distanceTo(pts[k - 1]))
    return { pts, cum, len: cum[cum.length - 1] || 0 }
  }

  const setPath = (outbound: GridCell[], back: GridCell[]) => {
    const a = build(outbound)
    const b = build(back)
    outPts = a.pts
    outCum = a.cum
    outLen = a.len
    backPts = b.pts
    backCum = b.cum
    backLen = b.len
    startXZ = outPts.length ? { x: outPts[0].x, z: outPts[0].z } : null
    goalXZ = outPts.length ? { x: outPts[outPts.length - 1].x, z: outPts[outPts.length - 1].z } : null
  }

  const placeAt = (pts: Vector3[], cum: number[], total: number, dist: number) => {
    if (pts.length < 2) return
    const d = Math.max(0, Math.min(total, dist))
    let seg = 1
    while (seg < cum.length && cum[seg] < d) seg += 1
    seg = Math.min(seg, pts.length - 1)
    const segLen = cum[seg] - cum[seg - 1] || 1
    const f = (d - cum[seg - 1]) / segLen
    const a = pts[seg - 1]
    const b = pts[seg]
    const x = a.x + (b.x - a.x) * f
    const z = a.z + (b.z - a.z) * f
    group.position.set(x, field.heightAt(x, z) + LIFT, z)
    const dirX = b.x - a.x
    const dirZ = b.z - a.z
    if (Math.hypot(dirX, dirZ) > 1e-4) group.rotation.y = Math.atan2(dirX, dirZ)
  }

  // 记录当前所处 leg：'collect' 阶段轮子停止转动，其它阶段按 HAULER_SPEED 累加。
  let currentLeg: Leg = 'outbound';
  const setLeg = (leg: Leg, t: number) => {
    currentLeg = leg;
    if (leg === 'collect') {
      if (outPts.length >= 2) {
        const last = outPts[outPts.length - 1]
        const prev = outPts[outPts.length - 2]
        group.position.set(last.x, field.heightAt(last.x, last.z) + LIFT, last.z)
        group.rotation.y = Math.atan2(last.x - prev.x, last.z - prev.z)
      }
      return
    }
    if (leg === 'outbound') placeAt(outPts, outCum, outLen, t * outLen)
    else placeAt(backPts, backCum, backLen, t * backLen)
  }

  const setArmAction = (a: HaulerArmAction) => {
    if (a !== armAction) {
      armAction = a; armTime = 0;
    }
    oreCrate.visible = a === 'carry';
  }

  /** 装饰动画：核心脉动 + 机械臂姿态。姿态按动作插值，不做物理。 */
  // 2026-09-03 轮子转动：按 mission 的 HAULER_SPEED=30 m/s 算出角速度，collect 阶段不转。
  const HAULER_ANGULAR_V = 30 / 1.5; // HR=1.5 m
  const update = (dt: number) => {
    time += dt; armTime += dt;
    if (currentLeg !== 'collect') for (const w of wheels) w.rotation.x += HAULER_ANGULAR_V * dt;
    // 目标姿态：肩俯仰 / 肘弯折 / 夹爪开合
    let shoulderPitch = -0.35
    let elbowPitch = 0.75
    let jawOpen = 0.15
    let turretYaw = 0
    if (armAction === 'reach') {
      // 放下手臂去够资源
      const f = Math.min(1, armTime / 1.0)
      shoulderPitch = -0.35 + f * 0.95
      elbowPitch = 0.75 + f * 0.55
      jawOpen = 0.15 + f * 0.75
    } else if (armAction === 'grab') {
      const f = Math.min(1, armTime / 0.6)
      shoulderPitch = 0.6
      elbowPitch = 1.3
      jawOpen = 0.9 - f * 0.8 // 夹爪闭合
    } else if (armAction === 'carry') {
      const f = Math.min(1, armTime / 1.0)
      shoulderPitch = 0.6 - f * 1.0
      elbowPitch = 1.3 - f * 0.5
      jawOpen = 0.1
    }
    // 待命时转台缓慢左右扫视，避免死板
    if (armAction === 'idle') turretYaw = Math.sin(time * 0.6) * 0.25
    // 钻头随采集动作旋转（idle 时静止）
    if (armAction !== 'idle') drill.rotation.y += dt * 14;
    // 渐隐推进：~0.8s 走完，到 0 后回调并隐藏
    if (fadingOut && opacityMul > 0) {
      opacityMul = Math.max(0, opacityMul - dt * 1.25);
      group.traverse((o) => { if ((o as Mesh).isMesh && (o as Mesh).material && 'opacity' in (o as Mesh).material) ((o as Mesh).material as any).opacity = (((o as Mesh).userData as any).baseOpacity ?? 1) * opacityMul });
      if (opacityMul === 0) { group.visible = false; fadingOut = false; if (hiddenCallback) hiddenCallback() }
    }

    armRoot.rotation.y = turretYaw
    shoulder.rotation.x = shoulderPitch
    elbow.rotation.x = elbowPitch
    jawL.rotation.z = jawOpen
    jawR.rotation.z = -jawOpen
  }

  // 2026-09-03：渐隐避免穿模。success 时不再瞬移+显形，而是淡出到 0 再被回收。
  let opacityMul = 1;
  let fadingOut = false;
  const show = (v: boolean) => {
    if (v) {
      fadingOut = false; opacityMul = 1;
      group.visible = true;
      group.traverse((o) => { if ((o as Mesh).isMesh && (o as Mesh).material && ((o as Mesh).material as any).transparent !== true) ((o as Mesh).material as any).transparent = true });
    } else {
      group.visible = false; fadingOut = false; opacityMul = 1;
    }
  }
  const position = () => ({ x: group.position.x, y: group.position.y, z: group.position.z })
  const endpoints = () => (startXZ && goalXZ ? { start: startXZ, goal: goalXZ } : null)
  /**
   * 取 6 个轮子的世界坐标。仿 R-7 的 getWheelWorldPositions（rover.ts:565），
   * 只算绕 Y 轴的朝向（hauler 不会翻车/俯仰）。
   *
   * **2026-09-03 用户反馈**：烟雾原挂在轮子中间部位（y ≈ 1.45m）。
   * 修正：把 y 改为贴地（`+ 0.05`，轮底略微抬升防 z-fight），让尘从轮子"卷地"起。
   * 这样学生看到的是"轮子后面扬起的沙"，而不是"车腰两侧喷气"。
   */
  const getWheelWorldPositions = (): Array<{ x: number; y: number; z: number }> => {
    const ch = Math.cos(group.rotation.y)
    const sh = Math.sin(group.rotation.y)
    return WHEEL_LOCAL.map(([lx, , lz]) => ({
      x: group.position.x + lx * ch + lz * sh,
      y: group.position.y + 0.05,
      z: group.position.z + (-lx) * sh + lz * ch,
    }))
  }
  const dispose = () => {};
  // 2026-09-03：触发渐隐（~0.8s），调用后由 update 推进；onHidden 在 opacity 0 时触发。
  let hiddenCallback: (() => void) | null = null;
  const fadeOut = (onHidden?: () => void) => { fadingOut = true; hiddenCallback = onHidden ?? null };
  return { group, setPath, setLeg, setArmAction, show, position, getWheelWorldPositions, endpoints, update, dispose, fadeOut }
}
