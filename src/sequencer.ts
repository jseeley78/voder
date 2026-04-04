import type { VoderEngine } from './engine'
import { PHONEMES, type PhonemeConfig, type PhonemeType } from './phonemes'
import { applyProsody, type ProsodyOptions } from './prosody'
import { getTransitionCurve } from './transitions'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Blend two band arrays: (1-t)*a + t*b */
function blendBands(a: number[], b: number[], t: number): number[] {
  const result: number[] = []
  for (let i = 0; i < 10; i++) {
    result.push((a[i] || 0) * (1 - t) + (b[i] || 0) * t)
  }
  return result
}

const COARTIC: Record<PhonemeType, { onset: number; steady: number; offset: number }> = {
  vowel:     { onset: 0.20, steady: 0.50, offset: 0.30 },
  fricative: { onset: 0.15, steady: 0.60, offset: 0.25 },
  nasal:     { onset: 0.25, steady: 0.45, offset: 0.30 },
  liquid:    { onset: 0.30, steady: 0.35, offset: 0.35 },
  glide:     { onset: 0.40, steady: 0.20, offset: 0.40 },
  stop:      { onset: 0.05, steady: 0.25, offset: 0.70 },
}

function isConsonant(type: PhonemeType): boolean {
  return type !== 'vowel'
}

function adjustTimingForContext(
  timing: { onset: number; steady: number; offset: number },
  _cur: { ph: PhonemeConfig },
  prev: { ph: PhonemeConfig } | null,
  next: { ph: PhonemeConfig } | null,
): { onset: number; steady: number; offset: number } {
  const prevIsC = prev && isConsonant(prev.ph.type)
  const nextIsC = next && isConsonant(next.ph.type)
  if (!prevIsC && !nextIsC) return timing
  let { onset, steady, offset } = timing
  if (prevIsC) { onset = Math.min(onset, 0.10); steady *= 0.5 }
  if (nextIsC) { offset = Math.min(offset, 0.15); steady *= 0.5 }
  if (prevIsC && nextIsC) { steady = Math.min(steady, 0.10) }
  const total = onset + steady + offset
  const scale = 1.0 / total
  return { onset: onset * scale, steady: steady * scale, offset: offset * scale }
}

const SILENCE_BANDS = Array(10).fill(0) as number[]

export type StopKey = 'bilabial' | 'alveolar' | 'velar' | null

function getStopKey(phoneme: string): StopKey {
  switch (phoneme) {
    case 'P': case 'B': return 'bilabial'
    case 'T': case 'D': case 'CH': case 'JH': return 'alveolar'
    case 'K': case 'G': return 'velar'
    default: return null
  }
}

export interface TokenEvent {
  index: number
  phoneme: string
  bands: number[]
  pitchHz: number
  durationMs: number
  stress: number
  voiced: boolean
  noise: number
  stopKey: StopKey
  /** Absolute time this token starts (seconds from context start) */
  startTime: number
}

export interface SequenceOptions {
  defaultDurationMs: number
  transitionMs: number
  basePitch: number
  rateScale: number
  expressiveness?: number
  humanize?: number
  onToken?: (event: TokenEvent) => void
  onDone?: () => void
}

export interface SequenceHandle {
  cancel: () => void
  done: Promise<void>
  /** Total duration of the scheduled audio in seconds */
  totalDuration: number
}

interface ResolvedToken {
  ph: PhonemeConfig
  bands: number[]
  ampMul: number
  pitchHz: number
  durationMs: number
  phoneme: string
  stress: number
  pauseAfterMs: number
}

function jit(spread: number): number {
  return (Math.random() - 0.5) * 2 * spread
}

