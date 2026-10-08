/**
 * 场景内 POI 信标（游戏化任务的关键可读层）。
 *
 * 这是本轮"让玩家看得懂要干什么"的核心：之前 POI 只存在于任务逻辑里，
 *   D 场景里没有任何可见标记，玩家不知道该往哪走、哪里能交互。
 *
 * 每个 POI 在地面上立一根"信标"：贴地脉冲环 + 竖直光柱 + 悬浮旋转光环 + 文字标签。
 * 玩家靠近时（进入交互半径）整组信标会高亮放大，配合 KIBO 提示与 HUD 交互条，
 * 把"探索 → 交互 → 采集/清洗/标注/训练/选路"的循环在画面里立起来。
 *
 * 信标不进入屏幕空间 Sobel 描边层（NO_EDGE_LAYER），否则半透明几何体勾线会脏。
 */
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  TorusGeometry,
  type Camera,
} from 'three'
import type { HeightField } from '../core/heightField'
import type { Poi, PoiKind, ScanCandidate } from '../core/mission'
import { NO_EDGE_LAYER, setLayerRecursive } from './postfx'

/** POI 按类型配色。3D 信标、小地图、HUD 交互条共用，保证"同一种东西一种颜色"。 */
export const POI_COLOR: Record<PoiKind, string> = {
  'base-clean': '#6fb8ff',
  'base-label': '#6fb8ff',
  'base-train': '#6fb8ff',
  'base-select': '#6fb8ff',
  'sample-a': '#5fd38a',
  'sample-b': '#5fd38a',
  'sample-c': '#5fd38a',
  'maze-entrance': '#c08bff',
  'energy-station': '#ffd24a',
}

/** 已交互完成的地标改成醒目的"完成色"，配合标签上的 ✓ 让用户一眼看出做过了。 */
export const COMPLETED_COLOR = '#3fe089'

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** 把标签画进 canvas：深色玻璃底 + 描边（完成态用完成色）+ 白字（完成态前缀 ✓）。 */
function paintLabel(canvas: HTMLCanvasElement, text: string, hex: string, done: boolean) {
  const w = canvas.width
  const h = canvas.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = 'rgba(18,12,26,0.78)'
  roundRect(ctx, 4, 4, w - 8, h - 8, 14)
  ctx.fill()
  ctx.lineWidth = 4
  ctx.strokeStyle = done ? COMPLETED_COLOR : hex
  roundRect(ctx, 4, 4, w - 8, h - 8, 14)
  ctx.stroke()
  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 38px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(done ? `✓ ${text}` : text, w / 2, h / 2 + 2)
}

/** 用 canvas 画一张"深色玻璃底 + 同色描边 + 白字"的标签贴图，挂成永远朝向相机的 Sprite。 */
/**
 * @param y 标签悬浮高度。**缺省 10.5**（一号原值，零回归）。
 *   2026-09-10 老大反馈第 8 条「UI 标记位置太低，应移到光柱顶部」：
 *   原先这里**硬编码 10.5**，会覆盖调用方按 `Poi.labelHeight` 算出的高度，
 *   导致 labelHeight 字段**实际不生效**。改为可传参后字段才真正起作用。
 */
function makeLabel(text: string, hex: string): Sprite {
  const w = 360
  const h = 80
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  paintLabel(canvas, text, hex, false)
  const tex = new CanvasTexture(canvas)
  tex.anisotropy = 4
  const mat = new SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false })
  const sprite = new Sprite(mat)
  const aspect = w / h
  // 「标记 UI 框」整体偏大，按需求缩小 50%（5.2 → 2.6），与火星车比例更协调。
  const baseH = 2.6
  sprite.scale.set(baseH * aspect, baseH, 1)
  sprite.position.y = 5.25
  sprite.userData.aspect = aspect
  sprite.userData.baseH = baseH
  // 标签始终可见（关 depthTest，不会被建筑/地形遮进缝隙里"凭空消失"）。
  sprite.visible = true
  return sprite
}

