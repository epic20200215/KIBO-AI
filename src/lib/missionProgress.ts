/**
 * 探索舱任务进度本地持久化。
 *
 * 设计原则：
 * - 仅记录简单进度（是否开始、已完成世界数、当前世界），不存运行时状态。
 * - 每个 mission 独立 key，避免不同任务互相污染。
 * - localStorage 不可用时静默降级，不影响游戏运行。
 */

export type MissionProgress = {
  /** 用户是否曾经启动过这个任务。 */
  started: boolean
  /** 已完成的世界数量（如火星任务有 2 张地图，完成第一张后 completedWorlds=1）。 */
  completedWorlds: number
  /** 当前应该进入的世界索引（下一张未完成的地图）。 */
  currentWorld: number
}

const STORAGE_KEY = 'kibo-mission-progress'

/**
 * 各任务的世界数量（火星任务叫「地图」，其它任务可能叫关卡 / 样本 / 航次）。
 *
 * 新增任务时在此登记；未登记的任务按 1 处理。
 * ⚠️ 不要从 `features/<task>/` 里 import 常量来填这里——lib 层不得反向依赖具体任务模块。
 * ⚠️ 这里登记的数量必须与该任务自己的常量一致（火星任务：`MARS_MAP_COUNT`），
 *    两者不一致会让探索舱的「任务完成」判定与任务内部推进对不上，
 *    已由 `missionProgress.test.ts` 的「世界数量登记一致性」用例锁死。
 */
const MISSION_WORLD_COUNT: Record<string, number> = {
  'mars-rover': 2,
}

/** 取指定任务的世界数量；未登记的任务按 1 处理。 */
export function getWorldCount(missionId: string): number {
  return MISSION_WORLD_COUNT[missionId] ?? 1
}

function getKey(missionId: string): string {
  return `${STORAGE_KEY}:${missionId}`
}

export function getDefaultMissionProgress(): MissionProgress {
  return {
    started: false,
    completedWorlds: 0,
    currentWorld: 0,
  }
}

/**
 * 把任意值夹到合法世界索引。
 * 注意：`Number(x) ?? fallback` 是错的——Number() 永不返回 null/undefined，
 * 字段缺失时会得到 NaN 并一路传播成 NaN 索引，导致后续 `worlds[NaN]` 全线崩溃。
 * 所以这里必须用 Number.isFinite 显式判定。
 */
function clampWorld(value: unknown, mapCount: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return Math.max(0, Math.min(mapCount - 1, fallback))
  return Math.max(0, Math.min(mapCount - 1, Math.trunc(n)))
}

/** 读取指定任务的进度；若未记录或解析失败则返回默认值。 */
export function loadMissionProgress(missionId: string, mapCount: number): MissionProgress {
  try {
    const raw = localStorage.getItem(getKey(missionId))
    if (!raw) return getDefaultMissionProgress()
    const parsed = JSON.parse(raw) as Partial<MissionProgress> | null
    if (!parsed || typeof parsed !== 'object') return getDefaultMissionProgress()
    const completedWorlds = Math.max(0, Math.min(mapCount, Number(parsed.completedWorlds) || 0))
    return {
      started: Boolean(parsed.started),
      completedWorlds,
      currentWorld: clampWorld(parsed.currentWorld, mapCount, completedWorlds),
    }
  } catch {
    return getDefaultMissionProgress()
  }
}

/** 写入指定任务的进度。 */
export function saveMissionProgress(missionId: string, progress: Partial<MissionProgress>, mapCount: number): void {
  try {
    const prev = loadMissionProgress(missionId, mapCount)
    const completedWorlds = Math.max(
      0,
      Math.min(mapCount, Number(progress.completedWorlds ?? prev.completedWorlds) || 0),
    )
    const next: MissionProgress = {
      started: progress.started ?? prev.started,
      completedWorlds,
      currentWorld: clampWorld(progress.currentWorld ?? prev.currentWorld, mapCount, completedWorlds),
    }
    localStorage.setItem(getKey(missionId), JSON.stringify(next))
  } catch {
    // localStorage 不可用时静默丢弃。
  }
}

/**
 * 重置指定任务到未开始状态。
 *
 * 直接**移除**记录而不是写入默认值：写入默认值会留下一条永远无法区分「重置过」
 * 与「刚开始」的空记录，也让 `localStorage` 里堆满无意义的空 key。
 * 读取侧 `loadMissionProgress` 在 key 缺失时本就返回默认值，行为完全等价。
 *
 * 不需要 mapCount 参数——重置只是删记录，与这个任务有几张地图无关。
 */
export function resetMissionProgress(missionId: string): void {
  try {
    localStorage.removeItem(getKey(missionId))
    // 2026-09-15 老大反馈：重置任务后应**重新弹出新手引导**，否则重置完既没有引导
    // 说明、也听不到旁白配音，想再测一次都没机会。
    // 引导标记是另一套 key（kibo-mars-onboarded-v1-w{worldIndex}，按地图分开），
    // 必须一并清除。用前缀扫描而不是枚举索引，避免以后加地图时漏删。
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i)
      if (k && k.startsWith('kibo-mars-onboarded-')) stale.push(k)
    }
    for (const k of stale) localStorage.removeItem(k)
  } catch {
    // localStorage 不可用时静默丢弃。
  }
}

/** 标记某个世界已完成，并解锁下一个世界（如果还有）。 */
export function completeMissionWorld(missionId: string, worldIndex: number, mapCount: number): MissionProgress {
  const prev = loadMissionProgress(missionId, mapCount)
  const completedWorlds = Math.max(prev.completedWorlds, worldIndex + 1)
  const currentWorld = Math.min(completedWorlds, mapCount - 1)
  const next: MissionProgress = { ...prev, started: true, completedWorlds, currentWorld }
  try {
    localStorage.setItem(getKey(missionId), JSON.stringify(next))
  } catch {
    // ignore
  }
  return next
}

/** 标记任务已启动（用户点击了「启动任务」或「任务进行中」按钮）。 */
export function startMission(missionId: string, mapCount: number): MissionProgress {
  const prev = loadMissionProgress(missionId, mapCount)
  const next: MissionProgress = { ...prev, started: true }
  saveMissionProgress(missionId, next, mapCount)
  return next
}
