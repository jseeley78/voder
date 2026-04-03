import { BAND_CENTERS, BAND_Q, BAND_COMPENSATION, type PhonemeConfig, type TransientConfig } from './phonemes'

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
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


/**
 * Register the glottal pulse AudioWorklet processor.
 * Returns true if successful, false if worklets aren't supported.
 */


export class VoderEngine {
  ctx: BaseAudioContext | null = null
  private master: GainNode | null = null
  private oscNode: AudioNode | null = null       // OscillatorNode or AudioWorkletNode
  private oscFreqParam: AudioParam | null = null  // .frequency param on either node type
  private oscGain: GainNode | null = null
  private noiseGain: GainNode | null = null
  private noiseNode: AudioBufferSourceNode | null = null
  private bandGains: GainNode[] = []
  private bandFilters: BiquadFilterNode[] = []
  private _started = false
  private _currentPitch = 110
  private _currentVoiced = true

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
  vibratoRate = 6.0   // Whitepaper: 6 cycles per second
  vibratoDepth = 2.75  // Whitepaper: 2-3% fluctuation at 6Hz — original Voder had no auto-vibrato

  /** Buzz source waveform type */
  waveformType: 'damped-pulse' | 'rosenberg' | 'impulse' | 'warm' | 'buzzy' | 'breathy' | 'sawtooth' | 'square' | 'triangle' | 'sine' = 'damped-pulse'

  // Track last scheduled values (needed for offline mode where .value
  // doesn't reflect scheduled ramps — it always returns the initial value)
  private _lastOscGain = 0
  private _lastNoiseGain = 0
  private _lastPitch = 110
  private _lastBandGains = new Float64Array(10)

  get started(): boolean {
    return this._started
  }

  async start(existingCtx?: AudioContext | OfflineAudioContext): Promise<void> {
    if (this._started) return
    this.ctx = existingCtx ?? new AudioContext()
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
    // Recording tap (not available in OfflineAudioContext or node-web-audio-api)
    try {
      this.recordDest = (this.ctx as any).createMediaStreamDestination()
      if (this.recordDest) this.analyser.connect(this.recordDest)
    } catch (_) {
      this.recordDest = null
    }

    // Try AudioWorklet glottal pulse, fall back to PeriodicWave
    // Create the buzz oscillator with the selected waveform
    const osc = this.ctx.createOscillator()
    this._applyWaveform(osc)
    this._initialPitch = this.pitchValue
    osc.frequency.value = this.pitchValue
    this.oscNode = osc
    this.oscFreqParam = osc.frequency
    osc.start()
    const buzzOutput: AudioNode = osc

    // Vibrato LFO → frequency param (works for both node types)
    this.vibratoLfo = this.ctx.createOscillator()
    this.vibratoLfo.type = 'sine'
    this.vibratoLfo.frequency.value = this.vibratoRate

    this.vibratoDepthNode = this.ctx.createGain()
    this.vibratoDepthNode.gain.value = this.vibratoDepth

    this.vibratoLfo.connect(this.vibratoDepthNode)
    this.vibratoDepthNode.connect(this.oscFreqParam)
    this.vibratoLfo.start()

    // No spectral tilt — the compensated band gains already account for
    // source spectrum differences vs real speech.
    this.oscGain = this.ctx.createGain()
    this.oscGain.gain.value = 0

    buzzOutput.connect(this.oscGain)

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
      // Q set per-band; default tilt=0.5 (upper bands sharper, lower wider)
      const bandPos = i / 9
      const tiltFactor = 1.0 + 0.5 * (bandPos - 0.5)
      filter.Q.value = BAND_Q[i] * 3.5 * Math.max(0.3, tiltFactor)

      const gain = this.ctx.createGain()
      gain.gain.value = 0

      this.oscGain.connect(filter)
      this.noiseGain.connect(filter)
      filter.connect(gain)
      gain.connect(this.master)
      this.bandGains.push(gain)
      this.bandFilters.push(filter)
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
    try { if ('close' in this.ctx!) (this.ctx as any).close() } catch (_) { /* already closed */ }
    this.ctx = null
    this._started = false
    this.bandGains = []
    this.bandFilters = []
  }

