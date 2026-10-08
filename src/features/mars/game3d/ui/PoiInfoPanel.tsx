/**
 * POI 说明面板（需求 E③）：点击场景里的 UI 标记（光柱信标）时弹出，
 * 说明"这个地点是干什么的"——把该 POI 在 AI-PBL 闭环里的角色讲清楚。
 *
 * 玻璃态居中卡片，与现有 OperationConsole 视觉一致；关闭方式：✕ / 点背景 / ESC。
 */
import { useEffect } from 'react'
import type { Poi } from '../core/mission'
import { POI_COLOR } from '../render/pois'

export type PoiInfoPanelProps = {
  poi: Poi
  onClose: () => void
}

export function PoiInfoPanel({ poi, onClose }: PoiInfoPanelProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const color = POI_COLOR[poi.kind] ?? '#ffffff'

  return (
    <div className="mars-poi-info" role="dialog" aria-modal="true" aria-label={`${poi.label} 说明`}>
      <div className="mars-poi-info__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="mars-poi-info__card" style={{ ['--info-accent' as any]: color }}>
        <header className="mars-poi-info__header">
          <span className="mars-poi-info__dot" style={{ background: color }} aria-hidden="true" />
          <h2 className="mars-poi-info__title">{poi.label}</h2>
          <button type="button" className="mars-poi-info__close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </header>
        <div className="mars-poi-info__body">
          <p className="mars-poi-info__desc">{poi.description}</p>
        </div>
      </div>
    </div>
  )
}
