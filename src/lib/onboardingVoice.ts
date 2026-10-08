/**
 * 新手引导旁白配音（KIBO 原声，2026-09-15 老大提供）。
 *
 * 为什么独立成 lib 模块（而不是写在 Onboarding.tsx 里）：
 * 探索舱（CabinPage，首屏包）需要在用户点「启动任务」时**预备音频**，
 * 若从 game3d 目录 import，会把 Three.js 整个懒加载块拖进首屏，首屏拆包就白做了。
 * 本模块是纯 DOM 逻辑，零 3D 依赖，首屏引用安全。
 *
 * 自动播放策略处理（老大 2026-09-15 反馈"没听到声音"）：
 *  Chrome 要求**有声媒体必须在用户手势（user activation）之后**才能播放。
 *  学生正常流程是「首页 → 点进入探索舱 → 点启动任务 → 进 3D」，点按钮产生的
 *  sticky activation 在同一文档内持续有效，因此引导里的 play() 会放行。
 *  但若直接打开 `#mission/mars-rover`（无前置交互）就会被拒——
 *  此时**不能静默失败**（静默 = 用户完全不知道有旁白），必须让 UI 显示兜底按钮。
 */

const VOICE_SRC = '/assets/kibo/voice-onboarding.mp3'

let voice: HTMLAudioElement | null = null

function getVoice(): HTMLAudioElement | null {
  if (typeof window === 'undefined') return null
  if (!voice) {
    try {
      voice = new Audio(VOICE_SRC)
      voice.preload = 'auto'
      voice.volume = 0.95
      // 暴露给 QA 工装：音频不在 DOM 里，否则查不到播放状态
      ;(window as unknown as { __kiboOnboardingVoice?: HTMLAudioElement }).__kiboOnboardingVoice =
        voice
    } catch {
      return null
    }
  }
  return voice
}

/**
 * 在**用户手势中**调用（探索舱点「启动任务」）：创建并预加载音频，不播放。
 * 目的有二：① 提前建好媒体元素，避免进入 3D 后首次播放有加载延迟；
 * ② 借这次用户交互让浏览器认可后续播放（sticky activation）。
 */
export function primeOnboardingVoice(): void {
  const a = getVoice()
  if (!a) return
  try {
    a.load()
  } catch {
    /* 预加载失败不影响后续 play 重试 */
  }
}

/**
 * 播放旁白。
 * @returns 是否成功启动播放；被浏览器自动播放策略拦截时 resolve **false**，
 *          由调用方（Onboarding）显示「播放旁白」兜底按钮——绝不静默失败。
 */
export function playOnboardingVoice(): Promise<boolean> {
  const a = getVoice()
  if (!a) return Promise.resolve(false)
  try {
    a.currentTime = 0
    return a.play().then(
      () => true,
      () => false,
    )
  } catch {
    return Promise.resolve(false)
  }
}

/** 旁白当前是否在播（QA 与 UI 用）。 */
export function isOnboardingVoicePlaying(): boolean {
  return !!voice && !voice.paused && !voice.ended
}
