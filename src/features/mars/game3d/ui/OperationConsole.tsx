/**
 * 操作台弹窗组件（UI/UX 重设计 P2）。
 *
 * 对应设计文档《火星任务UIUX redesign.md》第三节：
 *   3.2 数据清洗台 / 3.3 数据标注台 / 3.4 AI 训练舱 / 3.5 路径选择台
 *
 * 设计原则：
 * - 这些深度操作"绑定到场景中的 POI"，玩家走到操作台按 E 才弹出，不在主界面平铺。
 * - 玻璃态居中卡片（深色半透明 + 细边框 + 模糊背景），与现有 HUD 视觉一致。
 * - 每个弹窗都有一句"教学一句话"，把操作背后的 AI 训练逻辑讲清楚。
 * - 清洗 / 标注不再是"一键完成"，而是让学生逐条做判断——这是 AI PBL 的训练环节。
 * - 关闭方式：右上角 ✕ / 点背景 / 按 ESC，等价且不需要多余学习成本。
 */
import { useEffect, useMemo, useState } from 'react'
import {
  CAUTION_ROCK,
  BLOCKED_ROCK,
  CAUTION_SOFT,
  BLOCKED_SOFT,
  DATA_FLAW_TEXT,
  DATA_LABEL_TEXT,
  type DataLabel,
  type DataRecord,
  type MissionSnapshot,
  type Poi,
  type PoiKind,
  type RouteCandidate,
  type RouteEnergy,
} from '../core/mission'
import { POI_COLOR } from '../render/pois'

const POI_TITLE: Record<Exclude<PoiKind, 'sample-a' | 'sample-b' | 'sample-c' | 'maze-entrance' | 'energy-station'>, string> = {
  'base-clean': '数据清洗台',
  'base-label': '数据标注台',
  'base-train': 'AI 训练舱',
  'base-select': '路径选择台',
}

export type OperationConsoleProps = {
  poi: Poi
  snapshot: MissionSnapshot
  /** 路径选择台用的候选路线（由 mission.candidatePaths() 提供）。 */
  candidatePlans: RouteCandidate[]
  onClose: () => void
  /** 数据清洗：学生给某条记录判 keep / drop。 */
  onRecordCleanChoice: (id: string, choice: 'keep' | 'drop') => void
  /** 提交清洗结果。返回是否通过 + 错误列表。 */
  onConfirmCleaning: () => { ok: boolean; mistakes: { id: string; why: string }[] }
  /** 数据标注：学生给某条记录打标签。 */
  onRecordLabel: (id: string, label: DataLabel) => void
  /** 提交标注结果。返回是否通过 + 错误列表。 */
  onConfirmLabeling: () => { ok: boolean; mistakes: { id: string; why: string }[] }
  /** 训练 AI：消耗标注数据，置 trained。 */
  onTrain: () => void
  /** 选定一条候选路线（index 对应走近路/绕远路）。 */
  onSelectCandidate: (index: number) => void
  /** 派遣采集车沿选定的候选路线出发验证。 */
  onDispatchHauler: (index: number) => void
}

export function OperationConsole(props: OperationConsoleProps) {
  const { poi, onClose } = props

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const color = POI_COLOR[poi.kind] ?? '#ffffff'
  const title = POI_TITLE[poi.kind as keyof typeof POI_TITLE] ?? poi.label

  return (
    <div className="mars-console" role="dialog" aria-modal="true" aria-label={title}>
      <div className="mars-console__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="mars-console__card" style={{ ['--console-accent' as any]: color }}>
        <header className="mars-console__header">
          <span className="mars-console__dot" style={{ background: color }} aria-hidden="true" />
          <h2 className="mars-console__title">{title}</h2>
          <button type="button" className="mars-console__close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="mars-console__body">
          {poi.kind === 'base-clean' && <CleanConsole {...props} />}
          {poi.kind === 'base-label' && <LabelConsole {...props} />}
          {poi.kind === 'base-train' && <TrainConsole {...props} />}
          {poi.kind === 'base-select' && <SelectConsole {...props} />}
        </div>
      </div>
    </div>
  )
}

