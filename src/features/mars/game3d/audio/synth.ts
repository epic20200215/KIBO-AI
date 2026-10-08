/**
 * 3D 火星任务的程序化音效合成器（M7-c）。
 *
 * 设计约束：
 * 1. 不引入任何外部音频文件。全部用 OscillatorNode / GainNode / BiquadFilterNode
 *    实时合成，包体不增加一个字节。
 * 2. **默认关闭**。教学场景里学生可能在教室、图书馆，声音必须是主动打开的。
 *    开关状态持久化到 localStorage key `kibo:mars:audio-enabled`，
 *    与早期实现共用同一 key，保证用户静音设置不丢。
 * 3. **懒加载**。未打开声音前不创建 AudioContext，避免 Chrome 在控制台打印
 *    "The AudioContext was not allowed to start"，也避免无声占用音频硬件。
 * 4. 音效语义化，每个声音对应一条教学信息：
 *    - scan  上升啁啾：一次探测发出去了，覆盖率在涨
 *    - engine 低频噪声：R-7 正在实地跑，音量随车速
 *    - stuck  低频撞击 + 金属碎片：翻车，这是"AI 猜错"的代价
 *    - arrive 三音上行：到达终点
 *    - kibo   友好双音：KIBO 有话说（阶段切换）
 *    - click  短促滴音：UI 反馈
 *
 * 唯一使用 Math.random 的地方是发动机噪声缓冲。它不参与任何模拟，
 * 不影响任何可复现结果，与 core/rng.ts 的确定性约束不冲突。
 */

export const AUDIO_PREF_KEY = 'kibo:mars:audio-enabled'

export type Synth = {
  /** 打开/关闭声音。打开时会懒创建 AudioContext 并写入偏好。 */
  setEnabled: (on: boolean) => void
  /** 当前是否开启 */
  isEnabled: () => boolean
  /** 用户手势后调用，解锁被浏览器挂起的音频上下文 */
  resume: () => void
  /** 播放一次扫描波 */
  playScan: () => void
  /** 设置发动机音量（0..1）与音色强度（0..1）。0 会平滑淡出。 */
  setEngine: (volume: number, intensity: number) => void
  /** 播放翻车撞击 */
  playStuck: () => void
  /** 播放到达终点 */
  playArrive: () => void
  /** 播放 UI 点击 */
  playClick: () => void
  /** 播放 KIBO 提示音 */
  playKibo: () => void
  /** 页面隐藏时挂起，回来时恢复 */
  setPageVisible: (visible: boolean) => void
  dispose: () => void
}

type Graph = {
  ctx: AudioContext
  master: GainNode
  engineGain: GainNode
  engineFilter: BiquadFilterNode
  engineOsc: OscillatorNode
  noiseGain: GainNode
  noiseFilter: BiquadFilterNode
  noiseSrc: AudioBufferSourceNode
}

function readPreference(): boolean {
  try {
    return window.localStorage.getItem(AUDIO_PREF_KEY) === 'true'
  } catch {
    return false
  }
}

function writePreference(on: boolean) {
  try {
    window.localStorage.setItem(AUDIO_PREF_KEY, String(on))
  } catch {
    // 无痕模式下写不进去也不影响任务本身
  }
}

function getAudioCtor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined
  const w = window as unknown as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  return w.AudioContext ?? w.webkitAudioContext
}

