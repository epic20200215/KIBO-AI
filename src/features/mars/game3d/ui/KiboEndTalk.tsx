/**
 * 任务完成后的 KIBO 结算对白。
 *
 * 用户反馈：成功后 KIBO 头顶出现感叹号，点击后弹出正式的居中弹窗，
 * 展示 KIBO 头像、复盘这一趟解决了什么问题，并提供两个底部按钮：
 * - 回到探索舱
 * - 继续任务（若二号地图已就绪则进入，否则关闭弹窗留在当前场景）
 *
 * **2026-09-03 v1.3.5 重要修复**：关闭弹窗 ≠ 回到探索舱。
 * 之前 ✕ / ESC / 点背景遮罩全都绑了 onBackToCabin，用户只是想关掉弹窗看看场景，
 * 结果直接被踢回探索舱——任务进度虽已持久化，但体验是被打断的。
 * 现在严格区分：
 *   - 关界面（✕ / ESC / 点背景遮罩）→ onClose，只收起弹窗，人留在火星场景继续探索；
 *   - 只有显式点底部「回到探索舱」按钮 → onBackToCabin，才真实退出任务。
 */
import { useEffect } from 'react'

/** 结算时刻用 KIBO 的庆祝形象。 */
const AVATAR = `${import.meta.env.BASE_URL}assets/kibo/kibo-mission-celebrate-v1.webp`

export type KiboEndTalkProps = {
  /** 当前地图标题（火星一号 / 火星二号），用于在台词里点出这次解决的具体问题。 */
  worldGoal: string
  /** 采集车最终走的是哪条路线。 */
  routeLabel: string
  /** 往返结束后剩余的能源。 */
  energyLeft: number
  /**
   * 后面还有没有没打完的地图。
   * 最后一张地图的收尾不能再说「下一张地图地形完全不同」——那是在骗学生，
   * 也会让「继续任务」按钮显得像坏了。
   */
  hasNextWorld: boolean
  /** 只关闭弹窗、留在当前场景（✕ / ESC / 点背景遮罩）。 */
  onClose: () => void
  /** 点击「回到探索舱」：真实退出任务。 */
  onBackToCabin: () => void
  /** 点击「继续任务」。 */
  onContinueTask: () => void
}

export function KiboEndTalk({
  worldGoal,
  routeLabel,
  energyLeft,
  hasNextWorld,
  onClose,
  onBackToCabin,
  onContinueTask,
}: KiboEndTalkProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // ESC 只关界面，不退出任务。
      if (e.code === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="mars-kibo-endtalk" role="dialog" aria-modal="true" aria-label="KIBO 的祝贺">
      <div className="mars-kibo-endtalk__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="mars-kibo-endtalk__card">
        <button type="button" className="mars-kibo-endtalk__close" onClick={onClose} aria-label="关闭">
          ✕
        </button>

        <div className="mars-kibo-endtalk__header">
          <img className="mars-kibo-endtalk__avatar" src={AVATAR} alt="KIBO" width={96} height={96} />
          <div className="mars-kibo-endtalk__intro">
            <p className="mars-kibo-endtalk__name">KIBO</p>
            <p className="mars-kibo-endtalk__sub">任务完成 · 来听听 KIBO 怎么说</p>
          </div>
        </div>

        <div className="mars-kibo-endtalk__body">
          <p>
            太棒了，你做到了！采集车沿着你选的「{routeLabel}」跑完了整整一个往返，
            把能源安全带回了基地，还剩 {energyLeft.toFixed(0)} 点电。
          </p>
          <p>
            这一趟你解决的是 <strong>{worldGoal}</strong>。而且你没有走捷径——
            你是先开着 R-7 去实地采集真实地形，再亲手剔掉坏数据、给每条数据打上标签，
            用这些标准答案训练出导航 AI，最后才让采集车替 AI 去接受真实路线的检验。
          </p>
          <p>
            最难得的是：你没有直接相信 AI 给出的任意一条路线，而是先验证、再相信——这就是
            AI 创造者该有的样子。
          </p>
          {hasNextWorld ? (
            <p>下一张地图的地形完全不同，AI 还得靠你继续训练。我们下一站见。</p>
          ) : (
            <p>
              这一整套流程我们已经走通了。接下来你可以继续在这张地图里自由探索，
              也可以回探索舱看看别的任务——让我们继续努力，最终成为能够驾驭AI的创造者，
              而不是AI时代的旁观者。
            </p>
          )}
        </div>

        <div className="mars-kibo-endtalk__footer">
          <button type="button" className="mars-kibo-endtalk__confirm" onClick={onBackToCabin}>
            回到探索舱
          </button>
          {/*
            2026-09-12 老大反馈：二号地图（最后一张正式地图）任务结束后，
            KIBO 结束语对话框里**只应该有「回到探索舱」一个按钮**。
            注意「继续任务」= onContinueTask → onNextWorld，是**推进下一张地图的唯一入口**，
            不能整体删掉；改为按 hasNextWorld 分叉——
            二号（无下一张）自然只剩一个按钮，一号（有下一张）保持两个。
            关闭弹窗（✕ / 点遮罩）走 onClose，行为是**留在场景内**，不受影响。
          */}
          {hasNextWorld ? (
            <button type="button" className="mars-kibo-endtalk__secondary" onClick={onContinueTask}>
              继续任务
            </button>
          ) : null}
        </div>
        <p className="mars-kibo-endtalk__hint">设置界面内的退出任务也可以回到探索舱。</p>
      </div>
    </div>
  )
}
