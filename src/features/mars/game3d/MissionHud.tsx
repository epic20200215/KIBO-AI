/**
 * 任务 HUD：RPG 式紧凑任务界面。
 *
 * 设计原则（本轮优化）
 * --------------------
 * 1.  viewport 优先：关键信息用角落追踪器 + 状态徽标常驻，详细控制台默认收起。
 * 2.  不把所有面板平铺：需要深度操作时，用户主动展开右侧"AI 控制台"。
 * 3.  KIBO 对白以浮动气泡出现，不常驻占用空间，保持伙伴感。
 * 4.  所有文本走 DOM，不烘焙进贴图；每个鼠标操作都有等价键盘入口。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PHASE_LABEL,
  SIX_STEP_LABEL,
  SIX_STEP_ORDER,
  type HaulerRun,
  type MissionPhase,
  type MissionSnapshot,
  type Poi,
  type ScanCandidate,
  type UncertaintyChoice,
} from './core/mission'
import type { KiboLine } from './kiboLines'
import { kiboIdleLine, kiboPoiLine } from './kiboLines'
import { POI_COLOR } from './render/pois'
import { MissionMinimap } from './MissionMinimap'
import type { MarsStage, QualityLevel } from './stage'
import { MARS_MAP_COUNT, marsMapName } from './core/heightField'

/** 画质循环顺序（系统按钮点按切换，不弹菜单）。 */
const QUALITY_CYCLE: QualityLevel[] = ['high', 'medium', 'low']
const QUALITY_LABEL: Record<QualityLevel, string> = {
  high: '高清',
  medium: '均衡',
  low: '流畅',
}

export type MissionHudProps = {
  snapshot: MissionSnapshot
  candidates: ScanCandidate[]
  /** 候选扫描点：把 R-7 开到该点（玩家随后按 E 扫描），保留"开到位置再扫描"的游戏化操控。 */
  onDriveToCandidate: (c: ScanCandidate) => void
  /** 侦察阶段按 E 的扫描读条进度（0..1），null 表示空闲。供 HUD 画"以车身为中心"的扫描读条。 */
  scanProgress: number | null
  /** 样本站采集读条进度（0..1），null 表示空闲。走满后才真正采集到样本。 */
  interactProgress?: number | null
  onThresholds: (caution: number, blocked: number) => void
  onUnknownWeight: (v: number) => void
  onPhase: (p: MissionPhase) => void
  onReplan: () => void
  /** 软沙脱困：摇出 R-7 后恢复行驶（#53/#68 小游戏成功后调用）。 */
  onEscapeFromStuck?: () => void
  /** 在 HUD 内显示一条临时提示（例如小游戏失败后的鼓励）。 */
  onNotice?: (msg: string) => void
  onReset: () => void
  onUncertaintyChoice: (choice: NonNullable<UncertaintyChoice>, reason: string) => void
  onResetCamera: () => void
  /** 派遣 AI 自动驾驶验证车（资源采集车）沿指定候选路线验证。 */
  onDispatchHauler: (index: number) => void
  /** 完成当前地图后进入下一张地图（A → B → C）。 */
  onNextWorld?: () => void
  /** 地图 C 盲区指挥：下达命令、局部预览后果并放行验证车（P6）。 */
  /** @param choice `'proceed'` 继续前进｜`'reroute'` 返回重选路线（override plan） */
  onIssueBlindCommand?: (choice?: 'proceed' | 'reroute') => void
  /** 当前地图索引 0/1/2（A/B/C）。 */
  worldIndex?: number
  notice: string
  soundOn: boolean
  onToggleSound: () => void
  quality: QualityLevel
  onSetQuality: (q: QualityLevel) => void
  kiboLine: KiboLine
  /** 退出当前舞台（返回探索舱）。设置界面的"退出任务"入口，可选。 */
  onExit?: () => void
  /** 3D 舞台实例（小地图读取网格/路径用）。 */
  stage: MarsStage | null
  /** GM 面板（开发者工具）是否打开。 */
  devPanelOpen: boolean
  /** 切换 GM 面板。 */
  onToggleDevPanel: () => void
  /**
   * 是否有阻断式模态（操作台 / KIBO 对话 / POI 信息 / 结算 / 入场运镜 / 新手引导）正打开。
   * ESC 在任务场景内用作"打开设置"的快捷键，但若有这类模态打开，ESC 应交给该模态自己关闭，
   * 不能抢着打开设置界面（否则会和"ESC 关闭该模态"同时触发）。
   */
  blockingModalOpen?: boolean
}

const STEPS: MissionPhase[] = ['scan', 'rules', 'plan', 'drive', 'revise', 'report']

/** 阶段是否可进入。与 mission.ts 的 canEnter 保持同一口径。 */
function stepEnabled(step: MissionPhase, s: MissionSnapshot): boolean {
  if (step === 'scan') return true
  if (step === 'rules' || step === 'plan') return s.hasScanned
  if (step === 'drive') return Boolean(s.plan?.found)
  if (step === 'revise')
    return s.driveStatus === 'stuck' || s.driveStatus === 'arrived' || s.phase === 'revise'
  if (step === 'report') return s.driveStatus === 'arrived' || s.phase === 'report'
  return false
}

function objectiveHint(phase: MissionPhase): string {
  switch (phase) {
    case 'scan':
      return '收集地形数据来训练 AI'
    case 'rules':
      return '告诉 AI 什么坡能走'
    case 'plan':
      return '让 AI 按规则算路线'
    case 'drive':
      return '实测 AI 路线是否成立'
    case 'revise':
      return '补数据或改规则，让 AI 更准'
    case 'report':
      return '记录你训练出的 AI 方案'
  }
}

/** 每个 POI 的一句话用途，直接写进 HUD 交互条，让"不懂怎么玩"变成"一眼看懂"。 */
const POI_PURPOSE: Record<string, string> = {
  'base-clean': '把采集到的原始数据去噪，AI 才不会学到错误地形',
  'base-label': '给样本/路段打标签，这是 AI 学习的标准答案',
  'base-train': '消耗标注数据，训练导航 AI',
  'base-select': 'AI 按你的规则生成几条候选路径，你来选',
  'sample-a': '采集河床沉积样本，扩充 AI 的训练数据集',
  'sample-b': '采集沙丘背风侧样本，帮 AI 学会识别软沙',
  'sample-c': '采集坑缘溅射样本，让 AI 认识撞击地形',
  'maze-entrance': '只有 AI 验证通过的路径才能安全穿越',
  'energy-station': '派遣 AI 自动驾驶验证车，把训练好的 AI 放到真实路线上检验',
}

/** POI 交互条右下角的实时状态：根据背包/清洗/标注进度动态显示下一步。 */
function poiStatus(poi: Poi, s: MissionSnapshot): string {
  const samples = s.inventory.filter((i) => i.kind === 'sample')
  if (poi.kind.startsWith('sample-')) {
    const item = s.inventory.find((i) => i.id === poi.id)
    return item ? '已采集 · 待清洗标注' : '未采集 · 按 E 采集'
  }
  if (poi.kind === 'base-clean') {
    const cleaned = samples.filter((i) => i.cleaned).length
    return samples.length === 0 ? '先去采集样本' : `已清洗 ${cleaned}/${samples.length}`
  }
  if (poi.kind === 'base-label') {
    const toLabel = samples.filter((i) => i.cleaned && !i.labeled).length
    const labeled = samples.filter((i) => i.labeled).length
    if (labeled === 0 && toLabel === 0) return samples.length === 0 ? '先去采集样本' : '先清洗数据'
    return `待标注 ${toLabel} · 已标注 ${labeled}`
  }
  if (poi.kind === 'base-train') {
    if (s.trained) return '已完成训练'
    return samples.some((i) => i.labeled) ? '可以开始训练' : '需要先标注数据'
  }
  if (poi.kind === 'base-select') {
    if (!s.trained) return '先训练 AI，再回来选路线'
    return '选择路线并派采集车验证'
  }
  if (poi.kind === 'maze-entrance') return '验证通过的 AI 才能穿越'
  if (poi.kind === 'energy-station') {
    if (s.missionComplete) return '任务完成！'
    if (!s.trained) return '先训练 AI'
    return '采集车将到此采集资源'
  }
  return ''
}

