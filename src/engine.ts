import { BAND_CENTERS, BAND_Q, type PhonemeConfig, type TransientConfig } from './phonemes'

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export interface VoderFrame {
  voiced: boolean
  noise: number
  pitchHz: number
  bands: number[]
}

export class VoderEngine {
  ctx: AudioContext | null = null
  private master: GainNode | null = null
  private osc: OscillatorNode | null = null
  private oscGain: GainNode | null = null
  private noiseGain: GainNode | null = null
  private noiseNode: AudioBufferSourceNode | null = null
  private bandGains: GainNode[] = []
  private jitterTimer: ReturnType<typeof setInterval> | null = null
  private _started = false
  private _currentPitch = 120
  private _currentVoiced = true

  // UI reads these to get/set values
  pitchValue = 120
  masterValue = 0.18
  jitterValue = 1.2

  get started(): boolean {
    return this._started
  }

  async start(): Promise<void> {
    if (this._started) return
    this.ctx = new AudioContext()
    this.master = this.ctx.createGain()
    this.master.gain.value = this.masterValue
    this.master.connect(this.ctx.destination)

    // Buzz source: sawtooth through low-pass tilt
    // TODO: Replace with AudioWorklet pulse train for more authentic
    // relaxation-oscillator character (~0.3ms charge, ~0.8ms discharge)
    this.osc = this.ctx.createOscillator()
    this.osc.type = 'sawtooth'
    this.osc.frequency.value = this.pitchValue

    const oscTilt = this.ctx.createBiquadFilter()
    oscTilt.type = 'lowpass'
    oscTilt.frequency.value = 2200
    oscTilt.Q.value = 0.3

    this.oscGain = this.ctx.createGain()
    this.oscGain.gain.value = 0.08

    this.osc.connect(oscTilt)
    oscTilt.connect(this.oscGain)

    // Noise source: full-spectrum white noise (no high-pass — the real
    // Voder fed broadband noise into the filter bank)
    this.noiseNode = this._createNoiseSource()
    this.noiseGain = this.ctx.createGain()
    this.noiseGain.gain.value = 0.0

    this.noiseNode.connect(this.noiseGain)

    // 10-band filter bank with patent-accurate Q values
    for (let i = 0; i < BAND_CENTERS.length; i++) {
      const filter = this.ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = BAND_CENTERS[i]
      filter.Q.value = BAND_Q[i]

      const gain = this.ctx.createGain()
      gain.gain.value = 0

      this.oscGain.connect(filter)
      this.noiseGain.connect(filter)
      filter.connect(gain)
      gain.connect(this.master)
      this.bandGains.push(gain)
    }

    this.osc.start()
    this.noiseNode.start()
    this._started = true
    this._startJitter()
  }

  private _createNoiseSource(): AudioBufferSourceNode {
    const buffer = this.ctx!.createBuffer(1, this.ctx!.sampleRate * 2, this.ctx!.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1
    }
    const src = this.ctx!.createBufferSource()
    src.buffer = buffer
    src.loop = true
    return src
  }

  stop(): void {
    if (!this._started) return
    if (this.jitterTimer != null) clearInterval(this.jitterTimer)
    try { this.osc?.stop() } catch (_) { /* already stopped */ }
    try { this.noiseNode?.stop() } catch (_) { /* already stopped */ }
    try { this.ctx?.close() } catch (_) { /* already closed */ }
    this.ctx = null
    this._started = false
    this.bandGains = []
  }

  private _startJitter(): void {
    this.jitterTimer = setInterval(() => {
      if (!this._started || !this._currentVoiced || !this.osc) return
      const base = this._currentPitch
      const target = base + (Math.random() * 2 - 1) * this.jitterValue
      const t = this.ctx!.currentTime
      this.osc.frequency.cancelScheduledValues(t)
      this.osc.frequency.linearRampToValueAtTime(target, t + 0.03)
    }, 35)
  }

  setMaster(v: number): void {
    this.masterValue = v
    if (!this._started || !this.master) return
    this.master.gain.setTargetAtTime(v, this.ctx!.currentTime, 0.015)
  }

  applyFrame(frame: VoderFrame, transitionMs = 35): void {
    if (!this._started || !this.ctx) return
    const now = this.ctx.currentTime
    const sec = Math.max(transitionMs / 1000, 0.005)

    const voicedAmp = frame.voiced ? 0.08 : 0.0
    const noiseAmp = frame.noise ?? 0.0
    this._currentVoiced = frame.voiced
    this._currentPitch = frame.pitchHz

    this.oscGain!.gain.cancelScheduledValues(now)
    this.noiseGain!.gain.cancelScheduledValues(now)
    this.osc!.frequency.cancelScheduledValues(now)

    this.oscGain!.gain.linearRampToValueAtTime(voicedAmp, now + sec)
    this.noiseGain!.gain.linearRampToValueAtTime(noiseAmp * 0.07, now + sec)
    this.osc!.frequency.linearRampToValueAtTime(this._currentPitch, now + sec)

    const bands = frame.bands || []
    for (let i = 0; i < this.bandGains.length; i++) {
      const v = clamp((bands[i] || 0) * 0.9, 0, 1.2)
      this.bandGains[i].gain.cancelScheduledValues(now)
      this.bandGains[i].gain.linearRampToValueAtTime(v, now + sec)
    }
  }

  async transientBurst(tr: TransientConfig, pitchHz = 120): Promise<void> {
    const frame: VoderFrame = {
      voiced: false,
      noise: tr.noise ?? 1.0,
      pitchHz,
      bands: tr.bands || Array(10).fill(0),
    }
    this.applyFrame(frame, 4)
    await sleep(tr.durationMs || 18)
  }

  applyPhoneme(ph: PhonemeConfig, pitchHz: number, transitionMs: number): void {
    this.applyFrame({
      voiced: ph.voiced,
      noise: ph.noise,
      pitchHz: pitchHz + inferPitchOffset(ph),
      bands: ph.bands,
    }, transitionMs)
  }
}

function inferPitchOffset(ph: PhonemeConfig): number {
  // Slight pitch variation based on voiced/unvoiced character
  // This is a rough heuristic — real Voder used foot pedal
  if (!ph.voiced) return 0
  // Higher formant emphasis → slightly higher pitch tendency
  const highEnergy = ph.bands.slice(4).reduce((a, b) => a + b, 0)
  const lowEnergy = ph.bands.slice(0, 4).reduce((a, b) => a + b, 0)
  if (highEnergy > lowEnergy * 1.5) return 8
  if (lowEnergy > highEnergy * 2) return -6
  return 0
}
