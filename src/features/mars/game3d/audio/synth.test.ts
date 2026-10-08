import { AUDIO_PREF_KEY, createSynth } from './synth'

/**
 * 用最小的假 AudioContext 验证"什么时候该创建、什么时候该发声"。
 * 这里不测音色，只测契约：
 * - 默认关闭，且关闭时绝不创建 AudioContext
 * - 打开后才懒加载，并且偏好写进 localStorage
 * - 环境不支持 Web Audio 时全链路静默不抛错
 */

class FakeParam {
  value = 0
  setValueAtTime = vi.fn(() => this)
  linearRampToValueAtTime = vi.fn(() => this)
  exponentialRampToValueAtTime = vi.fn(() => this)
  setTargetAtTime = vi.fn(() => this)
}

function makeNode() {
  return {
    gain: new FakeParam(),
    frequency: new FakeParam(),
    Q: new FakeParam(),
    type: '',
    buffer: null as unknown,
    loop: false,
    onended: null as null | (() => void),
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  }
}

let created = 0
let oscillators = 0

class FakeAudioContext {
  state = 'running'
  currentTime = 0
  sampleRate = 48000
  destination = {}
  constructor() {
    created += 1
  }
  createGain = () => makeNode()
  createBiquadFilter = () => makeNode()
  createOscillator = () => {
    oscillators += 1
    return makeNode()
  }
  createBufferSource = () => makeNode()
  createBuffer = (_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) })
  resume = vi.fn(async () => {})
  suspend = vi.fn(async () => {})
  close = vi.fn(async () => {})
}

const w = window as unknown as { AudioContext?: unknown }

beforeEach(() => {
  created = 0
  oscillators = 0
  window.localStorage.clear()
})

afterEach(() => {
  delete w.AudioContext
})

describe('mars 3d synth', () => {
  it('没有 Web Audio 时全链路静默且不抛错', () => {
    delete w.AudioContext
    const s = createSynth()
    expect(s.isEnabled()).toBe(false)
    expect(() => {
      s.setEnabled(true)
      s.playScan()
      s.setEngine(1, 1)
      s.playStuck()
      s.playArrive()
      s.playClick()
      s.playKibo()
      s.resume()
      s.setPageVisible(false)
      s.dispose()
    }).not.toThrow()
    // 环境不支持时 setEnabled 不应把状态置为 true，避免 UI 显示"已开"却没声音
    expect(s.isEnabled()).toBe(false)
  })

  it('默认关闭，且关闭状态下不创建 AudioContext', () => {
    w.AudioContext = FakeAudioContext
    const s = createSynth()
    expect(s.isEnabled()).toBe(false)
    s.playScan()
    s.playStuck()
    s.setEngine(1, 1)
    expect(created).toBe(0)
    s.dispose()
  })

  it('打开后才懒创建 AudioContext，并写入偏好', () => {
    w.AudioContext = FakeAudioContext
    const s = createSynth()
    s.setEnabled(true)
    expect(created).toBe(1)
    expect(s.isEnabled()).toBe(true)
    expect(window.localStorage.getItem(AUDIO_PREF_KEY)).toBe('true')
    s.dispose()
  })

  it('复用已保存的偏好：上次开着，这次构造即为开启', () => {
    w.AudioContext = FakeAudioContext
    window.localStorage.setItem(AUDIO_PREF_KEY, 'true')
    const s = createSynth()
    expect(s.isEnabled()).toBe(true)
    // 仍然懒加载：没播任何声音前不建上下文
    expect(created).toBe(0)
    s.playScan()
    expect(created).toBe(1)
    s.dispose()
  })

  it('开启后各音效都会真正生成振荡器', () => {
    w.AudioContext = FakeAudioContext
    const s = createSynth()
    s.setEnabled(true)
    const base = oscillators
    s.playScan()
    s.playStuck()
    s.playArrive()
    s.playKibo()
    s.playClick()
    // scan1 + stuck2 + arrive3 + kibo1 + click1 = 8
    expect(oscillators - base).toBe(8)
    s.dispose()
  })

  it('关闭声音后不再生成新音源，并把偏好写回 false', () => {
    w.AudioContext = FakeAudioContext
    const s = createSynth()
    s.setEnabled(true)
    const afterOpen = oscillators
    s.setEnabled(false)
    expect(window.localStorage.getItem(AUDIO_PREF_KEY)).toBe('false')
    const afterClose = oscillators
    s.playScan()
    s.playStuck()
    expect(oscillators).toBe(afterClose)
    expect(afterOpen).toBeGreaterThan(0)
    s.dispose()
  })
})
