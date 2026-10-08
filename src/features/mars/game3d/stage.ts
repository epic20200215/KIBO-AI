/**
 * 3D 舞台装配：渲染器、场景、主循环、自适应画质。
 *
 * 这是 3D 部分唯一持有 WebGLRenderer 的地方。React 侧只负责挂载与卸载，
 * 不参与逐帧逻辑——避免把 60Hz 的状态变化灌进 React 渲染树。
 *
 * 任务逻辑不在这里。`core/mission.ts` 是任务本身，本文件只把它的状态
 * 翻译成画面：探明区变亮、路线丝带改形、漫游车在实测阶段才开动。
 */
import { DoubleSide, Group, Mesh, MeshBasicMaterial, Object3D, RingGeometry, Raycaster, Scene, Vector2, Vector3, WebGLRenderer } from 'three'
import { BASIN_SIZE, createHeightField, WORLD_SEEDS, type HeightField } from './core/heightField'
import { buildScanCandidates, createMission, SCAN_RADIUS, DRIVE_SPEED, type HaulerRun, type Mission, type MissionSnapshot, type Poi } from './core/mission'
import { applySunDirection } from './render/celMaterial'
import { BASE_AZIMUTH, BASE_DISTANCE, createCameraRig, DISTANCE_RANGE, ELEVATION, type CameraRig, type FlyoverStop } from './render/camera'
import { createKnowledgeTexture, type KnowledgeTexture } from './render/knowledgeTexture'
import { createLandmarks, type Landmarks } from './render/landmarks'
import { createKiboRampTexture, createRampTexture } from './render/ramp'
import { createReticle, type Reticle } from './render/reticle'
import { createSkyDome, type SkyDome } from './render/sky'
import { createTerrainRenderer, type TerrainRenderer } from './render/terrainMesh'
import { createRover, type Rover } from './render/rover'
import { createKibo, type Kibo, type KiboPose } from './render/kibo'
import { createRouteRibbon, type RouteRibbon } from './render/routeRibbon'
import { createCandidateRibbons, type CandidateRibbons } from './render/candidateRibbons'
import { createHauler, type Hauler } from './render/hauler'
import { createScanWave, type ScanWave } from './render/scanWave'
import { createDustSystem, type DustSystem } from './render/dust'
import { createTrackMask, type TrackMask } from './render/tracks'
import { createDustDevils, type DustDevilSet } from './render/dustDevil'
import { createDustStorm, type DustStorm } from './render/dustStorm'
// 2026-09-03 老大反馈：去掉近地面黄色雾霾；groundHaze 实现保留（groundHaze.ts）但本场景不再引入。
// import { createGroundHaze, type GroundHaze } from './render/groundHaze'
import { createPoiMarkers, createScanCandidateMarkers, type PoiMarkers, type ScanCandidateMarkers } from './render/pois'
import { createPostFX, setLayerRecursive, NO_EDGE_LAYER, NO_SOBEL_LAYER, type PostFX } from './render/postfx'
import { headingToward } from './render/orientation'

export type StageStats = {
  fps: number
  frameMs: number
  triangles: number
  drawCalls: number
  pixelRatio: number
  quality: QualityLevel
}

/** 画质分级。掉帧时自动下调，用于满足低端设备的性能底线。 */
export type QualityLevel = 'high' | 'medium' | 'low'

/**
 * 舞台需要的音频回调子集。
 *
 * 由 React 侧注入，stage 不直接持有 AudioContext——声音开关、浏览器手势解锁、
 * localStorage 偏好都属于宿主职责。stage 只负责"什么时候该响"。
 * 未注入时全链路静默，不影响任何画面逻辑。
 */
export type StageAudio = {
  playScan: () => void
  setEngine: (volume: number, intensity: number) => void
  playStuck: () => void
  playArrive: () => void
  playKibo: () => void
}

export type MarsStageOptions = {
  container: HTMLElement
  seed?: string
  /** 当前地图索引 0/1/2（A/B/C），决定使用 WORLD_SEEDS 中的哪个种子。 */
  worldIndex?: number
  reducedMotion?: boolean
  onStats?: (stats: StageStats) => void
  /** 连续低帧或 WebGL 丢失触发降级（显示诚实提示、停 3D 舞台）时回调 */
  onDegrade?: (reason: string) => void
  /** 任务状态变化（阶段、扫描预算、规划结果），供 HUD 订阅 */
  onMission?: (snapshot: MissionSnapshot) => void
  /** 扫描读条进度回调：扫描蓄力中返回 0..1，空闲/完成返回 null。供 HUD 画读条。 */
  onScanProgress?: (progress: number | null) => void
  /** POI 交互读条进度回调（样本站采集）：蓄力中返回 0..1，空闲/完成返回 null。 */
  onInteractProgress?: (progress: number | null) => void
  /** POI 交互读条走满：回传 POI id，由宿主真正执行采集（保证 UI 与逻辑一致）。 */
  onInteractComplete?: (poiId: string) => void
  /** 采集车跑完（成功回基地 / 中途失败）时回调，供宿主弹结果面板。 */
  onHaulerFinished?: (run: HaulerRun) => void
  /** 入场全景浏览播完（或跳过、或 reduced-motion 直接跳过）时回调，宿主据此收起字幕并交还操控。 */
  onIntroFlyoverDone?: () => void
  /** 音效回调。不传即静默。 */
  audio?: StageAudio
}

export type MarsStage = {
  field: HeightField
  mission: Mission
  rig: CameraRig
  scene: Scene
  sky: SkyDome
  terrain: TerrainRenderer
  landmarks: Landmarks
  rover: Rover
  kibo: Kibo
  ribbon: RouteRibbon
  /** 路径选择台打开时对比展示的 3 条候选路线丝带（保守/均衡/激进）。 */
  candidateRibbons: CandidateRibbons
  /** 能源采集车（选定路线后的穿越动画载体）。 */
  hauler: Hauler
  scan: ScanWave
  reticle: Reticle
  dust: DustSystem
  tracks: TrackMask
  devils: DustDevilSet
  storm: DustStorm
  // groundHaze 已停用（v1.3.4）：API 不再暴露
  /** 场景内 POI 信标（游戏化任务的可读层）。 */
  poiMarkers: PoiMarkers
  /** 侦察阶段候选扫描点标记（场景目标提示，减少纯 UI 列表依赖）。 */
  scanCandidateMarkers: ScanCandidateMarkers
  /** 屏幕空间 Sobel 描边后处理（low 画质自动关闭） */
  postfx: PostFX
  /** 世界层：路线丝带等继续挂在这里 */
  world: Group
  /** 在世界坐标处发射一次扫描（HUD 候选点按钮走这个入口） */
  scanAtWorld: (x: number, z: number) => boolean
  /** 把相机焦点移到某处，用于扫描后自动看向新探明区 */
  focusOn: (x: number, z: number) => void
  setReducedMotion: (on: boolean) => void
  setQuality: (level: QualityLevel) => void
  /** 进入手动驾驶（RPG 操控 / 实践测试）。 */
  enterManualDrive: () => void
  /** 退出手动驾驶，回到规划/自动模式。 */
  exitManualDrive: () => void
  /** 左键点地：拾取地面并把航点交给漫游车（自动驶向该点）。 */
  driveTo: (event: PointerEvent) => void
  /** 左键拾取分流：返回命中的对象类型（POI 标记 / KIBO NPC / 地面 / 无），host 据此弹面板或开车。 */
  pickAt: (event: PointerEvent) => PickHit
  /** 把漫游车开到指定世界坐标（候选扫描点 / 任务提示）：玩家随后开到位置按 E 扫描，而不是瞬间扫描。 */
  driveToPoint: (x: number, z: number) => void
  /** 第三人称跟随：相机焦点是否每帧锁定火星车（默认 true）。QA 截帧时关闭。 */
  setFollow: (on: boolean) => void
  /**
   * 播放入场全景浏览：镜头从终点（能源站）出发，快速掠过各个重要地点，
   * 最后降到 R-7 火星车上定格，随后交还操控。播放期间所有玩家输入被忽略。
   * reduced-motion 下直接跳过并返回 false。
   */
  playIntroFlyover: () => boolean
  /** 跳过入场浏览，立刻落到火星车跟车视角。 */
  skipIntroFlyover: () => void
  /** 入场浏览是否正在播放。 */
  introFlyoverActive: () => boolean
  /** 当前浏览站点的地名（用于 UI 字幕），未播放时返回 null。 */
  introFlyoverLabel: () => string | null
  /** 地图平移（WASD 移动镜头）输入：u 屏幕右(+)/左(-)，v 屏幕前/上(+)/后(-)。 */
  setCameraPanInput: (u: number, v: number) => void
  /** 扫描蓄力：在侦察阶段按 E 触发，以车身为圆心读条扫描。返回是否成功发起。 */
  startScanCharge: () => boolean
  /** POI 交互蓄力：靠近样本站按 E 触发采集读条，走满后由 options.onInteractComplete 回传 poiId。 */
  startInteractCharge: (poiId: string) => boolean
  /** 键盘/WASD 直接控车：throttle/steer ∈ [-1,1]。 */
  setManualInput: (throttle: number, steer: number) => void
  /** 供截图工装使用：把模拟时间推进到指定秒数并渲染一帧（不依赖真实时钟） */
  renderAtTime: (seconds: number) => void
  /** Part A(#167)：路径选择台打开时，把 3 条候选路线画成对比丝带。 */
  showCandidateRoutes: () => void
  /** Part A(#167)：高亮某条候选路线（选定后其余淡出）。 */
  highlightCandidate: (index: number) => void
  /** Part A(#167)：关闭选择台时清掉候选丝带，恢复主丝带。 */
  clearCandidateRoutes: () => void
  /** 派遣能源采集车沿指定候选路线往返（去程采集 → 返回基地）。自动驾驶，玩家不能操控。 */
  dispatchHauler: (candidateIndex: number) => boolean
  /** 能源采集车是否正在出勤。 */
  haulerActive: () => boolean
  /** 结束出勤：把采集车收回车库并复位（失败后重选路线时用）。 */
  recallHauler: () => void
  /**
   * KIBO 头顶在屏幕上的像素坐标，用于在 DOM 层挂感叹号标记。
   * KIBO 在相机背后或不可见时返回 null。
   */
  kiboScreenPosition: () => { x: number; y: number } | null
  /** KIBO 的世界坐标（含头顶偏移），供宿主把镜头转向它。 */
  kiboWorldPosition: () => { x: number; y: number; z: number }
  resize: () => void
  dispose: () => void
}