export function createSynth(): Synth {
  const Ctor = getAudioCtor()
  let enabled = Boolean(Ctor) && readPreference()
  let graph: Graph | null = null
  let disposed = false

  /** 懒创建音频图。返回 null 表示环境不支持（jsdom / 老浏览器），全链路降级为静默。 */
  const ensure = (): Graph | null => {
    if (disposed || !Ctor) return null
    if (graph) return graph

    const ctx = new Ctor()

    const master = ctx.createGain()
    master.gain.value = 0.5
    master.connect(ctx.destination)

    // --- 发动机：锯齿基频 + 低通，模拟电机的闷响
    const engineGain = ctx.createGain()
    engineGain.gain.value = 0
    const engineFilter = ctx.createBiquadFilter()
    engineFilter.type = 'lowpass'
    engineFilter.frequency.value = 180
    const engineOsc = ctx.createOscillator()
    engineOsc.type = 'sawtooth'
    engineOsc.frequency.value = 55
    engineOsc.connect(engineFilter)
    engineFilter.connect(engineGain)
    engineGain.connect(master)
    engineOsc.start()

    // --- 车轮碾沙：带通噪声层
    const len = Math.floor(ctx.sampleRate * 2)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    // 这里的随机只做音色，不参与任何模拟与可复现结果
    for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1
    const noiseSrc = ctx.createBufferSource()
    noiseSrc.buffer = buf
    noiseSrc.loop = true
    const noiseGain = ctx.createGain()
    noiseGain.gain.value = 0
    const noiseFilter = ctx.createBiquadFilter()
    noiseFilter.type = 'bandpass'
    noiseFilter.frequency.value = 120
    noiseFilter.Q.value = 0.8
    noiseSrc.connect(noiseFilter)
    noiseFilter.connect(noiseGain)
    noiseGain.connect(master)
    noiseSrc.start()

    graph = { ctx, master, engineGain, engineFilter, engineOsc, noiseGain, noiseFilter, noiseSrc }
    return graph
  }

  /** 取活跃音频图。关闭状态直接返回 null，所有播放函数因此变成 no-op。 */
  const live = (): Graph | null => {
    if (!enabled) return null
    const g = ensure()
    if (!g) return null
    if (g.ctx.state === 'suspended') void g.ctx.resume()
    return g
  }

  /** 一次性音源的通用尾部处理：播完自动断开，避免节点泄漏 */
  const autoRelease = (node: AudioScheduledSourceNode, gain: GainNode, stopAt: number) => {
    node.stop(stopAt)
    node.onended = () => {
      try {
        node.disconnect()
        gain.disconnect()
      } catch {
        // 已断开
      }
    }
  }

  const playScan = () => {
    const g = live()
    if (!g) return
    const { ctx, master } = g
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(220, t)
    osc.frequency.exponentialRampToValueAtTime(880, t + 0.35)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.linearRampToValueAtTime(0.3, t + 0.08)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55)
    osc.connect(gain)
    gain.connect(master)
    osc.start(t)
    autoRelease(osc, gain, t + 0.6)
  }

  const setEngine = (volume: number, intensity: number) => {
    // 注意：关闭声音时也要把发动机推到 0，否则重新打开会突然轰一声
    const g = enabled ? live() : graph
    if (!g) return
    const v = Math.min(1, Math.max(0, enabled ? volume : 0))
    const i = Math.min(1, Math.max(0, intensity))
    const t = g.ctx.currentTime
    g.engineGain.gain.setTargetAtTime(v * 0.2, t, 0.09)
    g.noiseGain.gain.setTargetAtTime(v * 0.14, t, 0.09)
    g.engineFilter.frequency.setTargetAtTime(180 + i * 260, t, 0.12)
    g.engineOsc.frequency.setTargetAtTime(55 + i * 32, t, 0.12)
    g.noiseFilter.frequency.setTargetAtTime(120 + i * 180, t, 0.12)
  }

  const playStuck = () => {
    const g = live()
    if (!g) return
    const { ctx, master } = g
    const t = ctx.currentTime
    // 底盘砸地：方波下滑
    const hit = ctx.createOscillator()
    hit.type = 'square'
    hit.frequency.setValueAtTime(90, t)
    hit.frequency.exponentialRampToValueAtTime(30, t + 0.18)
    const hitGain = ctx.createGain()
    hitGain.gain.setValueAtTime(0.42, t)
    hitGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28)
    hit.connect(hitGain)
    hitGain.connect(master)
    hit.start(t)
    autoRelease(hit, hitGain, t + 0.32)
    // 金属件相撞：高频锯齿快速衰减
    const metal = ctx.createOscillator()
    metal.type = 'sawtooth'
    metal.frequency.setValueAtTime(1180, t)
    metal.frequency.exponentialRampToValueAtTime(210, t + 0.35)
    const metalGain = ctx.createGain()
    metalGain.gain.setValueAtTime(0.1, t)
    metalGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.4)
    metal.connect(metalGain)
    metalGain.connect(master)
    metal.start(t)
    autoRelease(metal, metalGain, t + 0.45)
  }

  const playArrive = () => {
    const g = live()
    if (!g) return
    const { ctx, master } = g
    const t0 = ctx.currentTime
    // 三音上行，不做欢庆式音效——任务强调"这次成立不代表每次都成立"
    const notes = [523.25, 659.25, 783.99]
    notes.forEach((f, k) => {
      const t = t0 + k * 0.12
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(f, t)
      const gain = ctx.createGain()
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.linearRampToValueAtTime(0.18, t + 0.03)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.42)
      osc.connect(gain)
      gain.connect(master)
      osc.start(t)
      autoRelease(osc, gain, t + 0.46)
    })
  }

  const playClick = () => {
    const g = live()
    if (!g) return
    const { ctx, master } = g
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(1180, t)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.16, t)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08)
    osc.connect(gain)
    gain.connect(master)
    osc.start(t)
    autoRelease(osc, gain, t + 0.1)
  }

  const playKibo = () => {
    const g = live()
    if (!g) return
    const { ctx, master } = g
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(660, t)
    osc.frequency.setValueAtTime(880, t + 0.12)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.linearRampToValueAtTime(0.2, t + 0.04)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35)
    osc.connect(gain)
    gain.connect(master)
    osc.start(t)
    autoRelease(osc, gain, t + 0.4)
  }

  const setEnabled = (on: boolean) => {
    if (enabled === on) return
    enabled = on && Boolean(Ctor)
    writePreference(enabled)
    if (enabled) {
      const g = ensure()
      if (g && g.ctx.state === 'suspended') void g.ctx.resume()
      playClick()
    } else if (graph) {
      // 立刻掐掉持续音，一次性音效自然衰减完即止
      const t = graph.ctx.currentTime
      graph.engineGain.gain.setTargetAtTime(0, t, 0.04)
      graph.noiseGain.gain.setTargetAtTime(0, t, 0.04)
    }
  }

  return {
    setEnabled,
    isEnabled: () => enabled,
    resume: () => {
      const g = live()
      if (g && g.ctx.state === 'suspended') void g.ctx.resume()
    },
    playScan,
    setEngine,
    playStuck,
    playArrive,
    playClick,
    playKibo,
    setPageVisible: (visible: boolean) => {
      if (!graph) return
      if (!visible) void graph.ctx.suspend()
      else if (enabled) void graph.ctx.resume()
    },
    dispose: () => {
      disposed = true
      if (!graph) return
      try {
        graph.engineOsc.stop()
        graph.noiseSrc.stop()
      } catch {
        // 可能已停止
      }
      void graph.ctx.close()
      graph = null
    },
  }
}
