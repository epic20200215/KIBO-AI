import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { CabinPage } from '../pages/CabinPage'
import { HomePage } from '../pages/HomePage'
import { MissionBoundary } from '../pages/MissionBoundary'
// 火星 3D 任务（Three.js 重模块）按需懒加载：进入任务时才拉取独立 chunk，
// 避免 Three.js 被打进首屏主包。首屏仅首页/探索舱，纯 DOM/CSS，体积小、首屏快。
const MarsGame3D = lazy(
  () => import('../features/mars/game3d/MarsGame3D').then((m) => ({ default: m.MarsGame3D })),
)
// 3D 检视页仅开发构建使用、生产永不渲染；懒加载使其不进入生产主包。
const Mars3DDevPage = lazy(
  () => import('../pages/Mars3DDevPage').then((m) => ({ default: m.Mars3DDevPage })),
)
import { getInterfaceReviewMissions } from '../data/missions'
import {
  completeMissionWorld,
  loadMissionProgress,
  startMission,
} from '../lib/missionProgress'
import { MARS_MAP_COUNT } from '../features/mars/game3d/core/heightField'
import type { Mission } from '../types/mission'

type View = 'home' | 'cabin' | 'mission' | 'mars' | 'mars3d-dev'

/** 3D 检视页只在开发构建里存在，生产环境访问该 hash 会落回首页。 */
function isMars3DDevHash(): boolean {
  return import.meta.env.DEV && window.location.hash.startsWith('#dev/mars3d')
}

function getInitialView(): View {
  if (isMars3DDevHash()) return 'mars3d-dev'
  if (window.location.hash.startsWith('#mission/mars-rover')) return 'mars'
  return window.location.hash.startsWith('#explore') ? 'cabin' : 'home'
}

export function App() {
  // 下一版本起：探索舱展示全部五个任务介绍，仅 released 任务可进入体验，
  // 其余任务在 CabinPage 显示「敬请期待」（不再按 released 过滤隐藏）。
  const catalog = useMemo(() => getInterfaceReviewMissions(), [])
  const [view, setView] = useState<View>(getInitialView)
  const [selectedMission, setSelectedMission] = useState<Mission>(catalog[0])
  // 火星任务当前应进入的地图索引，从本地进度读取；完成一号地图后自动进入二号。
  const [marsWorldIndex, setMarsWorldIndex] = useState(() =>
    loadMissionProgress('mars-rover', MARS_MAP_COUNT).currentWorld,
  )

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const syncMotionPreference = () => {
      document.documentElement.dataset.motion = preference.matches ? 'reduced' : 'full'
    }
    syncMotionPreference()
    preference.addEventListener('change', syncMotionPreference)
    return () => preference.removeEventListener('change', syncMotionPreference)
  }, [])

  useEffect(() => {
    const syncFromLocation = () => {
      if (isMars3DDevHash()) {
        setView('mars3d-dev')
      } else if (window.location.hash.startsWith('#mission/mars-rover')) {
        setView('mars')
      } else if (!window.location.hash.startsWith('#explore')) {
        setView('home')
      } else if (view !== 'mission' && view !== 'mars') {
        setView('cabin')
      }
    }

    window.addEventListener('popstate', syncFromLocation)
    return () => window.removeEventListener('popstate', syncFromLocation)
  }, [view])

  const enterCabin = () => {
    window.history.pushState({ view: 'cabin' }, '', '#explore')
    setView('cabin')
    window.scrollTo({ top: 0 })
  }

  const returnHome = () => {
    window.history.pushState({ view: 'home' }, '', window.location.pathname)
    setView('home')
    window.scrollTo({ top: 0 })
  }

  const openMission = (mission: Mission) => {
    setSelectedMission(mission)
    setView('mission')
  }

  const startMarsMission = () => {
    // 标记任务已启动，并读取当前应进入的地图（完成一号后进二号）。
    const progress = startMission('mars-rover', MARS_MAP_COUNT)
    setMarsWorldIndex(progress.currentWorld)
    window.history.pushState({ view: 'mars' }, '', '#mission/mars-rover')
    setView('mars')
  }

  const returnToCabin = () => {
    window.history.pushState({ view: 'cabin' }, '', '#explore')
    setView('cabin')
  }

  return (
    <>
      {view === 'home' && (
        <HomePage onEnterComplete={enterCabin} />
      )}
      {view === 'cabin' && (
        <CabinPage
          catalog={catalog}
          initialMissionId={selectedMission.id}
          onHome={returnHome}
          onMissionSelected={setSelectedMission}
          onLaunchComplete={openMission}
        />
      )}
      {view === 'mission' && (
        <MissionBoundary
          mission={selectedMission}
          onBack={returnToCabin}
          onStart={selectedMission.id === 'mars-rover' ? startMarsMission : undefined}
        />
      )}
      {view === 'mars' && (
        <Suspense fallback={<MissionLoading label="火星任务加载中…" />}>
        <MarsGame3D
          showHud
          worldIndex={marsWorldIndex}
          onExit={returnToCabin}
          onWorldComplete={(worldIndex) => {
            // 2026-09-03 v1.3.4 老大反馈：成功后必须走 KIBO 对话环节，
            // **不能**立即推进 marsWorldIndex——那会让 stage useEffect 重建舞台，
            // 自动触发二号地图的 playIntroFlyover()，跳过了与 KIBO 的结算对白。
            //
            // 正确流程：
            //   1) 成功后 onWorldComplete 仅持久化 localStorage（completedWorlds/currentWorld），
            //      MarsGame3D 内部 worldIndex 仍停在当前地图；
            //   2) 玩家开车回基地，点 KIBO 头顶"!"弹 KiboEndTalk；
            //   3) 点击"继续任务"才走 handleContinueTask → onNextWorld → setMarsWorldIndex(next)，
            //      此时才推进并播放二号地图的开局运镜；
            //   4) 点"回到探索舱"则退出任务——探索舱按钮显示"任务进行中"，
            //      下次点入通过 localStorage.currentWorld 直接进入二号地图。
            completeMissionWorld('mars-rover', worldIndex, MARS_MAP_COUNT)
            // 不再 setMarsWorldIndex(next.currentWorld)
          }}
          onNextWorld={(next) => setMarsWorldIndex(next)}
        />
        </Suspense>
      )}
      {view === 'mars3d-dev' && (
        <Suspense fallback={<MissionLoading label="开发检视页加载中…" />}>
          {/* 2026-09-12 老大反馈：「回到探索舱」点了却回首页。根因：dev 检视页此前绑的是
              returnHome（回首页），而老大正是在 dev 页验收。改绑 returnToCabin（#explore）。 */}
          <Mars3DDevPage onExit={returnToCabin} />
        </Suspense>
      )}
    </>
  )
}

/**
 * 火星 3D 任务（及开发检视页）走 React.lazy 动态加载，区块到达前显示此兜底。
 * 必须是有意义的加载态而非白屏——否则导航到任务会出现视觉断裂，违背「不影响用户体验」。
 */
function MissionLoading({ label }: { label: string }) {
  return (
    <div className="mission-loading" role="status" aria-live="polite">
      <div className="mission-loading__ring" aria-hidden="true" />
      <p className="mission-loading__label">{label}</p>
    </div>
  )
}
