/**
 * 3D 火星任务的唯一 React 宿主。
 *
 * 职责边界：
 * - React 只做挂载、卸载、降级判定、HUD 与键盘入口；
 * - 逐帧逻辑全部在 `stage.ts` 里，不进入 React 渲染树；
 * - 任务逻辑全部在 `core/mission.ts` 里，React 只订阅快照；
 * - 所有文本走 DOM，不烘焙进贴图（纲领第五节）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { canCreateWebGLContext } from './webglSupport'
import { MissionHud } from './MissionHud'
import { kiboLineFor } from './kiboLines'
import { MARS_MAP_COUNT, WORLD_SEEDS, marsMapName } from './core/heightField'
import { createSynth, type Synth } from './audio/synth'
import { createHeightField } from './core/heightField'
import {
  buildScanCandidates,
  type DecisionEntry,
  type DriveInfo,
  type MissionPhase,
  type MissionSnapshot,
  type Poi,
  type PoiKind,
  type RouteCandidate,
  type RunRecord,
  type ScanCandidate,
  type UncertaintyChoice,
} from './core/mission'
import { createMarsStage, type MarsStage, type QualityLevel, type StageStats } from './stage'
import { VIEWPOINTS, findViewpoint } from './viewpoints'
import { OperationConsole, LockedConsole } from './ui/OperationConsole'
import { PoiInfoPanel } from './ui/PoiInfoPanel'
import { KiboDialogue } from './ui/KiboDialogue'
import { Onboarding, onboardingStorageKey } from './Onboarding'
import { MissionResultModal } from './ui/MissionResultModal'
import { KiboEndTalk } from './ui/KiboEndTalk'

export type MarsGame3DProps = {
  seed?: string
  /** 初始地图索引 0/1/2（A/B/C）。切换会重建整个 3D 舞台。 */
  worldIndex?: number
  /** WebGL 不可用或运行时降级时通知外层（例如上报埋点/日志）；3D 舞台自身已显示人话说明，不切换其它版本。 */
  onDegrade?: (reason: string) => void
  /** 开发期机位面板。生产环境默认关闭。 */
  showDevPanel?: boolean
  /** 任务 HUD。开发检视页可关掉，只看画面。 */
  showHud?: boolean
  /**
   * 进入地图时是否播放「全景浏览」入场运镜：镜头从终点掠过各重要地点，最后落到 R-7 上。
   * 玩家路线（探索舱进入）默认开启；开发检视/QA 截图通道关掉，否则镜头会一直在飞。
   */
  introFlyover?: boolean
  /** 退出当前舞台（返回探索舱）。透传给 HUD 的系统按钮区。 */
  onExit?: () => void
  /** 完成当前地图后请求进入下一张地图。若未提供，则停留在结算页。 */
  onNextWorld?: (nextIndex: number) => void
  /** 当前地图被完整完成时通知外层（用于持久化进度）。 */
  onWorldComplete?: (worldIndex: number) => void
}

declare global {
  interface Window {
    /** 截图工装与自动化评审使用的调试接口。仅在 3D 舞台挂载期间存在。 */
    __kiboMars3D?: {
      ready: boolean
      gotoViewpoint: (id: string) => boolean
      renderAtTime: (seconds: number) => void
      listViewpoints: () => string[]
      getStats: () => StageStats | null
      /** 评审脚本用：直接驱动任务状态，免去手工点击 */
      scanAt: (x: number, z: number) => boolean
      setPhase: (phase: MissionPhase) => void
      setThresholds: (caution: number, blocked: number) => void
      replan: () => void
      /** 开始实测（从起点跑当前规划路线）。截图 / QA 用。 */
      startDrive: () => void
      /** 调整规划权重，用于测试不同策略是否能到达终点 */
      setWeight: (key: 'distance' | 'caution' | 'soft' | 'rock' | 'climb' | 'unknown', value: number) => void
      /** 手动推进实测仿真（秒），不依赖实时渲染，保证截图可复现 */
      driveStep: (dt: number) => void
      stopDrive: () => void
      driveInfo: () => DriveInfo | null
      /** 进入/退出手动驾驶（RPG 操控 / 实践测试） */
      enterManualDrive: () => void
      exitManualDrive: () => void
      /** 键盘/WASD 直接控车：throttle/steer ∈ [-1,1] */
      setManualInput: (throttle: number, steer: number) => void
      /** 手动位姿（位置/朝向/速度/里程） */
      manualPose: () => { x: number; z: number; heading: number; speed: number; distance: number } | null
      /** 评审用：把漫游车开到指定世界坐标（候选扫描点）。 */
      driveToPoint: (x: number, z: number) => void
      /** 评审用：在侦察阶段以车身为圆心发起读条扫描（等价 E 键）。 */
      startScanCharge: () => boolean
      /** 对未知路段做显式处置（aiquests 六步：不确定性决策） */
      setUncertaintyChoice: (choice: NonNullable<UncertaintyChoice>, reason: string) => void
      /** 取决策日志（report 阶段生成任务记录用） */
      getDecisionLog: () => DecisionEntry[]
      /** 取历次运行记录（v1/v2 对照） */
      getRuns: () => RunRecord[]
      /** 复位镜头：退出自由轨道、回到受限工作视角 */
      resetCamera: () => void
      /** 漫游车当前世界坐标（scan/plan 阶段在起点） */
      roverPosition: () => { x: number; z: number }
      /** 评审机位微调：聚焦任意世界坐标 / 拉近 / 转方位 */
      focusOn: (x: number, z: number) => void
      setDistance: (d: number) => void
      setAzimuth: (a: number) => void
      /** 评审用：显隐全部地标（主基地 + A/B/C）。隐藏后只剩漫游车与地貌，便于单看车体。 */
      setLandmarksVisible: (visible: boolean) => void
      /** 评审用：显隐场景内 POI 信标（操作台/样本站/迷阵/能源站）。 */
      setPoisVisible: (visible: boolean) => void
      /** 评审用：单独显隐漫游车，便于拍纯净的主基地 / 地标三视。 */
      setRoverVisible: (visible: boolean) => void
      /** 评审用：单独显隐 KIBO，便于拍纯净的漫游车 / 主基地三视。 */
      setKiboVisible: (visible: boolean) => void
      /** 评审用：显隐火星地表（山脉/沙丘），便于拍无遮挡的纯净资产三视。 */
      setTerrainVisible: (visible: boolean) => void
      /** 评审用：显隐天空盒，便于拍无遮挡的纯净资产三视。 */
      setSkyVisible: (visible: boolean) => void
      /** 评审用：直接放置相机坐标（绕过方位/俯仰钳制），用于拍标准前/侧/顶三视。 */
      setCaptureCamera: (x: number, y: number, z: number, tx: number, ty: number, tz: number) => void
      /** 评审用：释放 setCaptureCamera 的直设相机，恢复受限工作视角。 */
      releaseCaptureCamera: () => void
      /** 评审/截图用：直接冻结或恢复实时渲染循环。 */
      setPaused: (paused: boolean) => void
      missionSnapshot: () => MissionSnapshot | null
      /** 评审用：按类型打开操作台弹窗（base-clean/base-label/base-train/base-select）。 */
      openConsole: (kind: PoiKind) => boolean
      /** 评审用：关闭操作台弹窗。 */
      closeConsole: () => void
      /** 路径选择台对比：把候选路线画成对比丝带。 */
      showCandidateRoutes: () => void
      /** 高亮某条候选路线（其余淡出）。 */
      highlightCandidate: (index: number) => void
      /** 清掉候选丝带，恢复主丝带。 */
      clearCandidateRoutes: () => void
      /** 派遣能源采集车沿指定候选路线往返验证（高潮动画）。 */
      dispatchHauler: (index: number) => boolean
      /** 截图/评审用：打开 KIBO 对话面板。 */
      openKiboDialogue: () => void
    }
  }
}