type Marker = {
  id: string
  kind: PoiKind
  group: Group
  groundRing: Mesh
  beam: Mesh
  /** 能源站与扫描候选点标记重叠，不再单独显示 POI 标签。 */
  label?: Sprite
  color: Color
  /** 标签文字，供完成后重绘（加 ✓）。 */
  text: string
  /** 是否已交互完成（变色提示）。 */
  done: boolean
  active: boolean
}

export type PoiMarkers = {
  group: Group
  update: (dt: number, camera: Camera) => void
  /** 高亮某个 POI（玩家进入其交互半径时调用），传 null 取消高亮。 */
  setActive: (id: string | null) => void
  /** 根据已完成的 POI id 集合变色提示（按住 E 交互成功后调用）。 */
  setCompleted: (ids: Set<string>) => void
  setVisible: (v: boolean) => void
  dispose: () => void
}

/** 为给定 POI 列表在场景中建立信标。坐标固定，整个任务期内只建一次。 */
export function createPoiMarkers(field: HeightField, pois: Poi[]): PoiMarkers {
  const root = new Group()
  root.name = 'PoiMarkers'
  const markers: Marker[] = []

  for (const p of pois) {
    const hex = POI_COLOR[p.kind] ?? '#ffffff'
    const color = new Color(hex)
    const gy = field.heightAt(p.x, p.z)
    const g = new Group()
    g.position.set(p.x, gy, p.z)
    g.name = `poi-${p.id}`

    // 基础几何很小：非激活时只是"地面上一颗有色小点"；激活时再放大，避免集群互相糊成一片。
    // polygonOffset 把底环深度稍向相机偏，避免被同高度的地形/碎石 z-fight 抢深度。
    const groundRing = new Mesh(
      new RingGeometry(0.95, 1.35, 64),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.55,
        side: DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    )
    groundRing.rotation.x = -Math.PI / 2
    groundRing.position.y = 0.25
    groundRing.renderOrder = 5

    const beam = new Mesh(
      new CylinderGeometry(0.25, 0.25, 12, 10, 1, true),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.08,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
      }),
    )
    beam.position.y = 6

    // 能源站（kind === 'energy-station'）同时是扫描候选点"target"的标记，
    // 两者会重叠成两个"能源站"标签。保留较大的扫描候选点标签，隐藏 POI 小标签。
    let label: Sprite | undefined
    if (p.kind !== 'energy-station') {
      // 标签基础高度：一号样本站地标（三角洲沉积岩塔）高约 13.5m，标签在塔顶上方一点；
      // 基地操作台等较矮，保持 13.5m。
      // 二号三个样本站高度差极大（巨砾 8.5m / 剖面 14m / 水冰点贴地），
      // 由 `Poi.labelHeight` 显式指定；一号不传 → 仍走旧规则（零回归）。
      // **信标光柱 beam 的中心在 y=6（顶部约 12m）**，故二号统一取 13 —— 标签落在光柱顶端，
      // 不再是"卡在光柱中部"（老大第 8 条）。
      const labelBaseY = p.labelHeight ?? (p.kind.startsWith('sample-') ? 16.5 : 13.5)
      label = makeLabel(p.label, hex)
      label.position.y = labelBaseY
      label.userData.baseY = labelBaseY
    }

    // 隐形点击体：半径 ~2.6、高 14 的圆柱，覆盖整根光柱，专供鼠标拾取（见 stage.pickAt）。
    // 透明不可见但参与 raycast，让"点标记"有舒服的命中范围，不必精确戳中细光柱。
    const hit = new Mesh(
      new CylinderGeometry(2.6, 2.6, 14, 8),
      new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    )
    hit.position.y = 7
    hit.name = `poi-hit-${p.id}`

    // 不再创建上方悬浮小光圈（halo）——用户反馈 y=4.2 那圈 Torus 太细看不清，
    // 改用底部大光圈 + 呼吸动效承担"选中"提示。
    g.add(groundRing, beam, hit)
    if (label) g.add(label)
    // 把 POI 身份写进 group 与点击体，供拾取时回查。
    g.userData.poiId = p.id
    g.userData.poiKind = p.kind
    g.userData.poi = p
    hit.userData.poiId = p.id
    root.add(g)
    markers.push({ id: p.id, kind: p.kind, group: g, groundRing, beam, label, color, text: p.label, done: false, active: false })
  }

  // 信标是 UI 层，不参与屏幕空间 Sobel 描边，否则半透明光柱会被勾出脏线。
  setLayerRecursive(root, NO_EDGE_LAYER)

  const kindBaseScale = (kind: PoiKind): number => {
    // 基地操作台集中在一小片区域，非激活时要保持"小点"避免糊成一片；
    // 样本站、迷阵入口、能源站彼此相距远，需要大一点才能从远处被看见。
    if (kind.startsWith('base-')) return 0.85
    if (kind.startsWith('sample-')) return 2.2
    if (kind === 'maze-entrance') return 1.8
    return 2.2 // energy-station
  }

  let time = 0
  const update = (dt: number, _camera: Camera) => {
    time += dt
    for (const m of markers) {
      // 呼吸节律比之前（2.2 rad/s）更慢，1.5 rad/s ≈ 0.66 Hz，更接近"呼吸"
      const pulse = 0.5 + 0.5 * Math.sin(time * 1.5)
      const gm = m.groundRing.material as MeshBasicMaterial
      // 完成后统一用完成色，否则用类型色；颜色每帧刷新，便于随完成态来回切换。
      const ringColor = m.done ? COMPLETED_COLOR : '#' + m.color.getHexString()
      gm.color.set(ringColor)
      // 底环：非激活按类型基础尺寸（小点），激活放大到 5× 基半径（4.75~6.75m 半径，
      // 略宽于样本站基座最大半径 5.3m）+ 明显呼吸缩放，让"被选中"一眼可辨。
      const baseScale = m.active ? 5.0 : kindBaseScale(m.kind)
      const ringScale = baseScale * (m.active ? 1.0 + pulse * 0.2 : 1.0 + pulse * 0.08)
      m.groundRing.scale.setScalar(ringScale)
      // 透明度：激活态呼吸（0.55~0.95）保持动效；非激活平滑过渡到稳态（完成 0.8 / 默认 0.45）
      if (m.active) {
        gm.opacity = 0.55 + pulse * 0.4
      } else {
        gm.opacity += ((m.done ? 0.8 : 0.45) - gm.opacity) * 0.15
      }
      const bm = m.beam.material as MeshBasicMaterial
      bm.color.set(ringColor)
      bm.opacity = (m.active ? 0.5 : 0.12) + pulse * 0.04
      // 标签始终可见（关 depthTest + 顶在光柱上方，不会被建筑吞掉）。
      // 能源站等部分 POI 不显示独立标签，避免与扫描候选点标签重叠。
      if (m.label) {
        m.label.visible = true
        const labelBaseY = (m.label.userData.baseY as number) ?? 13.5
        m.label.position.y = labelBaseY + Math.sin(time * 1.5 + m.group.position.x * 0.1) * 0.3
        const s = m.active ? 1.45 : 1
        const aspect = (m.label.userData.aspect as number) ?? 360 / 80
        const baseH = (m.label.userData.baseH as number) ?? 2.6
        m.label.scale.set(baseH * aspect * s, baseH * s, 1)
      }
    }
  }

  const setActive = (id: string | null) => {
    for (const m of markers) m.active = m.id === id
  }

  const setCompleted = (ids: Set<string>) => {
    for (const m of markers) {
      const done = ids.has(m.id)
      if (done !== m.done) {
        m.done = done
        if (m.label) {
          const tex = m.label.material.map as CanvasTexture
          const canvas = tex.image as HTMLCanvasElement
          paintLabel(canvas, m.text, '#' + m.color.getHexString(), done)
          tex.needsUpdate = true
        }
      }
    }
  }

  const setVisible = (v: boolean) => {
    root.visible = v
  }

  const dispose = () => {
    root.traverse((o) => {
      const mesh = o as Mesh
      if ((mesh as unknown as { geometry?: { dispose?: () => void } }).geometry) {
        ;(mesh as unknown as { geometry: { dispose: () => void } }).geometry.dispose()
      }
      const mat = (mesh as unknown as { material?: unknown }).material
      if (Array.isArray(mat)) (mat as Array<{ dispose: () => void }>).forEach((m) => m.dispose())
      else if (mat) (mat as { dispose: () => void }).dispose()
      const sp = o as Sprite
      if (sp.isSprite && sp.material.map) sp.material.map.dispose()
    })
  }

  return { group: root, update, setActive, setCompleted, setVisible, dispose }
}