function humanizeTokens(tokens: ResolvedToken[], amount: number): void {
  if (amount <= 0) return
  let pitchDrift = 0
  const driftRate = 0.006 * amount
  for (const tok of tokens) {
    tok.durationMs *= 1 + jit(0.08 * amount)
    pitchDrift += jit(driftRate)
    pitchDrift *= 0.95
    tok.pitchHz *= 1 + pitchDrift + jit(0.01 * amount)
    tok.bands = tok.bands.map(g => {
      if (g < 0.01) return g
      return Math.max(0, g * (1 + jit(0.06 * amount)))
    })
    if (tok.pauseAfterMs > 0) {
      tok.pauseAfterMs *= 1 + jit(0.15 * amount)
      tok.pauseAfterMs = Math.max(10, tok.pauseAfterMs)
    }
  }
}

/**
 * Schedule a phoneme sequence through the engine.
 *
 * All audio events are scheduled at absolute times using Web Audio's
 * setTargetAtTime. This works for both real-time playback (AudioContext)
 * and offline rendering (OfflineAudioContext).
 *
 * In real-time mode, the returned promise resolves after the audio
 * has played. In offline mode, it resolves immediately after scheduling
 * (call ctx.startRendering() to actually render).
 */
export function speakPhonemeSequence(
  engine: VoderEngine,
  input: string,
  options: SequenceOptions,
): SequenceHandle {
  let cancelled = false
  let totalDuration = 0

  const promise = (async () => {
    const rawTokens = input.trim().split(/\s+/).filter(Boolean).map(x => x.toUpperCase())
    if (!rawTokens.length) return

    const prosodyOpts: Partial<ProsodyOptions> = {
      expressiveness: options.expressiveness ?? 0.7,
    }
    const prosodyTokens = applyProsody(rawTokens, prosodyOpts)

    const resolved: ResolvedToken[] = []
    for (const pt of prosodyTokens) {
      const ph = PHONEMES[pt.phoneme]
      if (!ph) continue
      resolved.push({
        ph,
        bands: ph.bands.map(g => g * pt.ampMul),
        ampMul: pt.ampMul,
        pitchHz: options.basePitch * pt.pitchMul,
        durationMs: ((ph.durationMs ?? options.defaultDurationMs) * pt.durationMul) / options.rateScale,
        phoneme: pt.phoneme,
        stress: pt.stress,
        pauseAfterMs: pt.pauseAfterMs,
      })
    }

    if (!resolved.length) return

    humanizeTokens(resolved, options.humanize ?? 0.5)

    // Determine if we're in offline mode (OfflineAudioContext)
    const isOffline = engine.ctx instanceof OfflineAudioContext

    // Schedule all frames at absolute times
    // Start slightly after 0 to avoid edge cases
    let t = isOffline ? 0.05 : (engine.ctx?.currentTime ?? 0) + 0.05

    for (let i = 0; i < resolved.length; i++) {
      if (cancelled) break

      const cur = resolved[i]
      const prev = i > 0 ? resolved[i - 1] : null
      const next = i < resolved.length - 1 ? resolved[i + 1] : null
      const timing = COARTIC[cur.ph.type]

      // Notify UI (with startTime for synchronization)
      options.onToken?.({
        index: i,
        phoneme: cur.phoneme,
        bands: cur.bands,
        pitchHz: cur.pitchHz,
        durationMs: cur.durationMs,
        stress: cur.stress,
        voiced: cur.ph.voiced,
        noise: cur.ph.noise,
        stopKey: cur.ph.transient ? getStopKey(cur.phoneme) : null,
        startTime: t,
      })

      const adjTiming = adjustTimingForContext(timing, cur, prev, next)
      const onsetMs = cur.durationMs * adjTiming.onset
      const steadyMs = cur.durationMs * adjTiming.steady
      const offsetMs = cur.durationMs * adjTiming.offset

      // ── Transient burst + aspiration ──
      if (cur.ph.transient) {
        const burstMs = engine.transientBurst(cur.ph.transient, cur.pitchHz, t)
        t += burstMs / 1000

        const nextIsVowelLike = next && (next.ph.type === 'vowel' || next.ph.type === 'glide')
        if (!cur.ph.voiced && nextIsVowelLike) {
          const aspBands = next.bands.map(g => g * 0.5)
          engine.applyFrame({
            voiced: false,
            noise: 0.50,
            pitchHz: cur.pitchHz,
            bands: aspBands,
          }, 5, 'snap', t)
          t += 0.030
        }
      }

      // ── Source crossfade ──
      if (prev && onsetMs > 8) {
        const prevVoiced = prev.ph.voiced
        const curVoiced = cur.ph.voiced
        const prevNoise = prev.ph.noise
        const curNoise = cur.ph.noise
        const voiceAppearing = !prevVoiced && curVoiced && prevNoise > 0.3
        const voiceDisappearing = prevVoiced && !curVoiced && curNoise > 0.3
        const noiseAppearing = prevNoise < 0.1 && curNoise > 0.3
        const noiseDisappearing = prevNoise > 0.3 && curNoise < 0.1

        if (voiceAppearing || voiceDisappearing || noiseAppearing || noiseDisappearing) {
          const xfadeMs = Math.min(20, onsetMs * 0.4)
          const xfadeBands = blendBands(prev.bands, cur.bands, 0.5)
          engine.applyFrame({
            voiced: true,
            voicedAmp: (prev.ph.voicedAmp + cur.ph.voicedAmp) * 0.3,
            noise: Math.max(prevNoise, curNoise) * 0.5,
            pitchHz: cur.pitchHz,
            bands: xfadeBands,
          }, xfadeMs * 0.6, 'expo', t)
          t += Math.max(0.005, xfadeMs / 1000 - 0.003)
        }
      }

      {
        // ── Onset/Steady/Offset with transition-curve-guided timing ──

        // Check if we have a measured transition curve for this pair.
        // The curve guides the blend SHAPE (how quickly to shift from prev→cur)
        // but we always blend between OUR phoneme gains, not the curve's values.
        const prevPhoneme = prev?.phoneme ?? ''
        const transCurve = prev ? getTransitionCurve(prevPhoneme, cur.phoneme) : null

        // Phase 1: Onset transition
        if (onsetMs > 5) {
          const prevBands = prev ? prev.bands : SILENCE_BANDS
          // If we have a curve, derive the blend ratio from the curve's energy shift
          // (how far the curve has moved from its start to its end at the 25% mark)
          let blendToward = (prev && isConsonant(prev.ph.type) && isConsonant(cur.ph.type)) ? 0.65 : 0.5
          if (transCurve) {
            // Use curve shape: compare energy at frame 2 (25%) vs frame 0 (start)
            // High change = fast onset, low change = gradual onset
            const startEnergy = transCurve[0].reduce((a, b) => a + b, 0)
            const midEnergy = transCurve[2].reduce((a, b) => a + b, 0)
            const endEnergy = transCurve[7].reduce((a, b) => a + b, 0)
            const totalShift = Math.abs(endEnergy - startEnergy) || 1
            const earlyShift = Math.abs(midEnergy - startEnergy)
            blendToward = Math.max(0.3, Math.min(0.8, earlyShift / totalShift))
          }
          const onsetBands = blendBands(prevBands, cur.bands, blendToward)
          const prevAmp = prev?.ph.voicedAmp ?? 0
          engine.applyFrame({
            voiced: cur.ph.voiced,
            voicedAmp: prevAmp * 0.5 + cur.ph.voicedAmp * 0.5,
            noise: cur.ph.noise,
            pitchHz: cur.pitchHz,
            bands: onsetBands,
          }, onsetMs * 0.8, 'expo', t)
          t += Math.max(0.005, onsetMs / 1000 - 0.005)
        }

        // Phase 2: Steady state (or diphthong glide)
        if (cur.ph.onsetBands && cur.ph.offsetBands && steadyMs > 20) {
          const halfMs = steadyMs / 2
          const amp = cur.ampMul

          engine.applyFrame({
            voiced: cur.ph.voiced,
            voicedAmp: cur.ph.voicedAmp,
            noise: cur.ph.noise,
            pitchHz: cur.pitchHz,
            bands: cur.ph.onsetBands.map(g => g * amp),
          }, Math.min(onsetMs * 0.5, 20), 'expo', t)
          t += Math.max(0.005, halfMs / 1000 - 0.005)

          engine.applyFrame({
            voiced: cur.ph.voiced,
            voicedAmp: cur.ph.voicedAmp,
            noise: cur.ph.noise,
            pitchHz: cur.pitchHz,
            bands: cur.ph.offsetBands.map(g => g * amp),
          }, halfMs, 'smooth', t)
          t += Math.max(0.005, halfMs / 1000 - 0.005)
        } else {
          engine.applyFrame({
            voiced: cur.ph.voiced,
            voicedAmp: cur.ph.voicedAmp,
            noise: cur.ph.noise,
            pitchHz: cur.pitchHz,
            bands: cur.bands,
          }, Math.min(onsetMs * 0.5, 25), 'expo', t)
          if (steadyMs > 5) {
            t += Math.max(0.005, steadyMs / 1000 - 0.005)
          }
        }

        // Phase 3: Offset transition
        if (offsetMs > 5 && next) {
          const ccCluster = isConsonant(cur.ph.type) && isConsonant(next.ph.type)
          const blendFwd = ccCluster ? 0.6 : 0.4
          const blendKeep = 1.0 - blendFwd
          const offsetBands = blendBands(cur.bands, next.bands, blendFwd)
          engine.applyFrame({
            voiced: next.ph.voiced || cur.ph.voiced,
            voicedAmp: cur.ph.voicedAmp * blendKeep + next.ph.voicedAmp * blendFwd,
            noise: cur.ph.noise * blendKeep + (next.ph.noise ?? 0) * blendFwd,
            pitchHz: cur.pitchHz * blendKeep + next.pitchHz * blendFwd,
            bands: offsetBands,
          }, offsetMs, 'expo', t)
          t += Math.max(0.005, offsetMs / 1000 - 0.005)
        } else if (offsetMs > 5) {
          if (cur.ph.type === 'stop' && !cur.ph.voiced) {
            engine.applyFrame({
              voiced: false, noise: 0.3, pitchHz: cur.pitchHz,
              bands: [0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.10, 0.15, 0.10, 0.05],
            }, 8, 'snap', t)
            t += 0.015
          } else {
            engine.applyFrame({
              voiced: cur.ph.voiced,
              voicedAmp: cur.ph.voicedAmp * 0.3,
              noise: cur.ph.noise * 0.3,
              pitchHz: cur.pitchHz,
              bands: cur.bands.map(g => g * 0.3),
            }, offsetMs, 'slow', t)
            t += Math.max(0.005, offsetMs / 1000 - 0.005)
          }
        }
      }

      // Pause
      if (cur.pauseAfterMs > 0) {
        engine.applyFrame({
          voiced: false, noise: 0, pitchHz: cur.pitchHz,
          bands: SILENCE_BANDS,
        }, 20, 'expo', t)
        t += cur.pauseAfterMs / 1000
      }
    }

    // Final ramp to silence
    engine.applyFrame({
      voiced: false, noise: 0.0, pitchHz: options.basePitch,
      bands: SILENCE_BANDS,
    }, 60, 'expo', t)
    t += 0.1

    totalDuration = t - (isOffline ? 0.05 : (engine.ctx?.currentTime ?? 0))

    // In real-time mode, wait for the audio to play out
    // In offline mode, return immediately (caller will call startRendering)
    if (!isOffline) {
      // Wait for the scheduled audio to finish playing
      const waitMs = totalDuration * 1000 + 100
      let elapsed = 0
      while (elapsed < waitMs && !cancelled) {
        await sleep(50)
        elapsed += 50
      }
    }

    options.onDone?.()
  })()

  return {
    cancel: () => { cancelled = true },
    done: promise,
    get totalDuration() { return totalDuration },
  }
}