export function MarsGame3D({
  seed,
  worldIndex: worldIndexProp = 0,
  onDegrade,
  showDevPanel = false,
  showHud = true,
  introFlyover = true,
  onExit,
  onNextWorld,
  onWorldComplete,
}: MarsGame3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<MarsStage | null>(null)
  const statsRef = useRef<StageStats | null>(null)
  const [stats, setStats] = useState<StageStats | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const [activeViewpoint, setActiveViewpoint] = useState('overview')
  const [mission, setMission] = useState<MissionSnapshot | null>(null)
  const [notice, setNotice] = useState('')
  /** 扫描读条进度（0..1），null 表示空闲。供 HUD 画"以车身为中心"的扫描读条。 */
  const [scanProgress, setScanProgress] = useState<number | null>(null)
  /** POI 交互（样本站采集）读条进度（0..1），null 表示空闲。 */
  const [interactProgress, setInteractProgress] = useState<number | null>(null)
  /** GM 面板（开发者工具）开合状态。默认隐藏，仅由 HUD 上的 GM 按钮开启。 */
  const [devOpen, setDevOpen] = useState(showDevPanel ?? false)
  /** 当前地图索引 0/1（火星一号 / 火星二号）。 */
  const [worldIndex, setWorldIndex] = useState(Math.max(0, Math.min(MARS_MAP_COUNT - 1, worldIndexProp)))
  /** 用户在 HUD 手动选的画质；null 表示交给自动适配。 */
  const [qualityPref, setQualityPref] = useState<QualityLevel | null>(null)
  /** 运行时降级原因（持续低帧/WebGL 丢失）。用于无障碍降级提示，不谎称已切到 2.5D。 */
  const [degraded, setDegraded] = useState<string | null>(null)
  /** 当前打开的操作台弹窗（走到 POI 按 E 触发）。null 表示无弹窗。 */
  const [activeConsole, setActiveConsole] = useState<Poi | null>(null)
  /** 基地操作台未解锁时的"暂无法互动"锁定弹窗（需求 C #312）。 */
  const [lockedConsole, setLockedConsole] = useState<Poi | null>(null)
  // 需求 E③：左键点中 POI 标记 / KIBO NPC 时弹出的说明或对话面板。
  const [infoPanel, setInfoPanel] = useState<{ type: 'poi'; poi: Poi } | { type: 'kibo' } | null>(null)
  // 采集车验证结束弹窗：成功 / 失败。
  const [resultModal, setResultModal] = useState<{ kind: 'success' | 'failed'; reason?: string } | null>(null)
  // 任务成功后 KIBO 头顶感叹号标记与结算对白。
  const [kiboMarkerScreen, setKiboMarkerScreen] = useState<{ x: number; y: number } | null>(null)
  // 入场全景浏览：镜头从终点掠过各重要地点，最后落到 R-7 上再交还操控。
  const [introPlaying, setIntroPlaying] = useState(false)
  const [introLabel, setIntroLabel] = useState<string | null>(null)
  // 运镜结束后的"交接"提示：明确告诉玩家"现在归你操控了"，且刻意不挡画面、不拦输入。
  const [introHandoff, setIntroHandoff] = useState(false)
  const handoffTimerRef = useRef<number | null>(null)
  // 新手引导是否已主动关闭（按钮/ESC/回车）。仅用于判断"ESC 是否应打开设置"的阻断态，不参与渲染。
  const [onboardingDismissed, setOnboardingDismissed] = useState(false)
  /** 2026-09-13 老大反馈：新手说明先弹，确定/关闭后才播开场运镜（顺序不能反）。 */
  const [introPending, setIntroPending] = useState(false)
  /**
   * 这次进入时新手引导**到底会不会出现**（与 Onboarding 内部判断同源）。
   * 2026-09-13 事故根因：intro 曾被绑死在 onDismiss 上，而 Onboarding 内部
   * 用 localStorage 记忆「看过一次不再弹」——引导不渲染时 onDismiss 永不调用，
   * 开场动画就永远不播。父组件必须自己知道引导会不会出现，才能兜底触发动画。
   */
  const [onboardingWillShow] = useState(() => {
    try {
      return !window.localStorage.getItem(onboardingStorageKey(worldIndex))
    } catch {
      return true
    }
  })

  /**
   * 收尾入场浏览：字幕退场 → 弹"交接"提示 → 提示自动消失。
   * 交接提示这一步不能省：镜头定格后如果不给信号，玩家分不清是"还在动画里"
   * 还是"已经该我操作了"，尤其前面 9 秒都是系统主导，突然静止很容易被当成卡住。
   */
  const finishIntro = useCallback(() => {
    setIntroPlaying(false)
    setIntroLabel(null)
    setIntroHandoff(true)
    if (handoffTimerRef.current !== null) window.clearTimeout(handoffTimerRef.current)
    handoffTimerRef.current = window.setTimeout(() => {
      setIntroHandoff(false)
      handoffTimerRef.current = null
    }, 2600)
  }, [])

  // 卸载时清掉交接提示的定时器，避免对已卸载组件 setState。
  useEffect(() => () => {
    if (handoffTimerRef.current !== null) window.clearTimeout(handoffTimerRef.current)
  }, [])

  // 音效：默认关闭，偏好持久化在 localStorage（与历史 mars 任务共用同一开关 key）。
  // createSynth 本身不创建 AudioContext，真正打开声音时才懒加载。
  const synthRef = useRef<Synth | null>(null)
  if (synthRef.current === null) synthRef.current = createSynth()
  const synth = synthRef.current
  const [soundOn, setSoundOn] = useState(() => synth.isEnabled())

  // 候选点只与地形种子有关，不需要等舞台就绪
  const activeSeed = seed ?? WORLD_SEEDS[worldIndex]
  const candidates = useMemo<ScanCandidate[]>(
    () => buildScanCandidates(createHeightField(activeSeed, worldIndex), worldIndex),
    [activeSeed, worldIndex],
  )

  // 路径选择台的候选路线：打开时算一次（避免每帧重跑多次 A*），关闭时清空。
  const candidatePlans = useMemo<RouteCandidate[]>(() => {
    if (activeConsole?.kind !== 'base-select') return []
    return stageRef.current?.mission.candidatePaths() ?? []
  }, [activeConsole])

  const applyViewpoint = useCallback((id: string) => {
    const stage = stageRef.current
    const vp = findViewpoint(id)
    if (!stage || !vp) {
      // 静默 return false 会让截图/QA 工装极难排查（表现为"相机没动"）。
      // 常见原因：id 拼错、该机位不适用于当前地图（worlds 过滤）、stage 还没建好。
      console.warn(
        `[mars] applyViewpoint("${id}") 失败：${!stage ? 'stage 尚未就绪' : '找不到该机位（id 有误或不属于本地图）'}`,
      )
      return false
    }
    // 评审/开发者自由机位：关闭第三人称跟随，机位才能钉住不被火星车带走。
    stage.setFollow(false)
    // 二号地物坐标与一号完全不同（一号 sample-a 在 (-216,236)，二号在 (-150,130)），
    // 机位必须跟到**二号自己的地标**上；直接用硬编码 x/z 会把相机摆到一号的位置，
    // 表现就是"所有机位都跳默认视角"、开发通道看不了二号。
    // 一号永远走硬编码 x/z —— 零回归。
    let vx = vp.x
    let vz = vp.z
    if (worldIndex === 1 && vp.outflowLandmarkId) {
      const lm = stage.field.landmarks.find((m) => m.id === vp.outflowLandmarkId)
      if (lm) {
        vx = lm.x
        vz = lm.z
      }
    }
    stage.rig.setFocus(vx, stage.field.heightAt(vx, vz), vz)
    if (vp.azimuth !== undefined) stage.rig.setAzimuth(vp.azimuth)
    if (vp.distance !== undefined) stage.rig.setDistance(vp.distance)
    stage.rig.snapToFocus()
    setActiveViewpoint(id)
    return true
  }, [worldIndex])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    if (!canCreateWebGLContext()) {
      setUnsupported(true)
      onDegrade?.('浏览器不支持 WebGL')
      return
    }

    let stage: MarsStage | null = null
    try {
      stage = createMarsStage({
        container,
        seed,
        worldIndex,
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        onStats: (s) => {
          statsRef.current = s
          setStats(s)
        },
        onMission: (s) => setMission(s),
        onScanProgress: (p) => setScanProgress(p),
        onInteractProgress: (p) => setInteractProgress(p),
        // 采集读条走满：此刻才真正采集样本，保证"读条表达过程、满格才生效"。
        onInteractComplete: (poiId) => {
          const st = stageRef.current
          if (!st) return
          const poi = st.mission.pois().find((p) => p.id === poiId)
          const label = poi?.label ?? '样本'
          // 读条期间玩家可能把车开走：此时不再执行采集，避免"隔着半张地图把样本收上来"。
          const near = st.mission.snapshot().nearbyPoi
          if (!near || near.id !== poiId) {
            setNotice('采集中断：R-7 离开了样本站。开回样本站再按 E 重新采集。')
            return
          }
          const ok = st.mission.interact()
          setNotice(ok ? `已采集：${label}。返回基地进行数据清洗与标注。` : `${label} 已经采集过了。`)
        },
        onDegrade: (reason) => {
          // 记录原因用于无障碍提示。本任务没有 2.5D 版本，
          // 不会谎称已经切到别的渲染通道，只显示说明性提示。
          setDegraded(reason)
          onDegrade?.(reason)
        },
        // 入场全景浏览播完（或跳过）：收起字幕，先给一段"交接"提示再放新手引导。
        // 直接弹全屏引导会把"镜头定格 → 玩家接手"这个交接动作吃掉，
        // 玩家会以为是自己操作把镜头弄停的，还是不知道现在能不能动。
        onIntroFlyoverDone: finishIntro,
        // 采集车跑完（成功/失败）后弹出结算弹窗，而不是仅在 HUD 里飘一条提示。
        onHaulerFinished: (run) => {
          if (run.status === 'success') {
            setResultModal({ kind: 'success' })
          } else if (run.status === 'failed') {
            setResultModal({ kind: 'failed', reason: run.failReason ?? undefined })
          }
        },
        audio: {
          playScan: () => synth.playScan(),
          setEngine: (v, i) => synth.setEngine(v, i),
          playStuck: () => synth.playStuck(),
          playArrive: () => synth.playArrive(),
          playKibo: () => synth.playKibo(),
        },
      })
    } catch (error) {
      setUnsupported(true)
      onDegrade?.(`3D 场景初始化失败：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    stageRef.current = stage
    ;(window as any).__kiboStage = stage
    setMission(stage.mission.snapshot())

    const observer = new ResizeObserver(() => stage?.resize())
    observer.observe(container)

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const syncMotion = () => stage?.setReducedMotion(motionQuery.matches)
    motionQuery.addEventListener('change', syncMotion)

    window.__kiboMars3D = {
      ready: true,
      gotoViewpoint: applyViewpoint,
      renderAtTime: (seconds: number) => stage?.renderAtTime(seconds),
      listViewpoints: () => VIEWPOINTS.map((v) => v.id),
      getStats: () => statsRef.current,
      scanAt: (x, z) => Boolean(stage?.scanAtWorld(x, z)),
      setPhase: (phase) => stage?.mission.setPhase(phase),
      setThresholds: (caution, blocked) => stage?.mission.setThresholds(caution, blocked),
      replan: () => stage?.mission.replan(),
      setWeight: (key, value) => stage?.mission.setWeight(key, value),
      driveStep: (dt: number) => stage?.mission.stepDrive(dt),
      startDrive: () => stage?.mission.startDrive(),
      stopDrive: () => stage?.mission.stopDrive(),
      driveInfo: () => stage?.mission.driveInfo() ?? null,
      enterManualDrive: () => stage?.enterManualDrive(),
      exitManualDrive: () => stage?.exitManualDrive(),
      setManualInput: (th: number, st: number) => stage?.setManualInput(th, st),
      /** 评审用：把漫游车开到指定世界坐标（候选扫描点）。 */
      driveToPoint: (x: number, z: number) => stage?.driveToPoint(x, z),
      /** 评审用：在侦察阶段以车身为圆心发起读条扫描（等价 E 键）。 */
      startScanCharge: () => stage?.startScanCharge() ?? false,
      manualPose: () => stage?.mission.manualPose() ?? null,
      setUncertaintyChoice: (choice, reason) => stage?.mission.setUncertaintyChoice(choice, reason),
      getDecisionLog: () => stage?.mission.getDecisionLog() ?? [],
      getRuns: () => stage?.mission.getRuns() ?? [],
      resetCamera: () => {
        stage?.rig.setOrbitMode(false)
        applyViewpoint('overview')
      },
      roverPosition: () => stage?.mission.roverPosition() ?? { x: 0, z: 0 },
      focusOn: (x: number, z: number) => stage?.focusOn(x, z),
      setDistance: (d: number) => stage?.rig.setDistance(d),
      setAzimuth: (a: number) => stage?.rig.setAzimuth(a),
      setLandmarksVisible: (visible: boolean) => {
        if (stage) stage.landmarks.group.visible = visible
      },
      setPoisVisible: (visible: boolean) => {
        if (stage) stage.poiMarkers.setVisible(visible)
      },
      setRoverVisible: (visible: boolean) => {
        if (stage) stage.rover.group.visible = visible
      },
      setKiboVisible: (visible: boolean) => {
        if (stage) stage.kibo.group.visible = visible
      },
      setTerrainVisible: (visible: boolean) => {
        if (stage) stage.terrain.group.visible = visible
      },
      setSkyVisible: (visible: boolean) => {
        if (stage) stage.sky.mesh.visible = visible
      },
      setCaptureCamera: (x: number, y: number, z: number, tx: number, ty: number, tz: number) => {
        if (!stage) return
        stage.rig.paused = true
        stage.rig.camera.position.set(x, y, z)
        stage.rig.camera.lookAt(tx, ty, tz)
        stage.rig.camera.updateProjectionMatrix()
      },
      releaseCaptureCamera: () => {
        if (!stage) return
        stage.rig.paused = false
        stage.rig.snapToFocus()
      },
      /** 评审/截图用：直接冻结或恢复实时渲染循环（与 setCaptureCamera 同闭包，确保暂停到正在跑 rAF 的那个 stage）。 */
      setPaused: (paused: boolean) => {
        if (!stage) return
        stage.rig.paused = paused
      },
      missionSnapshot: () => stage?.mission.snapshot() ?? null,
      /** 评审用：按类型打开操作台弹窗（base-clean/base-label/base-train/base-select）。 */
      openConsole: (kind: PoiKind) => {
        const st = stageRef.current
        if (!st) return false
        const poi = st.mission.pois().find((p) => p.kind === kind)
        if (!poi) return false
        setActiveConsole(poi)
        return true
      },
      /** 评审用：关闭操作台弹窗。 */
      closeConsole: () => setActiveConsole(null),
      /** 路径选择台对比：把候选路线画成对比丝带。 */
      showCandidateRoutes: () => stage?.showCandidateRoutes(),
      /** 高亮某条候选路线（其余淡出）。 */
      highlightCandidate: (i: number) => stage?.highlightCandidate(i),
      /** 清掉候选丝带，恢复主丝带。 */
      clearCandidateRoutes: () => stage?.clearCandidateRoutes(),
      /** 派遣能源采集车沿指定候选路线往返验证（高潮动画）。 */
      dispatchHauler: (index: number) => stage?.dispatchHauler(index) ?? false,
      /** 截图/评审用：打开 KIBO 对话面板。 */
      openKiboDialogue: () => setInfoPanel({ type: 'kibo' }),
    }

    // 滚轮缩放：向上滚拉近（放大）、向下滚推远。距离范围由相机 rig 统一钳制，
    // 不构成自由飞行，符合 3D 准入的固定/受限轨道约束。
    const onWheel = (e: WheelEvent) => {
      const r = stage?.rig
      if (!r) return
      r.nudgeDistance(e.deltaY * 0.06)
      e.preventDefault()
    }
    container.addEventListener('wheel', onWheel, { passive: false })

    // 默认第三人称跟随火星车（不调用 applyViewpoint，避免被拉到全局上帝视角）。
    // 入场全景浏览：交给玩家之前，先把这张地图长什么样过一遍——从终点倒着扫回 R-7。
    if (introFlyover) {
      // 2026-09-13 老大反馈：不立即播——先弹新手说明，其确定/关闭后再开始运镜。
      setIntroPending(true)
    } else {
      setIntroPlaying(false)
    }
    return () => {
      observer.disconnect()
      motionQuery.removeEventListener('change', syncMotion)
      container.removeEventListener('wheel', onWheel)
      delete window.__kiboMars3D
      stage?.dispose()
      stageRef.current = null
    }
  }, [seed, worldIndex, onDegrade, applyViewpoint, synth, introFlyover])

  // 入场浏览期间跟踪当前站点，把地名送到字幕上。播放结束后这个 rAF 立刻停掉。
  useEffect(() => {
    if (!introPlaying) return undefined
    let raf = 0
    let last: string | null = null
    const tick = () => {
      const st = stageRef.current
      if (!st || !st.introFlyoverActive()) {
        finishIntro()
        return
      }
      const label = st.introFlyoverLabel()
      if (label !== last) {
        last = label
        setIntroLabel(label)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [introPlaying, finishIntro])

  /** 跳过入场浏览，立刻落到 R-7 跟车视角。 */
  const handleSkipIntroFlyover = useCallback(() => {
    stageRef.current?.skipIntroFlyover()
    // skipIntroFlyover 会走 endIntroFlyover → onIntroFlyoverDone → finishIntro；
    // 这里再兜一次，防止 reduced-motion 等分支下回调没触发导致字幕卡住。
    finishIntro()
  }, [finishIntro])

  // 入场浏览的跳过只走右下角按钮（鼠标点击），不绑定键盘。
  // ESC 已专用于"任务场景内打开设置界面"，不能在这里抢走；Space/Enter 同理只留给游戏内交互。

  // 运行时降级（持续低帧/WebGL 丢失）：停掉 3D 舞台，避免后台空转渲染。
  useEffect(() => {
    if (degraded && stageRef.current) {
      delete window.__kiboMars3D
      stageRef.current.dispose()
      stageRef.current = null
    }
  }, [degraded])

  // 外部控制 worldIndex 时同步内部状态（会触发 useEffect 重建舞台）
  useEffect(() => {
    const next = Math.max(0, Math.min(MARS_MAP_COUNT - 1, worldIndexProp))
    if (next !== worldIndex) setWorldIndex(next)
  }, [worldIndexProp])

  // 路径选择台打开时，在 3D 场景里画出候选路线丝带对比；关闭时清掉。
  // 2026-09-03 用户反馈：选择路径界面打开时镜头被拉到 overview 全景（distance=620），
  // 关闭后画面卡在全景机位、需要手动复位。需求：选择路径界面就在原地，不要做全景运镜。
  // 候选路线的丝带仍然画出来供学生参考，相机维持玩家当前所在视角。
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    if (activeConsole?.kind === 'base-select') {
      stage.showCandidateRoutes()
    } else {
      stage.clearCandidateRoutes()
    }
  }, [activeConsole])

  // 切到后台标签页就挂起音频；卸载时彻底关掉 AudioContext
  useEffect(() => {
    const onVisibility = () => synth.setPageVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      synth.dispose()
    }
  }, [synth])

  const handleToggleSound = useCallback(() => {
    const next = !synth.isEnabled()
    synth.setEnabled(next)
    setSoundOn(next)
    setNotice(next ? '任务音效已打开。扫描、行驶、翻车都会有声音提示。' : '任务音效已关闭。所有信息在画面和文字里都能看到。')
  }, [synth])

  /** 候选扫描点：把 R-7 开到该点（玩家随后按 E 扫描），而不是瞬间扫描——保留"开到位置再扫描"的游戏化操控。 */
  const handleDriveToCandidate = useCallback((c: ScanCandidate) => {
    const stage = stageRef.current
    if (!stage) return
    synth.resume()
    // 需求 C：扫描次数不限，直接前往候选点即可（不再拦截"次数用完"）。
    stage.driveToPoint(c.x, c.z)
    setNotice(`R-7 正开往${c.label}。开到后按 E，以车身为中心扫描这片区域。`)
  }, [synth])

  const handleThresholds = useCallback((caution: number, blocked: number) => {
    stageRef.current?.mission.setThresholds(caution, blocked)
    setNotice(`通行规则已更新：谨慎 ${Math.min(caution, blocked - 1)}°，禁行 ${blocked}°。`)
  }, [])

  const handleUnknownWeight = useCallback((v: number) => {
    stageRef.current?.mission.setWeight('unknown', v)
    setNotice(v >= 6 ? '规划器会尽量贴着已探明区走。' : v <= 1 ? '规划器会直接冲进没数据的区域。' : '')
  }, [])

  const handlePhase = useCallback((p: MissionPhase) => {
    const stage = stageRef.current
    if (!stage) return
    synth.resume()
    stage.mission.setPhase(p)
    const s = stage.mission.snapshot()
    if (s.phase !== p) {
      setNotice(
        p === 'drive'
          ? '还没有可行路线，先去规划一条。'
          : '至少要先扫描一次，才知道地形长什么样。',
      )
      return
    }
    if (p === 'plan') applyViewpoint('overview')
    setNotice('')
  }, [applyViewpoint, synth])

  const handleReplan = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    synth.playClick()
    const r = stage.mission.replan()
    setNotice(
      r.found
        ? `已重新规划：${r.lengthM.toFixed(0)} 米，其中 ${r.unknownCells} 格没有探测数据。`
        : '按当前规则找不到可行路线。',
    )
  }, [synth])

  const handleReset = useCallback(() => {
    synth.playClick()
    stageRef.current?.mission.reset()
    setNotice('任务已重置，回到扫描阶段。')
  }, [synth])

  /** 软沙脱困：把 R-7 从陷住的软沙格摇出来，继续走原路线（#53/#68）。 */
  const handleEscapeFromStuck = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    const ok = stage.mission.escapeFromStuck()
    if (ok) {
      synth.playClick()
      setNotice('R-7 摇出来了！继续走原路线。')
    }
  }, [synth])

  /** 不确定性处置：把学生对"没数据路段"的决定与理由写进决策日志。 */
  const handleUncertaintyChoice = useCallback(
    (choice: NonNullable<UncertaintyChoice>, reason: string) => {
      synth.playClick()
      stageRef.current?.mission.setUncertaintyChoice(choice, reason)
      setNotice(`已记录你的决定：${reason}`)
    },
    [synth],
  )

  /** 手动选定画质并锁定，弱机型/低电量用户可强制 low；画质分级由舞台独立判定。 */
  const handleSetQuality = useCallback((q: QualityLevel) => {
    stageRef.current?.setQuality(q)
    setQualityPref(q)
  }, [])

  /** 与最近的 POI 交互（E 键 / 点击 / 未来触屏按钮）。 */
  const handleInteract = useCallback(() => {
    const stage = stageRef.current
    if (!stage) return
    synth.resume()
    const near = stage.mission.nearbyPoi()
    if (!near) {
      setNotice('附近没有可交互的目标。靠近操作台或样本站后再试。')
      return
    }
    // 四个基地操作台：未采集样本前先弹"暂无法互动"锁定提示（需求 C #312），
    // 引导玩家先去样本站采集数据；采集到首个样本后，才打开对应的 2D 操作弹窗。
    if (near.kind === 'base-clean') {
      const s = stage.mission.snapshot()
      if (s.inventory.some((i) => i.kind === 'sample')) {
        setActiveConsole(near)
      } else {
        setLockedConsole(near)
      }
      return
    }
    if (near.kind === 'base-label') {
      const s = stage.mission.snapshot()
      if (!s.inventory.some((i) => i.kind === 'sample')) {
        setLockedConsole(near)
      } else if (!s.cleaningDone) {
        setNotice('数据还没清洗好。先去数据清洗台把坏数据剔除，再来标注。')
      } else {
        setActiveConsole(near)
      }
      return
    }
    if (near.kind === 'base-train') {
      const s = stage.mission.snapshot()
      if (!s.inventory.some((i) => i.kind === 'sample')) {
        setLockedConsole(near)
      } else if (!s.labelingDone) {
        setNotice('数据还没标注好。先去数据标注台按规则打完标签，再来训练。')
      } else {
        setActiveConsole(near)
      }
      return
    }
    if (near.kind === 'base-select') {
      const s = stage.mission.snapshot()
      if (!s.inventory.some((i) => i.kind === 'sample')) {
        setLockedConsole(near)
      } else if (!s.trained) {
        setNotice('AI 还没训练好。训练完成后，路径选择台才会生成路线。')
      } else {
        setActiveConsole(near)
      }
      return
    }
    // 样本站：按 E 触发采集读条，走满后由 onInteractComplete 真正采集——
    // 让"收集样本"有可见的过程，而不是点一下就瞬间完成。
    if (near.kind === 'sample-a' || near.kind === 'sample-b' || near.kind === 'sample-c') {
      // 已采集过：直接给反馈，不必再走一遍读条。
      if (stage.mission.snapshot().inventory.some((i) => i.id === near.id)) {
        setNotice(`${near.label} 已经采集过了。`)
        return
      }
      stage.startInteractCharge(near.id)
      return
    }
    // 能源站：现在它是采集车的目的地，不是玩家直接交付的地方。
    if (near.kind === 'energy-station') {
      const snap = stage.mission.snapshot()
      if (!snap.trained) {
        setNotice('能源站不接收未训练的数据。先把样本清洗、标注、训练好导航 AI，再派采集车来。')
        return
      }
      if (snap.missionComplete) {
        setNotice('这张地图的任务已经完成！采集车已经把能源安全送回主基地。')
      } else {
        setNotice('去路径选择台派遣采集车，让它自动驾驶到能源站采集资源并返回主基地。')
      }
      return
    }
    // 岩石迷阵入口：叙事性路标。
    if (near.kind === 'maze-entrance') {
      stage.mission.interact()
      setNotice('岩石迷阵入口。只有验证通过的 AI 路径才能安全穿越——先去把 AI 训练好、选好路线。')
    }
  }, [synth])

  // 操作台弹窗里的逐条交互：清洗 / 标注 / 训练 / 选路。
  const handleRecordCleanChoice = useCallback((id: string, choice: 'keep' | 'drop') => {
    stageRef.current?.mission.setRecordCleanChoice(id, choice)
  }, [])
  const handleConfirmCleaning = useCallback((): { ok: boolean; mistakes: { id: string; why: string }[] } => {
    const res = stageRef.current?.mission.confirmCleaning() ?? { ok: false, mistakes: [] }
    if (res.ok) {
      setNotice('数据清洗完成！坏数据已剔除，可以开始标注了。')
    } else {
      setNotice(`还有 ${res.mistakes.length} 条数据没判对，看看提示再改一次。`)
    }
    return res
  }, [])
  const handleRecordLabel = useCallback((id: string, label: 'pass' | 'caution' | 'block') => {
    stageRef.current?.mission.setRecordLabel(id, label)
  }, [])
  const handleConfirmLabeling = useCallback((): { ok: boolean; mistakes: { id: string; why: string }[] } => {
    const res = stageRef.current?.mission.confirmLabeling() ?? { ok: false, mistakes: [] }
    if (res.ok) {
      setNotice('数据标注完成！现在可以用这些标准答案去训练导航 AI 了。')
    } else {
      setNotice(`还有 ${res.mistakes.length} 条标签没标对，提示里会念出你定的规则。`)
    }
    return res
  }, [])
  const handleConsoleTrain = useCallback(() => {
    const ok = stageRef.current?.mission.train() ?? false
    if (ok) {
      const snap = stageRef.current?.mission.snapshot()
      setNotice(`导航 AI 训练完成，信心 ${(snap?.aiConfidence ?? 0) * 100}%。去路径选择台挑一条路线验证。`)
    } else {
      setNotice('训练 AI 需要先完成数据标注。把清洗过的数据逐条标完再来。')
    }
  }, [])
  const handleConsoleSelect = useCallback((index: number) => {
    const stage = stageRef.current
    if (!stage) return
    stage.mission.selectCandidate(index)
    stage.highlightCandidate(index)
    const label = stage.mission.candidatePaths()[index]?.label ?? '候选路线'
    setNotice(`已高亮「${label}」，点击「确定路线」让采集车出发验证。`)
  }, [])

  /** 路径选择台底部按钮：派遣采集车沿选定的候选路线往返验证。 */
  const handleDispatchHauler = useCallback((index: number) => {
    const stage = stageRef.current
    if (!stage) return
    const snap = stage.mission.snapshot()
    if (!snap.trained) {
      setNotice('采集车需要训练好的导航 AI 才能自动驾驶。先去 AI 训练舱完成训练。')
      return
    }
    if (snap.hauler.status !== 'idle' && snap.hauler.status !== 'success' && snap.hauler.status !== 'failed') {
      setNotice('采集车已经在路上了，等它跑完再试。')
      return
    }
    if (snap.hauler.status === 'failed') {
      stage.recallHauler()
    }
    setActiveConsole(null)
    const ok = stage.dispatchHauler(index)
    if (!ok) {
      setNotice('这条路线没法走。换一条候选路线，或者把地图扫清楚一点。')
      return
    }
    const label = stage.mission.candidatePaths()[index]?.label ?? '候选路线'
    setNotice(`采集车已出发走「${label}」。注意看车顶机械臂抓取资源和电池余量。`)
  }, [])

  /**
   * 结果弹窗的按钮：
   * - 失败 → 收车并把镜头放回主基地，玩家重新开 R-7 去路径选择台再选一条；
   * - 成功 → 不接管镜头，玩家重新拿回 R-7 操控权（finishHauler 已经把镜头复位到跟车视角）。
   *   玩家自己开回基地，路过 KIBO 头顶"!"标记时点它弹结算对白。
   *   之前的实现把 setFollow(false) + setFocus(kibo) 锁死在 KIBO，导致玩家没法开车。
   */
  const handleResultConfirm = useCallback((kind: 'success' | 'failed') => {
    setResultModal(null)
    const stage = stageRef.current
    if (kind === 'failed') {
      stage?.recallHauler()
      stage?.setFollow(true)
      stage?.rig.snapToFocus()
      setNotice('已回到主基地。去路径选择台重新比较两条路线，再验证一次。')
    } else {
      // 成功：把操控权完整交还玩家——重新跟随 R-7、确保 R-7 显形、镜头回到跟车机位。
      // v1.3.5：显式 setFollow(true) 是必要的——出勤期间若玩家用 WASD 平移过镜头，
      // stage 内部 followRover 会被置 false，光靠 finishHauler 里的 rig 复位不足以把
      // 相机的"跟随目标"切回 R-7，玩家会觉得"车不听我的"。
      stage?.setFollow(true)
      stage?.rig.snapToFocus()
      setNotice('去找 KIBO，把这次验证结果告诉它。点 KIBO 头顶的"!"也可以直接汇报。')
    }
  }, [])

  /** 从 KIBO 结算对白返回探索舱。 */
  const handleBackToCabin = useCallback(() => {
    setInfoPanel(null)
    onExit?.()
  }, [onExit])

  /** 从 KIBO 结算对白继续任务：若二号地图已就绪则进入，否则关闭弹窗留在当前场景。 */
  const handleContinueTask = useCallback(() => {
    const next = worldIndex + 1
    if (next < MARS_MAP_COUNT) {
      // 二号地图流程已就绪：直接切换。
      setWorldIndex(next)
      onNextWorld?.(next)
      setInfoPanel(null)
      setNotice(`进入${marsMapName(next)}地图：用你在${marsMapName(worldIndex)}地图学到的规则继续训练 AI。`)
    } else {
      // 后续地图尚未开发完成：关闭弹窗，让玩家在当前场景自由活动。
      setInfoPanel(null)
      setNotice('后续地图正在准备中，你可以在当前场景继续探索。')
    }
  }, [worldIndex, onNextWorld])

  // 任务完成后，KIBO 头顶感叹号跟随 KIBO 的屏幕位置。
  // 位置变化小于 3px 就不 setState，避免每帧重渲染整棵 React 树。
  const kiboMarkerLastRef = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!mission?.missionComplete) {
      kiboMarkerLastRef.current = null
      setKiboMarkerScreen(null)
      return
    }
    let raf = 0
    const tick = () => {
      const p = stageRef.current?.kiboScreenPosition() ?? null
      const last = kiboMarkerLastRef.current
      const moved = p && last ? Math.hypot(p.x - last.x, p.y - last.y) >= 3 : p !== last
      if (moved) {
        kiboMarkerLastRef.current = p
        setKiboMarkerScreen(p)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [mission?.missionComplete])

  /** 完成当前地图后进入下一张地图（火星一号 → 火星二号）。 */
  const handleNextWorld = useCallback(() => {
    const next = worldIndex + 1
    if (next >= MARS_MAP_COUNT) {
      setNotice('火星任务全部完成！你训练的 AI 已经通过了两张地图的考验。')
      return
    }
    setWorldIndex(next)
    onNextWorld?.(next)
    setNotice(`进入${marsMapName(next)}地图：用你在${marsMapName(worldIndex)}地图学到的规则继续训练 AI。`)
  }, [worldIndex, onNextWorld])

  /** 地图 C 盲区指挥：下达命令、局部预览后果并放行验证车（P6）。 */
  const handleIssueBlindCommand = useCallback((choice: 'proceed' | 'reroute' = 'proceed') => {
    const ok = stageRef.current?.mission.issueBlindCommand(choice) ?? false
    if (ok) {
      setNotice(
        choice === 'reroute'
          ? '已揭示盲区局部地形。实测已中止、路线回到规划台——用刚拿到的新数据重新拍板。'
          : '已下达指挥命令：盲区内地形已局部揭示，验证车继续前进。',
      )
    } else {
      setNotice('当前没有需要指挥的盲区，或验证车已经通过盲区了。')
    }
  }, [])

  // P2：强制双图教学弧——当前地图交付能源站后，必须走 KIBO 结算对白才能进入下一张地图。
  // v1.3.4 老大反馈：旧的"右侧报告面板点进入二号地图"提示会让学生跳过 KIBO，
  // 直接被世界切换的 flyover 接管——KIBO"❗️"、结算对白、按钮都没有机会出现。
  // 这里只做 onWorldComplete（持久化进度），不再覆盖 KIBO 引导提示：
  //   - resultModal 确定 → handleResultConfirm('success') 已经 setNotice('去找 KIBO...')
  //   - KIBO 头顶"❗️"在 missionComplete 后自动出现（kiboMarkerScreen 渲染逻辑）
  //   - 用户点 KIBO → KiboEndTalk 弹窗里有"回到探索舱 / 继续任务"两个按钮
  //   - 真正推进 worldIndex 仅由 handleContinueTask → onNextWorld 完成
  const deliveredWorldRef = useRef(-1)
  useEffect(() => {
    if (!mission?.missionComplete) return
    if (deliveredWorldRef.current === worldIndex) return
    deliveredWorldRef.current = worldIndex
    onWorldComplete?.(worldIndex)
    // 不再 setNotice——避免覆盖 handleResultConfirm 已设的"去找 KIBO..."
  }, [mission?.missionComplete, worldIndex, onWorldComplete])

  // === RPG 操控：右键拖拽转镜头、左键点地设航点、WASD 直接驾驶 ===
  const orbitRef = useRef({ active: false, x: 0, y: 0 })

  // WASD 不再控车，而是控制地图镜头平移（受限斜俯视下只平移焦点，不自由飞行）。
  const camKeysRef = useRef<Set<string>>(new Set())
  /** 根据当前按下的 WASD 计算地图平移输入并传给 stage（u 右/左，v 上/下）。 */
  const updateCamPan = useCallback(() => {
    const k = camKeysRef.current
    const u = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0)
    const v = (k.has('w') ? 1 : 0) - (k.has('s') ? 1 : 0)
    stageRef.current?.setCameraPanInput(u, v)
  }, [])

  /** 复位镜头：退出自由轨道、回到第三人称跟随火星车（正常游玩视角）。 */
  const handleResetCamera = useCallback(() => {
    stageRef.current?.rig.setOrbitMode(false)
    stageRef.current?.setFollow(true)
  }, [])

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    synth.resume()
    const stage = stageRef.current
    if (!stage) return
    if (e.button === 2) {
      // 右键：进入自由轨道并开始拖拽
      e.preventDefault()
      orbitRef.current = { active: true, x: e.clientX, y: e.clientY }
      stage.rig.setOrbitMode(true)
    } else if (e.button === 0) {
      // 左键：先分流命中对象——POI 标记弹说明、KIBO NPC 弹对话、地面则 R-7 自动驶向该点。
      const hit = stage.pickAt(e.nativeEvent)
      if (hit.type === 'poi') {
        setInfoPanel({ type: 'poi', poi: hit.poi })
      } else if (hit.type === 'kibo') {
        setInfoPanel({ type: 'kibo' })
      } else if (hit.type === 'ground') {
        // 任意阶段都可开到该点——包括侦察阶段"开到位置再按 E"，不再用鼠标点地直接扫描。
        // 采集车出勤期间左键不能给 R-7 改向：它是自动驾驶，玩家只能看。
        if (stageRef.current?.haulerActive()) {
          setNotice('采集车正在自动驾驶，鼠标左键不会控制它。你可以右键转视角、WASD 平移镜头。')
          return
        }
        stage.driveTo(e.nativeEvent)
      }
      // 'none'（点到天空/UI 外）不做任何事
    }
  }, [synth, mission?.phase])

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!orbitRef.current.active) return
      const dx = e.clientX - orbitRef.current.x
      const dy = e.clientY - orbitRef.current.y
      orbitRef.current.x = e.clientX
      orbitRef.current.y = e.clientY
      const rig = stageRef.current?.rig
      rig?.nudgeAzimuth(-dx * 0.005)
      rig?.nudgeElevation(-dy * 0.004)
    }
    const onUp = (e: PointerEvent) => {
      if (e.button === 2) orbitRef.current.active = false
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  // 2026-09-03：keyup 监听已并入上面新增的 window keydown/keyup useEffect，无需独立 handleKeyUp。

  if (unsupported || degraded) {
    return (
      <div className="mars3d-fallback" role="alert">
        <p>
          {unsupported
            ? '这台设备暂时无法显示 3D 火星盆地（浏览器不支持 WebGL）。'
            : `3D 视图已暂停：${degraded}。`}
        </p>
        <p className="mars3d-fallback__hint">
          该任务以 3D 形式呈现，需要支持 WebGL 的浏览器。可返回探索舱选择其它任务，或更换设备/浏览器后重试。
        </p>
      </div>
    )
  }

  const current = findViewpoint(activeViewpoint)

  // 是否有"阻断式模态"打开：ESC 在这些模态里应交给它们自己关闭，而不是抢开设置界面。
  // 新手引导用 onboardingDismissed 跟踪其真实可见性（它内部 dismiss 后即便渲染条件仍满足也已消失）。
  // 2026-09-13：新手说明先于运镜弹出（不等 introPlaying/introHandoff——运镜还没开始）；
  // 一旦 dismiss，运镜接管，onboarding 自然不再出现。
  const onboardingVisible = showHud && !!mission && !onboardingDismissed

  /**
   * 兜底：引导这次不显示（学生早就点过「开始探索」）时，**不能把开场动画一起搭进去**。
   * mission 就绪后立刻播——否则会出现「引导和动画都不出现」的空白开场。
   */
  useEffect(() => {
    if (!introPending) return
    if (!mission) return
    if (onboardingWillShow) return // 引导会出现 → 交给 onDismiss 触发
    setIntroPending(false)
    const started = stageRef.current?.playIntroFlyover()
    setIntroPlaying(!!started)
  }, [introPending, mission, onboardingWillShow])
  const blockingModalOpen =
    Boolean(activeConsole) ||
    Boolean(lockedConsole) ||
    Boolean(infoPanel) ||
    Boolean(resultModal) ||
    introPlaying ||
    onboardingVisible

  /**
   * 键盘：方向键调镜头（等价按钮入口）；WASD 平移地图镜头；空格复位跟车；E 交互。
   *
   * **2026-09-03 v1.3.4**：从 onKeyDown={handleKeyDown} 改成 window.addEventListener('keydown')。
   * 原因：之前监听器绑在 canvas 容器 div 上——用户点击 PoiPrompt 或任意 HUD 元素后，
   * 焦点离开 canvas，按 E 就触发不到 handleKeyDown，看起来"按 E 没反应"。
   * 改成 window 后不管焦点在哪儿都能收到；与 MissionHud 的 ESC 设置快捷键实现一致。
   *
   * 注：本 effect 放在这里而非顶层，是因为依赖的 handleInteract/handleIssueBlindCommand/
   * updateCamPan 都在更靠下声明；TS 不允许"使用在前、声明在后"的 const。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const rig = stageRef.current?.rig
      if (!rig) return
      // 浏览器要求用户手势后才能启动音频。键盘也算手势。
      synth.resume()
      const key = e.key.toLowerCase()
      // WASD 移动地图镜头（受限平移，不控车）：W 上 / S 下 / A 左 / D 右。
      if (key === 'w' || key === 'a' || key === 's' || key === 'd') {
        camKeysRef.current.add(key)
        updateCamPan()
        e.preventDefault()
        return
      }
      // 空格：镜头复位到以火星车为中心的第三人称跟随视角。
      if (key === ' ' || key === 'spacebar') {
        stageRef.current?.setFollow(true)
        e.preventDefault()
        return
      }
      if (key === 'e') {
        // 软沙脱困小游戏进行时，E 键要喂给小游戏而不是触发交互
        if (mission?.softStuck) {
          e.preventDefault()
          return
        }
        // 地图 C 实测：盲区入口停下等待指挥，E ＝ 下达指挥命令并预览后果（P6）
        if (mission?.awaitingBlindCommand) {
          handleIssueBlindCommand()
          e.preventDefault()
          return
        }
        // 侦察阶段：E 的语义取决于"玩家正靠近什么"。
        // 若靠近的是可交互 POI（基地操作台 / 样本站 / 能源站 / 迷阵入口），E 应优先"与 POI 交互"
        // （开操作台或弹出锁定提示），而不是以车身为中心扫描、白白触发一次扫描动作（需求 C #313）。
        // 只有附近没有任何可交互 POI 时，E 才发起扫描蓄力。
        if (mission?.phase === 'scan') {
          if (mission.nearbyPoi) {
            handleInteract()
            e.preventDefault()
            return
          }
          const started = stageRef.current?.startScanCharge() ?? false
          if (started) {
            e.preventDefault()
            return
          }
        }
        handleInteract()
        e.preventDefault()
        return
      }
      switch (e.key) {
        case 'ArrowLeft':
          rig.nudgeAzimuth(-0.06)
          e.preventDefault()
          break
        case 'ArrowRight':
          rig.nudgeAzimuth(0.06)
          e.preventDefault()
          break
        case 'ArrowUp':
          rig.nudgeDistance(-4)
          e.preventDefault()
          break
        case 'ArrowDown':
          rig.nudgeDistance(4)
          e.preventDefault()
          break
        default:
          break
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (camKeysRef.current.has(key)) {
        camKeysRef.current.delete(key)
        updateCamPan()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [synth, mission, handleInteract, handleIssueBlindCommand, updateCamPan])

  return (
    <div className="mars3d-root">
      <div
        ref={containerRef}
        className="mars3d-canvas"
        tabIndex={0}
        role="application"
        aria-label={`火星盆地三维视图，第三人称跟随 R-7 火星车。左键点击地面让 R-7 自动前往该点（AI 驾驶），右键拖拽转动镜头，鼠标滚轮拉近或推远，方向键微调观察角度。侦察阶段开到想要的位置后按 E 键，以车身为中心读条扫描一片圆形区域；靠近地标时按 E 交互。用键盘 WASD 平移地图镜头（W 上 / S 下 / A 左 / D 右），空格键把镜头复位到以 R-7 为中心的跟随视角。`}
        onPointerDown={handlePointerDown}
        onContextMenu={(e) => e.preventDefault()}
      />

      {showHud && mission && (
        <MissionHud
          snapshot={mission}
          stage={stageRef.current}
          candidates={candidates}
          kiboLine={kiboLineFor(mission)}
          notice={notice}
          onDriveToCandidate={handleDriveToCandidate}
          onThresholds={handleThresholds}
          onUnknownWeight={handleUnknownWeight}
          onPhase={handlePhase}
          onReplan={handleReplan}
          onEscapeFromStuck={handleEscapeFromStuck}
          onNotice={setNotice}
          onReset={handleReset}
          onUncertaintyChoice={handleUncertaintyChoice}
          onResetCamera={handleResetCamera}
          onDispatchHauler={handleDispatchHauler}
          onNextWorld={handleNextWorld}
          onIssueBlindCommand={handleIssueBlindCommand}
          worldIndex={worldIndex}
          scanProgress={scanProgress}
          interactProgress={interactProgress}
          soundOn={soundOn}
          onToggleSound={handleToggleSound}
          quality={qualityPref ?? stats?.quality ?? 'high'}
          onSetQuality={handleSetQuality}
          onExit={onExit}
          devPanelOpen={devOpen}
          onToggleDevPanel={() => setDevOpen((v) => !v)}
          blockingModalOpen={blockingModalOpen}
        />
      )}

      {showHud && mission && activeConsole && (
        <OperationConsole
          poi={activeConsole}
          snapshot={mission}
          candidatePlans={candidatePlans}
          onClose={() => setActiveConsole(null)}
          onRecordCleanChoice={handleRecordCleanChoice}
          onConfirmCleaning={handleConfirmCleaning}
          onRecordLabel={handleRecordLabel}
          onConfirmLabeling={handleConfirmLabeling}
          onTrain={handleConsoleTrain}
          onSelectCandidate={handleConsoleSelect}
          onDispatchHauler={handleDispatchHauler}
        />
      )}

      {showHud && mission && lockedConsole && (
        <LockedConsole poi={lockedConsole} onClose={() => setLockedConsole(null)} />
      )}

      {infoPanel?.type === 'poi' && (
        <PoiInfoPanel poi={infoPanel.poi} onClose={() => setInfoPanel(null)} />
      )}
      {infoPanel?.type === 'kibo' && mission && (mission.missionComplete ? (
        <KiboEndTalk
          worldGoal={mission.worldGoal.label}
          routeLabel={mission.hauler.routeLabel}
          energyLeft={mission.hauler.energy}
          hasNextWorld={worldIndex + 1 < MARS_MAP_COUNT}
          // v1.3.5：关界面 ≠ 回探索舱。✕/ESC/点背景只收起弹窗、人留在火星场景；
          // 只有显式点底部「回到探索舱」按钮才真实退出任务。
          onClose={() => setInfoPanel(null)}
          onBackToCabin={handleBackToCabin}
          onContinueTask={handleContinueTask}
        />
      ) : (
        <KiboDialogue snapshot={mission} onClose={() => setInfoPanel(null)} />
      ))}

      {/* 采集车验证结果弹窗（成功 / 失败） */}
      {resultModal && (
        <MissionResultModal
          kind={resultModal.kind}
          reason={resultModal.reason}
          onConfirm={() => handleResultConfirm(resultModal.kind)}
        />
      )}

      {/* 任务完成后 KIBO 头顶的感叹号：点它汇报 */}
      {mission?.missionComplete && kiboMarkerScreen && !resultModal && !infoPanel && (
        <button
          type="button"
          className="mars-kibo-marker"
          style={{ left: `${kiboMarkerScreen.x}px`, top: `${kiboMarkerScreen.y}px` }}
          aria-label="和 KIBO 对话"
          onClick={() => setInfoPanel({ type: 'kibo' })}
        >
          !
        </button>
      )}

      {devOpen && (
        <div className="mars3d-devpanel">
          <div className="mars3d-devpanel__row">
            {VIEWPOINTS.map((vp) => (
              <button
                key={vp.id}
                type="button"
                onClick={() => applyViewpoint(vp.id)}
                aria-pressed={activeViewpoint === vp.id}
                className={activeViewpoint === vp.id ? 'is-active' : undefined}
              >
                {vp.label}
              </button>
            ))}
          </div>
          {stats && (
            <p className="mars3d-devpanel__stats">
              {stats.fps.toFixed(0)} fps · {stats.frameMs.toFixed(1)} ms · 三角面{' '}
              {(stats.triangles / 1000).toFixed(0)}k · drawcall {stats.drawCalls} · 像素比{' '}
              {stats.pixelRatio.toFixed(2)} · 画质 {stats.quality}
            </p>
          )}
          {current && <p className="mars3d-devpanel__hint">检视要点：{current.focusOn}</p>}
          {degraded && (
            <p className="mars3d-devpanel__hint mars3d-devpanel__hint--warn">
              已降级：{degraded}
            </p>
          )}
        </div>
      )}

      {/* 入场全景浏览的字幕与跳过入口。镜头此时不属于玩家，所以显眼地给出"跳过"。 */}
      {introPlaying && (
        <div className="mars-intro" role="status" aria-live="polite">
          <div className="mars-intro__card">
            <p className="mars-intro__eyebrow">{marsMapName(worldIndex)}地图 · 全景浏览</p>
            {/* key 让地名每次切换都重新挂载，触发淡入，避免文字硬跳。 */}
            <p key={introLabel ?? 'init'} className="mars-intro__place">
              {introLabel ?? '准备中…'}
            </p>
            <p className="mars-intro__lead">镜头正在带你过一遍这张地图，最后会停在 R-7 上。</p>
            <button type="button" className="mars-intro__skip" onClick={handleSkipIntroFlyover}>
              跳过，直接开始
            </button>
          </div>
        </div>
      )}

      {/*
        交接提示：镜头定格、操控交还的那一瞬间。
        刻意做成不拦点击的轻提示——玩家这 2.6 秒里已经可以开车了，
        不能让"提示"变成又一层要点的弹窗。
      */}
      {introHandoff && (
        <div className="mars-intro-handoff" role="status" aria-live="polite">
          <p className="mars-intro-handoff__title">现在由你操控 R-7</p>
          <p className="mars-intro-handoff__lead">
            左键点地面让 R-7 开过去，靠近淡青色标记按 E 扫描。
          </p>
        </div>
      )}

      {/* 2026-09-13 老大反馈：新手说明先于运镜弹出，确定/关闭后才开始播镜头动画。 */}
      {showHud && mission && !onboardingDismissed && (
        <Onboarding
          worldIndex={worldIndex}
          onDismiss={() => {
            setOnboardingDismissed(true)
            if (introPending) {
              setIntroPending(false)
              const started = stageRef.current?.playIntroFlyover()
              setIntroPlaying(!!started)
            }
          }}
        />
      )}
    </div>
  )
}
