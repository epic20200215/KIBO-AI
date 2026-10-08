import { useEffect, useMemo, useRef, useState } from 'react'
import { primeOnboardingVoice } from '../lib/onboardingVoice'
import { ArrowRight, ChevronLeft, ChevronRight, Clock3, Home, Orbit, RotateCcw } from 'lucide-react'
import { Brand } from '../components/Brand'
import {
  getWorldCount,
  loadMissionProgress,
  resetMissionProgress,
  startMission,
  type MissionProgress,
} from '../lib/missionProgress'
import type { Mission } from '../types/mission'

type CabinPageProps = {
  catalog: Mission[]
  initialMissionId: string
  onHome: () => void
  onMissionSelected: (mission: Mission) => void
  onLaunchComplete: (mission: Mission) => void
}

type Direction = 1 | -1

type TransitionState = {
  previous: Mission
  direction: Direction
} | null

function wrappedOffset(index: number, selected: number, length: number) {
  let offset = index - selected
  const half = Math.floor(length / 2)
  if (offset > half) offset -= length
  if (offset < -half) offset += length
  return offset
}

export function CabinPage({
  catalog,
  initialMissionId,
  onHome,
  onMissionSelected,
  onLaunchComplete,
}: CabinPageProps) {
  const initialIndex = Math.max(0, catalog.findIndex((mission) => mission.id === initialMissionId))
  const [selectedIndex, setSelectedIndex] = useState(initialIndex)
  const [transition, setTransition] = useState<TransitionState>(null)
  const [launching, setLaunching] = useState(false)
  const [progressTick, setProgressTick] = useState(0)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  /** 重置成功后的短暂回执文案；空串表示不显示。 */
  const [resetNotice, setResetNotice] = useState('')
  /** 触发重置的按钮，弹窗关闭后焦点要还给它，键盘用户才不会丢失位置。 */
  const resetButtonRef = useRef<HTMLButtonElement | null>(null)
  const resetCancelRef = useRef<HTMLButtonElement | null>(null)
  /** 弹窗卡片，用于把 Tab 焦点圈在弹窗内（焦点陷阱）。 */
  const resetCardRef = useRef<HTMLDivElement | null>(null)
  const pointerStart = useRef<number | null>(null)
  const wheelLocked = useRef(false)
  const wheelTimer = useRef<number | null>(null)
  const selectedMission = catalog[selectedIndex]
  const worldCount = getWorldCount(selectedMission.id)
  const [titleLead, ...titleRest] = selectedMission.title.split('：')

  // 对所有已发布任务一视同仁，不再为 mars-rover 开特例分支，
  // 否则未来上线第二个任务时，它的重置按钮会凭空消失。
  const missionProgress: MissionProgress | null = useMemo(() => {
    if (selectedMission.status !== 'released') return null
    return loadMissionProgress(selectedMission.id, worldCount)
  }, [selectedMission, worldCount, progressTick])

  /** 全新状态（没启动过、也没完成过任何世界）时重置是无意义的空操作，按钮置灰。 */
  const isPristine = missionProgress !== null && !missionProgress.started && missionProgress.completedWorlds === 0

  const selectIndex = (nextIndex: number, direction: Direction) => {
    // 转场中与「二次确认」弹窗打开时都禁止换任务。
    // 弹窗守卫尤其关键：弹窗标题、正文里的任务名，以及「确认重置」清掉的 missionId
    // 全部取自 selectedMission。若在弹窗开着时切换任务，用户确认后清掉的
    // 会是刚切到的那个任务的进度——而弹窗上写的还是旧任务名，属于不可逆误伤。
    // 这里在最内层拦截，键盘 / 滚轮 / 拖拽 / 坐标节点点击四个入口一并覆盖。
    if (launching || showResetConfirm) return
    const normalized = (nextIndex + catalog.length) % catalog.length
    if (normalized === selectedIndex) return
    setTransition({ previous: selectedMission, direction })
    setSelectedIndex(normalized)
    onMissionSelected(catalog[normalized])
  }

  const move = (direction: Direction) => selectIndex(selectedIndex + direction, direction)

  // 故意不写依赖数组：handleKey 必须读到每次渲染最新的 selectedIndex 与守卫状态，
  // 写成 [selectedIndex] 这种一旦漏依赖就会让闭包读到陈旧值、切到错误的任务。
  // 每次渲染重注册一个 keydown 的开销可忽略，这里正确性优先。
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        move(-1)
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        move(1)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  })

  // 卸载时回收滚轮去抖定时器，避免在已卸载组件上 setState。
  useEffect(() => () => {
    if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current)
  }, [])

  // 重置二次确认弹窗：Esc 关闭、Tab 焦点陷阱、
  // 打开时把焦点交给「取消」（破坏性操作不预选确认），关闭后焦点归还触发按钮。
  useEffect(() => {
    if (!showResetConfirm) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setShowResetConfirm(false)
        return
      }
      // 焦点陷阱：Tab 只允许在弹窗内循环，不许 Tab 到背景的任务切换器上
      // （否则键盘用户会在模态弹窗开着时误切任务）。
      if (event.key !== 'Tab') return
      const card = resetCardRef.current
      if (!card) return
      const focusables = Array.from(card.querySelectorAll<HTMLElement>('button:not([disabled])'))
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (!first || !last) return
      const active = document.activeElement
      if (event.shiftKey && (active === first || !card.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !card.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    resetCancelRef.current?.focus()
    const trigger = resetButtonRef.current
    return () => {
      window.removeEventListener('keydown', onKey)
      // 关闭后把焦点还给重置按钮，键盘用户不会丢失位置。
      trigger?.focus()
    }
  }, [showResetConfirm])

  // 重置回执自动消失（3.2s）。
  useEffect(() => {
    if (!resetNotice) return
    const timer = window.setTimeout(() => setResetNotice(''), 3200)
    return () => window.clearTimeout(timer)
  }, [resetNotice])

  const railNodes = useMemo(
    () => catalog.map((mission, index) => ({ mission, index, offset: wrappedOffset(index, selectedIndex, catalog.length) })),
    [catalog, selectedIndex],
  )

  return (
    <main
      className={`cabin-page ${launching ? 'cabin-page--launching' : ''}`}
      style={{ '--mission-accent': selectedMission.accent, '--mission-accent-soft': selectedMission.accentSoft } as React.CSSProperties}
      onWheel={(event) => {
        if (wheelLocked.current || Math.abs(event.deltaY) < 28) return
        wheelLocked.current = true
        move(event.deltaY > 0 ? 1 : -1)
        // 存 id 以便卸载时清理，避免在已卸载的组件上残留定时器。
        if (wheelTimer.current !== null) window.clearTimeout(wheelTimer.current)
        wheelTimer.current = window.setTimeout(() => { wheelLocked.current = false }, 520)
      }}
      onPointerDown={(event) => { pointerStart.current = event.clientX }}
      onPointerUp={(event) => {
        if (pointerStart.current === null) return
        const delta = event.clientX - pointerStart.current
        pointerStart.current = null
        if (Math.abs(delta) > 48) move(delta < 0 ? 1 : -1)
      }}
    >
      <header className="cabin-header">
        <Brand inverse onClick={onHome} />
        <div className="cabin-header__center">
          <Orbit size={16} aria-hidden="true" />
          <span>KIBO EXPLORATION DECK</span>
        </div>
        <div className="cabin-header__actions">
          <button className="cabin-home" type="button" onClick={onHome} aria-label="返回官网首页">
            <Home size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="cabin-stage">
        <div className="mission-window">
          {transition && (
            <img
              key={`previous-${transition.previous.id}`}
              className={`mission-window__image mission-window__image--exit-${transition.direction > 0 ? 'left' : 'right'}`}
              src={transition.previous.poster}
              alt=""
            />
          )}
          <img
            key={selectedMission.id}
            className={`mission-window__image ${transition ? `mission-window__image--enter-${transition.direction > 0 ? 'right' : 'left'}` : ''}`}
            src={selectedMission.poster}
            alt=""
            onAnimationEnd={() => setTransition(null)}
          />
          <div className="mission-window__glass" />
          <div className="mission-window__scan" />
        </div>

        <div className="cabin-console-screen" aria-hidden="true">
          <img src={`${import.meta.env.BASE_URL}assets/cabin/cabin-console-standby-v1.webp`} alt="" width="1600" height="320" />
        </div>

        <img className="cabin-stage__shell" src={`${import.meta.env.BASE_URL}assets/cabin/cabin-shell-front-v4.webp`} alt="" width="1672" height="941" />

        <div className="cabin-stage__kibo-wrap">
          <span className="cabin-stage__kibo-shadow" aria-hidden="true" />
          <img
            className="cabin-stage__kibo"
            src={`${import.meta.env.BASE_URL}assets/kibo/kibo-welcome.webp`}
            alt="KIBO 任务向导"
            width="1211"
            height="1299"
          />
        </div>

        <section className="cabin-mission" aria-labelledby="mission-title" aria-live="polite">
          <p className="cabin-mission__eyebrow">
            <span>{selectedMission.coordinate}</span>
            {selectedMission.eyebrow}
          </p>
          <h1 id="mission-title">
            {titleLead}{titleRest.length > 0 && <>：<br />{titleRest.join('：')}</>}
          </h1>
          <p className="cabin-mission__summary">{selectedMission.summary}</p>
          <div className="cabin-mission__meta">
            <span><Clock3 size={15} aria-hidden="true" />约 {selectedMission.durationMinutes} 分钟</span>
            {selectedMission.knowledgeNodes.map((node) => <span key={node}>{node}</span>)}
          </div>
          {selectedMission.status === 'released' ? (
            <div className="mission-start-group">
              {missionProgress && missionProgress.completedWorlds >= worldCount ? (
                // 2026-09-13 老大反馈：任务完成后主按钮必须**禁用**——想重新体验走旁边的
                // 「重置」（重置后 completedWorlds 清零，按钮变回「启动任务」），
                // 这样重置按钮才有存在的价值。此前「任务完成」仍绑着 setLaunching(true)，
                // 点了还能进任务场景，重置按钮形同虚设。
                <button
                  className="mission-start mission-start--completed"
                  type="button"
                  disabled
                  aria-label={`任务已完成：${selectedMission.title}。点击旁边的重置按钮可重新体验`}
                  title="任务已完成。想重新体验？点击旁边的重置按钮"
                >
                  <strong>任务完成</strong>
                </button>
              ) : (
                <button
                  className={`mission-start${missionProgress?.started ? ' mission-start--in-progress' : ''}`}
                  type="button"
                  onClick={() => {
                    // 2026-09-15：在**用户手势中**预备新手引导旁白（预建媒体元素 + 预加载）。
                    // 这样进入 3D 后引导里的 play() 借本次 sticky activation 放行，
                    // 避免被浏览器自动播放策略拦截（老大反馈"没听到声音"）。
                    primeOnboardingVoice()
                    startMission(selectedMission.id, worldCount)
                    setProgressTick((n) => n + 1)
                    setLaunching(true)
                  }}
                  aria-label={`${missionProgress?.started ? '继续任务' : '启动任务'}：${selectedMission.title}`}
                >
                  <strong>{missionProgress?.started ? '任务进行中' : '启动任务'}</strong>
                  <ArrowRight size={20} aria-hidden="true" />
                </button>
              )}
              {/*
                重置按钮长期存在：任务任何状态下都出现，且任何状态下都点得动（需求原文）。
                这里**刻意不置灰**——disabled 按钮点了毫无反馈，10–12 岁学生会反复点，
                比弹窗更糟。全新状态照样弹窗，只是弹的是「不需要重置」的提示，
                而不是「无法撤销」的确认，避免无意义的恐吓。
              */}
              {missionProgress && (
                <button
                  ref={resetButtonRef}
                  className="mission-reset"
                  type="button"
                  onClick={() => setShowResetConfirm(true)}
                  aria-label={isPristine ? '查看重置说明：任务尚未开始' : '重置任务进度'}
                  title={isPristine ? '任务尚未开始，无需重置' : '重置任务进度'}
                >
                  <RotateCcw size={16} aria-hidden="true" />
                </button>
              )}
            </div>
          ) : (
            <button
              className="mission-start mission-start--locked"
              type="button"
              disabled
              aria-label={`${selectedMission.title}：敬请期待`}
            >
              <strong>敬请期待</strong>
            </button>
          )}
          {/*
            重置回执：按钮文案从「任务进行中」变回「启动任务」这个变化发生在被遮罩
            盖住的背景里，学生根本看不到，会怀疑「到底重置成功没有」。
            必须给一句明确回执；role=status + aria-live 让读屏用户同样能收到。
          */}
          {resetNotice && (
            <p className="mission-reset-notice" role="status" aria-live="polite">
              {resetNotice}
            </p>
          )}
        </section>

        <div className="cabin-stage__reflection" />
      </div>

      <div className="cabin-switcher" aria-label="切换任务">
        {catalog.length > 1 && (
          <button type="button" className="cabin-switcher__arrow" onClick={() => move(-1)} aria-label="上一个任务">
            <ChevronLeft aria-hidden="true" />
          </button>
        )}
        <div className="coordinate-rail">
          <div className="coordinate-rail__arc" aria-hidden="true" />
          {railNodes.map(({ mission, index, offset }) => {
            const arcY = Math.abs(offset) * Math.abs(offset) * 7
            return (
              <button
                key={mission.id}
                type="button"
                className={`coordinate-node ${index === selectedIndex ? 'coordinate-node--active' : ''}`}
                style={{ '--node-x': `${offset * 132}px`, '--node-x-mobile': `${offset * 62}px`, '--node-y': `${arcY}px` } as React.CSSProperties}
                onClick={() => selectIndex(index, offset >= 0 ? 1 : -1)}
                aria-current={index === selectedIndex ? 'true' : undefined}
                aria-label={`选择任务：${mission.shortTitle}`}
              >
                <span className="coordinate-node__dot" />
                <span className="coordinate-node__label">{mission.shortTitle}</span>
                <span className="coordinate-node__coordinate">{mission.coordinate}</span>
              </button>
            )
          })}
        </div>
        {catalog.length > 1 && (
          <button type="button" className="cabin-switcher__arrow" onClick={() => move(1)} aria-label="下一个任务">
            <ChevronRight aria-hidden="true" />
          </button>
        )}
      </div>

      {launching && (
        <div className="mission-launch" aria-label={`正在进入任务：${selectedMission.title}`}>
          <img
            className="mission-launch__scene"
            src={selectedMission.poster}
            alt=""
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget) onLaunchComplete(selectedMission)
            }}
          />
          <div className="mission-launch__frame" />
        </div>
      )}

      {showResetConfirm && (
        <div
          className="cabin-reset-confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cabin-reset-confirm-title"
          aria-describedby="cabin-reset-confirm-body"
        >
          <div
            className="cabin-reset-confirm__backdrop"
            onClick={() => setShowResetConfirm(false)}
          />
          <div className="cabin-reset-confirm__card" ref={resetCardRef}>
            <h2 id="cabin-reset-confirm-title" className="cabin-reset-confirm__title">
              {isPristine ? '这个任务还没有开始' : '重置任务进度？'}
            </h2>
            {/*
              文案不写死「地形数据 / 通行规则」这类火星专属名词——重置按钮已对所有
              已发布任务通用，写死会让第二个任务的弹窗说出不属于它的东西。
            */}
            <p id="cabin-reset-confirm-body" className="cabin-reset-confirm__body">
              {isPristine ? (
                <>
                  「{selectedMission.title}」还没有任何进度，不需要重置。<br />
                  直接点「启动任务」就可以开始了。
                </>
              ) : (
                <>
                  确定要重置「{selectedMission.title}」吗？<br />
                  这个任务的全部进度都会被清空——已采集的数据、训练好的 AI、已通过的关卡都会丢失，需要从头开始，且无法撤销。
                </>
              )}
            </p>
            <div className="cabin-reset-confirm__actions">
              <button
                ref={resetCancelRef}
                type="button"
                className="cabin-reset-confirm__cancel"
                onClick={() => setShowResetConfirm(false)}
              >
                {isPristine ? '知道了' : '取消'}
              </button>
              {!isPristine && (
                <button
                  type="button"
                  className="cabin-reset-confirm__confirm"
                  onClick={() => {
                    resetMissionProgress(selectedMission.id)
                    setProgressTick((n) => n + 1)
                    setShowResetConfirm(false)
                    setResetNotice(`「${selectedMission.title}」已重置，可以重新开始了`)
                  }}
                >
                  确认重置
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
