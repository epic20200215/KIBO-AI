/**
 * KIBO 对话面板（需求 E③）：点击场景里的 KIBO NPC 时弹出，
 * 展示 KIBO 的 2D 形象 + 当前任务阶段的教学对白（kiboLineFor 按阶段生成）。
 * 对白解释"现在处于什么阶段、该怎么把任务推进下去"，与 KIBO 引导机器人定位一致。
 *
 * 玻璃态居中卡片；2D 形象按对白情绪切换（alert / celebrate 用对应表情图）。
 * 关闭方式：✕ / 点背景 / ESC。
 */
import { useEffect } from 'react'
import type { MissionSnapshot } from '../core/mission'
import { kiboLineFor } from '../kiboLines'

/** KIBO 2D 形象按情绪切换（素材在 public/assets/kibo/）。 */
const MOOD_IMAGE: Record<string, string> = {
  guide: '/assets/kibo/kibo-welcome.webp',
  idle: '/assets/kibo/kibo-welcome.webp',
  alert: '/assets/kibo/kibo-mission-alert-v1.webp',
  celebrate: '/assets/kibo/kibo-mission-celebrate-v1.webp',
}

export type KiboDialogueProps = {
  snapshot: MissionSnapshot
  onClose: () => void
}

export function KiboDialogue({ snapshot, onClose }: KiboDialogueProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const line = kiboLineFor(snapshot)
  const img = MOOD_IMAGE[line.mood] ?? MOOD_IMAGE.idle

  return (
    <div className="mars-kibo-dialog" role="dialog" aria-modal="true" aria-label="KIBO 对话">
      <div className="mars-kibo-dialog__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="mars-kibo-dialog__card">
        <button type="button" className="mars-kibo-dialog__close" onClick={onClose} aria-label="关闭">
          ✕
        </button>
        <div className="mars-kibo-dialog__avatar">
          <img src={img} alt="KIBO" width={168} height={168} />
        </div>
        <div className="mars-kibo-dialog__text">
          <p className="mars-kibo-dialog__name">KIBO</p>
          <p className="mars-kibo-dialog__line">{line.text}</p>
        </div>
      </div>
    </div>
  )
}