  /**
   * Build a PeriodicWave for the "damped pulse" waveform described in the
   * 1939 whitepaper: "a repeated damped pulse with a fundamental frequency
   * of 100 cycles per second and several upper harmonics."
   *
   * Each period: sharp impulse that decays exponentially. In the frequency
   * domain, this means harmonics that fall off like e^(-n*decay).
   * Compared to sawtooth (1/n), the damped pulse has:
   *   - Stronger fundamental
   *   - Faster harmonic rolloff (more "guttural", less "buzzy")
   *   - A characteristic percussive attack
   */
  private _createDampedPulse(): PeriodicWave {
    const N = 64
    const real = new Float32Array(N)
    const imag = new Float32Array(N)
    const decay = 0.12  // controls how fast harmonics fall off
    for (let n = 1; n < N; n++) {
      // Damped pulse: harmonics decay exponentially
      // e^(-n * decay) gives a steeper rolloff than 1/n
      // Phase aligned to create a sharp positive pulse
      imag[n] = Math.exp(-n * decay)
      real[n] = 0
    }
    return this.ctx!.createPeriodicWave(real, imag, { disableNormalization: false })
  }

  /**
   * Build a Rosenberg glottal pulse: polynomial open phase + polynomial
   * close phase. Smoother than the damped pulse, used in 70s-80s
   * speech synthesis (Klatt synthesizer).
   */
  private _createRosenbergPulse(): PeriodicWave {
    const N = 64
    const real = new Float32Array(N)
    const imag = new Float32Array(N)
    // Rosenberg model: harmonics fall off as 1/n^2 with alternating phase
    for (let n = 1; n < N; n++) {
      imag[n] = 1.0 / (n * n)
      real[n] = 0
    }
    return this.ctx!.createPeriodicWave(real, imag, { disableNormalization: false })
  }

  /**
   * Build an impulse train: just a sharp click at each period.
   * All harmonics at equal amplitude — the filter bank does ALL shaping.
   * This is the theoretical minimum source for a channel vocoder.
   */
  private _createImpulseTrain(): PeriodicWave {
    const N = 64
    const real = new Float32Array(N)
    const imag = new Float32Array(N)
    // All harmonics at equal amplitude = impulse in time domain
    for (let n = 1; n < N; n++) {
      imag[n] = 1.0
      real[n] = 0
    }
    return this.ctx!.createPeriodicWave(real, imag, { disableNormalization: false })
  }

  /** Warm pulse: square + triangle blend. Rich body, soft edges. */
  private _createWarmPulse(): PeriodicWave {
    const N = 64, real = new Float32Array(N), imag = new Float32Array(N)
    for (let n = 1; n < N; n++) {
      const isOdd = n % 2 === 1
      imag[n] = isOdd ? (0.6 / n + 0.4 / (n * n)) : 0
    }
    return this.ctx!.createPeriodicWave(real, imag, { disableNormalization: false })
  }

  /** Buzzy pulse: sawtooth with boosted even harmonics. Reed-like. */
  private _createBuzzyPulse(): PeriodicWave {
    const N = 64, real = new Float32Array(N), imag = new Float32Array(N)
    for (let n = 1; n < N; n++) {
      imag[n] = (n % 2 === 0 ? 1.5 : 1.0) / n
    }
    return this.ctx!.createPeriodicWave(real, imag, { disableNormalization: false })
  }

  /** Breathy pulse: damped pulse with noisy upper harmonics. Whispery. */
  private _createBreathyPulse(): PeriodicWave {
    const N = 64, real = new Float32Array(N), imag = new Float32Array(N)
    for (let n = 1; n < N; n++) {
      const base = Math.exp(-n * 0.12)
      const breath = n > 10 ? 0.3 * Math.sin(n * 7.3) : 0
      imag[n] = base + Math.abs(breath)
      real[n] = breath * 0.5
    }
    return this.ctx!.createPeriodicWave(real, imag, { disableNormalization: false })
  }

  /** Apply the selected waveform to an oscillator */
  private _applyWaveform(osc: OscillatorNode): void {
    switch (this.waveformType) {
      case 'damped-pulse':
        osc.setPeriodicWave(this._createDampedPulse())
        break
      case 'rosenberg':
        osc.setPeriodicWave(this._createRosenbergPulse())
        break
      case 'impulse':
        osc.setPeriodicWave(this._createImpulseTrain())
        break
      case 'warm':
        osc.setPeriodicWave(this._createWarmPulse())
        break
      case 'buzzy':
        osc.setPeriodicWave(this._createBuzzyPulse())
        break
      case 'breathy':
        osc.setPeriodicWave(this._createBreathyPulse())
        break
      case 'sawtooth':
        osc.type = 'sawtooth'
        break
      case 'square':
        osc.type = 'square'
        break
      case 'sine':
        osc.type = 'sine'
        break
      case 'triangle':
        osc.type = 'triangle'
        break
    }
  }

