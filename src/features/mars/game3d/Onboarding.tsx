/**
 * 新手引导遮罩（游戏化任务流程 M6）。
 *
 * 目标：新玩家进入火星任务时，不看说明书也能开始第一趟任务。
 * - 黑场淡入 + KIBO 欢迎对白，建立"你不是开车，是训练 AI 开车"的心智模型。
 * - 用图标卡片讲清五种操作（驾驶 / 转视角 / 缩放 / 移动选择 / 交互），
 *   而不是堆一段文字说明。
 * - 给出第一个具体目标，点"开始探索"后不再打扰（localStorage 记一次）。
 *
 * 面向的是 10–12 岁玩家，文案走游戏化、不说教；不出现任何开发者术语。
 */
import { useEffect, useRef, useState } from 'react'
import { playOnboardingVoice } from '../../../lib/onboardingVoice'

/**
 * 新手引导「已看过」的本地标记，**按地图分开**。
 *
 * 2026-09-13 两点修正：
 * 1. 父组件（MarsGame3D）必须能**同步读取这个 key** 来判断引导这次会不会出现——
 *    否则会死锁：intro 若绑在 onDismiss 上，而引导因该标记不渲染时 onDismiss 永不
 *    调用，开场动画就永远不播（本日事故）。
 * 2. 原来是一个全局 key：学生在一号点过「开始探索」，**进二号就再也不弹了**——
 *    每张地图的地形、流程、目标都不同，引导理应各弹一次。故按 worldIndex 分 key。
 */
export const onboardingStorageKey = (worldIndex = 0) => `kibo-mars-onboarded-v1-w${worldIndex}`

export type OnboardingProps = {
  onDismiss: () => void
  /** 当前地图索引，用于按地图记忆「是否已看过引导」。 */
  worldIndex?: number
}

export function Onboarding({ onDismiss, worldIndex = 0 }: OnboardingProps) {
  const [show, setShow] = useState(() => {
    try {
      return !window.localStorage.getItem(onboardingStorageKey(worldIndex))
    } catch {
      return true
    }
  })
  const startRef = useRef<HTMLButtonElement | null>(null)
  /** 自动播放被浏览器拦截时置 true —— 显示兜底的「播放旁白」按钮。 */
  const [voiceBlocked, setVoiceBlocked] = useState(false)

  useEffect(() => {
    if (show) startRef.current?.focus()
  }, [show])

  /**
   * 旁白配音：引导出现即播。
   * **cleanup 里刻意什么都不做**——关闭引导时组件会卸载，若在这里 pause()
   * 配音就会中断，违反老大「关掉界面也一直念完」的要求。
   *
   * 播放被浏览器自动播放策略拦截时（例如直接打开任务 URL、没有前置用户交互），
   * 置 voiceBlocked 让界面显示「🔊 播放旁白」兜底按钮——**绝不静默失败**，
   * 否则用户根本不知道有旁白存在（2026-09-15 老大反馈"没听到声音"的根因）。
   */
  useEffect(() => {
    if (!show) return
    let cancelled = false
    void playOnboardingVoice().then((ok) => {
      if (!cancelled && !ok) setVoiceBlocked(true)
    })
    return () => {
      cancelled = true
    }
  }, [show])

  useEffect(() => {
    if (!show) return
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault()
        dismiss()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show])

  if (!show) return null

  function dismiss() {
    try {
      window.localStorage.setItem(onboardingStorageKey(worldIndex), '1')
    } catch {
      /* 忽略隐私模式下的写入失败 */
    }
    setShow(false)
    onDismiss()
  }

  return (
    <div className="mars-onboard" role="dialog" aria-modal="true" aria-label="任务引导">
      <div className="mars-onboard__card">
        <div className="mars-onboard__kibo" aria-hidden="true">
          <img src="/assets/kibo/kibo-head.webp" alt="" />
        </div>
        <h2 className="mars-onboard__title">欢迎来到火星基地</h2>
        <p className="mars-onboard__lead">
          我是 <strong>KIBO</strong>，你的 AI 训练助理。
          <br />
          今天你要<strong>亲手操控火星车 R-7</strong>，
          收集火星地形数据、定下通行规则，训练出一套导航 AI。
          然后派另一辆<strong>AI 自动驾驶的资源采集车</strong>走同一条路线——它不靠你手控，只靠 AI 判断，
          能过才算你的 AI 真的学会了。你不是在看演示，是自己在<strong>教 AI 怎么开车</strong>。
        </p>

        <p className="mars-onboard__goal">
          任务目标：
          <br />
          开着 R-7 到<strong>淡青色标记的推荐扫描点</strong>，
          <strong>按 E</strong> 扫描地形（扫描次数不限，可随时回头补采），扫到的每一块地形都会变成
          <strong>训练 AI 的真实数据</strong>。看清地形后，教 AI 通行规则、规划路线，
          让 R-7 实地跑一遍；最后派<strong>AI 自动驾驶的资源采集车</strong>再走一遍做「期末考试」。
          任务共有 <strong>火星一号、火星二号两张地图</strong>，二号地形完全不同，越来越难。
        </p>

        <div className="mars-onboard__actions">
          {/*
            自动播放兜底：浏览器拦截时给一个明确入口。点它是真实用户手势，
            播放必定成功；不点也不影响任务进行（旁白是增强项）。
          */}
          {voiceBlocked ? (
            <button
              type="button"
              className="mars-onboard__start"
              onClick={() => {
                void playOnboardingVoice().then((ok) => {
                  if (ok) setVoiceBlocked(false)
                })
              }}
            >
              🔊 播放旁白
            </button>
          ) : null}
          <button
            ref={startRef}
            type="button"
            className="mars-onboard__start"
            onClick={dismiss}
          >
            开始探索 →
          </button>
          <button type="button" className="mars-onboard__skip" onClick={dismiss}>
            跳过引导
          </button>
        </div>
      </div>
    </div>
  )
}
