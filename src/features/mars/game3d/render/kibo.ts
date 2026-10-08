/**
 * KIBO 引导机器人：按三视图**全量重写**（2026-09-01，非增量优化）。
 *
 * 重写原因：旧模型脚底落在 local y ≈ -0.98，而 stage 的根节点 y = 地面高度 + 0.02，
 * 导致 KIBO 有将近 1 个单位陷在地里，只剩上半身可见，比例整体失真。
 *
 * 基准（严格对齐 `docs/火星任务/视觉基准图/三视图/KIBO-引导机器人-三视图.png`）：
 * - 正面朝 +z，总高 ≈ 2.6（脚底 y=0 → 头顶 y=2.6，对齐 stage 的 KIBO_HEAD_OFFSET）。
 * - 头高 ≈ 0.86，约占全高 1/3（chibi 比例）。
 * - 屏幕 + 橙色 bezel 是**圆角矩形**（ExtrudeGeometry + 圆角 Shape），非直角 box。
 * - 头部宽扁圆角"头盔"，正面被扁平的屏幕组件压平（不是纯球）。
 * - 耳罩：青色发光中心 + 深灰外圈。
 * - 手是**深色手套**（kiboDark），脚是**白靴 + 橙底**。
 * - 橙色点睛：bezel / 肩盖 / 胸甲 U 形饰线 / 腰带 / 袖口 / 膝环 / 靴口 / 靴底。
 * - 青色点睛：耳罩中心 / 胸口能量核心。
 *
 * 统一使用 `createCelMaterial` + `addSilhouetteOutline`。
 */
import {
  BoxGeometry,
  CapsuleGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  Path,
  Shape,
  SphereGeometry,
  TorusGeometry,
  type Texture,
} from 'three'
import { PALETTE } from './palette'
import { addSilhouetteOutline, createCelMaterial, noOutline } from './celMaterial'
import { localYawToward, worldToLocalDir } from './orientation'
import { setLayerRecursive, NO_EDGE_LAYER, NO_SOBEL_LAYER } from './postfx'

function mat(hex: string, ramp: Texture, emissive = 0) {
  const m = createCelMaterial(hex, ramp)
  if (emissive) m.uniforms.uEmissive.value = emissive
  return m
}

function box(w: number, h: number, d: number, hex: string, ramp: Texture, emissive = 0): Mesh {
  return new Mesh(new BoxGeometry(w, h, d), mat(hex, ramp, emissive))
}

function cyl(r: number, h: number, hex: string, ramp: Texture, seg = 12): Mesh {
  return new Mesh(new CylinderGeometry(r, r, h, seg), mat(hex, ramp))
}

/**
 * 往 target 写入一条圆角矩形外轮廓。Shape 与 Path 共享同一套曲线 API，
 * 因此外轮廓（Shape）与挖孔（Path）可以复用同一份实现。
 */
function addRoundedRect(
  target: Path,
  w: number,
  h: number,
  r: number,
): void {
  const x = -w / 2
  const y = -h / 2
  target.moveTo(x + r, y)
  target.lineTo(x + w - r, y)
  target.quadraticCurveTo(x + w, y, x + w, y + r)
  target.lineTo(x + w, y + h - r)
  target.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  target.lineTo(x + r, y + h)
  target.quadraticCurveTo(x, y + h, x, y + h - r)
  target.lineTo(x, y + r)
  target.quadraticCurveTo(x, y, x + r, y)
}

export type KiboPose = {
  x: number
  y: number
  z: number
  heading: number
  bob: number
  mood?: 'idle' | 'guide' | 'alert' | 'celebrate' | 'dance'
  pointAt?: { x: number; z: number }
}