  /** Change waveform on a running engine */
  /**
   * Change the base pitch. Uses the oscillator's `detune` parameter
   * (in cents) so it works ALONGSIDE the sequencer's frequency
   * automation without conflicting. The sequencer schedules absolute
   * frequencies; detune shifts them all up or down.
   */
  /** Initial pitch when engine started — detune is relative to this */
  private _initialPitch = 110

  /**
   * Change the base pitch live. Uses oscillator.detune (in cents) which
   * stacks ON TOP of the sequencer's frequency automation. This means
   * all scheduled pitch contours shift proportionally — like the original
   * Voder operator pressing the foot pedal harder shifts everything up.
   */
  setPitch(hz: number): void {
    this.pitchValue = hz
    if (this._started && this.oscNode && this._initialPitch > 0) {
      const cents = 1200 * Math.log2(hz / this._initialPitch)
      ;(this.oscNode as any).detune.value = cents
    }
  }

  /** Change the filter Q multiplier on a running engine. */
  _qMul = 3.5
  _qTilt = 0.0  // -1 = wider low bands, +1 = wider high bands
  setFilterQ(multiplier: number, tilt?: number): void {
    this._qMul = multiplier
    if (tilt !== undefined) this._qTilt = tilt
    for (let i = 0; i < this.bandFilters.length; i++) {
      // Per-band Q: tilt ramps the multiplier across bands
      // tilt=0: uniform. tilt>0: lower bands wider, upper bands sharper
      // tilt<0: lower bands sharper, upper bands wider
      const bandPosition = i / 9  // 0.0 (band 0) to 1.0 (band 9)
      const tiltFactor = 1.0 + this._qTilt * (bandPosition - 0.5)
      this.bandFilters[i].Q.value = BAND_Q[i] * multiplier * Math.max(0.3, tiltFactor)
    }
    // Compensate volume: narrower filters pass less energy.
    if (this.master) {
      const compensation = Math.sqrt(multiplier / 2.0)
      this.master.gain.value = this.masterValue * compensation
    }
  }

  /** Zero the detune offset so applyFrame pitchHz values are absolute. Returns saved cents to pass to restoreDetune. */
  zeroDetune(): number {
    if (!this._started || !this.oscNode) return 0
    const saved = (this.oscNode as any).detune?.value ?? 0
    ;(this.oscNode as any).detune.value = 0
    return saved
  }

  /** Restore a previously saved detune offset. */
  restoreDetune(cents: number): void {
    if (!this._started || !this.oscNode) return
    ;(this.oscNode as any).detune.value = cents
  }

  setWaveform(type: 'damped-pulse' | 'rosenberg' | 'impulse' | 'warm' | 'buzzy' | 'breathy' | 'sawtooth' | 'square' | 'triangle' | 'sine'): void {
    this.waveformType = type
    if (this._started && this.oscNode) {
      try {
        this._applyWaveform(this.oscNode as OscillatorNode)
      } catch (_) { /* node might not support setPeriodicWave */ }
    }
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
    this.master.gain.setValueAtTime(this.master.gain.value, this.ctx!.currentTime); this.master.gain.linearRampToValueAtTime(v, this.ctx!.currentTime + 0.045)
  }

  setVibratoRate(hz: number): void {
    this.vibratoRate = hz
    if (this.vibratoLfo) {
      this.vibratoLfo.frequency.setValueAtTime(this.vibratoLfo.frequency.value, this.ctx!.currentTime); this.vibratoLfo.frequency.linearRampToValueAtTime(hz, this.ctx!.currentTime + 0.15)
    }
  }