/** 侦察阶段扫描候选点标记（游戏化目标提示）。 */
export type ScanCandidateMarkers = {
  group: Group
  /** 只在侦察阶段显示 */
  setVisible: (v: boolean) => void
  update: (dt: number) => void
  /** 根据已扫描的候选 id 集合切换箭头颜色（橘黄→绿）。 */
  setScanned: (ids: Set<string>) => void
  dispose: () => void
}

const SCAN_CANDIDATE_COLOR = '#aee6ff'
/** 扫描候选提示箭头（倒三角）：未扫描=醒目橘黄，已扫描=绿。 */
const SCAN_ARROW_ORANGE = '#ff8a1e'
const ARROW_BASE_H = 2.4
const ARROW_ASPECT = 128 / 104
/** 箭头基准高度（在 UI 标记框上方）。 */
const ARROW_BASE_Y = 12.8

function makeScanCandidateLabel(text: string): Sprite {
  const w = 320
  const h = 72
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(12,18,28,0.78)'
    roundRect(ctx, 4, 4, w - 8, h - 8, 12)
    ctx.fill()
    ctx.lineWidth = 3
    ctx.strokeStyle = SCAN_CANDIDATE_COLOR
    roundRect(ctx, 4, 4, w - 8, h - 8, 12)
    ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.font = 'bold 32px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, w / 2, h / 2 + 2)
  }
  const tex = new CanvasTexture(canvas)
  tex.anisotropy = 4
  const mat = new SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false })
  const sprite = new Sprite(mat)
  const aspect = w / h
  const baseH = 4.8
  sprite.scale.set(baseH * aspect, baseH, 1)
  // 注意：这里的高度只是初值，**调用方随后会用 `Poi.labelHeight` 覆盖**
  // （见 createPoiMarkers 里的 label.position.y = labelBaseY）。
  // 2026-09-10 老大第 8 条「UI 标记应移到光柱顶部」由调用方的 labelBaseY 决定：
  // 信标光柱 beam 中心在 y=6（顶部约 12m），故二号统一取 13。
  sprite.position.y = 10.5
  return sprite
}