const BLINK_PERIOD = 3.1
function hash01(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b1, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
function isBlinking(t: number): boolean {
  const seg = Math.floor(t / BLINK_PERIOD)
  const h = hash01(seg)
  if (h > 0.72) return false
  const at = 0.3 + hash01(seg ^ 0x5bf03635) * (BLINK_PERIOD - 0.6)
  const local = t - seg * BLINK_PERIOD
  return local >= at && local < at + 0.13
}

export type Kibo = {
  group: Group
  setPose: (p: KiboPose) => void
  setTime: (t: number) => void
  dispose: () => void
}

/** 手臂根节点（setPose 里复位用）。 */
const ARM_BASE_Y = 1.1
const ARM_BASE_X = 0.42

export function createKibo(ramp: Texture): Kibo {
  const root = new Group()
  root.name = 'Kibo'
  // 标记这是可交互的 NPC，供 stage.pickAt 命中后弹出 KIBO 对话面板。
  root.userData.npc = 'kibo'

  // 三视图约定：正面朝 +z（与通用资产一致，相机从 +z 拍摄）。
  const visual = new Group()
  visual.name = 'KiboVisual'
  root.add(visual)

  // ========== 头部（占全高约 54%，2 头身矮胖比例；用户 2026-09-02 反馈："矮矮胖胖 2 头身"）==========
  // 头壳：宽扁圆角"头盔"（不是纯球），正面由扁平的屏幕组件压平
  // 头壳：宽扁圆角"头盔"。2026-09-02 用户反馈"头太大"再缩：radius 0.70→0.55，
  // 脸（bezel+面罩+眼+嘴）尺寸不动，只缩小白色头壳 → 脸在头里的占比从 34% 提到 44%。
  const headGroup = new Group()
  const head = new Mesh(new SphereGeometry(0.55, 32, 28), mat(PALETTE.kiboBody, ramp))
  head.scale.set(1.08, 1.0, 0.96)
  // 头高 1.10（y 1.10→2.20），headGroup 中心 y=1.65 → 头顶 2.20、脚底 0
  headGroup.position.y = 1.65
  visual.add(headGroup)

  // 头盔主体
  headGroup.add(head)

  // --- 面部：大面积黑色弧形面罩 + 橙色 bezel（官方形象最核心的识别特征）。
  // 2026-09-02 主美续改：bezel 与面罩球冠的角域收窄（用户反馈"黑脸太大"），
  // 让面部特征在红框所示的较小区域内，眼睛与嘴的相对比例更接近参考。
  // 2026-09-03 用户反馈"脸悬浮在头外面"：之前 bezel z=0.66 / screen z=0.70 / eyes z=0.75 / smile z=0.75，
  // 但头壳 sphere scale.z=0.96，半径 0.55，前表面只到 z=0.528，脸部整体浮在头前 0.13~0.22m。
  // 改为把整个面件贴到头表面：bezel 紧贴头面 (z=0.52)，screen 在 bezel 前一档 (z=0.58)，
  // 双眼/嘴在 screen 前一档 (z=0.62)，整体看像是嵌在头上的屏幕，不再悬空。
  const screenW = 0.52
  const screenH = 0.42
  const screenR = 0.16
  const bezelShape = new Shape()
  addRoundedRect(bezelShape, screenW + 0.16, screenH + 0.16, screenR + 0.04)
  const bezelHole = new Path()
  addRoundedRect(bezelHole, screenW, screenH, screenR)
  bezelShape.holes.push(bezelHole)
  const bezelGeo = new ExtrudeGeometry(bezelShape, { depth: 0.05, bevelEnabled: false })
  bezelGeo.translate(0, 0, -0.025)
  const bezelFrame = new Mesh(bezelGeo, mat(PALETTE.kiboAccent, ramp))
  bezelFrame.position.set(0, 0.04, 0.52) // ← 从 0.66 贴到头表面 0.52
  bezelFrame.renderOrder = 1
  headGroup.add(noOutline(bezelFrame))

  // 黑色面罩：圆角矩形板，z 略凸在 bezel 之上（renderOrder 更高）
  const screenShape = new Shape()
  addRoundedRect(screenShape, screenW, screenH, screenR)
  const screenGeo = new ExtrudeGeometry(screenShape, { depth: 0.04, bevelEnabled: false })
  screenGeo.translate(0, 0, -0.02)
  const screen = new Mesh(screenGeo, mat(PALETTE.kiboDark, ramp))
  screen.position.set(0, 0.04, 0.58) // ← 从 0.70 收到 0.58
  screen.renderOrder = 2
  headGroup.add(noOutline(screen))

  // 双眼：竖椭圆发光黄眼（按红框比例缩小约 40%），贴面罩正前方
  const eyeGeo = new SphereGeometry(0.058, 16, 14)
  const eyeMat = mat(PALETTE.kiboEye, ramp, 0.95)
  const eyeL = new Mesh(eyeGeo, eyeMat)
  eyeL.scale.set(1.0, 1.5, 0.4)
  eyeL.position.set(-0.10, 0.14, 0.62) // ← 从 0.75 收到 0.62
  headGroup.add(noOutline(eyeL))
  const eyeR = new Mesh(eyeGeo, eyeMat)
  eyeR.scale.set(1.0, 1.5, 0.4)
  eyeR.position.set(0.10, 0.14, 0.62) // ← 从 0.75 收到 0.62
  headGroup.add(noOutline(eyeR))

  // 嘴：半圆环（arc=π）绕 X 轴翻 180°，从正面看是下弯的"∪"形水平微笑。
  // 之前的 rotation.y=π/2 把环旋到 YZ 面，所以显示成竖的一条线。
  const smile = new Mesh(new TorusGeometry(0.085, 0.015, 8, 20, Math.PI), mat(PALETTE.kiboMouth, ramp, 0.9))
  smile.rotation.x = Math.PI
  smile.position.set(0, -0.08, 0.62) // ← 从 0.75 收到 0.62
  headGroup.add(noOutline(smile))

  // 耳罩：橙色圆盘 + 青色发光中心。头更大后移到 x=±0.66
  for (const side of [-1, 1]) {
    const earRDisc = cyl(0.16, 0.06, PALETTE.kiboAccent, ramp, 22)
    earRDisc.rotation.z = side * Math.PI / 2
    earRDisc.position.set(side * 0.66, 0.04, 0.03)
    headGroup.add(noOutline(earRDisc))
    const earCore = cyl(0.095, 0.06, PALETTE.kiboVisor, ramp, 20)
    earCore.rotation.z = side * Math.PI / 2
    earCore.position.set(side * 0.668, 0.04, 0.03)
    earCore.material = mat(PALETTE.kiboVisor, ramp, 0.75)
    headGroup.add(noOutline(earCore))
  }

  // 头顶橙色分模线（头更大，y 抬到 0.65）
  const topStripe = box(0.08, 0.028, 0.34, PALETTE.kiboAccent, ramp)
  topStripe.position.set(0, 0.65, 0.03)
  headGroup.add(noOutline(topStripe))

  // ========== 颈（矮胖 2 头身：颈更短、领口橙环贴近肩）==========
  const neck = cyl(0.08, 0.07, PALETTE.kiboJoint, ramp, 14)
  neck.position.y = 1.10
  visual.add(neck)
  const collar = new Mesh(new TorusGeometry(0.32, 0.035, 8, 24), mat(PALETTE.kiboAccent, ramp))
  collar.rotation.x = Math.PI / 2
  collar.position.y = 1.05
  visual.add(noOutline(collar))

  // ========== 躯干（矮胖 2 头身：y 0.6→1.1，高 0.5，圆胖球体）==========
  const torso = new Group()
  torso.position.y = 0.85
  visual.add(torso)

  // 胸腔：圆胖球体（chibi 标志性球状身体）
  const chest = new Mesh(new SphereGeometry(0.32, 20, 16), mat(PALETTE.kiboBody, ramp))
  chest.scale.set(1.0, 0.78, 0.92)
  torso.add(chest)

  // 胸口能量核心：橙色外环 + 青色发光圆 + 深色中心点（随身体缩小）
  const coreRing = new Mesh(new TorusGeometry(0.14, 0.025, 8, 26), mat(PALETTE.kiboAccent, ramp))
  coreRing.position.set(0, 0.06, 0.255)
  torso.add(noOutline(coreRing))
  const chestDisc = cyl(0.105, 0.045, PALETTE.kiboVisor, ramp, 20)
  chestDisc.rotation.x = Math.PI / 2
  chestDisc.position.set(0, 0.06, 0.25)
  chestDisc.material = mat(PALETTE.kiboVisor, ramp, 0.8)
  torso.add(noOutline(chestDisc))
  const coreDot = cyl(0.038, 0.045, PALETTE.kiboDark, ramp, 16)
  coreDot.rotation.x = Math.PI / 2
  coreDot.position.set(0, 0.06, 0.258)
  torso.add(noOutline(coreDot))
  // 核心两侧橙色小圆点
  for (const side of [-1, 1]) {
    const dot = new Mesh(new SphereGeometry(0.035, 10, 8), mat(PALETTE.kiboAccent, ramp, 0.3))
    dot.position.set(side * 0.18, 0.14, 0.24)
    torso.add(noOutline(dot))
  }

  // 腰部橙带（贴近身体下半）
  const waistBand = new Mesh(new TorusGeometry(0.30, 0.028, 8, 24), mat(PALETTE.kiboAccent, ramp))
  waistBand.rotation.x = Math.PI / 2
  waistBand.position.set(0, -0.21, 0)
  torso.add(noOutline(waistBand))

  // ========== 手臂（2 头身矮胖：肩到胯部，总长约 0.5，呈轻微弧线状）==========
  function createArm(isRight: boolean) {
    const arm = new Group()
    const side = isRight ? 1 : -1

    // 肩：橙色肩盖 + 白色肩甲
    const shoulderCap = new Mesh(new SphereGeometry(0.10, 14, 12), mat(PALETTE.kiboAccent, ramp))
    arm.add(noOutline(shoulderCap))
    const pauldron = new Mesh(new SphereGeometry(0.125, 14, 12), mat(PALETTE.kiboBody, ramp))
    pauldron.scale.set(1, 0.95, 0.9)
    pauldron.position.set(0, -0.03, 0)
    arm.add(pauldron)

    const upperArm = new Mesh(new CapsuleGeometry(0.08, 0.10, 8, 14), mat(PALETTE.kiboBody, ramp))
    upperArm.position.set(0, -0.13, 0)
    arm.add(upperArm)

    const elbow = new Mesh(new SphereGeometry(0.06, 14, 12), mat(PALETTE.kiboBody, ramp))
    // 肘向外微凸，让手臂有弧线感（参考官方效果图的姿态）
    elbow.position.set(side * 0.05, -0.22, 0)
    arm.add(elbow)

    const foreArm = new Mesh(new CapsuleGeometry(0.07, 0.10, 8, 14), mat(PALETTE.kiboBody, ramp))
    foreArm.position.set(side * 0.03, -0.31, 0)
    arm.add(foreArm)

    // 袖口橙环
    const cuff = cyl(0.09, 0.035, PALETTE.kiboAccent, ramp, 14)
    cuff.position.set(0, -0.40, 0)
    arm.add(noOutline(cuff))

    // 深色手套手（三视图：手是深色）
    const hand = new Mesh(new SphereGeometry(0.095, 14, 12), mat(PALETTE.kiboDark, ramp))
    hand.scale.set(0.9, 1.0, 0.85)
    // 手略往内收，配合肘外凸形成完整弧线
    hand.position.set(-side * 0.015, -0.48, 0)
    arm.add(noOutline(hand))
    // 拇指外撇
    const thumb = new Mesh(new CapsuleGeometry(0.024, 0.05, 6, 8), mat(PALETTE.kiboDark, ramp))
    thumb.position.set(-side * 0.055, -0.46, 0.05)
    thumb.rotation.z = side * 0.5
    arm.add(noOutline(thumb))

    arm.position.set(side * ARM_BASE_X, ARM_BASE_Y, 0)
    return arm
  }

  const rightArm = createArm(true)
  rightArm.name = 'rightArm'
  visual.add(rightArm)

  const leftArm = createArm(false)
  leftArm.name = 'leftArm'
  visual.add(leftArm)

  // ========== 腿（2 头身矮胖：髋 y=0.6 → 靴底 y=0，总高 0.6）==========
  function createLeg(isRight: boolean) {
    const leg = new Group()
    const side = isRight ? 1 : -1

    // 髋 + 膝：深灰（短，仅占腿上段一小段）
    const hip = new Mesh(new SphereGeometry(0.10, 14, 12), mat(PALETTE.kiboJoint, ramp))
    leg.add(hip)
    const knee = new Mesh(new SphereGeometry(0.075, 14, 12), mat(PALETTE.kiboJoint, ramp))
    knee.position.set(0, -0.10, 0)
    leg.add(knee)

    // 白靴（矮胖，主导）：矮胶囊坐在橙底之上
    const boot = new Mesh(new CapsuleGeometry(0.16, 0.10, 8, 14), mat(PALETTE.kiboBody, ramp))
    boot.position.set(0, -0.32, 0.03)
    leg.add(boot)
    // 橙色靴头（前掌）
    const toe = new Mesh(new SphereGeometry(0.12, 16, 14), mat(PALETTE.kiboAccent, ramp))
    toe.scale.set(1.0, 0.6, 0.8)
    toe.position.set(0, -0.46, 0.12)
    leg.add(noOutline(toe))
    // 橙色靴底（底面 local y=-0.575 → 世界 y=0）
    const sole = box(0.28, 0.05, 0.38, PALETTE.kiboAccent, ramp)
    sole.position.set(0, -0.575, 0.04)
    leg.add(noOutline(sole))

    leg.position.set(side * 0.20, 0.6, 0)
    return leg
  }

  const rightLeg = createLeg(true)
  rightLeg.name = 'rightLeg'
  visual.add(rightLeg)

  const leftLeg = createLeg(false)
  leftLeg.name = 'leftLeg'
  visual.add(leftLeg)

  // ========== 描边 ==========
  // 整体外部轮廓描边：只保留最外层剪影，零件内部不出黑线。
  addSilhouetteOutline(visual, {
    thickness: (r) => Math.max(0.10, Math.min(0.32, r * 0.15)),
    skipSmall: 0.15,
  })
  // KIBO 整组挪到 NO_EDGE_LAYER，避开 postfx 屏幕空间 Sobel：
  // 否则面罩、头身接缝、手臂关节等法线差大的地方会被 Sobel 勾出内部黑线，
  // 看起来很"脏"。只保留 addSilhouetteOutline 那一道单一外轮廓。
  setLayerRecursive(visual, NO_SOBEL_LAYER)

  // ========== 状态 ==========
  let baseY = 0
  let baseYaw = 0
  let curMood: KiboPose['mood'] = 'idle'
  let curArmYaw = 0

  const setPose = (p: KiboPose) => {
    baseY = p.y + p.bob
    baseYaw = p.heading
    root.position.set(p.x, baseY, p.z)
    root.rotation.y = baseYaw
    curMood = p.mood ?? 'idle'

    rightArm.rotation.set(0, 0, 0)
    leftArm.rotation.set(0, 0, 0)
    rightArm.position.set(ARM_BASE_X, ARM_BASE_Y, 0)
    leftArm.position.set(-ARM_BASE_X, ARM_BASE_Y, 0)

    if (curMood === 'guide') {
      // 2026-09-02 用户反馈"一只手总抬起"：guide 模式不再抬臂指向。
      // 指向完全靠整身 `heading`（已在 setPose 外由 headingToward 驱动），
      // 双手锁定在 idle 弧线位。
      // 同时清掉之前用于"挥手指向"的 curArmYaw 状态，避免残留抖动。
      curArmYaw = 0
      rightArm.rotation.set(0, 0, -0.18)
      rightArm.position.set(ARM_BASE_X, ARM_BASE_Y, 0)
      leftArm.rotation.set(0, 0, 0.18)
      leftArm.position.set(-ARM_BASE_X, ARM_BASE_Y, 0)
    } else if (curMood === 'celebrate') {
      rightArm.rotation.z = -2.4
      leftArm.rotation.z = 2.4
    } else if (curMood === 'alert') {
      rightArm.rotation.z = -0.6
      rightArm.rotation.x = -0.6
      leftArm.rotation.z = 0.6
      leftArm.rotation.x = -0.6
    } else {
      // idle 与 dance：自然站姿——双臂完全自然垂放在两侧，呈轻微弧线状
      // （参考官方效果图的姿态：r.z 微小外撇 + 肘部外凸 + 手微收，形成弧线）。
      // 用户 2026-09-02 反馈："双臂都要往下放，双手垂放在两侧，呈一个弧线状"。
      rightArm.rotation.set(0, 0, -0.18)
      rightArm.position.set(ARM_BASE_X, ARM_BASE_Y, 0)
      leftArm.rotation.set(0, 0, 0.18)
      leftArm.position.set(-ARM_BASE_X, ARM_BASE_Y, 0)
    }
  }

  const setTime = (t: number) => {
    // 眨眼：竖椭圆黄眼 scale.y 短暂压扁（base 1.5，blink 时压到 0.14）
    const blink = isBlinking(t)
    const eyeOpenY = blink ? 0.14 : 1.5
    eyeL.scale.y = eyeOpenY
    eyeR.scale.y = eyeOpenY
    // 胸口核心呼吸脉冲
    chestDisc.material = mat(PALETTE.kiboVisor, ramp, 0.6 + 0.25 * Math.sin(t * 1.8))

    if (curMood === 'alert') {
      root.position.y = baseY + Math.sin(t * 12) * 0.03
      root.rotation.y = baseYaw + Math.sin(t * 16) * 0.05
    } else if (curMood === 'celebrate') {
      // 庆祝：原地小幅蹦跳 + 双臂上举，绝不自转（曾因 t*1.2 永久旋转 → "不停转圈"）
      root.position.y = baseY + Math.abs(Math.sin(t * 3.2)) * 0.12
      root.rotation.y = baseYaw
    } else if (curMood === 'dance') {
  // 偶尔跳一小段搞笑舞蹈：身体左右摇 + 原地蹦 + 头轻摇。
  // 双手**始终保持在两侧**（不再举到肩高），用户 2026-09-02 反馈：
  // "kibo的一只手始终处于抬起来的状态，要改为两只手都是放在两侧"。
      const u = t * 5.5
      root.position.y = baseY + Math.abs(Math.sin(u)) * 0.14
      root.rotation.y = baseYaw + Math.sin(u * 0.5) * 0.30
      // 双手锁定在 idle 弧线位（r.z=±0.18），不举起来
      rightArm.rotation.set(0, 0, -0.18)
      rightArm.position.set(ARM_BASE_X, ARM_BASE_Y, 0)
      leftArm.rotation.set(0, 0, 0.18)
      leftArm.position.set(-ARM_BASE_X, ARM_BASE_Y, 0)
      // 手臂极轻的前后摆动（不脱离两侧）
      rightArm.rotation.x = Math.cos(u) * 0.10
      leftArm.rotation.x = Math.cos(u + Math.PI) * 0.10
    } else if (curMood === 'idle') {
      // 轻微呼吸 + 头微动，双臂保持下垂不再有任何摆动。
      root.position.y = baseY + Math.sin(t * 1.2) * 0.012
      root.rotation.y = baseYaw + Math.sin(t * 0.6) * 0.04
    } else {
      root.position.y = baseY
      root.rotation.y = baseYaw
    }
  }

  const dispose = () => {
    root.traverse((o) => {
      const m = o as Mesh
      if (m.isMesh) {
        m.geometry.dispose()
        const mm = m.material
        if (Array.isArray(mm)) mm.forEach((x) => x.dispose())
        else mm.dispose()
      }
    })
  }

  return { group: root, setPose, setTime, dispose }
}