  setVibratoDepth(hz: number): void {
    this.vibratoDepth = hz
    if (this.vibratoDepthNode) {
      this.vibratoDepthNode.gain.setValueAtTime(this.vibratoDepthNode.gain.value, this.ctx!.currentTime); this.vibratoDepthNode.gain.linearRampToValueAtTime(hz, this.ctx!.currentTime + 0.15)
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
  /**
   * Apply a frame at a specific time. If `atTime` is provided, schedules
   * at that absolute time (for offline rendering). Otherwise uses currentTime
   * (for live playback). Same code path either way.
   */
  applyFrame(frame: VoderFrame, transitionMs = 35, shape: 'snap' | 'expo' | 'smooth' | 'slow' = 'expo', atTime?: number): void {
    if (!this._started || !this.ctx) return
    const now = atTime ?? this.ctx.currentTime
    const sec = Math.max(transitionMs / 1000, 0.005)

    // Drive the sources to match eSpeak's output level (~0.10 RMS).
    // Was 0.30/0.10 giving only 0.016 RMS — 5x too quiet.
    const voicedAmp = frame.voiced ? (frame.voicedAmp ?? 0.8) * 1.50 : 0.0
    const noiseAmp = (frame.noise ?? 0.0) * 0.80
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
    // Faster default transitions — analysis showed our F1-F2 dynamic range
    // is half of eSpeak's because our transitions are too smooth.
    // A skilled operator snaps between positions, not glides slowly.
    const tau = shape === 'snap' ? sec / 8
              : shape === 'slow' ? sec / 2
              : sec / 8  // expo — snappier, matches operator finger speed — was sec/3, now snappier

    // All shapes use linearRamp (compatible with node-web-audio-api).
    // setValueCurveAtTime causes Rust panics in the polyfill.
    // The 'smooth' shape just uses a longer ramp time.
    if (shape === 'smooth') {
      // S-curve approximated as a slower linear ramp
      const rampEnd = now + sec
      this.oscGain!.gain.cancelScheduledValues(now)
      this.oscGain!.gain.setValueAtTime(this._lastOscGain, now)
      this.oscGain!.gain.linearRampToValueAtTime(voicedAmp, rampEnd)
      this._lastOscGain = voicedAmp
      this.noiseGain!.gain.cancelScheduledValues(now)
      this.noiseGain!.gain.setValueAtTime(this._lastNoiseGain, now)
      this.noiseGain!.gain.linearRampToValueAtTime(noiseAmp, rampEnd)
      this._lastNoiseGain = noiseAmp
      this.oscFreqParam!.cancelScheduledValues(now)
      this.oscFreqParam!.setValueAtTime(this._lastPitch, now)
      this.oscFreqParam!.linearRampToValueAtTime(this._currentPitch, rampEnd)
      this._lastPitch = this._currentPitch
      const bands = frame.bands || []
      for (let i = 0; i < this.bandGains.length; i++) {
        const v = clamp((bands[i] || 0) * BAND_COMPENSATION[i], 0, 1.5)
        this.bandGains[i].gain.cancelScheduledValues(now)
        this.bandGains[i].gain.setValueAtTime(this._lastBandGains[i], now)
        this.bandGains[i].gain.linearRampToValueAtTime(v, rampEnd)
        this._lastBandGains[i] = v
      }
    } else {
      // Linear ramp approximating exponential approach.
      // Using setValueAtTime + linearRampToValueAtTime instead of
      // setTargetAtTime because node-web-audio-api has numerical overflow
      // bugs with setTargetAtTime in OfflineAudioContext.
      // Ramp duration = tau*3 gives ~95% of the exponential shape.
      const rampEnd = now + tau * 3

      // Use tracked values instead of .value (which returns 0 in offline mode)
      this.oscGain!.gain.setValueAtTime(this._lastOscGain, now)
      this.oscGain!.gain.linearRampToValueAtTime(voicedAmp, rampEnd)
      this._lastOscGain = voicedAmp

      this.noiseGain!.gain.setValueAtTime(this._lastNoiseGain, now)
      this.noiseGain!.gain.linearRampToValueAtTime(noiseAmp, rampEnd)
      this._lastNoiseGain = noiseAmp

      this.oscFreqParam!.setValueAtTime(this._lastPitch, now)
      this.oscFreqParam!.linearRampToValueAtTime(this._currentPitch, rampEnd)
      this._lastPitch = this._currentPitch

      const bands = frame.bands || []
      for (let i = 0; i < this.bandGains.length; i++) {
        const v = clamp((bands[i] || 0) * BAND_COMPENSATION[i], 0, 1.5)
        this.bandGains[i].gain.cancelScheduledValues(now)
        this.bandGains[i].gain.setValueAtTime(this._lastBandGains[i], now)
        this.bandGains[i].gain.linearRampToValueAtTime(v, rampEnd)
        this._lastBandGains[i] = v
      }
    }
  }

  /** Schedule a transient burst. Returns the duration in ms for time tracking. */
  transientBurst(tr: TransientConfig, pitchHz = 110, atTime?: number): number {
    const frame: VoderFrame = {
      voiced: false,
      noise: tr.noise ?? 1.0,
      pitchHz,
      bands: tr.bands || Array(10).fill(0),
    }
    this.applyFrame(frame, 3, 'snap', atTime)
    return tr.durationMs || 15
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