/**
 * 扫描候选提示箭头：一个朝向相机的"倒三角"（尖端朝下，指向标记地点）。
 * 白底绘制 + 轻描边，运行时靠 SpriteMaterial.color 染色（未扫描橘黄 / 已扫描绿），
 * 避免每帧重绘 canvas。放在 UI 标记框上方，循环跳动吸引注意。
 */
function makeScanArrow(): Sprite {
  const w = 128
  const h = 104
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (ctx) {
    ctx.clearRect(0, 0, w, h)
    // 倒三角：尖端朝下指向标记点。
    ctx.beginPath()
    ctx.moveTo(w * 0.5, h * 0.94)
    ctx.lineTo(w * 0.1, h * 0.1)
    ctx.lineTo(w * 0.9, h * 0.1)
    ctx.closePath()
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.lineWidth = 6
    ctx.strokeStyle = 'rgba(110,55,0,0.5)'
    ctx.stroke()
  }
  const tex = new CanvasTexture(canvas)
  tex.anisotropy = 4
  const mat = new SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    color: new Color(SCAN_ARROW_ORANGE),
  })
  const sprite = new Sprite(mat)
  sprite.scale.set(ARROW_BASE_H * ARROW_ASPECT, ARROW_BASE_H, 1)
  return sprite
}