/** 3.2 数据清洗台：让学生逐条判断哪些是坏数据。 */
function CleanConsole({ snapshot, onRecordCleanChoice, onConfirmCleaning, onClose }: OperationConsoleProps) {
  const records = snapshot.records
  const [feedback, setFeedback] = useState<{ mistakes: { id: string; why: string }[] } | null>(null)
  const decided = records.filter((r) => r.cleanChoice !== null).length

  const setKeep = (r: DataRecord) => {
    onRecordCleanChoice(r.id, 'keep')
    setFeedback(null)
  }
  const setDrop = (r: DataRecord) => {
    onRecordCleanChoice(r.id, 'drop')
    setFeedback(null)
  }

  const submit = () => {
    const res = onConfirmCleaning()
    if (res.ok) onClose()
    else setFeedback({ mistakes: res.mistakes })
  }

  if (records.length === 0) {
    return (
      <div className="mars-console__panel">
        <p className="mars-console__empty">还没有原始数据。先去样本站采集，再回来清洗。</p>
      </div>
    )
  }

  // 2026-09-02 用户反馈"清洗只出现 1 类数据"：3 站各采 6 条 = 18 条才算完整。
  // 少于 3 站时直接提示回去采，避免误判坏数据时把好数据剔除（被 PBL 教学设计坑了）。
  const STATION_KINDS = ['sample-a', 'sample-b', 'sample-c'] as const
  const collectedStations = new Set(
    records
      .map((r) => r.id.split('#')[0])
      .filter((id) => STATION_KINDS.includes(id as (typeof STATION_KINDS)[number])),
  )
  if (collectedStations.size < STATION_KINDS.length) {
    const missing = STATION_KINDS.length - collectedStations.size
    const got = Array.from(collectedStations).map((s) => s.replace('sample-', '').toUpperCase()).join(' / ')
    return (
      <div className="mars-console__panel">
        <p className="mars-console__empty">
          原始数据不全（当前 {got}，还差 {missing} 个样本站）。
          <br />
          三类地形的代表性数据都得采，否则你教 AI 的规则会漏一种地形。
          <br />
          先去样本站补采，再回来清洗。
        </p>
      </div>
    )
  }

  return (
    <div className="mars-console__panel">
      <p className="mars-console__lead">
        下面是 R-7 采集回来的<strong>原始数据</strong>。看坡度、岩石度、软沙度这些数值，
        找出明显不合理（比如负数、重复、缺失）的记录，把它们剔除掉。
      </p>
      <ul className="mars-console__record-list" role="list">
        {records.map((r) => {
          const chosen = r.cleanChoice
          const wrong = feedback?.mistakes.find((m) => m.id === r.id)
          return (
            <li
              key={r.id}
              className={`mars-console__record${chosen === 'keep' ? ' is-keep' : chosen === 'drop' ? ' is-drop' : ''}${wrong ? ' is-wrong' : ''}`}
            >
              <div className="mars-console__record-main">
                <span className="mars-console__record-source">{r.source} · 数据{r.dataNumber}</span>
                <span className="mars-console__record-nums">
                  {/* 清洗阶段显示原始坡度，让学生自己发现 -999 这类异常 */}
                  <span>坡度 {r.slopeDeg.toFixed(0)}°</span>
                  <span>岩石 {fmtPct(r.rock)}</span>
                  <span>软沙 {fmtPct(r.soft)}</span>
                </span>
                {wrong && <span className="mars-console__record-why">{wrong.why}</span>}
              </div>
              <div className="mars-console__record-actions">
                <button
                  type="button"
                  className={chosen === 'keep' ? 'is-keep is-active' : 'is-keep'}
                  onClick={() => setKeep(r)}
                  aria-pressed={chosen === 'keep'}
                >
                  保留
                </button>
                <button
                  type="button"
                  className={chosen === 'drop' ? 'is-drop is-active' : 'is-drop'}
                  onClick={() => setDrop(r)}
                  aria-pressed={chosen === 'drop'}
                >
                  剔除
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      <p className="mars-console__progress">已检查 {decided} / {records.length} 条</p>
      <p className="mars-console__teach">教学：AI 只能学到"你给它的数据"——坏数据进去，坏结论出来。</p>
      <div className="mars-console__actions">
        <button type="button" className="is-primary" disabled={decided < records.length} onClick={submit}>
          确认清洗结果
        </button>
      </div>
    </div>
  )
}

/** 3.3 数据标注台：让学生按自己定的规则逐条分类。 */
function LabelConsole({ snapshot, onRecordLabel, onConfirmLabeling, onClose }: OperationConsoleProps) {
  const records = useMemo(() => snapshot.records.filter((r) => r.cleanChoice === 'keep'), [snapshot.records])
  const [feedback, setFeedback] = useState<{ mistakes: { id: string; why: string }[] } | null>(null)
  const decided = records.filter((r) => r.label !== null).length

  const setLabel = (r: DataRecord, label: DataLabel) => {
    onRecordLabel(r.id, label)
    setFeedback(null)
  }

  const submit = () => {
    const res = onConfirmLabeling()
    if (res.ok) onClose()
    else setFeedback({ mistakes: res.mistakes })
  }

  if (records.length === 0) {
    return (
      <div className="mars-console__panel">
        <p className="mars-console__empty">没有可标注的数据。可能清洗时把好数据都剔除了，回去重新清洗。</p>
      </div>
    )
  }

  return (
    <div className="mars-console__panel">
      <p className="mars-console__lead">
        给每条数据打上标签。AI 会<strong>同时看三个指标</strong>，取最严格的一档：
      </p>
      <ul className="mars-console__rule-list">
        <li>
          <strong>坡度</strong>：地形倾斜角度（°）。
          <span className="mars-console__rule-range">
            &lt; {snapshot.cautionDeg}° 可通行，&lt; {snapshot.blockedDeg}° 难走，更陡禁行
          </span>
        </li>
        <li>
          <strong>岩石度</strong>：地面岩石覆盖比例，越高越颠簸、越容易损伤车轮。
          <span className="mars-console__rule-range">
            &lt; {Math.round(snapshot.cautionRock * 100)}% 可通行，&lt; {Math.round(snapshot.blockedRock * 100)}% 难走，更高禁行
          </span>
        </li>
        <li>
          <strong>软沙度</strong>：地面松软沙子比例，越高越容易陷车。
          <span className="mars-console__rule-range">
            &lt; {Math.round(snapshot.cautionSoft * 100)}% 可通行，&lt; {Math.round(snapshot.blockedSoft * 100)}% 难走，更高禁行
          </span>
        </li>
      </ul>
      <div className="mars-console__legend" aria-label="标签图例">
        <span className="mars-console__legend-item">
          <i className="mars-console__swatch is-pass" /> 可通行
        </span>
        <span className="mars-console__legend-item">
          <i className="mars-console__swatch is-caution" /> 难走
        </span>
        <span className="mars-console__legend-item">
          <i className="mars-console__swatch is-block" /> 禁行
        </span>
      </div>
      <ul className="mars-console__record-list" role="list">
        {records.map((r) => {
          const wrong = feedback?.mistakes.find((m) => m.id === r.id)
          return (
            <li
              key={r.id}
              className={`mars-console__record${wrong ? ' is-wrong' : ''}`}
            >
              <div className="mars-console__record-main">
                <span className="mars-console__record-source">{r.source} · 数据{r.dataNumber}</span>
                <span className="mars-console__record-nums">
                  <span>坡度 {fmtSlope(r.slopeDeg)}°</span>
                  <span>岩石 {fmtPct(r.rock)}</span>
                  <span>软沙 {fmtPct(r.soft)}</span>
                </span>
                {wrong && <span className="mars-console__record-why">{wrong.why}</span>}
              </div>
              <div className="mars-console__record-actions is-labels">
                {(['pass', 'caution', 'block'] as const).map((label) => (
                  <button
                    key={label}
                    type="button"
                    className={`${r.label === label ? 'is-active' : ''} is-${label}`}
                    onClick={() => setLabel(r, label)}
                    aria-pressed={r.label === label}
                  >
                    {DATA_LABEL_TEXT[label]}
                  </button>
                ))}
              </div>
            </li>
          )
        })}
      </ul>
      <p className="mars-console__progress">已标注 {decided} / {records.length} 条</p>
      <p className="mars-console__teach">教学：你标的每一类都是 AI 的"标准答案"——标得越准，AI 越可靠。</p>
      <div className="mars-console__actions">
        <button type="button" className="is-primary" disabled={decided < records.length} onClick={submit}>
          确认标注结果
        </button>
      </div>
    </div>
  )
}

/** 3.4 AI 训练舱：标注量 + 三维度质量预估 + 训练动画。 */
function TrainConsole({ snapshot, onTrain, onClose }: OperationConsoleProps) {
  const labeled = snapshot.records.filter((r) => r.cleanChoice === 'keep' && r.label !== null).length
  const [phase, setPhase] = useState<'idle' | 'training' | 'done'>(snapshot.trained ? 'done' : 'idle')

  // 三维度质量预估（0-100），由当前认知确定性推导，纯展示用。
  const accuracy = Math.round(Math.min(100, 35 + snapshot.coverage * 60))
  const caution = Math.round(Math.min(100, 30 + Math.max(0, 45 - snapshot.cautionDeg) * 2))
  const efficiency = Math.round(Math.min(100, 40 + snapshot.weights.unknown * 6))

  const start = () => {
    setPhase('training')
    // 2026-09-03 用户反馈：训练结束后会自动关闭训练界面，导致用户无法第一时间看到
    // 训练后的数据结果，而是要再次点击才能看到。
    // 修正：训练完成后只切换到 done 阶段并显示训练质量结果，由用户自己点 ✕ 关闭。
    window.setTimeout(() => {
      onTrain()
      setPhase('done')
    }, 2200)
  }

  return (
    <div className="mars-console__panel">
      <p className="mars-console__lead">
        把标注好的数据喂给导航 AI。它学的是"你判断地形能不能走"的经验——学完就能自己去实地验证。
      </p>
      <dl className="mars-console__stats">
        <div>
          <dt>已标注数据</dt>
          <dd>{labeled}</dd>
        </div>
        <div>
          <dt>探明覆盖率</dt>
          <dd>{Math.round(snapshot.coverage * 100)}%</dd>
        </div>
      </dl>

      {phase === 'done' && (
        <div className="mars-console__radar" aria-label="模型质量">
          <QualityBar label="准确率" value={accuracy} />
          <QualityBar label="谨慎度" value={caution} />
          <QualityBar label="效率" value={efficiency} />
        </div>
      )}

      {phase === 'training' && (
        <div className="mars-console__training" role="status" aria-live="polite">
          <span className="mars-console__spinner" aria-hidden="true" />
          <p>AI 正在学习你的标注……</p>
        </div>
      )}

      <p className="mars-console__teach">教学：模型质量取决于你标注的数据——这就是"数据驱动"的直观含义。</p>

      <div className="mars-console__actions">
        {phase === 'idle' && (
          <button type="button" className="is-primary" disabled={labeled === 0} onClick={start}>
            开始训练
          </button>
        )}
        {phase === 'done' && <p className="mars-console__ok">训练完成，去路径选择台挑一条路线验证。</p>}
        {labeled === 0 && phase === 'idle' && (
          <p className="mars-console__empty">还没有标注数据。先去数据标注台把样本标完。</p>
        )}
      </div>
    </div>
  )
}

function QualityBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="mars-console__qbar">
      <span className="mars-console__qbar-label">{label}</span>
      <span className="mars-console__qbar-track" aria-hidden="true">
        <span className="mars-console__qbar-fill" style={{ width: `${value}%` }} />
      </span>
      <span className="mars-console__qbar-value">{value}</span>
    </div>
  )
}

/** 3.5 路径选择台：3 张候选路线卡片 + 能源预算 + 确定路线按钮。 */
/**
 * 把路线特征翻译成客观中性的描述。
 * 按 PBL 红线：UI 绝不替学生判断哪条路更稳、更险、更省电。
 * 只描述路线的客观形态（里程、未知格、难走格、避开了什么），
 * 不评价、不暗示、不总结——决定权留给学生。
 *
 * 历史教训：v1.3.1 写过"确定耗电 X / 电池电量 Y"对比 + "里程最长也最稳"等评价，
 * 被老大定为泄题；v1.3.2 回退掉确定耗电数字但保留"留得出余量/够不够回基地得自己算"
 * "里程最短也最险/区间越窄"等评价性文案，依然泄题。本版本（v1.3.3）连评价也删了。
 */
function routeRiskHint(c: RouteCandidate, e: RouteEnergy): string {
  if (!c.summary?.found) return '无可行路线'
  if (c.label === '绕远路') {
    return `贴着已探明区走，绕开没扫过的地段，也不走颠簸路面。`
  }
  if (c.label === '走近路') {
    return `为了近，硬穿 ${e.cautionCells} 段难走路面，也要切过一小片没扫过的地段。`
  }
  return c.note
}

function SelectConsole({ candidatePlans, snapshot, onSelectCandidate, onDispatchHauler }: OperationConsoleProps) {
  const [selected, setSelected] = useState<number | null>(null)
  const found = candidatePlans.filter((c) => c.summary?.found)
  const priced = found.map((c) => c.energy).filter((e): e is RouteEnergy => e !== null && e !== undefined)
  // 两条路全军覆没时，问题不在选哪条，而在数据不够——直接把学生推回采集环节。
  const allDoomed = priced.length > 0 && priced.every((e) => e.worst > e.battery)

  // 当 mission 的 uncertaintyChoice 反映已有选择时，同步高亮。
  const missionChoice = snapshot.uncertaintyChoice
  const selectedIndex = useMemo(() => {
    if (selected !== null) return selected
    if (missionChoice === 'detour') return 1
    if (missionChoice === 'pass-reason') return 0
    return null
  }, [selected, missionChoice])

  return (
    <div className="mars-console__panel">
      <p className="mars-console__lead">
        训练好的 AI 生成了 <strong>{candidatePlans.length} 条</strong>候选路线。里程、未知区域、难走路段都不一样——
        你要挑一条能让采集车<strong>往返</strong>基地和能源站、又不把电池耗光的路线。
      </p>
      {found.length === 0 ? (
        <p className="mars-console__empty">还没有可行路线。先去「规划路线」阶段生成一条路线，再回来选。</p>
      ) : (
        <div className="mars-console__cards is-routes" role="radiogroup" aria-label="候选路线">
          {candidatePlans.map((c, k) => {
            const s = c.summary
            const e = c.energy
            const active = selectedIndex === k
            return (
              <button
                type="button"
                role="radio"
                aria-checked={active}
                key={c.label}
                className={`mars-console__route${active ? ' is-active' : ''}${s?.found ? '' : ' is-disabled'}`}
                disabled={!s?.found}
                onClick={() => {
                  setSelected(k)
                  onSelectCandidate(k)
                }}
              >
                <span className="mars-console__card-label">{c.label}</span>
                <span className="mars-console__card-note">{c.note}</span>
                {s?.found && e && (
                  <span className="mars-console__card-stats is-stacked">
                    {/*
                      红线 v1.3.3：路径选择台只给客观数据（里程/未知格/难走格），
                      不显示「确定耗电 / 电池电量」对比——那等于替学生判断电池够不够；
                      也不显示「乐观~最坏耗电」区间——那等于告诉他风险程度。
                      学生要算账必须自己结合清洗标注/决策的与未知地图覆盖面积。
                    */}
                    <span className="mars-console__stat">
                      <span className="mars-console__stat-key">往返里程</span>
                      <span className="mars-console__stat-value">{e.roundTripM.toFixed(0)} m</span>
                    </span>
                    <span className="mars-console__stat">
                      <span className="mars-console__stat-key">没扫过的区域</span>
                      <span className="mars-console__stat-value">{e.unknownCells} 格</span>
                    </span>
                    <span className="mars-console__stat">
                      <span className="mars-console__stat-key">难走路段</span>
                      <span className="mars-console__stat-value">{e.cautionCells} 格</span>
                    </span>
                    <span className="mars-console__stat is-hint">
                      {routeRiskHint(c, e)}
                    </span>
                  </span>
                )}
                {!s?.found && <span className="mars-console__card-note">无可行路线</span>}
              </button>
            )
          })}
        </div>
      )}
      {allDoomed && (
        <p className="mars-console__warn is-block">
          按最坏情况估算，这几条路线目前都存在能源风险——未知区域越多，估算结果越保守。
          可以先关掉这个台子，开着 R-7 出去多扫几片（按 <kbd>E</kbd> 扫描，次数不限），
          等地图更清楚后再回来比较。
        </p>
      )}
      <p className="mars-console__teach">
        {/* 红线 v1.3.3：教学一句话只描述"路线不唯一 + 替 AI 拍板"，绝不评价哪条更好。
            旧版"近路颠簸费电/远路稳妥/穿未知区最短也最险"是泄题——把几种走法都点了一遍。 */}
        教学：路线不是唯一的——AI 会按不同取舍生成几条，让你来拍。
      </p>
      <div className="mars-console__actions">
        <button
          type="button"
          className="is-primary is-wide"
          disabled={selectedIndex === null}
          onClick={() => {
            if (selectedIndex !== null) onDispatchHauler(selectedIndex)
          }}
        >
          确定路线，开始验证
        </button>
      </div>
      {snapshot.hauler.status === 'failed' && (
        <p className="mars-console__warn">上次验证失败了：{snapshot.hauler.failReason} 换一条路线再试。</p>
      )}
    </div>
  )
}

/** 3.1 基地操作台"暂无法互动"锁定弹窗（需求 C #312）。 */
export function LockedConsole({ poi, onClose }: { poi: Poi; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const color = POI_COLOR[poi.kind] ?? '#ffffff'
  const title = POI_TITLE[poi.kind as keyof typeof POI_TITLE] ?? poi.label

  return (
    <div className="mars-console" role="dialog" aria-modal="true" aria-label={`${title}（暂未解锁）`}>
      <div className="mars-console__backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="mars-console__card mars-console__card--locked"
        style={{ ['--console-accent' as any]: color }}
      >
        <header className="mars-console__header">
          <span className="mars-console__dot" style={{ background: color }} aria-hidden="true" />
          <h2 className="mars-console__title">{title}</h2>
          <button type="button" className="mars-console__close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="mars-console__body">
          <p className="mars-console__lock-badge">暂无法互动</p>
          <p className="mars-console__lock-core">先去采集数据样本</p>
          <p className="mars-console__lock-desc">
            操作台需要先有样本才能开工。开着 R-7 到淡青色标记的样本站
            （<strong>河床</strong> / <strong>沙丘</strong> / <strong>坑缘</strong>），
            <strong>按 E</strong> 采集地形样本，回来就能用这座操作台了。
          </p>
          <div className="mars-console__actions">
            <button type="button" className="is-primary" onClick={onClose}>
              确定
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function fmtSlope(n: number): string {
  if (n < -900) return '—' // 超量程
  if (n < 0) return '0'
  return n.toFixed(0)
}

function fmtPct(n: number): string {
  if (n < 0) return '—'
  return `${Math.round(n * 100)}%`
}