function haulerStatusText(status: HaulerRun['status']): string {
  switch (status) {
    case 'outbound':
      return '自动驾驶中：前往能源站'
    case 'collecting':
      return '到达能源站：机械臂正在抓取玄武岩/赤铁矿/橄榄石'
    case 'returning':
      return '返程中：返回主基地'
    case 'success':
      return '验证完成：玄武岩/赤铁矿/橄榄石已安全送回'
    case 'failed':
      return '验证失败'
    default:
      return ''
  }
}

/**
 * 不确定性处置的三个选项（aiquests：扫描盲区 → 显式决策 → 留下理由）。
 * 理由文本预置，保证键盘/触屏用户零输入也能完成决策，同时决策日志有可追溯记录。
 */
const UNCERTAINTY_OPTIONS: Array<{
  choice: NonNullable<UncertaintyChoice>
  label: string
  reason: string
  desc: string
}> = [
  {
    choice: 'detour',
    label: '绕开它',
    reason: '选择绕行：不拿没有数据的路段赌运气。',
    desc: '调高"对未知区的谨慎程度"，让规划器贴着已探明区走。里程会变长。',
  },
  {
    choice: 'pass-reason',
    label: '说明理由后通过',
    reason: '选择通过：已知这段没有数据，判断风险可控，用实测来验证。',
    desc: '承认这是一次带假设的决策，跑完之后用结果检验假设对不对。',
  },
  {
    choice: 'accept-risk',
    label: '承担风险直穿',
    reason: '选择直穿：优先里程最短，接受可能翻车的后果。',
    desc: '最短但最险。翻车了也是有效数据——你会知道那里到底能不能走。',
  },
]

/**
 * KIBO 对白气泡的触发与生命周期管理（UI/UX 重设计 2.2）。
 *
 * 触发时机：阶段切换、进入新 POI 区域、玩家停滞 30 秒、实测成功/失败。
 * 行为：出现后停留 3 秒自动淡出；玩家按键或点击气泡立即关闭；任意操作重置 30 秒停滞计时。
 * 纯展示逻辑，不持有任务状态——阶段/POI/驾驶状态都来自传入的 snapshot。
 */
function useKiboBubble(s: MissionSnapshot, baseLine: KiboLine) {
  const [line, setLine] = useState<KiboLine>(baseLine)
  const [visible, setVisible] = useState(true)
  const hideTimer = useRef<number | null>(null)
  const idleTimer = useRef<number | null>(null)
  const prevPhase = useRef(s.phase)
  const prevPoi = useRef(s.nearbyPoi?.id ?? null)
  const prevDrive = useRef(s.driveStatus)

  const hideAfter = useCallback(() => {
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setVisible(false), 3000)
  }, [])

  const trigger = useCallback(
    (next: KiboLine) => {
      setLine(next)
      setVisible(true)
      hideAfter()
      // 任意一次触发都刷新停滞计时
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current)
      idleTimer.current = window.setTimeout(() => trigger(kiboIdleLine), 30000)
    },
    [hideAfter],
  )

  // 玩家任何操作都算"没在发呆"：重置 30 秒停滞计时，按键同时立即关闭气泡
  useEffect(() => {
    const onActivity = (e: Event) => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current)
      idleTimer.current = window.setTimeout(() => trigger(kiboIdleLine), 30000)
      if (e.type === 'keydown') setVisible(false)
    }
    window.addEventListener('keydown', onActivity)
    window.addEventListener('pointerdown', onActivity)
    return () => {
      window.removeEventListener('keydown', onActivity)
      window.removeEventListener('pointerdown', onActivity)
    }
  }, [trigger])

  // 阶段 / POI 区域 / 成功失败 切换 → 触发对应台词
  useEffect(() => {
    const poiId = s.nearbyPoi?.id ?? null
    const phaseChanged = prevPhase.current !== s.phase
    const poiChanged = prevPoi.current !== poiId
    const driveChanged = prevDrive.current !== s.driveStatus
    let next: KiboLine | null = null
    if (phaseChanged) next = baseLine
    else if (driveChanged && (s.driveStatus === 'arrived' || s.driveStatus === 'stuck')) next = baseLine
    else if (poiChanged && poiId) next = kiboPoiLine(poiId)
    if (next) trigger(next)
    prevPhase.current = s.phase
    prevPoi.current = poiId
    prevDrive.current = s.driveStatus
  }, [s.phase, s.nearbyPoi?.id, s.driveStatus, baseLine, trigger])

  // 初次进入展示欢迎/阶段台词，3 秒后淡出
  useEffect(() => {
    hideAfter()
    return () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current)
    }
  }, [hideAfter])

  const dismiss = useCallback(() => {
    setVisible(false)
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current)
  }, [])

  return { line, visible, dismiss }
}