/** 在场景中建立侦察阶段候选扫描点的可见标记，让玩家"看到该往哪开"。 */
export function createScanCandidateMarkers(field: HeightField, candidates: ScanCandidate[]): ScanCandidateMarkers {
  const root = new Group()
  root.name = 'ScanCandidateMarkers'
  root.visible = false

  const color = new Color(SCAN_CANDIDATE_COLOR)
  const entries: { id: string; group: Group; halo: Mesh; groundRing: Mesh; arrow: Sprite; scanned: boolean }[] = []

  for (const c of candidates) {
    const gy = field.heightAt(c.x, c.z)
    const g = new Group()
    g.position.set(c.x, gy, c.z)
    g.name = `scan-cand-${c.id}`

    const groundRing = new Mesh(
      new RingGeometry(1.2, 1.7, 32),
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: DoubleSide, depthWrite: false }),
    )
    groundRing.rotation.x = -Math.PI / 2
    groundRing.position.y = 0.08

    const pole = new Mesh(
      new CylinderGeometry(0.06, 0.06, 4.5, 8),
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false }),
    )
    pole.position.y = 2.25

    const diamond = new Mesh(
      new ConeGeometry(0.55, 1.1, 4),
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }),
    )
    diamond.position.y = 5.0
    diamond.rotation.y = Math.PI / 4

    const label = makeScanCandidateLabel(c.label)
    const arrow = makeScanArrow()
    arrow.position.y = ARROW_BASE_Y

    g.add(groundRing, pole, diamond, label, arrow)
    root.add(g)
    entries.push({ id: c.id, group: g, halo: diamond, groundRing, arrow, scanned: false })
  }

  setLayerRecursive(root, NO_EDGE_LAYER)

  let time = 0
  const update = (dt: number) => {
    time += dt
    for (const e of entries) {
      const pulse = 0.5 + 0.5 * Math.sin(time * 2.4 + e.group.position.x * 0.05)
      e.halo.rotation.y += dt * 1.2
      e.halo.scale.setScalar(1.0 + pulse * 0.15)
      const gm = e.groundRing.material as MeshBasicMaterial
      gm.opacity = 0.45 + pulse * 0.25
      // 倒三角箭头：循环跳动（y 弹跳 + 轻微缩放脉冲），已扫描转绿。
      const s = 1 + (0.5 + 0.5 * Math.sin(time * 3 + e.group.position.z * 0.05)) * 0.18
      e.arrow.position.y = ARROW_BASE_Y + Math.abs(Math.sin(time * 3 + e.group.position.x * 0.05)) * 0.7
      e.arrow.scale.set(ARROW_BASE_H * ARROW_ASPECT * s, ARROW_BASE_H * s, 1)
      ;(e.arrow.material as SpriteMaterial).color.set(e.scanned ? COMPLETED_COLOR : SCAN_ARROW_ORANGE)
    }
  }

  const setVisible = (v: boolean) => {
    root.visible = v
  }

  /** 根据已扫描的候选 id 集合切换箭头颜色（橘黄→绿）。 */
  const setScanned = (ids: Set<string>) => {
    for (const e of entries) e.scanned = ids.has(e.id)
  }

  const dispose = () => {
    root.traverse((o) => {
      const mesh = o as Mesh
      if ((mesh as unknown as { geometry?: { dispose?: () => void } }).geometry) {
        ;(mesh as unknown as { geometry: { dispose: () => void } }).geometry.dispose()
      }
      const mat = (mesh as unknown as { material?: unknown }).material
      if (Array.isArray(mat)) (mat as Array<{ dispose: () => void }>).forEach((m) => m.dispose())
      else if (mat) (mat as { dispose: () => void }).dispose()
      const sp = o as Sprite
      if (sp.isSprite && sp.material.map) sp.material.map.dispose()
    })
  }

  return { group: root, setVisible, update, setScanned, dispose }
}