const PIXEL_RATIO_BY_QUALITY: Record<QualityLevel, number> = {
  // 纲领要求像素比上限 1.5，不追 retina 2.0
  high: 1.5,
  medium: 1.15,
  low: 0.85,
}

/** 实测阶段的行驶速度（米/秒）。演示用，不是教学数值。与 mission 的 DRIVE_SPEED 保持一致。 */
const ROVER_SPEED = DRIVE_SPEED

/**
 * 入场全景浏览的航线：从终点（能源站）倒着扫回起点，最后落在 R-7 上。
 *
 * 顺序按地理上的一条连续弧线排（东南 → 北 → 西 → 南 → 起点），
 * 不做来回折返，否则运镜像在乱飞、玩家建立不起空间感。
 * 单站 travel 0.8s / hold 0.42s，完整版约 9.6 秒——够看清每个地方，又不至于让人等。
 *
 * `brief=true` 是"已经看过一次"的精简版：只保留终点 → 主基地 → 火星车三站，约 3.6 秒。
 * 教学产品会被反复进入，每次都放 9 秒完整版是纯粹的摩擦；
 * 但完全跳过又会让玩家失去"我在哪儿"的锚点，所以留一个短版兜住空间感。
 */
function buildIntroRoute(field: HeightField, brief = false, worldIndex = 0): FlyoverStop[] {
  const start = field.start
  const goal = field.goal
  // 与 mission.ts 的 ROVER_SPAWN 保持一致：二号停靠位在基地东南（KIBO 旁）
  const rover =
    worldIndex === 1
      ? { x: start.x + 36, z: start.z + 34 }
      : { x: start.x, z: start.z + 44 }
  // 用户 2026-09-02 拍板：开局动画机位与跟车机位 (BASE_AZIMUTH=π) 相反，
  // 这样主基地落在终点左侧，镜头从屏幕右侧往左移动。
  // BASE_AZIMUTH 是跟车机位（车尾）；这里写死 0 表示"画面方向相反"。
  const a = 0
  // 浏览段抬高俯仰、拉远视距，形成"俯瞰全场"的观感；最后一站落回跟车机位。
  const overview = (x: number, z: number, label: string, dist: number, azOff: number): FlyoverStop => ({
    x,
    z,
    label,
    distance: dist,
    azimuth: a + azOff,
    elevation: 0.62,
    travel: 1.8,
    hold: 0.5,
  })
  /** 最后一站：降回第三人称跟车机位，定格在 R-7 上，随后交还操控。
   *  这一段刻意比巡游段慢（1.9s）——从俯瞰压到贴地是最容易"砸"下去的一下，
   *  给足时间才有"镜头稳稳落在车上"的重量感。 */
  const settleOnRover = (): FlyoverStop => ({
    x: rover.x,
    z: rover.z,
    label: 'R-7 火星车',
    distance: BASE_DISTANCE,
    azimuth: BASE_AZIMUTH,
    elevation: ELEVATION,
    travel: 1.9,
    hold: 0,
  })

  // -------------------------------------------------------------------------
  // 二号（外流河道）：站点**从真实地物 field.landmarks 读取**，地物坐标改了自动跟随。
  //
  // 2026-09-12 老大反馈「二号缺少开局动态镜头」：原实现 8 站里有 5 站硬编码了
  // **火星一号**的地物（岩石迷阵 / 采样点 C 坑缘溅射毯 / 主陨石坑坑缘 / 风成沙丘带 /
  // 采样点 A 河床沉积），二号是外流河道、根本没有陨石坑与沙丘带，镜头会飞到无意义的位置。
  // 现在二号改走自己的地物：能源站 → 采样点 C → 采样点 B → 采样点 A → 主河道 → 主基地 → 火星车。
  // 一号保持原有硬编码站点不变（零回归）。
  // -------------------------------------------------------------------------
  const lastIdx = (arr: FlyoverStop[]) => arr.length - 1
  const toBrief = (stops: FlyoverStop[]): FlyoverStop[] =>
    stops.map((s, i) =>
      // 最后一站是"降回跟车机位"，保持原本的慢速落地（travel 1.9 / hold 0）
      i === lastIdx(stops) ? s : { ...s, travel: i === 0 ? 0 : 1.0, hold: i === 0 ? 0.6 : 0.4 },
    )

  if (worldIndex === 1) {
    const lm = (id: string) => field.landmarks.find((l) => l.id === id)
    const sc = lm('sample-c')
    const sb = lm('sample-b')
    const sa = lm('sample-a')
    const ch = lm('channel')
    const full: FlyoverStop[] = [
      // 第一站不飞行，直接落点，多停一会儿让玩家认出"这就是任务终点"
      { ...overview(goal.x, goal.z, '能源站 · 任务终点', 120, 0.28), travel: 0, hold: 1.3 },
    ]
    if (sc) full.push(overview(sc.x, sc.z, '采样点 C · 浅层水冰探测点', 95, -0.14))
    // 2026-09-12 老大反馈：镜头顺序必须沿路线走（终点 → 基地方向单调推进），
    // 否则会"往回走"。主河道站在 C 与 B 之间（自东南向西北依次经过）。
    if (ch) full.push(overview(ch.x, ch.z, '主外流河道', 150, 0.3))
    if (sb) full.push(overview(sb.x, sb.z, '采样点 B · 河道层理剖面', 95, 0.16))
    if (sa) full.push(overview(sa.x, sa.z, '采样点 A · 洪水搬运巨砾', 95, -0.1))
    full.push(overview(start.x, start.z, '主基地 · 着陆平台', 105, -0.1))
    full.push(settleOnRover())
    return brief ? toBrief(full) : full
  }

  if (brief) {
    // 用户 2026-09-02 反馈：brief 只走 3 站"跳过其他重要地点"不对。
    // brief 仍走全部 8 站，但用更短的 travel/hold（≈4.8s），让老玩家快速过一遍。
    const fastOverview = (x: number, z: number, label: string, dist: number, azOff: number, hold: number): FlyoverStop => ({
      x, z, label, distance: dist, azimuth: a + azOff, elevation: 0.62, travel: 1.0, hold,
    })
    return [
      fastOverview(goal.x, goal.z, '能源站 · 任务终点', 120, 0.28, 0.6),
      fastOverview(284, 8, '岩石迷阵', 130, 0.22, 0.4),
      fastOverview(216, 92, '采样点 C · 坑缘溅射毯', 92, -0.14, 0.4),
      fastOverview(104, -68, '主陨石坑坑缘', 150, 0.3, 0.4),
      fastOverview(-264, -92, '风成沙丘带', 165, -0.22, 0.4),
      fastOverview(-216, 236, '采样点 A · 河床沉积', 92, 0.16, 0.4),
      fastOverview(start.x, start.z, '主基地 · 着陆平台', 105, -0.1, 0.6),
      settleOnRover(),
    ]
  }

  return [
    // 第一站不飞行，直接落点，多停一会儿让玩家认出"这就是任务终点"。
    { ...overview(goal.x, goal.z, '能源站 · 任务终点', 120, 0.28), travel: 0, hold: 1.3 },
    overview(284, 8, '岩石迷阵', 130, 0.22),
    overview(216, 92, '采样点 C · 坑缘溅射毯', 92, -0.14),
    overview(104, -68, '主陨石坑坑缘', 150, 0.3),
    overview(-264, -92, '风成沙丘带', 165, -0.22),
    overview(-216, 236, '采样点 A · 河床沉积', 92, 0.16),
    overview(start.x, start.z, '主基地 · 着陆平台', 105, -0.1),
    settleOnRover(),
  ]
}

