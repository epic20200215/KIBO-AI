import { useEffect } from 'react'
import { primeOnboardingVoice } from '../lib/onboardingVoice'
import { ArrowRight, Clock3, Compass, Play, Sparkles } from 'lucide-react'
import { Brand } from '../components/Brand'
import type { Mission } from '../types/mission'

type MissionBoundaryProps = {
  mission: Mission
  onBack: () => void
  onStart?: () => void
}

export function MissionBoundary({ mission, onBack, onStart }: MissionBoundaryProps) {
  useEffect(() => {
    if (!onStart) return
    const image = new Image()
    image.src = '/assets/missions/mars-simulator-base-v1.webp'
  }, [onStart])

  return (
    <main
      className="mission-boundary"
      style={{ '--mission-accent': mission.accent, '--mission-accent-soft': mission.accentSoft } as React.CSSProperties}
    >
      <img className="mission-boundary__poster" src={mission.poster} alt="" />
      <div className="mission-boundary__shade" />

      <header className="mission-boundary__header">
        <Brand inverse onClick={onBack} />
      </header>

      <section className="mission-boundary__brief" aria-labelledby="brief-title">
        <p><Compass size={17} aria-hidden="true" />任务序章 · {mission.coordinate}</p>
        <h1 id="brief-title">{mission.title}</h1>
        <p className="mission-boundary__summary">{mission.summary}</p>
        <div className="mission-boundary__meta">
          <span><Clock3 size={16} aria-hidden="true" />约 {mission.durationMinutes} 分钟</span>
          <span><Sparkles size={16} aria-hidden="true" />亲手测试与修改</span>
        </div>
        <div className="mission-boundary__nodes">
          {mission.knowledgeNodes.map((node) => <span key={node}>{node}</span>)}
        </div>
        <div className="mission-boundary__actions">
          {onStart && (
            <button
              className="mission-boundary__start"
              type="button"
              onClick={() => {
                // 2026-09-15：这是进入 3D 前的**最后一次用户手势**，在这里预备新手引导
                // 旁白（预建媒体元素 + 预加载），让引导里的 play() 借本次 sticky
                // activation 放行，避免被浏览器自动播放策略拦截而听不到声音。
                primeOnboardingVoice()
                onStart()
              }}
            >
              <Play size={19} aria-hidden="true" />
              开始任务
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          )}
        </div>
      </section>
    </main>
  )
}
