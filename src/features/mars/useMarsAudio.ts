import { useEffect, useRef, useState } from 'react'

export type MarsAudioCue = 'scan' | 'select' | 'radio' | 'step' | 'route' | 'rover' | 'compare' | 'reveal' | 'warning' | 'complete'

const AUDIO_KEY = 'kibo:mars:audio-enabled'

const cueSettings: Record<MarsAudioCue, { frequency: number; end: number; duration: number; type: OscillatorType; gain: number; harmonic?: number }> = {
  scan: { frequency: 540, end: 780, duration: .18, type: 'sine', gain: .038, harmonic: 1.5 },
  select: { frequency: 310, end: 370, duration: .09, type: 'triangle', gain: .032 },
  radio: { frequency: 820, end: 390, duration: .28, type: 'sawtooth', gain: .027, harmonic: .5 },
  step: { frequency: 98, end: 68, duration: .11, type: 'triangle', gain: .025 },
  route: { frequency: 225, end: 520, duration: .36, type: 'sine', gain: .04, harmonic: 2 },
  rover: { frequency: 128, end: 162, duration: .12, type: 'square', gain: .018 },
  compare: { frequency: 390, end: 325, duration: .29, type: 'triangle', gain: .036, harmonic: 1.5 },
  reveal: { frequency: 260, end: 660, duration: .44, type: 'sine', gain: .043, harmonic: 2 },
  warning: { frequency: 188, end: 158, duration: .24, type: 'sawtooth', gain: .027, harmonic: .5 },
  complete: { frequency: 330, end: 528, duration: .56, type: 'sine', gain: .044, harmonic: 1.5 },
}

function readSavedPreference() {
  try {
    return window.localStorage.getItem(AUDIO_KEY) === 'true'
  } catch {
    return false
  }
}

function playCue(context: AudioContext, cue: MarsAudioCue) {
  const setting = cueSettings[cue]
  const now = context.currentTime
  const master = context.createGain()
  master.gain.setValueAtTime(.0001, now)
  master.gain.exponentialRampToValueAtTime(setting.gain, now + .018)
  master.gain.exponentialRampToValueAtTime(.0001, now + setting.duration)
  master.connect(context.destination)

  const connectOscillator = (frequencyScale: number, gainScale: number) => {
    const oscillator = context.createOscillator()
    const voiceGain = context.createGain()
    oscillator.type = setting.type
    oscillator.frequency.setValueAtTime(setting.frequency * frequencyScale, now)
    oscillator.frequency.exponentialRampToValueAtTime(setting.end * frequencyScale, now + setting.duration)
    voiceGain.gain.value = gainScale
    oscillator.connect(voiceGain).connect(master)
    oscillator.start(now)
    oscillator.stop(now + setting.duration + .03)
  }

  connectOscillator(1, 1)
  if (setting.harmonic) connectOscillator(setting.harmonic, .24)
}

export function useMarsAudio() {
  const [enabled, setEnabled] = useState(readSavedPreference)
  const contextRef = useRef<AudioContext | null>(null)
  const ambienceRef = useRef<{ source: AudioBufferSourceNode; gain: GainNode } | null>(null)

  const ensureContext = async () => {
    if (!contextRef.current) contextRef.current = new window.AudioContext()
    if (contextRef.current.state === 'suspended') await contextRef.current.resume()
    return contextRef.current
  }

  const stopAmbience = () => {
    const ambience = ambienceRef.current
    if (!ambience) return
    const now = contextRef.current?.currentTime ?? 0
    ambience.gain.gain.setTargetAtTime(0, now, .08)
    window.setTimeout(() => {
      try { ambience.source.stop() } catch { /* The source may already be stopped during cleanup. */ }
    }, 220)
    ambienceRef.current = null
  }

  const startAmbience = async () => {
    if (ambienceRef.current) return
    const context = await ensureContext()
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate)
    const data = buffer.getChannelData(0)
    let seed = 8731
    for (let index = 0; index < data.length; index += 1) {
      seed = (seed * 48271) % 2147483647
      data[index] = ((seed / 2147483647) * 2 - 1) * .18
    }
    const source = context.createBufferSource()
    const filter = context.createBiquadFilter()
    const gain = context.createGain()
    source.buffer = buffer
    source.loop = true
    filter.type = 'lowpass'
    filter.frequency.value = 165
    gain.gain.value = .011
    source.connect(filter).connect(gain).connect(context.destination)
    source.start()
    ambienceRef.current = { source, gain }
  }

  const play = async (cue: MarsAudioCue) => {
    if (!enabled) return
    const context = await ensureContext()
    await startAmbience()
    playCue(context, cue)
  }

  const toggle = async () => {
    const next = !enabled
    setEnabled(next)
    try {
      window.localStorage.setItem(AUDIO_KEY, String(next))
    } catch {
      // The task remains fully usable when storage is unavailable.
    }
    if (next) {
      const context = await ensureContext()
      await startAmbience()
      playCue(context, 'select')
    } else {
      stopAmbience()
    }
  }

  useEffect(() => {
    const syncVisibility = () => {
      if (!contextRef.current) return
      if (document.hidden) {
        void contextRef.current.suspend()
      } else if (enabled) {
        void contextRef.current.resume()
      }
    }
    document.addEventListener('visibilitychange', syncVisibility)
    return () => document.removeEventListener('visibilitychange', syncVisibility)
  }, [enabled])

  useEffect(() => () => {
    stopAmbience()
    void contextRef.current?.close()
  }, [])

  return { enabled, play, toggle }
}