/** 入场浏览"已看过"的本地标记。隐私模式下写入失败不影响播放（默认走完整版）。 */
const INTRO_SEEN_KEY = 'kibo-mars-intro-seen-v1'
const introSeen = () => {
  try {
    return window.localStorage.getItem(INTRO_SEEN_KEY) === '1'
  } catch {
    return false
  }
}
const markIntroSeen = () => {
  try {
    window.localStorage.setItem(INTRO_SEEN_KEY, '1')
  } catch {
    /* 隐私模式下忽略 */
  }
}

/** 左键拾取结果：命中哪个对象，host 据此决定弹面板还是开车。 */
export type PickHit =
  | { type: 'poi'; poi: Poi }
  | { type: 'kibo' }
  | { type: 'ground'; x: number; z: number }
  | { type: 'none' }

/** 三条候选路线的丝带配色（路径选择台对比视图）。与 OperationConsole 卡片语义呼应。 */
const CANDIDATE_COLORS: Record<string, string> = {
  保守: '#4aa3ff',
  均衡: '#39e0d0',
  激进: '#ff9a3d',
}

export function createMarsStage(options: MarsStageOptions): MarsStage {
  const { container } = options

  const renderer = new WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
    // 截图工装需要在 drawImage 之后仍能读到像素
    preserveDrawingBuffer: true,
  })
  renderer.setClearColor(0x1a1220, 1)
  container.appendChild(renderer.domElement)
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'

  const scene = new Scene()
  const world = new Group()
  world.name = 'World'
  scene.add(world)

  const worldIndex = Math.max(0, Math.min(1, options.worldIndex ?? 0))
  const field = createHeightField(options.seed ?? WORLD_SEEDS[worldIndex], worldIndex)
  /** KIBO 固定站位：主基地前坪。用户要求"NPC 不跟随火星车，就站在原地"，
   * 且要"方便用户第一时间找到 NPC 对话"，同时不能挡在火星车前面；
   * 因此把 KIBO 放在基地与火星车之间、更靠近基地的前坪位置，
   * 仅在原地转向注视火星车，绝不随车移动。 */
  // KIBO 站在基地环外侧、与数据标注台拉开距离，避免和 POI 交互半径重叠。
  const kiboHome = { x: field.start.x + 26, z: field.start.z + 10 }
  // 2026-09-01 用户拍板：KIBO 取消小范围游走，就固定在 kiboHome 站立。
  // 保留 kiboPos 是为了与下游 setPose 的锚点接口保持一致（始终 = kiboHome）。
  const kiboPos = { x: kiboHome.x, z: kiboHome.z }
  // 偶尔跳一小段搞笑舞蹈：首次 45~60s，之后每 60~90s 跳 3~4s。
  // 2026-09-01 续：把频次调稀（之前 12~32s 太密，用户以为"默认就抬臂"），
  // 让默认自然站姿（双臂下垂）是绝对主流。
  let kiboDanceTimer = 45 + Math.random() * 15
  let kiboDanceRemaining = 0
  const ramp = createRampTexture()
  const sky = createSkyDome(worldIndex)
  const terrain = createTerrainRenderer(field, ramp, worldIndex)
  const landmarks = createLandmarks(field, worldIndex)
  const rover = createRover(ramp)
  const kibo = createKibo(createKiboRampTexture())
  const ribbon = createRouteRibbon(field, ramp)
  const candidateRibbons = createCandidateRibbons(field, ramp)
  const hauler = createHauler(field, ramp)
  const scan = createScanWave(ramp)
  const reticle = createReticle(field)
  const dust = createDustSystem()
  const tracks = createTrackMask(BASIN_SIZE)
  const devils = createDustDevils(undefined, worldIndex)
  const storm = createDustStorm()
  // 2026-09-03 用户反馈：去掉近地面黄色雾霾（groundHaze 用 skyHorizon 暖黄做径向雾，
  // 会让整个地表颜色发黄、挡住主美的色彩设计）。本轮彻底停用——保留 createGroundHaze
  // 实现供以后需要时再恢复，先不让它进场景树。
  // const groundHaze = createGroundHaze()

  // --- 地面点击动效：让玩家明确看到每次让 R-7 移动的目标点 ---
  const clickRingMat = new MeshBasicMaterial({
    color: 0x4ecdc4,
    transparent: true,
    opacity: 0,
    side: DoubleSide,
    depthWrite: false,
  })
  const clickRing = new Mesh(new RingGeometry(0.4, 0.8, 32), clickRingMat)
  clickRing.rotation.x = -Math.PI / 2
  clickRing.visible = false
  let clickRingTime = 0

  /** 在指定地面位置播放一次扩散圆环。 */
  const playClickRing = (x: number, z: number) => {
    clickRing.position.set(x, field.heightAt(x, z) + 0.3, z)
    clickRing.scale.set(1, 1, 1)
    clickRingTime = 0.6
    clickRing.visible = true
  }

  // --- 任务：认知场 + 规划网格 + 确定性 A*
  const mission = createMission(field, worldIndex)

  // --- POI 信标：把任务逻辑里的可交互点立成场景里看得见的地标 ---
  const poiMarkers = createPoiMarkers(field, mission.pois())
  // --- 侦察阶段候选扫描点标记：让玩家在场景里直接看到"值得扫哪里" ---
  const scanCands = buildScanCandidates(field, worldIndex)
  const scanCandidateMarkers = createScanCandidateMarkers(field, scanCands)

  /** 根据 knowledge 反推哪些候选点已被扫描覆盖，并同步到箭头颜色。 */
  const syncScanMarkers = () => {
    const ids = new Set<string>()
    for (const c of scanCands) {
      if (mission.knowledge.scannedAt(c.x, c.z) >= 0.5) ids.add(c.id)
    }
    scanCandidateMarkers.setScanned(ids)
  }
  const knowTex: KnowledgeTexture = createKnowledgeTexture(mission.knowledge)
  terrain.setKnowledgeTexture(knowTex.texture)
  terrain.setTrackMask(tracks.texture)
  terrain.setThresholds({
    slopeCaution: mission.grid.cautionDeg,
    slopeBlocked: mission.grid.blockedDeg,
  })

  scene.add(sky.mesh)
  world.add(terrain.group)
  world.add(landmarks.group)
  world.add(rover.group)
  world.add(kibo.group)
  world.add(ribbon.mesh)
  world.add(candidateRibbons.group)
  world.add(hauler.group)
  world.add(scan.group)
  world.add(reticle.group)
  world.add(dust.group)
  world.add(devils.group)
  world.add(storm.group)
  world.add(poiMarkers.group)
  world.add(scanCandidateMarkers.group)
  world.add(clickRing)

  // --- 统一注入主光方向。**必须放在所有资产 add 进 world 之后**，否则后加入的材质拿不到。
  // 二号地图（worldIndex = 1）用黄昏低角度太阳形成长拉影；一号注入的就是原 SUN_DIRECTION
  // 取值，因此一号观感逐像素不变。
  // 用遍历注入而非给各资产工厂函数加 worldIndex 参数，是为避免改动六七个文件的签名。
  applySunDirection(world, worldIndex)

  // groundHaze 已停用（v1.3.4 老大反馈黄雾让地表发黄）：不再 scene.add
  // scene.add(groundHaze.mesh)

  const rig = createCameraRig(1)
  rig.setReducedMotion(Boolean(options.reducedMotion))
  const spawn0 = mission.roverPosition()
  rig.setFocus(spawn0.x, field.heightAt(spawn0.x, spawn0.z), spawn0.z)

  // --- 屏幕空间描边：把"不该被勾线"的层挪到 NO_EDGE_LAYER，几何缓冲趟直接跳过。
  // 天穹/尘霭/粒子/扫描波/丝带/准星本身就是半透明氛围件，勾了线只会脏。
  for (const o of [sky.mesh, dust.group, devils.group, storm.group, scan.group, reticle.group, ribbon.mesh, candidateRibbons.group]) {
    setLayerRecursive(o, NO_EDGE_LAYER)
  }
  rig.camera.layers.enable(NO_EDGE_LAYER)
  // 2026-09-03：新增 NO_SOBEL_LAYER（= 2），主渲染趟也要看到——矿石/样本站/主基地/
  // NPC/火星车/采集车 都在这一层，相机不 enable 就完全不可见。
  rig.camera.layers.enable(NO_SOBEL_LAYER)
  const postfx = createPostFX(renderer, rig.camera.far)

  let quality: QualityLevel = 'high'
  /** 用户手动选了画质后锁定，自动适配不再覆盖（弱机型用户可强制 low）。低帧/WebGL 丢失触发的降级仍独立生效，与画质锁定互不覆盖。 */
  let qualityLocked = false
  let reducedMotion = Boolean(options.reducedMotion)
  let disposed = false
  let rafId = 0
  let lastTime = 0
  let elapsed = 0
  let statsAccum = 0
  let statsFrames = 0
  let smoothFrameMs = 16.7
  let lowFpsSeconds = 0
  let degraded = false
  /** 第三人称跟随：焦点每帧锁定火星车，火星车居中、受限缩放。QA 截帧时关闭。 */
  let followRover = true
  /** 入场全景浏览的航线；非 null 表示正在播放，播放期间所有玩家输入被忽略。 */
  let introRoute: FlyoverStop[] | null = null
  /** 地图平移（WASD）输入：u 屏幕右(+)/左(-)，v 屏幕前/上(+)/后(-)。非零时暂停跟车。 */
  let camPanU = 0
  let camPanV = 0
  /** 扫描蓄力计时（秒）。非 null 表示正在读条，到 SCAN_CHARGE_TIME 时以车身为圆心落下一发扫描。 */
  let scanCharge: number | null = null
  const SCAN_CHARGE_TIME = 1.2
  /** POI 交互（样本站采集）蓄力计时（秒）。非 null 表示正在读条。 */
  let interactCharge: number | null = null
  let interactPoiId: string | null = null
  const INTERACT_CHARGE_TIME = 1.6
  /**
   * 读条走满 100% 后的保持时长（秒）。
   * 修复"进度条不按实际进度表现"：原先走满那一帧立即回调 null，React 会把 100% 与 null 批处理掉，
   * 进度条永远显示在 99% 就凭空消失，看不到真实的"走到 100% 再收起"。
   * 现在走满后先把动作执行掉，再让读条以 100% 停留一小段时间，然后才收起。
   */
  const CHARGE_HOLD_TIME = 0.2
  let scanChargeHold = 0
  let interactChargeHold = 0

  /** 实测阶段已行驶的里程。只有 phase==='drive' 才推进。 */
  let driven = 0
  /** Part B(#167)：能源采集车穿越动画播放中。 */
  let haulerActive = false
  /** 2026-09-03：采集车正在渐隐（防重入，避免每帧重复触发 fadeOut 与完成回调）。 */
  let haulerFading = false
  /** 2026-09-03：采集车出勤期间，主丝带改画采集车实际路线（mission.haulerRoute()），与 hauler 对齐。 */
  let ribbonFollowsHauler = false
  let prevDriven = 0
  let prevManualDist = 0
  let snap: MissionSnapshot = mission.snapshot()

  // --- 音频。截图工装批量推进时间时必须闭嘴，否则一次 renderAtTime 会连放上百次撞击音
  let audioActive = true
  const audio = {
    playScan: () => { if (audioActive) options.audio?.playScan() },
    setEngine: (v: number, i: number) => { if (audioActive) options.audio?.setEngine(v, i) },
    playStuck: () => { if (audioActive) options.audio?.playStuck() },
    playArrive: () => { if (audioActive) options.audio?.playArrive() },
    playKibo: () => { if (audioActive) options.audio?.playKibo() },
  }
  /** 上一帧的行驶状态，用于检测 running→stuck / running→arrived 的跳变 */
  let prevDriveStatus: string = 'idle'

  // --- 路径几何缓存。规划结果一变就重建，避免逐帧遍历格子。
  let pathPts: Array<{ x: number; z: number }> = []
  let cum: number[] = [0]
  let pathLen = 1

  const rebuildPathCache = () => {
    const cells = mission.path()
    pathPts = cells.map((c) => ({ x: c.x, z: c.z }))
    cum = [0]
    for (let k = 1; k < pathPts.length; k += 1) {
      cum.push(cum[k - 1] + Math.hypot(pathPts[k].x - pathPts[k - 1].x, pathPts[k].z - pathPts[k - 1].z))
    }
    pathLen = cum[cum.length - 1] || 1
    // 采集车出勤期间，丝带已由 dispatchHauler 设为采集车实际路线，不在此处被默认 plan 覆盖。
    if (!ribbonFollowsHauler) ribbon.setPath(cells)
  }

  const samplePath = (dist: number) => {
    if (pathPts.length === 0) return { x: field.start.x, z: field.start.z }
    const d = Math.min(Math.max(dist, 0), pathLen)
    let k = 1
    while (k < cum.length && cum[k] < d) k += 1
    const a = pathPts[Math.max(0, k - 1)]
    const b = pathPts[Math.min(pathPts.length - 1, k)]
    const seg = (cum[Math.min(k, cum.length - 1)] ?? 0) - cum[k - 1] || 1
    const f = (d - cum[k - 1]) / seg
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f }
  }

  mission.subscribe((s) => {
    const phaseChanged = snap.phase !== s.phase
    snap = s
    rebuildPathCache()
    terrain.setThresholds({ slopeCaution: s.cautionDeg, slopeBlocked: s.blockedDeg })
    reticle.setVisible(s.phase === 'scan')
    reticle.setEnabled(true)
    scanCandidateMarkers.setVisible(s.phase === 'scan')
    if (s.phase === 'scan') syncScanMarkers()
    // 复盘/修改阶段才揭示"没数据却真禁行"的隐藏段，避免规划阶段提前泄题
    ribbon.setShowHidden(s.phase === 'revise' || s.phase === 'report')
    if (phaseChanged && s.phase === 'drive') driven = 0
    // 任务整体重置（回到 scan 且扫描次数清零）时抹掉旧车辙，
    // 否则"再来一次"会看到上一轮的辙痕，误导学生以为自己走过那里
    if (phaseChanged && s.phase === 'scan' && s.scansUsed === 0) tracks.clear()
    // 阶段切换＝KIBO 有话说。翻车/到达的专属音在 renderFrame 里按状态跳变触发，
    // 这里只管流程节点，避免同一时刻两个提示音撞在一起。
    if (phaseChanged) audio.playKibo()
    options.onMission?.(s)
  })

  const applyQuality = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, PIXEL_RATIO_BY_QUALITY[quality])
    renderer.setPixelRatio(dpr)
    dust.setPixelRatio(dpr)
    dust.setParticleCap(quality === 'high' ? 600 : quality === 'medium' ? 400 : 200)
    terrain.setTrackLod(quality === 'low' ? 0.5 : 1.0)
    // 低端机直接抬高低地形 LOD 下限，砍掉近处最细网格（顶点法线来源不变，不突变）
    terrain.setMinLod(quality === 'low' ? 2 : 0)
    postfx.setQuality(quality)
    syncPostSize()
  }

  /** 后处理 RT 必须跟着 drawing buffer 走（= CSS 尺寸 × pixelRatio），否则墨线粗细会错。 */
  const syncPostSize = () => {
    const dpr = renderer.getPixelRatio()
    postfx.setSize((container.clientWidth || 1) * dpr, (container.clientHeight || 1) * dpr)
  }

  const resize = () => {
    const width = container.clientWidth || 1
    const height = container.clientHeight || 1
    renderer.setSize(width, height, false)
    rig.setAspect(width / Math.max(1, height))
    applyQuality()
  }

  const scanAtWorld = (x: number, z: number): boolean => {
    // 需求 C：扫描次数不设上限，scanAt 在 scan 阶段恒成功（仅统计 scansUsed）。
    const out = mission.scanAt(x, z)
    if (!out.ok) return false
    knowTex.sync()
    scan.pulse(x, z, SCAN_RADIUS)
    reticle.moveTo(x, z, SCAN_RADIUS)
    audio.playScan()
    syncScanMarkers()
    return true
  }

  // --- 指针拾取：左键点地交由 host 调 driveTo（火星车自动驶向该点）；扫描改由"开到位置按 E"完成。
  const raycaster = new Raycaster()
  const pointer = new Vector2()
  /** 手动驾驶的目标点（左键点地设的航点）；为空时由键盘/WASD 直接控。 */
  let manualTarget: { x: number; z: number } | null = null

  const pickGround = (event: PointerEvent): { x: number; z: number } | null => {
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, rig.camera)
    raycaster.layers.mask = rig.camera.layers.mask
    const hits = raycaster.intersectObject(terrain.group, true)
    if (hits.length === 0) return null
    return { x: hits[0].point.x, z: hits[0].point.z }
  }

  /** 左键命中分流：先 KIBO NPC（基地区域要能点中它）→ 再 POI 信标 → 最后地面。 */
  const pickAt = (event: PointerEvent): PickHit => {
    if (inputLocked()) return { type: 'none' }
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, rig.camera)
    // 显式同步 layers：Three.js 0.165+ 在 setFromCamera 里自动复制 camera.layers，
    // 但不同版本行为不一致。这里强制把相机 mask（0b111 = layer 0+1+2）同步给 raycaster，
    // 否则 KIBO/主基地/样本站（都在 layer 2 NO_SOBEL_LAYER）测不到。
    raycaster.layers.mask = rig.camera.layers.mask

    // 1) KIBO NPC（最高优先级）：基地区域的隐形点击圆柱（半径 2.6m）会盖住 NPC，
    //    所以必须先测 NPC，否则玩家在基地里永远点不到 KIBO。
    const kiboHits = raycaster.intersectObject(kibo.group, true)
    if (kiboHits.length > 0) return { type: 'kibo' }
    // 2) POI 信标：命中隐形点击体或任一信标零件，向上回溯到带 poi 的 group。
    const poiHits = raycaster.intersectObject(poiMarkers.group, true)
    for (const h of poiHits) {
      let o: Object3D | null = h.object
      while (o) {
        if (o.userData && o.userData.poi) return { type: 'poi', poi: o.userData.poi as Poi }
        o = o.parent
      }
    }
    // 3) 地面：交给 driveTo（R-7 自动驶向该点）
    const groundHits = raycaster.intersectObject(terrain.group, true)
    if (groundHits.length > 0) return { type: 'ground', x: groundHits[0].point.x, z: groundHits[0].point.z }
    return { type: 'none' }
  }

  /** 收尾入场浏览：交还跟车视角、放开输入，并通知宿主收起字幕。 */
  const endIntroFlyover = () => {
    if (!introRoute) return
    introRoute = null
    followRover = true
    rig.resetView()
    rig.snapToFocus()
    camPanU = 0
    camPanV = 0
    markIntroSeen()
    options.onIntroFlyoverDone?.()
  }

  /** 入场浏览播放期间屏蔽玩家输入：镜头不属于玩家，任何操作都会打断空间感的建立。 */
  const inputLocked = () => introRoute !== null

  const renderFrame = (dt: number) => {
    elapsed += dt
    rig.setHeading(rover.group.rotation.y)
    rig.update(dt)
    // 浏览播完（含用户跳过）的那一帧就交还控制权，避免出现"镜头停住但还不能操作"的空窗。
    if (introRoute && !rig.isFlyoverPlaying()) endIntroFlyover()
    const focus = rig.camera.position
    terrain.updateLod(focus.x, focus.z)
    terrain.setTime(elapsed)
    landmarks.setTime(elapsed)
    knowTex.sync()
    sky.setTime(reducedMotion ? 0 : elapsed)
    // reduced-motion：冻结装饰性动画，仅保留静态姿态，提供等价画面
    const t = reducedMotion ? 0 : elapsed
    ribbon.setTime(t)
    candidateRibbons.setTime(t)
    scan.setTime(t)
    reticle.setTime(t)
    dust.setTime(t)
    devils.setTime(t)
    // groundHaze 已停用（v1.3.4）：下面的 setTime + 跟随相机位置不再调用。
    // groundHaze.setTime(t)
    // groundHaze.mesh.position.x = focus.x
    // groundHaze.mesh.position.z = focus.z

    // 地面点击动效：扩散 + 淡出，0.6 秒一轮，结束即隐藏。
    if (clickRingTime > 0) {
      clickRingTime -= dt
      const k = Math.max(0, Math.min(1, 1 - clickRingTime / 0.6))
      const s = 1 + k * 5
      clickRing.scale.set(s, s, s)
      clickRingMat.opacity = (1 - k) * 0.85
      if (clickRingTime <= 0) clickRing.visible = false
    }

    // 采集车自动驾驶：仿真推进放在最前面，后面所有位置/能源/成败都读同一份状态。
    if (haulerActive) mission.stepHauler(dt)
    hauler.update(dt)

    // 漫游车位姿：自动沿路径行驶 或 手动驾驶（RPG 操控 / 实践测试）二选一
    let pose: { x: number; z: number }
    let groundY: number
    let heading: number
    let stuck = false
    let moving = false
    let speed = 0
    let wheelDist = 0
    let mastLook: { x: number; y: number; z: number }
    let tiltPitch = 0
    let tiltRoll = 0
    let stuckAtPos: { x: number; z: number } | null = null

    if (snap.manual) {
      // 手动模式：玩家输入直接驱动，可在任意阶段探索
      // 若有航点（左键点地），先用自动驾驶算出油门/转向再积分
      if (manualTarget) {
        const p0 = mission.manualPose()
        const desired = headingToward(manualTarget.x - p0.x, manualTarget.z - p0.z)
        let dh = desired - p0.heading
        while (dh > Math.PI) dh -= 2 * Math.PI
        while (dh < -Math.PI) dh += 2 * Math.PI
        const dist = Math.hypot(manualTarget.x - p0.x, manualTarget.z - p0.z)
        const steer = Math.max(-1, Math.min(1, dh * 1.6))
        const throttle = dist < 2 ? 0 : Math.abs(dh) > 1.1 ? 0.18 : 1
        mission.setManualInput(throttle, steer)
        if (dist < 2.5) {
          manualTarget = null
          mission.setManualInput(0, 0)
        }
      }
      mission.stepManual(dt)
      const mp = mission.manualPose()
      pose = { x: mp.x, z: mp.z }
      groundY = field.heightAt(mp.x, mp.z)
      heading = mp.heading
      wheelDist = mp.distance
      speed = dt > 0 ? Math.abs(mp.distance - prevManualDist) / dt : 0
      prevManualDist = mp.distance
      moving = speed > 0.15
      const lookAhead = 8
      mastLook = {
        x: mp.x + Math.cos(heading) * lookAhead,
        y: field.heightAt(mp.x + Math.cos(heading) * lookAhead, mp.z - Math.sin(heading) * lookAhead),
        z: mp.z - Math.sin(heading) * lookAhead,
      }
      tiltPitch = reducedMotion ? 0 : Math.sin(t * 0.9) * 0.012
      tiltRoll = reducedMotion ? 0 : Math.cos(t * 0.7) * 0.01
    } else {
      // 自动模式：drive 阶段沿规划路径行驶；其余阶段（scan/rules/plan/revise/report）
      // 火星车停在停靠位（默认基地外开阔地 ROVER_SPAWN），第三人称跟车入画即见车，不会被主基地遮挡。
      // 手动驾驶（WASD 或左键航点）期间暂停自动驾驶，避免实测里程偷偷推进导致松手后瞬移。
      if (snap.phase === 'drive' && pathLen > 1 && !snap.manual) {
        mission.stepDrive(dt)
      }
      const ds = mission.driveInfo()
      if (snap.phase === 'drive') {
        driven = ds.progress
        wheelDist = driven
        pose = samplePath(driven)
        groundY = field.heightAt(pose.x, pose.z)
        const ahead = samplePath(Math.min(pathLen, driven + 2))
        // 车头必须真的朝向行进方向。约定与换算集中在 render/orientation.ts，
        // 那里有单测锁死"模型正面是 +X"这件事。
        heading =
          Math.hypot(ahead.x - pose.x, ahead.z - pose.z) > 1e-4
            ? headingToward(ahead.x - pose.x, ahead.z - pose.z)
            : 0
        // 翻车时车身倾斜、底盘下沉，把"开进真实禁行地形"的冲突直观化
        stuck = ds.status === 'stuck'
        stuckAtPos = ds.stuckAt
        tiltPitch = stuck
          ? ds.stuckHazard === 'soft'
            ? -0.18 // 软沙陷车：底盘下沉
            : ds.stuckHazard === 'rock'
              ? -0.34 // 卡在裸岩：翘起更高
              : -0.3 // 陡坡翻车
          : reducedMotion
            ? 0
            : Math.sin(t * 0.9) * 0.012
        tiltRoll = stuck ? 0.16 : reducedMotion ? 0 : Math.cos(t * 0.7) * 0.01
        // 桅杆相机注视点：drive 看前方 8m，stuck 看翻车方向地面
        mastLook = stuck
          ? { x: (ds.stuckAt?.x ?? pose.x), y: groundY, z: (ds.stuckAt?.z ?? pose.z) }
          : { x: ahead.x, y: field.heightAt(ahead.x, ahead.z), z: ahead.z }
        moving = ds.status === 'running' || ds.status === 'arrived'
        speed = moving && dt > 0 ? Math.abs(driven - prevDriven) / dt : 0
      } else {
        // 非实测：漫游车停在停靠位（ROVER_SPAWN 或上一次手动停靠处）
        const mp = mission.manualPose()
        pose = { x: mp.x, z: mp.z }
        driven = 0
        wheelDist = mp.distance
        groundY = field.heightAt(pose.x, pose.z)
        heading = mp.heading
        const aheadX = pose.x + Math.cos(heading) * 8
        const aheadZ = pose.z - Math.sin(heading) * 8
        tiltPitch = reducedMotion ? 0 : Math.sin(t * 0.9) * 0.012
        tiltRoll = reducedMotion ? 0 : Math.cos(t * 0.7) * 0.01
        // 侦察以车身为中心看火星车；其余阶段看车头前方
        mastLook = snap.phase === 'scan'
          ? { x: pose.x, y: groundY, z: pose.z }
          : { x: aheadX, y: field.heightAt(aheadX, aheadZ), z: aheadZ }
        moving = false
        speed = 0
      }
    }

    // --- 镜头：WASD 地图平移优先（暂停跟车），否则第三人称跟随"当前主角车"。 ---
    // 采集车出勤期间，视觉中心从玩家的 R-7 换到采集车——玩家现在是旁观者，
    // 看得见它一路烧电、一路撞坑，这正是"你拍板的路线"被检验的过程。
    if (camPanU !== 0 || camPanV !== 0) {
      followRover = false
      rig.panScreen(camPanU, camPanV, dt)
    } else if (followRover) {
      if (haulerActive) {
        const hp = hauler.position()
        rig.setFocus(hp.x, hp.y + 1.0, hp.z)
      } else {
        rig.setFocus(pose.x, groundY + 1.0, pose.z)
      }
    }

    // --- 侦察阶段：扫描准星以车身为中心（"开到位置按 E"），不再跟随鼠标。 ---
    if (snap.phase === 'scan') {
      reticle.moveTo(pose.x, pose.z, SCAN_RADIUS)
    }

    // --- 扫描蓄力：按 E 后以车身为圆心读条，到时落下一发扫描。 ---
    // 读条严格按 scanCharge / SCAN_CHARGE_TIME 的真实比例推进；走满后保留 100% 一小段再收起。
    if (scanCharge !== null) {
      scanCharge += dt
      const p = Math.min(1, scanCharge / SCAN_CHARGE_TIME)
      options.onScanProgress?.(p)
      if (scanCharge >= SCAN_CHARGE_TIME) {
        if (scanChargeHold === 0) scanAtWorld(pose.x, pose.z)
        scanChargeHold += dt
        if (scanChargeHold >= CHARGE_HOLD_TIME) {
          scanCharge = null
          scanChargeHold = 0
          options.onScanProgress?.(null)
        }
      }
    }

    // --- POI 交互蓄力（样本站采集）：走满后回传 poiId，由宿主执行真正的采集。 ---
    if (interactCharge !== null) {
      interactCharge += dt
      const p = Math.min(1, interactCharge / INTERACT_CHARGE_TIME)
      options.onInteractProgress?.(p)
      if (interactCharge >= INTERACT_CHARGE_TIME) {
        if (interactChargeHold === 0 && interactPoiId) options.onInteractComplete?.(interactPoiId)
        interactChargeHold += dt
        if (interactChargeHold >= CHARGE_HOLD_TIME) {
          interactCharge = null
          interactChargeHold = 0
          interactPoiId = null
          options.onInteractProgress?.(null)
        }
      }
    }

    rover.setPose({
      x: pose.x,
      y: groundY + (stuck ? -0.18 : 0.05),
      z: pose.z,
      heading,
      pitch: tiltPitch,
      roll: tiltRoll,
      wheelCompression: [0, 0, 0, 0, 0, 0],
      wheelSpin: wheelDist / 0.36,
      arm: snap.phase === 'scan' ? 0.85 : (stuck ? 0.04 : 0.15),
      armAction: snap.phase === 'scan' ? 'scan' : (stuck ? 'stuck' : 'idle'),
      lookAt: mastLook,
      battery: snap.battery,
    })
    if (haulerActive) {
      // 采集车自动驾驶：位置与成败完全由 mission 的确定性仿真决定，
      // stage 只负责把车的位姿、丝带进度、机械臂动作画出来。
      // 视觉中心从玩家的 R-7 切到采集车：R-7 暂隐，扬尘改从采集车后方喷出。
      const run = mission.haulerRun()
      ribbon.setProgress(run.progress)
      rover.group.visible = false
      // 渐隐期间**不能**再调 hauler.show(true)：show(true) 内部会把 fadingOut=false /
      // opacityMul=1 重置，等于每帧把 fadeOut() 设的渐隐状态冲掉，渐隐永远推不动，
      // finishHauler 回调也永远不触发——表现为"采集车回到基地不消失、R-7 也回不来"。
      if (!haulerFading) hauler.show(true)
      if (run.status === 'collecting') {
        // 机械臂动作：前 1/3 放下、中间 1/3 夹紧、后 1/3 抬起夹着资源
        const f = Math.min(1, Math.max(0, (run.progress - 0.45) / 0.1))
        hauler.setLeg('collect', 0)
        hauler.setArmAction(f < 0.34 ? 'reach' : f < 0.67 ? 'grab' : 'carry')
      } else {
        const outbound = run.status === 'outbound'
        hauler.setLeg(outbound ? 'outbound' : 'return', run.legProgress)
        hauler.setArmAction(outbound ? 'idle' : 'carry')
      }
      // 2026-09-03 用户反馈①：采集车尾部的烟雾比例太小，并且挂在车底中间位置。
      // 修正挂点：仿 R-7 后轮拖尾模式，扬尘从采集车的左后/右后两轮底部冒出，不再喷在车身中心。
      // 用户反馈②（v1.3.5）：放大一倍 → intensity 1.2 → 2.4。
      // 用户反馈③（v1.3.6）：再放大一倍 → 2.4 → 5.42。
      //
      // **intensity 换算必须按 dust 的 size 公式反推，不能直接乘 2**：
      //   dust.ts: p.size = rng(0.85,1.25) * baseSize * (0.65 + intensity * 1.05)
      //   其中 0.65 是常数项，所以 intensity 翻倍 ≠ 视觉尺寸翻倍。
      //   推导：
      //     当前 2.4   → 尺寸因子 0.65 + 2.4*1.05  = 3.17
      //     再放大一倍 → 目标尺寸因子 3.17 * 2      = 6.34
      //                  intensity = (6.34 - 0.65) / 1.05 ≈ 5.42
      //   参考：R-7 的 intensity 上限是 1.2（尺寸因子 1.91），采集车现为 R-7 的 3.3 倍，
      //   但采集车体积本就约为 R-7 的 3 倍，"滚滚烟尘"的体量感才对得上。
      //   注：emitBatch 的粒子数 count 在 intensity > 0.9 时已封顶 5，放大只改尺寸、不变密度。
      const HAULER_DUST_INTENSITY = 5.42
      const haulerWheels = hauler.getWheelWorldPositions()
      if (haulerWheels.length >= 6) {
        // wheels 顺序：左后[0]/左中[1]/左前[2]/右后[3]/右中[4]/右前[5]
        dust.emitBatch([haulerWheels[0], haulerWheels[3]], HAULER_DUST_INTENSITY)
      } else {
        const hpPos = hauler.position()
        dust.emit({ x: hpPos.x, y: hpPos.y, z: hpPos.z }, HAULER_DUST_INTENSITY)
      }
      if (run.status === 'success' || run.status === 'failed') {
        // 2026-09-03：成功时渐隐消失（避免车瞬移到基地穿模）；失败时保持原位再回收。
        // 用 haulerFading 防重入——这段每帧都会跑，不能反复触发 fadeOut/回调。
        if (!haulerFading) {
          haulerFading = true
          const finishHauler = () => {
            haulerActive = false
            haulerFading = false
            hauler.show(false)
            rover.group.visible = true
            // 运行结束：丝带交还默认规划路线，镜头复位到 R-7 默认跟车机位。
            ribbonFollowsHauler = false
            ribbon.setPath(mission.path())
            ribbon.mesh.visible = true
            rig.setDistance(BASE_DISTANCE)
            rig.setAzimuth(BASE_AZIMUTH)
            rig.snapToFocus()
            if (run.status === 'failed') {
              audio.playStuck()
            } else {
              audio.playArrive()
            }
            options.onHaulerFinished?.(run)
          }
          if (run.status === 'success') {
            // 渐隐 ~0.8s 完成后再回收，视觉上"车顺利回到基地然后消失"。
            hauler.fadeOut(finishHauler)
          } else {
            // 失败：车已经卡住不动，直接回收（同时补 show(false)，之前漏了会让车一直留在场上）。
            finishHauler()
          }
        }
      }
    } else {
      ribbon.setProgress(pathLen > 1 ? driven / pathLen : 0)
    }

    // 扬尘：行驶时从接地轮子后方发射；stuck/idle 只留少量落尘；
    // 沙尘暴下无论是否移动都强制重扬尘，强化"被吞没"的奇观感
    const stormI = storm.intensityAt(pose.x, pose.z)
    storm.setTime(t)
    sky.setStorm(stormI)
    if (speed > 0.2 || stuck || stormI > 0.05) {
      const intensity = stuck ? 0.15 : Math.max(Math.min(1.2, speed / 8), stormI * 0.95)
      const wheels = rover.getWheelWorldPositions({
        x: pose.x, y: groundY + (stuck ? -0.18 : 0.05), z: pose.z,
        heading, pitch: tiltPitch, roll: tiltRoll,
        wheelCompression: [0, 0, 0, 0, 0, 0], wheelSpin: wheelDist / 0.36, arm: stuck ? 0.04 : 0.15,
      })
      // 拖尾扬尘从双后轮同时冒出（WHEEL_POS 索引 4/5），左右对称，
      // 不再从车身侧面/前轮喷尘，保证"尾巴冒烟"恒从车尾出来。
      if (wheels.length >= 6) {
        dust.emitBatch([wheels[4], wheels[5]], intensity)
      } else {
        for (const w of wheels) dust.emit(w, intensity)
      }
    }

    // 车辙：只在真正行驶时压印，翻车原地打滑不再累积新痕
    if (moving) {
      tracks.stamp(pose.x, pose.z, heading)
    }
    tracks.flush()

    // --- 音频：发动机随车速，状态跳变触发一次性音效
    // 只有 running 才有发动机声；arrived/stuck/idle 一律淡出到 0，
    // 让"车停了"这件事在听觉上也成立。
    const engineVol = moving ? Math.min(1, 0.35 + speed / 9) : 0
    audio.setEngine(engineVol, Math.min(1, speed / 9))
    const driveKey = snap.manual ? (moving ? 'running' : 'idle') : mission.driveInfo().status
    if (driveKey !== prevDriveStatus) {
      if (driveKey === 'stuck') audio.playStuck()
      else if (driveKey === 'arrived') audio.playArrive()
      prevDriveStatus = driveKey
    }

    // --- KIBO 行为（2026-09-01 改：取消小范围游走，固定站在 kiboHome）。
    // 位置永远等于 kiboHome；朝向永远指向火星车（翻车时指向翻车点），
    // 这样"基地向导 / 朋友"的角色感保持住，同时不离开指定范围。
    // 偶尔跳一段舞蹈：kiboDanceTimer 归零时启动一段随机时长的 dance，
    // 期间 mood 强制为 'dance'（覆盖普通 idle/guide，但仍让位给翻车 alert）。
    if (kiboDanceRemaining > 0) {
      kiboDanceRemaining = Math.max(0, kiboDanceRemaining - dt)
    } else {
      kiboDanceTimer -= dt
      if (kiboDanceTimer <= 0) {
        kiboDanceRemaining = 3.0 + Math.random() * 1.0
        kiboDanceTimer = 60 + Math.random() * 30
      }
    }

    const anchor = { x: kiboHome.x, z: kiboHome.z }
    const pointTarget = stuck
      ? { x: stuckAtPos?.x ?? pose.x, z: stuckAtPos?.z ?? pose.z }
      : { x: pose.x, z: pose.z }
    // 朝向：永远面向火星车（翻车时指向翻车点）
    const kiboHeading = headingToward(pointTarget.x - anchor.x, pointTarget.z - anchor.z)
    // 情绪优先级：翻车 alert > 正在跳舞 dance > 阶段引导 guide > 普通 idle
    const kiboMood: KiboPose['mood'] = stuck
      ? 'alert'
      : kiboDanceRemaining > 0
        ? 'dance'
        : (snap.phase === 'scan' || snap.phase === 'plan' || snap.phase === 'drive' || snap.phase === 'revise')
          ? 'guide'
          : 'idle'
    kibo.setPose({
      x: anchor.x,
      y: field.heightAt(anchor.x, anchor.z) + 0.02,
      z: anchor.z,
      heading: kiboHeading,
      bob: reducedMotion ? 0 : Math.sin(t * 1.6) * 0.015,
      mood: kiboMood,
      pointAt: kiboMood === 'guide' || kiboMood === 'alert' ? pointTarget : undefined,
    })

    // 角色的自身动画（眼睛呼吸、眨眼、警报抖动、庆祝自转）。
    // 必须在 setPose 之后调用：setTime 是在 setPose 写入的基准位姿上做叠加。
    rover.setTime(t)
    kibo.setTime(t)

    // POI 信标：玩家进入交互半径时高亮，否则保持待引导的安静脉冲；
    // 已交互完成的地标改为完成色（按住 E 交互成功后即时变色）。
    poiMarkers.setActive(snap.nearbyPoi?.id ?? null)
    poiMarkers.setCompleted(mission.completedPoiIds())
    poiMarkers.update(dt, rig.camera)
    // 侦察阶段候选扫描点：持续轻微呼吸动画，提示玩家"往这开"。
    scanCandidateMarkers.update(dt)

    sky.mesh.position.copy(rig.camera.position)
    // 走后处理：几何缓冲趟 → 主渲染趟 → Sobel 合成趟。low 画质时内部直连渲染。
    postfx.render(scene, rig.camera)
    prevDriven = driven
  }

  /** 自适应画质：连续超预算就降级，长期富余就回升。用户手动锁定后不再自动改。 */
  const adaptQuality = (frameMs: number, dt: number) => {
    smoothFrameMs += (frameMs - smoothFrameMs) * 0.08

    if (!qualityLocked) {
      if (smoothFrameMs > 26 && quality === 'high') {
        quality = 'medium'
        applyQuality()
      } else if (smoothFrameMs > 34 && quality === 'medium') {
        quality = 'low'
        applyQuality()
      } else if (smoothFrameMs < 13 && quality === 'low') {
        quality = 'medium'
        applyQuality()
      } else if (smoothFrameMs < 11 && quality === 'medium') {
        quality = 'high'
        applyQuality()
      }
    }

    // 连续 5 秒低于 25fps（40ms/帧）触发降级（诚实提示 + 停 3D 舞台）
    if (smoothFrameMs > 40) {
      lowFpsSeconds += dt
      if (lowFpsSeconds > 5 && !degraded) {
        degraded = true
        options.onDegrade?.('连续 5 秒帧率低于 25fps')
      }
    } else {
      lowFpsSeconds = 0
    }
  }

  const loop = (now: number) => {
    if (disposed) return
    rafId = requestAnimationFrame(loop)
    if (lastTime === 0) lastTime = now
    const dt = Math.min((now - lastTime) / 1000, 0.1)
    lastTime = now

    // 截图工装 setCaptureCamera 会把 rig.paused 置 true：暂停自动渲染，
    // 避免 rAF 与 page.screenshot 在 swiftshader 下争用，并让画布静止（截图瞬时且稳定）。
    // renderAtTime 仍会直接调用 renderFrame 做单帧渲染，不受此门控影响。
    if (rig.paused) return
    const t0 = performance.now()
    renderFrame(dt)
    const frameMs = performance.now() - t0

    adaptQuality(frameMs, dt)

    statsAccum += dt
    statsFrames += 1
    if (statsAccum >= 0.5 && options.onStats) {
      options.onStats({
        fps: statsFrames / statsAccum,
        frameMs: smoothFrameMs,
        triangles: terrain.getTriangleCount(),
        drawCalls: renderer.info.render.calls,
        pixelRatio: renderer.getPixelRatio(),
        quality,
      })
      statsAccum = 0
      statsFrames = 0
    }
  }

  rebuildPathCache()
  reticle.moveTo(field.start.x, field.start.z, SCAN_RADIUS)
  reticle.setVisible(true)
  resize()
  rig.playIntro()
  rafId = requestAnimationFrame(loop)

  /** KIBO 头顶高度偏移（米）：让感叹号落在头顶而不是脚下。 */
  const KIBO_HEAD_OFFSET = 2.2
  const kiboScreenPosition = (): { x: number; y: number } | null => {
    const rect = renderer.domElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    const p = new Vector3(
      kibo.group.position.x,
      kibo.group.position.y + KIBO_HEAD_OFFSET,
      kibo.group.position.z,
    )
    p.project(rig.camera)
    // z > 1 表示在相机背后，DOM 层不该显示标记
    if (p.z > 1) return null
    return {
      x: (p.x * 0.5 + 0.5) * rect.width + rect.left,
      y: (-p.y * 0.5 + 0.5) * rect.height + rect.top,
    }
  }
  const kiboWorldPosition = () => ({
    x: kibo.group.position.x,
    y: kibo.group.position.y + KIBO_HEAD_OFFSET * 0.5,
    z: kibo.group.position.z,
  })

  return {
    field,
    mission,
    rig,
    scene,
    sky,
    terrain,
    landmarks,
    rover,
    kibo,
    ribbon,
    candidateRibbons,
    hauler,
    scan,
    reticle,
    dust,
    tracks,
    devils,
    storm,
    // groundHaze 已停用（v1.3.4 老大反馈）：不在 API 里暴露，避免外部误用
    poiMarkers,
    scanCandidateMarkers,
    postfx,
    world,
    scanAtWorld,
    focusOn: (x, z) => {
      rig.setFocus(x, field.heightAt(x, z), z)
    },
    setReducedMotion: (on) => {
      reducedMotion = on
      rig.setReducedMotion(on)
      dust.setReducedMotion(on)
      devils.setReducedMotion(on)
      storm.setReducedMotion(on)
    },
    setQuality: (level) => {
      quality = level
      qualityLocked = true
      applyQuality()
      // groundHaze 已停用（v1.3.4）
      // groundHaze.setQuality(level)
      devils.group.visible = level !== 'low'
    },
    /** 进入手动驾驶（RPG 操控 / 实践测试）。 */
    enterManualDrive: () => mission.enterManual(),
    /** 退出手动驾驶，回到规划/自动模式。 */
    exitManualDrive: () => {
      mission.exitManual()
      manualTarget = null
    },
    /** 左键点地：拾取地面并把航点交给漫游车（自动驶向该点）。 */
    driveTo: (event: PointerEvent) => {
      if (inputLocked()) return
      const hit = pickGround(event)
      if (!hit) return
      mission.enterManual()
      manualTarget = hit
      playClickRing(hit.x, hit.z)
    },
    /** 左键命中分流：POI 标记 / KIBO NPC / 地面。 */
    pickAt,
    /** 把漫游车开到指定世界坐标：进入手动模式并设航点，玩家开到位置后按 E 扫描。 */
    driveToPoint: (x: number, z: number) => {
      if (inputLocked()) return
      mission.enterManual()
      manualTarget = { x, z }
      playClickRing(x, z)
    },
    /** 第三人称跟随开关：QA 截帧时关闭，正常游玩开启。 */
    setFollow: (on: boolean) => {
      followRover = on
      if (on) rig.resetView()
      // 复位/重新跟车时清除平移输入，避免镜头卡在偏离态
      camPanU = 0
      camPanV = 0
    },
    playIntroFlyover: () => {
      if (introRoute) return false
      // reduced-motion 下不做运镜：尊重系统偏好，直接进常规跟车视角。
      if (reducedMotion) {
        rig.resetView()
        return false
      }
      // 看过一次就走精简版：教学产品会被反复进入，完整版留作"第一印象"。
      const route = buildIntroRoute(field, introSeen(), worldIndex)
      // 注意顺序：playFlyover 内部会把焦点直接落到第一站，之后不能再调 snapToFocus /
      // resetView，两者都会清掉 rig 的浏览状态（它们是给 QA 截帧用的）。
      const ok = rig.playFlyover(route, (x, z) => field.heightAt(x, z))
      if (!ok) {
        rig.resetView()
        return false
      }
      introRoute = route
      // 浏览期间不接受玩家输入，也不让 WASD 把车开走。
      mission.setManualInput(0, 0)
      return true
    },
    skipIntroFlyover: () => {
      if (!introRoute) return
      rig.skipFlyover()
      endIntroFlyover()
    },
    introFlyoverActive: () => introRoute !== null,
    introFlyoverLabel: () => {
      if (!introRoute) return null
      const i = rig.flyoverStopIndex()
      if (i < 0 || i >= introRoute.length) return null
      return introRoute[i].label
    },
    /** 地图平移（WASD 移动镜头）输入：u 右(+)/左(-)，v 前/上(+)/后(-)。 */
    setCameraPanInput: (u: number, v: number) => {
      if (inputLocked()) {
        camPanU = 0
        camPanV = 0
        return
      }
      camPanU = u
      camPanV = v
    },
    /** 扫描蓄力：侦察阶段按 E 触发，以车身为圆心读条扫描。 */
    startScanCharge: () => {
      if (inputLocked()) return false
      if (snap.phase !== 'scan' || scanCharge !== null) return false
      scanCharge = 0
      scanChargeHold = 0
      options.onScanProgress?.(0)
      return true
    },
    /** POI 交互蓄力：靠近样本站按 E 触发，读条表达"正在采集样本"的过程。 */
    startInteractCharge: (poiId: string) => {
      if (inputLocked()) return false
      if (interactCharge !== null) return false
      interactCharge = 0
      interactChargeHold = 0
      interactPoiId = poiId
      options.onInteractProgress?.(0)
      return true
    },
    /** 键盘/WASD 直接控车：throttle/steer ∈ [-1,1]。 */
    setManualInput: (throttle: number, steer: number) => {
      // 入场浏览期间锁死油门：玩家按住 W 也不会让车自己开走，接手时位置与镜头才对得上。
      if (inputLocked()) {
        mission.setManualInput(0, 0)
        return
      }
      mission.setManualInput(throttle, steer)
    },
    renderAtTime: (seconds) => {
      // 用固定步长把状态推进到指定时刻，保证截图可复现
      const step = 1 / 60
      elapsed = 0
      driven = 0
      rig.snapToFocus() // 消除入场与弹簧瞬态，保证同一机位每次截图一致
      audioActive = false // 批量推进时间时静音，否则会连放上百次撞击音
      try {
        for (let t = 0; t < seconds; t += step) renderFrame(step)
        renderFrame(step)
      } finally {
        audioActive = true
      }
    },
    /** Part A(#167)：路径选择台打开时，把候选路线画成对比丝带。 */
    showCandidateRoutes: () => {
      const cands = mission.candidatePaths()
      const routes = cands
        .filter((c) => c.path.length >= 2)
        .map((c, i) => ({
          id: 'cand-' + i,
          label: c.label,
          cells: c.path,
          color: CANDIDATE_COLORS[c.label] ?? '#cfd2d8',
        }))
      candidateRibbons.setRoutes(routes)
      candidateRibbons.setActive(null)
      // 选择台对比期间隐藏主丝带，避免与候选丝带重叠成一团
      ribbon.mesh.visible = false
    },
    /** Part A(#167)：高亮某条候选路线（其余淡出）。 */
    highlightCandidate: (index) => {
      candidateRibbons.setActive(index)
    },
    /** Part A(#167)：关闭选择台时清掉候选丝带，恢复主丝带。 */
    clearCandidateRoutes: () => {
      candidateRibbons.clear()
      ribbon.mesh.visible = true
    },
    /**
     * 派遣能源采集车沿某条候选路线往返验证：基地 → 能源站（机械臂抓取资源）→ 基地。
     *
     * 采集车全程自动驾驶：玩家只能用右键转视角、WASD 平移镜头、Space 拉近，
     * **左键点地不会给它改路线**——左键改向在 pickup 处被 haulerActive 拦掉。
     */
    dispatchHauler: (candidateIndex) => {
      const cands = mission.candidatePaths()
      const cand = cands[candidateIndex]
      const cells = cand?.path ?? []
      if (cells.length < 2) return false
      if (!mission.beginHaulerRun(candidateIndex)) return false
      // 往返两段：去程到能源站，回程原路返回（不含重复的端点）。
      const back = [...cells].slice(0, -1).reverse()
      hauler.setPath(cells, [...back, cells[0]])
      hauler.setArmAction('idle')
      hauler.show(true)
      haulerActive = true
      // 主丝带改画采集车实际路线：丝带与车用同一份 cell 列表，彻底消除"车在某些路段脱离丝带"。
      ribbonFollowsHauler = true
      ribbon.setPath(mission.haulerRoute())
      // 派遣瞬间把 R-7 停稳：否则玩家出发前按着 W 不放，
      // 采集车跑这一趟的时候 R-7 会自己溜走，等回来时人已经不在基地了。
      mission.setManualInput(0, 0)
      // 视觉中心从 R-7 换到采集车：拉近镜头、隐藏全程路径丝带，
      // 让学生跟随采集车看它一路烧电，而不是一眼看完全局路径。
      // 视距取玩家可用范围的下限：再近会穿模，再远就又变成"看全局"了。
      ribbon.mesh.visible = false
      followRover = true // 采集车出发时强制恢复镜头跟随，避免之前 WASD 平移导致镜头固定不动
      rig.setDistance(BASE_DISTANCE * 2)
      rig.setAzimuth(BASE_AZIMUTH)
      rig.snapToFocus()
      return true
    },
    /** 能源采集车是否正在出勤。 */
    haulerActive: () => haulerActive,
    /** 收车：隐藏采集车并把仿真状态复位，玩家回到 R-7 继续操作。 */
    recallHauler: () => {
      haulerActive = false
      hauler.show(false)
      hauler.setArmAction('idle')
      mission.resetHaulerRun()
      // 丝带交还默认规划路线（采集车路线已随 reset 清空）。
      ribbonFollowsHauler = false
      ribbon.setPath(mission.path())
      rover.group.visible = true
      ribbon.mesh.visible = true
      rig.setDistance(BASE_DISTANCE)
      rig.setAzimuth(BASE_AZIMUTH)
      rig.snapToFocus()
    },
    kiboScreenPosition,
    kiboWorldPosition,
    resize,
    dispose: () => {
      disposed = true
      audio.setEngine(0, 0) // 卸载前掐掉持续音，避免路由切走后发动机还在响
      audioActive = false
      cancelAnimationFrame(rafId)
      terrain.dispose()
      landmarks.dispose()
      rover.dispose()
      kibo.dispose()
      ribbon.dispose()
      candidateRibbons.dispose()
      scan.dispose()
      reticle.dispose()
      dust.dispose()
      tracks.dispose()
      devils.dispose()
      storm.dispose()
      // groundHaze 已停用（v1.3.4）：不再 dispose（也没创建实例）
      poiMarkers.dispose()
      scanCandidateMarkers.dispose()
      clickRing.geometry.dispose()
      clickRingMat.dispose()
      postfx.dispose()
      knowTex.dispose()
      sky.dispose()
      ramp.dispose()
      rig.dispose()
      renderer.dispose()
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement)
      }
    },
  }
}
