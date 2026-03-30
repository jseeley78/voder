import { BAND_CENTERS, BAND_Q, BAND_COMPENSATION, type PhonemeConfig, type TransientConfig } from './phonemes'
import { GLOTTAL_WORKLET_CODE } from './glottal-worklet'

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
 * Fallback PeriodicWave for browsers that don't support AudioWorklet.
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

/**
 * Register the glottal pulse AudioWorklet processor.
 * Returns true if successful, false if worklets aren't supported.
 */
async function registerGlottalWorklet(ctx: AudioContext): Promise<boolean> {
  try {
    const blob = new Blob([GLOTTAL_WORKLET_CODE], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    await ctx.audioWorklet.addModule(url)
    URL.revokeObjectURL(url)
    return true
  } catch (_) {
    return false
  }
}

export class VoderEngine {
  ctx: AudioContext | null = null
  private master: GainNode | null = null
  private oscNode: AudioNode | null = null       // OscillatorNode or AudioWorkletNode
  private oscFreqParam: AudioParam | null = null  // .frequency param on either node type
  private oscGain: GainNode | null = null
  private noiseGain: GainNode | null = null
  private noiseNode: AudioBufferSourceNode | null = null
  private bandGains: GainNode[] = []
  private _started = false
  private _currentPitch = 110
  private _currentVoiced = true
  private _useWorklet = false

  // Vibrato LFO
  private vibratoLfo: OscillatorNode | null = null
  private vibratoDepthNode: GainNode | null = null

  // Random jitter
  private jitterTimer: ReturnType<typeof setInterval> | null = null

  /** Exposed for waveform/spectrum visualization */
  analyser: AnalyserNode | null = null
  /** For recording the output as WAV */
  recordDest: MediaStreamAudioDestinationNode | null = null

  pitchValue = 110
  masterValue = 1.0
  jitterValue = 0.8
  vibratoRate = 5.2
  vibratoDepth = 0    // Off by default — original Voder had no auto-vibrato

  get started(): boolean {
    return this._started
  }

  async start(): Promise<void> {
    if (this._started) return
    this.ctx = new AudioContext()
    this.master = this.ctx.createGain()
    this.master.gain.value = this.masterValue

    // Output EQ: models the frequency response of a 1939 horn speaker.
    // The real Voder was demonstrated through PA speakers that had:
    //   - Natural rolloff below ~150 Hz (no subwoofer)
    //   - Presence peak at 2-4 kHz (horn resonance, aids intelligibility)
    //   - Rolloff above ~6 kHz (speaker limitation)
    // This actually HELPS clarity — the presence boost is in the range
    // where consonant and vowel distinctions are most audible.

    // Low shelf: gently cut below 200 Hz (-4 dB) to reduce rumble
    const eqLow = this.ctx.createBiquadFilter()
    eqLow.type = 'lowshelf'
    eqLow.frequency.value = 200
    eqLow.gain.value = -4

    // Presence peak: boost 2.5 kHz (+5 dB) for clarity
    const eqMid = this.ctx.createBiquadFilter()
    eqMid.type = 'peaking'
    eqMid.frequency.value = 2800
    eqMid.Q.value = 0.8
    eqMid.gain.value = 5

    // High shelf: cut above 7 kHz (-3 dB) to soften harshness
    const eqHigh = this.ctx.createBiquadFilter()
    eqHigh.type = 'highshelf'
    eqHigh.frequency.value = 7000
    eqHigh.gain.value = -3

    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0.8

    // Signal chain: master → EQ → analyser → speakers
    this.master.connect(eqLow)
    eqLow.connect(eqMid)
    eqMid.connect(eqHigh)
    eqHigh.connect(this.analyser)
    this.analyser.connect(this.ctx.destination)

    // Recording tap — captures the same signal the speakers get
    this.recordDest = this.ctx.createMediaStreamDestination()
    this.analyser.connect(this.recordDest)

    // Try AudioWorklet glottal pulse, fall back to PeriodicWave
    this._useWorklet = await registerGlottalWorklet(this.ctx)

    let buzzOutput: AudioNode
    if (this._useWorklet) {
      // AudioWorklet: asymmetric pulse train with cycle-to-cycle jitter
      const workletNode = new AudioWorkletNode(this.ctx, 'glottal-pulse')
      this.oscNode = workletNode
      this.oscFreqParam = workletNode.parameters.get('frequency')!
      this.oscFreqParam.value = this.pitchValue
      buzzOutput = workletNode
    } else {
      // Fallback: PeriodicWave on standard OscillatorNode
      const osc = this.ctx.createOscillator()
      osc.setPeriodicWave(createGlottalWave(this.ctx))
      osc.frequency.value = this.pitchValue
      this.oscNode = osc
      this.oscFreqParam = osc.frequency
      osc.start()
      buzzOutput = osc
    }

    // Vibrato LFO → frequency param (works for both node types)
    this.vibratoLfo = this.ctx.createOscillator()
    this.vibratoLfo.type = 'sine'
    this.vibratoLfo.frequency.value = this.vibratoRate

    this.vibratoDepthNode = this.ctx.createGain()
    this.vibratoDepthNode.gain.value = this.vibratoDepth

    this.vibratoLfo.connect(this.vibratoDepthNode)
    this.vibratoDepthNode.connect(this.oscFreqParam)
    this.vibratoLfo.start()

    // Spectral tilt
    const oscTilt = this.ctx.createBiquadFilter()
    oscTilt.type = 'lowpass'
    oscTilt.frequency.value = 3400
    oscTilt.Q.value = 0.65

    this.oscGain = this.ctx.createGain()
    this.oscGain.gain.value = 0

    buzzOutput.connect(oscTilt)
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

    this.noiseNode.start()
    this._started = true
    this._startJitter()
  }

  /**
   * Create a noise source modeled on the Voder's gas-filled triode.
   *
   * Two differences from simple Math.random() white noise:
   *
   * 1. Gaussian distribution — real ionic noise follows a normal
   *    distribution (central limit theorem). Gaussian noise sounds
   *    smoother because extreme amplitudes are rare. We use the
   *    Box-Muller transform to convert uniform → Gaussian.
   *
   * 2. Pink spectral tilt — real electronic noise has a 1/f component
   *    (more energy at low frequencies). We apply a simple 1/f filter
   *    by accumulating a running average. This matches how the ear
   *    perceives loudness (equal energy per octave, not per Hz) and
   *    gives fricatives a warmer, less "digital" character.
   */
  private _createNoiseSource(): AudioBufferSourceNode {
    const sr = this.ctx!.sampleRate
    // 4-second buffer to minimize audible repetition
    const buffer = this.ctx!.createBuffer(1, sr * 4, sr)
    const data = buffer.getChannelData(0)

    // Generate Gaussian white noise via Box-Muller transform
    for (let i = 0; i < data.length; i += 2) {
      const u1 = Math.random() || 1e-10  // avoid log(0)
      const u2 = Math.random()
      const r = Math.sqrt(-2 * Math.log(u1))
      const theta = 2 * Math.PI * u2
      data[i] = r * Math.cos(theta)
      if (i + 1 < data.length) {
        data[i + 1] = r * Math.sin(theta)
      }
    }

    // Apply pink spectral tilt (1/f filtering).
    // Uses Paul Kellet's refined method: three leaky integrators
    // at different time constants approximate a -3dB/octave slope.
    let b0 = 0, b1 = 0, b2 = 0
    for (let i = 0; i < data.length; i++) {
      const white = data[i]
      b0 = 0.99765 * b0 + white * 0.0990460
      b1 = 0.96300 * b1 + white * 0.2965164
      b2 = 0.57000 * b2 + white * 1.0526913
      data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.22
    }

    const src = this.ctx!.createBufferSource()
    src.buffer = buffer
    src.loop = true
    return src
  }

  stop(): void {
    if (!this._started) return
    if (this.jitterTimer != null) clearInterval(this.jitterTimer)
    try {
      if (this.oscNode) {
        if ('stop' in this.oscNode) (this.oscNode as OscillatorNode).stop()
        this.oscNode.disconnect()
      }
    } catch (_) { /* already stopped */ }
    try { this.vibratoLfo?.stop() } catch (_) { /* already stopped */ }
    try { this.noiseNode?.stop() } catch (_) { /* already stopped */ }
    try { this.ctx?.close() } catch (_) { /* already closed */ }
    this.ctx = null
    this._started = false
    this.bandGains = []
  }

  private _startJitter(): void {
    this.jitterTimer = setInterval(() => {
      if (!this._started || !this._currentVoiced || !this.oscFreqParam) return
      const base = this._currentPitch
      const target = base + (Math.random() * 2 - 1) * this.jitterValue
      const t = this.ctx!.currentTime
      this.oscFreqParam.cancelScheduledValues(t)
      this.oscFreqParam.linearRampToValueAtTime(target, t + 0.03)
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

  /**
   * Transition shape controls how the parameter ramp behaves.
   * Models different operator movements:
   *   'snap'   — very fast attack (stop burst release, ~95% in 1/5 of time)
   *   'expo'   — fast start, slow finish (default finger movement)
   *   'smooth' — S-curve ease-in-out (vowel-to-vowel glide)
   *   'slow'   — gradual onset (nasal/liquid fade-in)
   */
  applyFrame(frame: VoderFrame, transitionMs = 35, shape: 'snap' | 'expo' | 'smooth' | 'slow' = 'expo'): void {
    if (!this._started || !this.ctx) return
    const now = this.ctx.currentTime
    const sec = Math.max(transitionMs / 1000, 0.005)

    const voicedAmp = frame.voiced ? (frame.voicedAmp ?? 0.8) * 0.30 : 0.0
    const noiseAmp = (frame.noise ?? 0.0) * 0.10
    this._currentVoiced = frame.voiced
    this._currentPitch = frame.pitchHz

    this.oscGain!.gain.cancelScheduledValues(now)
    this.noiseGain!.gain.cancelScheduledValues(now)
    this.oscFreqParam!.cancelScheduledValues(now)

    // Time constant varies by transition shape:
    //   snap:   tau = sec/6 → 95% complete in ~sec/2 (very fast)
    //   expo:   tau = sec/3 → 95% complete in ~sec (default)
    //   smooth: use setValueCurveAtTime with S-curve
    //   slow:   tau = sec/1.5 → takes full duration to settle
    const tau = shape === 'snap' ? sec / 6
              : shape === 'slow' ? sec / 1.5
              : sec / 3  // expo (default)

    if (shape === 'smooth' && sec > 0.015) {
      // S-curve: slow start, fast middle, slow end (ease-in-out)
      // Use setValueCurveAtTime with a computed cosine curve
      const steps = Math.max(4, Math.round(sec * 200))  // ~200 steps/sec
      const bands = frame.bands || []

      // For source gains, use S-curve
      const oscCurve = new Float32Array(steps)
      const noiseCurve = new Float32Array(steps)
      const pitchCurve = new Float32Array(steps)
      const prevOsc = this.oscGain!.gain.value
      const prevNoise = this.noiseGain!.gain.value
      const prevPitch = this.oscFreqParam!.value

      for (let i = 0; i < steps; i++) {
        // Cosine interpolation: 0→1 with ease-in-out
        const t = 0.5 * (1 - Math.cos(Math.PI * i / (steps - 1)))
        oscCurve[i] = prevOsc * (1 - t) + voicedAmp * t
        noiseCurve[i] = prevNoise * (1 - t) + noiseAmp * t
        pitchCurve[i] = prevPitch * (1 - t) + this._currentPitch * t
      }

      this.oscGain!.gain.setValueCurveAtTime(oscCurve, now, sec)
      this.noiseGain!.gain.setValueCurveAtTime(noiseCurve, now, sec)
      this.oscFreqParam!.setValueCurveAtTime(pitchCurve, now, sec)

      // Band gains also get S-curves
      for (let i = 0; i < this.bandGains.length; i++) {
        const v = clamp((bands[i] || 0) * BAND_COMPENSATION[i], 0, 1.5)
        const prevV = this.bandGains[i].gain.value
        const curve = new Float32Array(steps)
        for (let j = 0; j < steps; j++) {
          const t = 0.5 * (1 - Math.cos(Math.PI * j / (steps - 1)))
          curve[j] = prevV * (1 - t) + v * t
        }
        this.bandGains[i].gain.cancelScheduledValues(now)
        this.bandGains[i].gain.setValueCurveAtTime(curve, now, sec)
      }
    } else {
      // Exponential approach for snap/expo/slow
      this.oscGain!.gain.setTargetAtTime(voicedAmp, now, tau)
      this.noiseGain!.gain.setTargetAtTime(noiseAmp, now, tau)
      this.oscFreqParam!.setTargetAtTime(this._currentPitch, now, tau)

      const bands = frame.bands || []
      for (let i = 0; i < this.bandGains.length; i++) {
        const v = clamp((bands[i] || 0) * BAND_COMPENSATION[i], 0, 1.5)
        this.bandGains[i].gain.cancelScheduledValues(now)
        this.bandGains[i].gain.setTargetAtTime(v, now, tau)
      }
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
