import { BAND_CENTERS, BAND_Q, BAND_COMPENSATION, type PhonemeConfig, type TransientConfig } from './phonemes'

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export interface VoderFrame {
  voiced: boolean
  noise: number
  /** Voiced source amplitude 0-1. Defaults to 0.25 if omitted. */
  voicedAmp?: number
  pitchHz: number
  bands: number[]
}

/**
 * Build a PeriodicWave that approximates the Voder's relaxation oscillator.
 * The original used a gas triode with ~0.3ms charge, ~0.8ms discharge,
 * producing a pulse-like waveform rich in harmonics but with a steeper
 * spectral rolloff than a sawtooth.
 */
function createGlottalWave(ctx: AudioContext): PeriodicWave {
  const N = 64
  const real = new Float32Array(N)
  const imag = new Float32Array(N)
  real[0] = 0
  imag[0] = 0
  for (let n = 1; n < N; n++) {
    const evenFactor = n % 2 === 0 ? 0.7 : 1.0
    imag[n] = evenFactor / Math.pow(n, 1.2)
    real[n] = 0
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false })
}

export class VoderEngine {
  ctx: AudioContext | null = null
  private master: GainNode | null = null
  private osc: OscillatorNode | null = null
  private oscGain: GainNode | null = null
  private noiseGain: GainNode | null = null
  private noiseNode: AudioBufferSourceNode | null = null
  private bandGains: GainNode[] = []
  private _started = false
  private _currentPitch = 110
  private _currentVoiced = true

  // Vibrato LFO nodes
  private vibratoLfo: OscillatorNode | null = null
  private vibratoDepthNode: GainNode | null = null

  // Random jitter (separate from vibrato)
  private jitterTimer: ReturnType<typeof setInterval> | null = null

  /** Exposed for waveform/spectrum visualization */
  analyser: AnalyserNode | null = null

  pitchValue = 110
  masterValue = 1.0
  jitterValue = 0.8
  vibratoRate = 5.2   // Hz — typical vocal vibrato ~5-6 Hz
  vibratoDepth = 2.5  // Hz — deviation from center pitch

  get started(): boolean {
    return this._started
  }

  async start(): Promise<void> {
    if (this._started) return
    this.ctx = new AudioContext()
    this.master = this.ctx.createGain()
    this.master.gain.value = this.masterValue

    // Analyser for waveform/spectrum visualization
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0.8

    this.master.connect(this.analyser)
    this.analyser.connect(this.ctx.destination)

    // Buzz source
    this.osc = this.ctx.createOscillator()
    this.osc.setPeriodicWave(createGlottalWave(this.ctx))
    this.osc.frequency.value = this.pitchValue

    // Vibrato LFO: sine wave modulating the oscillator frequency.
    // This is sample-accurate and produces smooth periodic pitch wobble,
    // unlike the random jitter which adds slight instability.
    //   LFO (sine) → vibratoDepthNode (gain = depth in Hz) → osc.frequency
    this.vibratoLfo = this.ctx.createOscillator()
    this.vibratoLfo.type = 'sine'
    this.vibratoLfo.frequency.value = this.vibratoRate

    this.vibratoDepthNode = this.ctx.createGain()
    this.vibratoDepthNode.gain.value = this.vibratoDepth

    this.vibratoLfo.connect(this.vibratoDepthNode)
    this.vibratoDepthNode.connect(this.osc.frequency)
    this.vibratoLfo.start()

    // Spectral tilt
    const oscTilt = this.ctx.createBiquadFilter()
    oscTilt.type = 'lowpass'
    oscTilt.frequency.value = 3800
    oscTilt.Q.value = 0.4

    this.oscGain = this.ctx.createGain()
    this.oscGain.gain.value = 0

    this.osc.connect(oscTilt)
    oscTilt.connect(this.oscGain)

    // Noise source
    this.noiseNode = this._createNoiseSource()
    this.noiseGain = this.ctx.createGain()
    this.noiseGain.gain.value = 0

    this.noiseNode.connect(this.noiseGain)

    // 10-band filter bank
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
    try { this.vibratoLfo?.stop() } catch (_) { /* already stopped */ }
    try { this.noiseNode?.stop() } catch (_) { /* already stopped */ }
    try { this.ctx?.close() } catch (_) { /* already closed */ }
    this.ctx = null
    this._started = false
    this.bandGains = []
  }

  /** Random micro-jitter — adds slight pitch instability on top of vibrato */
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

  setVibratoRate(hz: number): void {
    this.vibratoRate = hz
    if (this.vibratoLfo) {
      this.vibratoLfo.frequency.setTargetAtTime(hz, this.ctx!.currentTime, 0.05)
    }
  }

  setVibratoDepth(hz: number): void {
    this.vibratoDepth = hz
    if (this.vibratoDepthNode) {
      this.vibratoDepthNode.gain.setTargetAtTime(hz, this.ctx!.currentTime, 0.05)
    }
  }

  applyFrame(frame: VoderFrame, transitionMs = 35): void {
    if (!this._started || !this.ctx) return
    const now = this.ctx.currentTime
    const sec = Math.max(transitionMs / 1000, 0.005)

    const voicedAmp = frame.voiced ? (frame.voicedAmp ?? 0.25) * 0.25 : 0.0
    const noiseAmp = (frame.noise ?? 0.0) * 0.20
    this._currentVoiced = frame.voiced
    this._currentPitch = frame.pitchHz

    this.oscGain!.gain.cancelScheduledValues(now)
    this.noiseGain!.gain.cancelScheduledValues(now)
    this.osc!.frequency.cancelScheduledValues(now)

    this.oscGain!.gain.linearRampToValueAtTime(voicedAmp, now + sec)
    this.noiseGain!.gain.linearRampToValueAtTime(noiseAmp, now + sec)
    this.osc!.frequency.linearRampToValueAtTime(this._currentPitch, now + sec)

    const bands = frame.bands || []
    for (let i = 0; i < this.bandGains.length; i++) {
      // Apply band energy compensation: wider bands are attenuated so
      // equal gain values in the phoneme table produce equal loudness
      const v = clamp((bands[i] || 0) * BAND_COMPENSATION[i], 0, 1.5)
      this.bandGains[i].gain.cancelScheduledValues(now)
      this.bandGains[i].gain.linearRampToValueAtTime(v, now + sec)
    }
  }

  async transientBurst(tr: TransientConfig, pitchHz = 110): Promise<void> {
    const frame: VoderFrame = {
      voiced: false,
      noise: tr.noise ?? 1.0,
      pitchHz,
      bands: tr.bands || Array(10).fill(0),
    }
    this.applyFrame(frame, 3)
    await sleep(tr.durationMs || 15)
  }

  applyPhoneme(ph: PhonemeConfig, pitchHz: number, transitionMs: number): void {
    this.applyFrame({
      voiced: ph.voiced,
      noise: ph.noise,
      voicedAmp: ph.voicedAmp,
      pitchHz,
      bands: ph.bands,
    }, transitionMs)
  }
}