export function MissionHud(props: MissionHudProps) {
  const { snapshot: s, candidates, notice, blockingModalOpen } = props
  const coveragePct = Math.round(s.coverage * 100)
  const plan = s.plan
  const needsChoice = Boolean(plan?.found) && (plan?.unknownCells ?? 0) > 0 && s.uncertaintyChoice === null
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const sixIndex = SIX_STEP_ORDER.indexOf(s.sixStep)
  const bubble = useKiboBubble(s, props.kiboLine)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyC' && !e.repeat && !(e.target instanceof HTMLInputElement)) {
        setDrawerOpen((open) => !open)
      }
      if (e.code === 'Escape') {
        // ESC 即"设置界面快捷键"：设置开着就关；抽屉（任务面板）开着就关；
        // 若有阻断式模态（操作台/对话/POI/结算/运镜/引导）打开，则交给它自己关闭，这里不开设置；
        // 以上都没有时，才在任务场景内弹出设置界面。
        if (settingsOpen) setSettingsOpen(false)
        else if (drawerOpen) setDrawerOpen(false)
        else if (!blockingModalOpen) setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen, settingsOpen, blockingModalOpen])

  return (
    <div className="mars-hud">
      {/* ---------- 右上角：小地图 + 设置工具列 ----------
          用户反馈：GM 按钮暂时隐藏，当前对玩家没有实际作用。 */}
      <div className="mars-hud__rightcol">
        <MissionMinimap stage={props.stage} snapshot={s} candidates={props.candidates} />
        <div className="mars-hud__toolstack">
          <button
            type="button"
            className="mars-hud__tool"
            onClick={() => setSettingsOpen(true)}
            aria-label="设置"
            aria-haspopup="dialog"
            title="设置"
          >
            <SettingsIcon />
          </button>
        </div>
      </div>

      {/* ---------- 左上角：RPG 式任务追踪器（常驻，最简） ---------- */}
      <div className="mars-hud__tracker">
        <button
          type="button"
          className="mars-hud__tracker-card"
          onClick={() => setDrawerOpen(true)}
          aria-expanded={drawerOpen}
          aria-controls="mars-hud-drawer"
          aria-label="打开任务面板"
        >
          <span className="mars-hud__tracker-kicker">{s.worldGoal.label}</span>
          <span className="mars-hud__tracker-title">{SIX_STEP_LABEL[s.sixStep]}</span>
          <span className="mars-hud__tracker-phase">{PHASE_LABEL[s.phase]}</span>
          <span className="mars-hud__tracker-hint">{s.worldGoal.brief}</span>
        </button>
        <nav className="mars-hud__tracker-progress" aria-label="学习进度">
          <ol>
            {SIX_STEP_ORDER.map((step, k) => (
              <li
                key={step}
                className={`${k === sixIndex ? 'is-active' : ''}${k < sixIndex ? ' is-done' : ''}`}
                aria-current={k === sixIndex ? 'step' : undefined}
                title={SIX_STEP_LABEL[step]}
              >
                <span aria-hidden="true" />
              </li>
            ))}
          </ol>
        </nav>
      </div>

      {/* ---------- KIBO 伙伴对白气泡（上下文触发，3 秒淡出，按键/点击关闭） ---------- */}
      <KiboBubble line={bubble.line} visible={bubble.visible} onDismiss={bubble.dismiss} />

      {/* ---------- 右侧：可折叠 AI 控制台（详细操作入口） ---------- */}
      <aside
        id="mars-hud-drawer"
        className={`mars-hud__drawer${drawerOpen ? ' is-open' : ''}`}
        aria-hidden={!drawerOpen}
      >
        <div className="mars-hud__drawer-shell">
          <header className="mars-hud__drawer-header">
            <h2>任务面板</h2>
            <button
              type="button"
              className="mars-hud__drawer-close"
              onClick={() => setDrawerOpen(false)}
              aria-label="收起任务面板"
            >
              ✕
            </button>
          </header>

          <div className="mars-hud__drawer-tabs" role="tablist" aria-label="任务阶段">
            <ol>
              {STEPS.map((step, k) => {
                const enabled = stepEnabled(step, s)
                const active = s.phase === step
                return (
                  <li key={step}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={active}
                      aria-disabled={!enabled}
                      className={`${active ? 'is-active' : ''}`}
                      onClick={() => props.onPhase(step)}
                      disabled={!enabled}
                      title={PHASE_LABEL[step]}
                    >
                      <span aria-hidden="true">{k + 1}</span>
                      <span className="mars-hud__drawer-tab-label">{PHASE_LABEL[step]}</span>
                    </button>
                  </li>
                )
              })}
            </ol>
          </div>

          <div className="mars-hud__drawer-body">
            <PhaseBody {...props} />
          </div>

          <footer className="mars-hud__drawer-footer">
            <div className="mars-hud__drawer-tools">
              <button type="button" onClick={props.onReset}>
                重置任务
              </button>
              <button type="button" onClick={props.onResetCamera}>
                复位镜头
              </button>
            </div>
          </footer>
        </div>
      </aside>

      {drawerOpen && (
        <div
          className="mars-hud__drawer-backdrop"
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ---------- 右下角：操作说明小面板（用户指定：鼠标左键 / 鼠标右键 / E，图标化） ---------- */}
      <div className="mars-hud__help" aria-label="操作说明">
        <span className="mars-hud__help-title">操作说明</span>
        <ul className="mars-hud__help-list">
          <li>
            <span className="mars-hud__help-icon" aria-hidden="true">
              <MouseLeftIcon />
            </span>
            <span>R-7 自动前往该点</span>
          </li>
          <li>
            <span className="mars-hud__help-icon" aria-hidden="true">
              <MouseRightIcon />
            </span>
            <span>转动视角</span>
          </li>
          <li>
            <span className="mars-hud__help-icon" aria-hidden="true">
              <KeyEIcon />
            </span>
            <span>扫描 / 交互</span>
          </li>
          <li>
            <span className="mars-hud__help-icon" aria-hidden="true">
              <KeyWASDIcon />
            </span>
            <span>移动地图镜头</span>
          </li>
          <li>
            <span className="mars-hud__help-icon" aria-hidden="true">
              <KeySpaceIcon />
            </span>
            <span>镜头复位（跟随 R-7）</span>
          </li>
        </ul>
      </div>

      {/* ---------- 设置界面（传统游戏设置弹窗） ---------- */}
      {settingsOpen && (
        <SettingsModal
          soundOn={props.soundOn}
          onToggleSound={props.onToggleSound}
          quality={props.quality}
          onSetQuality={props.onSetQuality}
          onExit={props.onExit}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <p className="mars-hud__live" role="status" aria-live="polite">
        {notice}
      </p>

      {/* ---------- 画面下方中央：统一竖向堆叠底座 ----------
          采集车能源条 / 扫描读条 / 采集读条 / POI 交互条都在这里自上而下依次排开。
          之前四者各自 absolute + 固定 bottom，任意两个同时出现就重叠（用户实测：
          能源条压住扫描读条、采集读条压住 POI 交互条）。现在改为单个 flex column 底座，
          出现几个就占几行，结构上不可能重叠。 */}
      <div className="mars-hud__bottomstack">
        {/* ---------- 采集车出勤状态：能源条 + 当前阶段 ---------- */}
        {s.hauler.status !== 'idle' && (
          <div className="mars-hud__hauler" role="status" aria-live="polite">
            <div className="mars-hud__hauler-header">
              <span>采集车 · {s.hauler.routeLabel || '验证中'}</span>
              <span className="mars-hud__hauler-energy">
                能源 {s.hauler.energy.toFixed(0)} / {s.hauler.battery}
              </span>
            </div>
            <div className="mars-hud__hauler-bar" aria-hidden="true">
              <span
                className={`mars-hud__hauler-fill${s.hauler.energy < s.hauler.battery * 0.25 ? ' is-low' : ''}`}
                style={{ width: `${(s.hauler.energy / s.hauler.battery) * 100}%` }}
              />
            </div>
            <span className="mars-hud__hauler-status">{haulerStatusText(s.hauler.status)}</span>
          </div>
        )}

        {/* ---------- 侦察阶段按 E：以车身为中心的扫描读条 ---------- */}
        {props.scanProgress !== null && (
          <ChargeBar progress={props.scanProgress} label="扫描中 · 以 R-7 为中心" ariaLabel="扫描读条" />
        )}

        {/* ---------- 样本站按 E：采集样本的读条（走满后才真正采集） ---------- */}
        {props.interactProgress != null && (
          <ChargeBar
            progress={props.interactProgress}
            label="采集中 · 正在提取样本"
            ariaLabel="采集读条"
            variant="collect"
          />
        )}

        {/* ---------- 靠近 POI 时的交互条：让"下一步干什么"一眼可见 ---------- */}
        {s.nearbyPoi && <PoiPrompt poi={s.nearbyPoi} snapshot={s} />}
      </div>
    </div>
  )
}

/**
 * 通用读条（扫描 / 采集共用）。
 *
 * 关键：填充宽度直接用**未取整的真实比例**（clamped * 100），百分比文字才取整显示。
 * 之前 width 也用取整值，读条会出现台阶、且最后一帧 100% 常被立即的 null 批处理掉，
 * 看起来就像"动画没有跟随真实进度"。现在两者分离：宽度连续、文字可读。
 * 居中常驻于画面下方；prefers-reduced-motion 下仍显示（它是状态反馈，不是装饰动效）。
 */
function ChargeBar({
  progress,
  label,
  ariaLabel,
  variant,
}: {
  progress: number
  label: string
  ariaLabel: string
  variant?: 'scan' | 'collect'
}) {
  const clamped = Math.min(1, Math.max(0, progress))
  const pct = Math.round(clamped * 100)
  return (
    <div
      className={`mars-hud__scancharge${variant === 'collect' ? ' is-collect' : ''}`}
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="mars-hud__scancharge-label">{label}</span>
      <span className="mars-hud__scancharge-track" aria-hidden="true">
        <span className="mars-hud__scancharge-fill" style={{ width: `${clamped * 100}%` }} />
      </span>
      <span className="mars-hud__scancharge-pct">{pct}%</span>
    </div>
  )
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.5-3c0 .4-.05.8-.14 1.18l2.03 1.57a.49.49 0 0 1 .12.63l-1.92 3.33a.49.49 0 0 1-.6.22l-2.39-.96a7.94 7.94 0 0 1-1.69.99l-.36 2.55a.49.49 0 0 1-.49.42h-3.84a.49.49 0 0 1-.49-.42l-.36-2.55a7.94 7.94 0 0 1-1.69-.99l-2.39.96a.49.49 0 0 1-.6-.22L2.39 15.38a.49.49 0 0 1 .12-.63l2.03-1.57A7.58 7.58 0 0 1 4.5 12c0-.4.05-.8.14-1.18L2.61 9.25a.49.49 0 0 1-.12-.63l1.92-3.33a.49.49 0 0 1 .6-.22l2.39.96a7.94 7.94 0 0 1 1.69-.99L9.45 2.49A.49.49 0 0 1 9.94 2.07h3.84c.25 0 .47.18.49.42l.36 2.55a7.94 7.94 0 0 1 1.69.99l2.39-.96a.49.49 0 0 1 .6.22l1.92 3.33a.49.49 0 0 1-.12.63l-2.03 1.57c.09.38.14.78.14 1.18Zm-1.5 0a6 6 0 1 0-12 0 6 6 0 0 0 12 0Z"
      />
    </svg>
  )
}

function MouseLeftIcon() {
  return (
    <svg viewBox="0 0 24 32" width="16" height="22" aria-hidden="true" focusable="false">
      <rect x="4" y="1" width="16" height="28" rx="8" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="12" y1="1" x2="12" y2="11" stroke="currentColor" strokeWidth="2" />
      <path d="M5 9 h7 v-7 a6 6 0 0 0-7 7Z" fill="currentColor" opacity="0.95" />
    </svg>
  )
}

function MouseRightIcon() {
  return (
    <svg viewBox="0 0 24 32" width="16" height="22" aria-hidden="true" focusable="false">
      <rect x="4" y="1" width="16" height="28" rx="8" fill="none" stroke="currentColor" strokeWidth="2" />
      <line x1="12" y1="1" x2="12" y2="11" stroke="currentColor" strokeWidth="2" />
      <path d="M19 9 h-7 v-7 a6 6 0 0 1 7 7Z" fill="currentColor" opacity="0.95" />
    </svg>
  )
}

function KeyEIcon() {
  return (
    <svg viewBox="0 0 28 20" width="26" height="20" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="26" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <text x="14" y="14" textAnchor="middle" fill="currentColor" fontSize="12" fontWeight="700" fontFamily="system-ui, sans-serif">
        E
      </text>
    </svg>
  )
}

/** WASD 键帽组合：四向箭头排布，直观表达「移动地图镜头」。 */
function KeyWASDIcon() {
  return (
    <svg viewBox="0 0 34 34" width="26" height="26" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.8">
        <rect x="12" y="1" width="10" height="10" rx="2.5" />
        <rect x="12" y="12" width="10" height="10" rx="2.5" />
        <rect x="1" y="12" width="10" height="10" rx="2.5" />
        <rect x="23" y="12" width="10" height="10" rx="2.5" />
      </g>
      <g fill="currentColor" fontSize="7" fontWeight="400" fontFamily="system-ui, sans-serif" textAnchor="middle">
        <text x="17" y="9">W</text>
        <text x="17" y="20">S</text>
        <text x="6" y="20">A</text>
        <text x="28" y="20">D</text>
      </g>
    </svg>
  )
}

/** 空格键长条键帽：表达「镜头复位」。 */
function KeySpaceIcon() {
  return (
    <svg viewBox="0 0 34 20" width="30" height="18" aria-hidden="true" focusable="false">
      <rect x="1" y="3" width="32" height="14" rx="6" fill="none" stroke="currentColor" strokeWidth="2" />
      <text x="17" y="14" textAnchor="middle" fill="currentColor" fontSize="8" fontWeight="400" fontFamily="system-ui, sans-serif">
        Space
      </text>
    </svg>
  )
}

function SettingsModal({
  soundOn,
  onToggleSound,
  quality,
  onSetQuality,
  onExit,
  onClose,
}: {
  soundOn: boolean
  onToggleSound: () => void
  quality: QualityLevel
  onSetQuality: (q: QualityLevel) => void
  onExit?: () => void
  onClose: () => void
}) {
  return (
    <div
      className="mars-hud__settings-backdrop"
      onClick={onClose}
      aria-hidden="true"
    >
      <div
        className="mars-hud__settings"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mars-hud__settings-header">
          <h2>设置</h2>
          <button
            type="button"
            className="mars-hud__settings-close"
            onClick={onClose}
            aria-label="关闭设置"
          >
            ✕
          </button>
        </header>

        <div className="mars-hud__settings-row">
          <span className="mars-hud__settings-label">音效</span>
          <button
            type="button"
            className={`mars-hud__seg${soundOn ? ' is-on' : ''}`}
            onClick={onToggleSound}
            aria-pressed={soundOn}
          >
            {soundOn ? '开' : '关'}
          </button>
        </div>

        <div className="mars-hud__settings-row">
          <span className="mars-hud__settings-label">画质</span>
          <div className="mars-hud__seg-group" role="group" aria-label="画质">
            {QUALITY_CYCLE.map((q) => (
              <button
                key={q}
                type="button"
                className={quality === q ? 'is-active' : ''}
                onClick={() => onSetQuality(q)}
                aria-pressed={quality === q}
              >
                {QUALITY_LABEL[q]}
              </button>
            ))}
          </div>
        </div>

        {onExit && (
          <div className="mars-hud__settings-row mars-hud__settings-row--exit">
            <button type="button" className="mars-hud__settings-exit" onClick={onExit}>
              退出任务
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function PhaseBody(props: MissionHudProps) {
  const { snapshot: s } = props
  const coveragePct = Math.round(s.coverage * 100)
  const plan = s.plan
  const needsChoice = Boolean(plan?.found) && (plan?.unknownCells ?? 0) > 0 && s.uncertaintyChoice === null

  // 缺口-8：规则滑块（坡度/未知区权重）拖拽会高频触发全量 A* replan（实测单次 ~37ms），
  // 直接下发会掉帧。这里用「本地受控草稿值 + 150ms 防抖」：拖动时 thumb 立即跟手，
  // 停拖后才批量把最新值下发到 mission 重算路线；防抖只延迟昂贵计算，不延迟视觉反馈。
  const [cautionDraft, setCautionDraft] = useState(s.cautionDeg)
  const [blockedDraft, setBlockedDraft] = useState(s.blockedDeg)
  const [unknownDraft, setUnknownDraft] = useState(s.weights.unknown)
  const thresholdDebounceRef = useRef<number | null>(null)
  const pendingThresholdsRef = useRef<{ caution: number; blocked: number } | null>(null)
  const pendingUnknownRef = useRef<number | null>(null)

  // 外部快照变化（扫描/重置/重规划）时拉齐本地草稿，避免与 mission 状态漂移。
  useEffect(() => {
    setCautionDraft(s.cautionDeg)
    setBlockedDraft(s.blockedDeg)
    setUnknownDraft(s.weights.unknown)
  }, [s.cautionDeg, s.blockedDeg, s.weights.unknown])

  // 卸载时清掉未触发的防抖定时器，避免回调落到已卸载的舞台。
  useEffect(
    () => () => {
      if (thresholdDebounceRef.current !== null) window.clearTimeout(thresholdDebounceRef.current)
    },
    [],
  )

  const flushThresholds = useCallback(() => {
    if (pendingThresholdsRef.current) {
      props.onThresholds(pendingThresholdsRef.current.caution, pendingThresholdsRef.current.blocked)
      pendingThresholdsRef.current = null
    }
    if (pendingUnknownRef.current !== null) {
      props.onUnknownWeight(pendingUnknownRef.current)
      pendingUnknownRef.current = null
    }
    thresholdDebounceRef.current = null
  }, [props])

  const scheduleFlush = useCallback(() => {
    if (thresholdDebounceRef.current !== null) window.clearTimeout(thresholdDebounceRef.current)
    thresholdDebounceRef.current = window.setTimeout(flushThresholds, 150)
  }, [flushThresholds])

  const onCautionChange = useCallback(
    (v: number) => {
      setCautionDraft(v)
      pendingThresholdsRef.current = { caution: v, blocked: blockedDraft }
      scheduleFlush()
    },
    [blockedDraft, scheduleFlush],
  )
  const onBlockedChange = useCallback(
    (v: number) => {
      setBlockedDraft(v)
      pendingThresholdsRef.current = { caution: cautionDraft, blocked: v }
      scheduleFlush()
    },
    [cautionDraft, scheduleFlush],
  )
  const onUnknownChange = useCallback(
    (v: number) => {
      setUnknownDraft(v)
      pendingUnknownRef.current = v
      scheduleFlush()
    },
    [scheduleFlush],
  )

  return (
    <section className="mars-hud__panel" aria-label={`当前步骤：${SIX_STEP_LABEL[s.sixStep]}（${PHASE_LABEL[s.phase]}）`}>
      {s.phase === 'scan' && (
        <div className="mars-hud__body">
          <h2 className="mars-hud__title">开着 R-7，给 AI 收集数据</h2>
          <p className="mars-hud__lead">
            灰色影线区域是<strong>还没探测过</strong>的地方。没有数据，AI 就无从学习，
            规划器也不敢下判断。场景中<strong>淡青色的标记</strong>是推荐扫描点，开着 R-7 到你觉得有数据价值的地方，
            <strong>按 E</strong> 以车身为中心扫描，把真实地形喂进 AI 的训练集
            （扫描次数<strong>不限</strong>，随时可以回头补采）。
          </p>
          <div className="mars-hud__meters">
            <Meter label="已探明" value={`${coveragePct}%`} ratio={s.coverage} />
          </div>
          <p className="mars-hud__hint">
            左键点地或点击"开往 · xx"，R-7 会自动驾驶到你选的位置。
            跟着场景里淡青色标记开到位置后按 <kbd>E</kbd> 读条扫描。
            用键盘 <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 平移地图镜头，<kbd>空格</kbd> 把镜头复位到以 R-7 为中心的跟随视角。
          </p>
          <ul className="mars-hud__candidates">
            {props.candidates.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => props.onDriveToCandidate(c)}
                >
                  <span className="mars-hud__cand-label">开往 · {c.label}</span>
                  <span className="mars-hud__cand-hint">{c.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {s.phase === 'rules' && (
        <div className="mars-hud__body">
          <h2 className="mars-hud__title">告诉 AI 什么坡能走</h2>
          <p className="mars-hud__lead">
            这两个数字就是 AI 要学的全部通行规则。谨慎坡度和禁行坡度会直接把地图分成
            "能走 / 要小心 / 不能走"三类——AI 会按你定的规则去学，而不是自己瞎猜。
          </p>
          <Slider
            id="caution"
            label="谨慎坡度"
            suffix="°"
            min={4}
            max={30}
            value={cautionDraft}
            swatch="caution"
            desc="超过这个坡度会通行，但代价更高。"
            onChange={onCautionChange}
          />
          <Slider
            id="blocked"
            label="禁行坡度"
            suffix="°"
            min={8}
            max={45}
            value={blockedDraft}
            swatch="blocked"
            desc="超过这个坡度直接不走。调得越低，绕路越多。"
            onChange={onBlockedChange}
          />
          <Slider
            id="unknown"
            label="对未知区的谨慎程度"
            suffix=""
            min={0}
            max={10}
            step={0.5}
            value={unknownDraft}
            swatch="unknown"
            desc="调高＝宁可绕远也贴着已探明区走；调低＝敢直接冲进没数据的地方。"
            onChange={onUnknownChange}
          />
        </div>
      )}

      {s.phase === 'plan' && (
        <div className="mars-hud__body">
          <h2 className="mars-hud__title">AI 按你的教学算出的路线</h2>
          <p className="mars-hud__lead">
            规划器根据你已扫的数据和你定的规则，算出了一条候选路线。它不是最终答案，
            而是 AI 按你的教学做出的建议。检查里程、谨慎路段和没数据的路段，
            再决定要不要让 R-7 去实测。
          </p>
          {plan?.found ? (
            <>
              <dl className="mars-hud__stats">
                <Stat label="里程" value={`${plan.lengthM.toFixed(0)} m`} />
                <Stat label="谨慎路段" value={`${plan.cautionCells} 格`} tone={plan.cautionCells > 0 ? 'warn' : 'ok'} />
                <Stat
                  label="没数据的路段"
                  value={`${plan.unknownCells} 格`}
                  tone={plan.unknownCells > 0 ? 'danger' : 'ok'}
                />
                <Stat label="算法展开" value={`${plan.expanded} 格`} />
              </dl>
              {plan.unknownCells > 0 ? (
                <p className="mars-hud__warn" role="note">
                  这条路线有 <strong>{plan.unknownCells}</strong> 格穿过<strong>没有探测数据</strong>的区域。
                  规划器不是"知道那里能走"，而是"不知道那里不能走"。要不要回去补扫描，你来定。
                </p>
              ) : (
                <p className="mars-hud__ok" role="note">
                  整条路线都建立在已探明数据上。这不代表一定顺利，但至少不是猜的。
                </p>
              )}
              {!s.targetKnown && (
                <p className="mars-hud__warn" role="note">
                  终点周边还没探明。最后一段是估计值。
                </p>
              )}

              {(plan.unknownCells ?? 0) > 0 && (
                <div className="mars-hud__decision" role="group" aria-label="不确定性处置">
                  <h3 className="mars-hud__decision-title">
                    有 {plan.unknownCells} 格是猜的，你打算怎么办？
                  </h3>
                  {s.uncertaintyChoice === null ? (
                    <ul className="mars-hud__decision-opts">
                      {UNCERTAINTY_OPTIONS.map((o) => (
                        <li key={o.choice}>
                          <button type="button" onClick={() => props.onUncertaintyChoice(o.choice, o.reason)}>
                            <span className="mars-hud__decision-label">{o.label}</span>
                            <span className="mars-hud__decision-desc">{o.desc}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mars-hud__ok" role="note">
                      已决定：{UNCERTAINTY_OPTIONS.find((o) => o.choice === s.uncertaintyChoice)?.label}
                      。理由已记入决策日志。要改主意可以重新规划。
                    </p>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="mars-hud__warn" role="note">
              按当前规则找不到任何可行路线。把禁行坡度调高一点，或者先补几次扫描。
            </p>
          )}
          {needsChoice && (
            <p className="mars-hud__warn" role="note">
              先在上方选择「有 {plan?.unknownCells ?? 0} 格是猜的，你打算怎么办？」，再开始实地测试。
            </p>
          )}
          <div className="mars-hud__actions">
            <button
              type="button"
              className="is-primary"
              onClick={() => props.onPhase('drive')}
              disabled={needsChoice}
              title={needsChoice ? '先对没数据的路段做出处置，再开始实测' : undefined}
            >
              开始实地测试 →
            </button>
            <button type="button" onClick={props.onReplan}>
              重新规划
            </button>
            <button type="button" onClick={() => props.onPhase('scan')}>
              回去补扫描
            </button>
            <button type="button" onClick={() => props.onPhase('rules')}>
              改规则
            </button>
          </div>
        </div>
      )}

          {s.phase === 'drive' && (
        <div className="mars-hud__body">
          {s.driveStatus === 'arrived' && (
            <>
              <Celebration />
              <h2 className="mars-hud__title mars-hud__title--ok">到达终点</h2>
              <p className="mars-hud__lead">
                路线成立！R-7 安全到达，说明你的数据、规则、决策凑成了可靠的 AI 方案。
                现在让 AI 自动驾驶的<strong>资源采集验证车</strong>再走一遍同一条路线：它不靠你手控，
                只靠训练好的 AI 判断，能过才算真的 AI 方案。
              </p>
              {s.trained && s.plan?.found && (
                <div className="mars-hud__actions">
                  <button type="button" className="is-primary" onClick={() => props.onDispatchHauler(1)}>
                    派遣 AI 验证车出发 →
                  </button>
                </div>
              )}
              <div className="mars-hud__actions">
                <button type="button" className="is-primary" onClick={() => props.onPhase('report')}>
                  记录成果 →
                </button>
                <button type="button" onClick={() => props.onPhase('revise')}>
                  再改改
                </button>
              </div>
            </>
          )}
          {s.driveStatus === 'running' && (
            <>
              <h2 className="mars-hud__title">R-7 正在实测 AI 路线</h2>
              <p className="mars-hud__lead">
                纸面上能走的路线，跑起来不一定能走——尤其是<strong>橙色虚线</strong>那段，
                那是 AI 没数据、只能靠猜的地方。这次实测会告诉 AI 它的判断对不对。
              </p>
              {plan && (
                <div className="mars-hud__meters">
                  <Meter
                    label="行驶进度"
                    value={`${Math.round((s.driveProgress / Math.max(1, plan.lengthM)) * 100)}%`}
                    ratio={s.driveProgress / Math.max(1, plan.lengthM)}
                  />
                </div>
              )}
              {s.awaitingBlindCommand && (
                <div className="mars-hud__blind-command" role="alert">
                  <h3 className="mars-hud__title mars-hud__title--warn">⚠ 前方盲区 · 需要指挥命令</h3>
                  <p className="mars-hud__lead">
                    路线从这里开始是一段<strong>你没扫到的地形</strong>。AI 看不见，但任务必须走——这正是考验你敢不敢先探一小片再决定。
                    下达指挥命令，先<strong>局部预览</strong>盲区内到底有什么（陡坡？岩石？软沙？），再决定继续还是重规划。
                  </p>
                  <p className="mars-hud__hint">
                    盲区长度约 {s.blindZone ? `${s.blindZone.lengthM.toFixed(0)}m` : '—'}。
                    下达命令不会消耗扫描预算，只揭示入口附近一小片「AI 临门一脚能看到」的地形。
                  </p>
                  <div className="mars-hud__actions">
                    {/* 两个决策都不暗示对错（铁律 #3）：一个赌、一个重选，由学生自己权衡 */}
                    <button
                      type="button"
                      className="is-primary"
                      onClick={() => props.onIssueBlindCommand?.('proceed')}
                    >
                      继续前进（E）
                    </button>
                    <button type="button" onClick={() => props.onIssueBlindCommand?.('reroute')}>
                      返回重选路线
                    </button>
                  </div>
                </div>
              )}
              {!s.awaitingBlindCommand && s.blindCommanded && s.worldIndex === 1 && (
                <p className="mars-hud__ok" role="note">
                  已下达指挥命令，盲区内地形已局部揭示。据此重新规划，或让验证车继续前进。
                </p>
              )}
              <div className="mars-hud__actions">
                <button type="button" onClick={() => props.onPhase('plan')}>
                  回到规划
                </button>
              </div>
            </>
          )}
          {s.driveStatus === 'stuck' &&
            (s.softStuck ? (
              <SoftSandEscape {...props} />
            ) : (
              <>
                <h2 className="mars-hud__title mars-hud__title--danger">
                  {s.stuckReason === 'guess' ? '数据不够，AI 的猜测翻车了' : '规则漏判，R-7 在已探明陡坡翻车'}
                </h2>
                <p className="mars-hud__lead">
                  {s.stuckReason === 'guess'
                    ? 'R-7 开进了一段你没扫描的地方，真实地形是陡坡，根本走不了。这就是「AI 在没数据时会瞎猜」的代价——但也给 AI 增加了一条真实训练样本。'
                    : 'R-7 开到了一段你已探明、但规则没判定为禁行的地方。把禁行坡度调高，AI 下次就会把这类陡坡算成不能走。'}
                </p>
                <p className="mars-hud__warn" role="note">
                  {s.stuckReason === 'guess'
                    ? '翻车原因：这段路 AI 是「猜」的，没有数据。补扫描或改规则，都能让 AI 下一次更准。'
                    : '翻车原因：规则太宽松，已探明的陡坡没被算成禁行。'}
                </p>
                <div className="mars-hud__actions">
                  <button type="button" className="is-primary" onClick={() => props.onPhase('revise')}>
                    修改后重新测试 →
                  </button>
                </div>
              </>
            ))}
        </div>
      )}

      {s.phase === 'revise' && (
        <div className="mars-hud__body">
          <h2 className="mars-hud__title">修改，再训练一次 AI</h2>
          <p className="mars-hud__lead">
            每一轮修改都在重新训练 AI 的判断。你可以回去补扫描（给 AI 更多真实数据）、
            改规则（告诉 AI 什么不能走）、重新规划（让 AI 再算一次）——直到 AI 给出的路线经得起实测。
          </p>
          {s.hiddenBlocked > 0 ? (
            <p className="mars-hud__warn" role="note">
              路线上还有 <strong>{s.hiddenBlocked}</strong> 格是"没数据却真禁行"。这正是刚才翻车的位置。
            </p>
          ) : (
            <p className="mars-hud__ok" role="note">
              这条路线上已经没有隐藏的禁行格了。
            </p>
          )}
          {s.runs.length > 0 && (
            <p className="mars-hud__hint">
              小地图里的<strong>蓝色虚线</strong>是上一版（v{s.runs.length}）实际走过的轨迹，
              <strong>青色实线</strong>是当前这一版路线——对比两条线，看看你的改动改到了哪。
            </p>
          )}
          <div className="mars-hud__actions">
            <button type="button" className="is-primary" onClick={() => props.onPhase('drive')}>
              重新测试 →
            </button>
            <button type="button" onClick={() => props.onPhase('scan')}>
              回去补扫描
            </button>
            <button type="button" onClick={() => props.onPhase('rules')}>
              改规则
            </button>
            <button type="button" onClick={props.onReplan}>
              重新规划
            </button>
          </div>
          <p className="mars-hud__hint">
            重新测试＝用当前路线再跑一次；补扫描＝用掉一次预算把红段看清；改规则＝让 AI 把陡坡也算成禁行；重新规划＝在当前认知上重算路线。
          </p>
        </div>
      )}

      {s.phase === 'report' && (
        <div className="mars-hud__body">
          <h2 className="mars-hud__title">任务成果：你训练出的 AI 方案</h2>
          <dl className="mars-hud__stats">
            <Stat label="已探明覆盖率" value={`${Math.round(s.coverage * 100)}%`} />
            <Stat label="使用扫描" value={`${s.scansUsed} 次`} />
            {plan && <Stat label="最终里程" value={`${plan.lengthM.toFixed(0)} m`} />}
            <Stat label="是否到达" value="已到达" tone="ok" />
            <Stat
              label="导航 AI 信心"
              value={`${(s.aiConfidence * 100).toFixed(0)}%`}
              tone={s.aiConfidence >= 0.6 ? 'ok' : s.aiConfidence >= 0.3 ? 'warn' : 'danger'}
            />
            <Stat
              label="隐藏禁行格"
              value={`${s.hiddenBlocked} 格`}
              tone={s.hiddenBlocked > 0 ? 'danger' : 'ok'}
            />
          </dl>
          <p className="mars-hud__lead">
            你用 <strong>{s.scansUsed}</strong> 次扫描，在一片大部分未知的火星地形上训练出了一套导航 AI。
            R-7 是你手控的<strong>任务车</strong>，负责收集数据、验证路线；
            资源采集车是 AI 自动驾驶的<strong>验证车</strong>，它的通过与否直接由 AI 信心决定。
            这就是工程决策和考试选择题最大的区别。
          </p>

          {s.previousPlan && plan && (
            <div className="mars-hud__compare" aria-label="两次方案对照">
              <h3 className="mars-hud__compare-title">AI 工具迭代：上一版 → 这一版</h3>
              <table className="mars-hud__compare-table">
                <thead>
                  <tr>
                    <th scope="col">指标</th>
                    <th scope="col">上一版</th>
                    <th scope="col">这一版</th>
                    <th scope="col">变化</th>
                  </tr>
                </thead>
                <tbody>
                  <CompareRow name="里程 (m)" a={s.previousPlan.lengthM} b={plan.lengthM} lowerBetter />
                  <CompareRow name="没数据路段 (格)" a={s.previousPlan.unknownCells} b={plan.unknownCells} lowerBetter />
                  <CompareRow name="谨慎路段 (格)" a={s.previousPlan.cautionCells} b={plan.cautionCells} lowerBetter />
                </tbody>
              </table>
              <p className="mars-hud__hint">
                更少的"没数据路段"意味着这一版更少靠猜——这就是"验证 AI 工具"看得见的进步。
              </p>
            </div>
          )}

          {s.decisionLog.length > 0 && (
            <div className="mars-hud__log" aria-label="决策日志">
              <h3 className="mars-hud__log-title">任务决策日志（{s.decisionLog.length} 步）</h3>
              <ol className="mars-hud__log-list">
                {s.decisionLog.slice(-8).map((e, k) => (
                  <li key={k}>{describeDecision(e)}</li>
                ))}
              </ol>
            </div>
          )}

          <p className="mars-hud__hint">
            已探明覆盖率只有 {Math.round(s.coverage * 100)}%——不用等到 100% 数据才行动，
            这正是工程决策和考试选择题最大的区别。
          </p>
          <div className="mars-hud__actions">
            {/*
              v1.3.4 老大反馈：成功后必须走 KIBO 对话环节——"回到探索舱/继续任务"
              两个按钮在 KiboEndTalk 里。进入二号地图的按钮在这里直接进入下一张，
              会跳过 KIBO 引导流程，违背 PBL 设计。missionComplete 时彻底隐藏。
            */}
            {!s.missionComplete && (props.worldIndex ?? 0) < MARS_MAP_COUNT - 1 && props.onNextWorld && (
              <button type="button" className="is-primary" onClick={props.onNextWorld}>
                进入{marsMapName((props.worldIndex ?? 0) + 1)}地图 →
              </button>
            )}
            <button type="button" onClick={props.onReset}>
              再来一次
            </button>
          </div>
        </div>
      )}

      <p className="mars-hud__live" role="status" aria-live="polite">
        {props.notice}
      </p>
    </section>
  )
}

function PoiPrompt({
  poi,
  snapshot,
}: {
  poi: Poi
  snapshot: MissionSnapshot
}) {
  const purpose = POI_PURPOSE[poi.kind] ?? ''
  const status = poiStatus(poi, snapshot)
  const color = POI_COLOR[poi.kind] ?? '#ffffff'
  return (
    <div className="mars-hud__poi-prompt" role="status" aria-live="polite">
      <span className="mars-hud__poi-dot" style={{ background: color }} aria-hidden="true" />
      <div className="mars-hud__poi-body">
        <strong className="mars-hud__poi-title">{poi.label}</strong>
        <span className="mars-hud__poi-purpose">{purpose}</span>
        <span className="mars-hud__poi-status">{status}</span>
      </div>
      <>
        <kbd className="mars-hud__poi-key" aria-hidden="true">
          E
        </kbd>
        <span className="mars-hud__poi-keyhint">交互</span>
      </>
    </div>
  )
}

function KiboBubble({
  line,
  visible,
  onDismiss,
}: {
  line: KiboLine
  visible: boolean
  onDismiss: () => void
}) {
  if (!line.text) return null
  return (
    <div
      className={`mars-hud__kibo is-${line.mood}${visible ? ' is-visible' : ''}`}
      role="note"
      aria-live="polite"
      onClick={onDismiss}
    >
      <span className="mars-hud__kibo-avatar" aria-hidden="true">
        <img src="/assets/kibo/kibo-head.webp" alt="" />
      </span>
      <p className="mars-hud__kibo-text">{line.text}</p>
    </div>
  )
}

function Meter({
  label,
  value,
  ratio,
  tone = 'ok',
}: {
  label: string
  value: string
  ratio: number
  tone?: 'ok' | 'warn'
}) {
  return (
    <div className={`mars-hud__meter is-${tone}`}>
      <span className="mars-hud__meter-label">{label}</span>
      <span className="mars-hud__meter-value">{value}</span>
      <span className="mars-hud__meter-track" aria-hidden="true">
        <span className="mars-hud__meter-fill" style={{ width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%` }} />
      </span>
    </div>
  )
}

function Stat({ label, value, tone = 'ok' }: { label: string; value: string; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className={`mars-hud__stat is-${tone}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}

function CompareRow({
  name,
  a,
  b,
  lowerBetter,
}: {
  name: string
  a: number
  b: number
  lowerBetter?: boolean
}) {
  const delta = b - a
  const rounded = Math.round(delta * 10) / 10
  const improved = lowerBetter ? delta < -0.05 : delta > 0.05
  const worse = lowerBetter ? delta > 0.05 : delta < -0.05
  const tone = improved ? 'is-better' : worse ? 'is-worse' : 'is-same'
  const sign = rounded > 0 ? '+' : ''
  return (
    <tr className={`mars-hud__compare-row ${tone}`}>
      <th scope="row">{name}</th>
      <td>{Math.round(a * 10) / 10}</td>
      <td>{Math.round(b * 10) / 10}</td>
      <td>{Math.abs(rounded) < 0.05 ? '持平' : `${sign}${rounded}`}</td>
    </tr>
  )
}

function describeDecision(e: MissionSnapshot['decisionLog'][number]): string {
  switch (e.type) {
    case 'scan':
      return `扫描了一处地形`
    case 'thresholds':
      return `设定通行规则：谨慎 ${e.cautionDeg}°、禁行 ${e.blockedDeg}°`
    case 'weight':
      return `调整规划偏好：${e.key} = ${e.value}`
    case 'plan':
      return `重新规划：${e.lengthM.toFixed(0)}m，其中 ${e.unknownCells} 格没数据`
    case 'uncertainty':
      return `对未知路段的处置：${e.reason}`
    case 'drive-start':
      return `第 ${e.run} 次实测出发`
    case 'drive-end':
      return `第 ${e.run} 次实测${e.status === 'arrived' ? '到达终点' : e.status === 'stuck' ? '中途翻车' : '结束'}`
    case 'manual-start':
      return '进入手动驾驶'
    case 'manual-end':
      return `手动驾驶结束（行驶 ${e.distance.toFixed(0)}m）`
    case 'blind-command':
      return `在盲区入口下达指挥命令，局部揭示地形（预览后果）`
    default:
      return '一次操作'
  }
}

function Slider({
  id,
  label,
  suffix,
  min,
  max,
  step = 1,
  value,
  desc,
  swatch,
  onChange,
}: {
  id: string
  label: string
  suffix: string
  min: number
  max: number
  step?: number
  value: number
  desc: string
  swatch: 'caution' | 'blocked' | 'unknown'
  onChange: (v: number) => void
}) {
  return (
    <div className="mars-hud__slider">
      <label htmlFor={`slider-${id}`}>
        <span className={`mars-hud__swatch is-${swatch}`} aria-hidden="true" />
        {label}
        <output htmlFor={`slider-${id}`}>
          {value}
          {suffix}
        </output>
      </label>
      <input
        id={`slider-${id}`}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-describedby={`slider-${id}-desc`}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <p id={`slider-${id}-desc`} className="mars-hud__slider-desc">
        {desc}
      </p>
    </div>
  )
}

/**
 * 软沙脱困小游戏（#53/#68）。
 * 当 R-7 陷在软沙里（而非撞上硬障碍）时，把"翻车"变成一段可操作的脱困：
 * 连按 E / 空格（或点按钮）把进度条填满，在限时内摇出即脱困成功，继续走原路线；
 * 超时则引导玩家重新规划一条绕开软沙的路线。
 * 整套文案走游戏化、面向 10–12 岁玩家，无开发者术语。
 */
/**
 * 到达终点时的轻量庆祝动画（CSS confetti）。
 * 增强游戏化的正向反馈，同时用 prefers-reduced-motion 尊重减少动态效果偏好。
 */
function Celebration() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 18 }, (_, i) => ({
        i,
        left: `${10 + (i % 6) * 16}%`,
        delay: `${(i % 5) * 80}ms`,
        hue: [40, 190, 320, 60, 160][i % 5],
      })),
    [],
  )
  return (
    <div className="mars-hud__celebration" aria-hidden="true">
      {pieces.map((p) => (
        <span
          key={p.i}
          className="mars-hud__celebration-piece"
          style={{
            left: p.left,
            animationDelay: p.delay,
            backgroundColor: `hsl(${p.hue}, 90%, 60%)`,
          }}
        />
      ))}
    </div>
  )
}

/**
 * 软沙脱困小游戏（#53/#68）。
 * 当 R-7 陷在软沙里（而非撞上硬障碍）时，把"翻车"变成一段可操作的脱困：
 * 连按 E / 空格（或点按钮）把进度条填满，在限时内摇出即脱困成功，继续走原路线；
 * 超时则引导玩家重新规划一条绕开软沙的路线。
 * 整套文案走游戏化、面向 10–12 岁玩家，无开发者术语。
 */
function SoftSandEscape(props: MissionHudProps) {
  const [progress, setProgress] = useState(0)
  const [failed, setFailed] = useState(false)
  // 倒计时放宽到 10 秒：目标用户 10–12 岁，需留出读说明与反应时间；
  // 也避免自动截图（软件渲染下进度截图耗时较长）把小游戏判超时。
  const [timeLeft, setTimeLeft] = useState(10)
  const escapedRef = useRef(false)

  const feed = useCallback(() => {
    setProgress((p) => Math.min(100, p + 18))
  }, [])

  useEffect(() => {
    if (failed) return
    const timer = setInterval(() => {
      // 舞台被暂停（截图/调试）时，倒计时也暂停：避免玩家还没看清说明就被判超时。
      if (props.stage?.rig.paused) return
      setTimeLeft((t) => {
        if (t <= 1) {
          clearInterval(timer)
          setFailed(true)
          return 0
        }
        return t - 1
      })
    }, 1000)
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if ((k === 'e' || k === ' ') && !e.repeat) {
        e.preventDefault()
        feed()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      clearInterval(timer)
      window.removeEventListener('keydown', onKey)
    }
  }, [failed, feed])

  useEffect(() => {
    if (escapedRef.current) return
    if (progress >= 100 && !failed) {
      escapedRef.current = true
      props.onEscapeFromStuck?.()
    }
  }, [progress, failed, props])

  useEffect(() => {
    if (failed) {
      props.onNotice?.('软沙没摇出来——换条路绕过去，照样能把 R-7 送到终点。')
    }
  }, [failed, props])

  if (failed) {
    return (
      <div className="mars-softsand mars-softsand--fail" role="alertdialog" aria-label="陷进软沙">
        <h2 className="mars-softsand__title">没能摇出来……</h2>
        <p className="mars-softsand__lead">R-7 还陷在软沙里。看来得重新规划一条绕开软沙的路线。</p>
        <div className="mars-softsand__actions">
          <button type="button" className="is-primary" onClick={() => props.onPhase('revise')}>
            去修改路线 →
          </button>
        </div>
      </div>
    )
  }

  const pct = Math.round(progress)
  return (
    <div className="mars-softsand" role="dialog" aria-label="软沙脱困">
      <h2 className="mars-softsand__title">陷进软沙了！</h2>
      <p className="mars-softsand__lead">
        连按 <kbd>E</kbd> 或 <kbd>空格</kbd>（也可以点下面的按钮）把 R-7 摇出来
      </p>
      <div className="mars-softsand__meter" aria-hidden="true">
        <div className="mars-softsand__fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="mars-softsand__count" aria-live="polite">
        脱困进度 {pct}% · 剩余 {timeLeft} 秒
      </p>
      <div className="mars-softsand__actions">
        <button type="button" className="is-primary" onClick={feed}>
          摇出来！
        </button>
      </div>
    </div>
  )
}
