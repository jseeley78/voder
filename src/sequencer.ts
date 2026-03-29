import type { VoderEngine, VoderFrame } from './engine'
import { PHONEMES, type PhonemeConfig, type PhonemeType } from './phonemes'
import { applyProsody, type ProsodyOptions } from './prosody'

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

/**
 * Coarticulation timing profiles per phoneme type.
 * Values are fractions of total duration.
 *   onset:  transition FROM previous sound's target
 *   steady: hold at this phoneme's target
 *   offset: transition TOWARD next sound's target
 */
const COARTIC: Record<PhonemeType, { onset: number; steady: number; offset: number }> = {
  vowel:     { onset: 0.20, steady: 0.50, offset: 0.30 },
  fricative: { onset: 0.15, steady: 0.60, offset: 0.25 },
  nasal:     { onset: 0.25, steady: 0.45, offset: 0.30 },
  liquid:    { onset: 0.35, steady: 0.25, offset: 0.40 },
  glide:     { onset: 0.45, steady: 0.10, offset: 0.45 },
  stop:      { onset: 0.05, steady: 0.25, offset: 0.70 },
}

/** Is this phoneme type a consonant? */
function isConsonant(type: PhonemeType): boolean {
  return type !== 'vowel'
}

/**
 * Adjust coarticulation timing for consonant clusters.
 * When two consonants are adjacent, tighten the transition:
 *   - Shrink the steady state (consonants in clusters barely hold)
 *   - Speed up onset/offset (transitions between consonants are fast)
 *   - Same-place clusters (nt, mp, nk) get nearly instant transitions
 */
function adjustTimingForContext(
  timing: { onset: number; steady: number; offset: number },
  _cur: { ph: PhonemeConfig },
  prev: { ph: PhonemeConfig } | null,
  next: { ph: PhonemeConfig } | null,
): { onset: number; steady: number; offset: number } {
  const prevIsC = prev && isConsonant(prev.ph.type)
  const nextIsC = next && isConsonant(next.ph.type)

  // Not in a cluster — use default timing
  if (!prevIsC && !nextIsC) return timing

  let { onset, steady, offset } = timing

  // Consonant follows another consonant: fast onset, reduced steady
  if (prevIsC) {
    onset = Math.min(onset, 0.10)
    steady *= 0.5
  }

  // Consonant precedes another consonant: fast offset, reduced steady
  if (nextIsC) {
    offset = Math.min(offset, 0.15)
    steady *= 0.5
  }

  // Both sides are consonants (middle of a cluster like "str"):
  // minimal steady state, almost all transition
  if (prevIsC && nextIsC) {
    steady = Math.min(steady, 0.10)
  }

  // Redistribute: what we took from steady goes to the vowel-facing side
  // (the transition that carries the most perceptual information)
  const total = onset + steady + offset
  const scale = 1.0 / total
  return { onset: onset * scale, steady: steady * scale, offset: offset * scale }
}

const SILENCE_BANDS = Array(10).fill(0) as number[]

/** Which of the 3 stop keys is firing (maps to place of articulation) */
export type StopKey = 'bilabial' | 'alveolar' | 'velar' | null

/** Map stop phonemes to their physical key */
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
}

export interface SequenceOptions {
  defaultDurationMs: number
  transitionMs: number
  basePitch: number
  rateScale: number
  expressiveness?: number
  onToken?: (event: TokenEvent) => void
  onDone?: () => void
}

export interface SequenceHandle {
  cancel: () => void
  done: Promise<void>
}

interface ResolvedToken {
  ph: PhonemeConfig
  bands: number[]      // after prosody amplitude scaling
  ampMul: number       // prosody amplitude multiplier (for diphthong scaling)
  pitchHz: number
  durationMs: number
  phoneme: string
  stress: number
  pauseAfterMs: number
}

export function speakPhonemeSequence(
  engine: VoderEngine,
  input: string,
  options: SequenceOptions,
): SequenceHandle {
  let cancelled = false

  const promise = (async () => {
    const rawTokens = input.trim().split(/\s+/).filter(Boolean).map(x => x.toUpperCase())
    if (!rawTokens.length) return

    const prosodyOpts: Partial<ProsodyOptions> = {
      expressiveness: options.expressiveness ?? 0.7,
    }
    const prosodyTokens = applyProsody(rawTokens, prosodyOpts)

    // Resolve all tokens to their phoneme configs + prosody modifiers
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

    for (let i = 0; i < resolved.length; i++) {
      if (cancelled) break

      const cur = resolved[i]
      const prev = i > 0 ? resolved[i - 1] : null
      const next = i < resolved.length - 1 ? resolved[i + 1] : null
      const timing = COARTIC[cur.ph.type]

      // Notify UI
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
      })

      // Adjust timing for consonant clusters
      const adjTiming = adjustTimingForContext(timing, cur, prev, next)
      const onsetMs = cur.durationMs * adjTiming.onset
      const steadyMs = cur.durationMs * adjTiming.steady
      const offsetMs = cur.durationMs * adjTiming.offset

      // ── Transient burst + aspiration ──
      if (cur.ph.transient) {
        await engine.transientBurst(cur.ph.transient, cur.pitchHz)

        // Aspiration after voiceless stops — only before vowels or glides.
        // In clusters like "st" or "sk", no aspiration occurs.
        const nextIsVowelLike = next && (next.ph.type === 'vowel' || next.ph.type === 'glide')
        if (!cur.ph.voiced && nextIsVowelLike) {
          const aspBands = next.bands.map(g => g * 0.3)
          engine.applyFrame({
            voiced: false,
            noise: 0.6,
            pitchHz: cur.pitchHz,
            bands: aspBands,
          }, 5)
          await sleep(30)
          if (cancelled) break
        }
      }

      // ── Phase 1: Onset transition ──
      // Consonant clusters use tighter blending (jump to target faster)

      if (onsetMs > 5) {
        const prevBands = prev ? prev.bands : SILENCE_BANDS
        const blendToward = (prev && isConsonant(prev.ph.type) && isConsonant(cur.ph.type)) ? 0.75 : 0.5
        const onsetBands = blendBands(prevBands, cur.bands, blendToward)
        const prevAmp = prev?.ph.voicedAmp ?? 0
        const onsetFrame: VoderFrame = {
          voiced: cur.ph.voiced,
          voicedAmp: prevAmp * 0.5 + cur.ph.voicedAmp * 0.5,
          noise: cur.ph.noise,
          pitchHz: cur.pitchHz,
          bands: onsetBands,
        }
        engine.applyFrame(onsetFrame, onsetMs * 0.8)
        await sleep(Math.max(5, onsetMs - 5))
        if (cancelled) break
      }

      // ── Phase 2: Steady state (or diphthong glide) ──
      if (cur.ph.onsetBands && cur.ph.offsetBands && steadyMs > 20) {
        // Diphthong: glide from onset vowel target to offset vowel target
        const halfMs = steadyMs / 2
        const amp = cur.ampMul

        // First half: onset vowel target
        engine.applyFrame({
          voiced: cur.ph.voiced,
          voicedAmp: cur.ph.voicedAmp,
          noise: cur.ph.noise,
          pitchHz: cur.pitchHz,
          bands: cur.ph.onsetBands.map(g => g * amp),
        }, Math.min(onsetMs * 0.5, 20))
        await sleep(Math.max(5, halfMs - 5))
        if (cancelled) break

        // Second half: glide to offset vowel target
        engine.applyFrame({
          voiced: cur.ph.voiced,
          voicedAmp: cur.ph.voicedAmp,
          noise: cur.ph.noise,
          pitchHz: cur.pitchHz,
          bands: cur.ph.offsetBands.map(g => g * amp),
        }, halfMs)
        await sleep(Math.max(5, halfMs - 5))
        if (cancelled) break
      } else {
        // Normal phoneme: hold at target
        const steadyFrame: VoderFrame = {
          voiced: cur.ph.voiced,
          voicedAmp: cur.ph.voicedAmp,
          noise: cur.ph.noise,
          pitchHz: cur.pitchHz,
          bands: cur.bands,
        }
        engine.applyFrame(steadyFrame, Math.min(onsetMs * 0.5, 25))
        if (steadyMs > 5) {
          await sleep(Math.max(5, steadyMs - 5))
          if (cancelled) break
        }
      }

      // ── Phase 3: Offset transition toward next phoneme ──
      if (offsetMs > 5 && next) {
        // Consonant clusters blend more aggressively toward the next target
        const ccCluster = isConsonant(cur.ph.type) && isConsonant(next.ph.type)
        const blendFwd = ccCluster ? 0.6 : 0.4
        const blendKeep = 1.0 - blendFwd

        const offsetBands = blendBands(cur.bands, next.bands, blendFwd)
        const offsetVoiced = next.ph.voiced || cur.ph.voiced
        const offsetNoise = cur.ph.noise * blendKeep + (next.ph.noise ?? 0) * blendFwd
        const offsetPitch = cur.pitchHz * blendKeep + next.pitchHz * blendFwd

        const offsetFrame: VoderFrame = {
          voiced: offsetVoiced,
          voicedAmp: cur.ph.voicedAmp * blendKeep + next.ph.voicedAmp * blendFwd,
          noise: offsetNoise,
          pitchHz: offsetPitch,
          bands: offsetBands,
        }
        engine.applyFrame(offsetFrame, offsetMs)
        await sleep(Math.max(5, offsetMs - 5))
      } else if (offsetMs > 5) {
        // No next phoneme — fade to silence
        const fadeFrame: VoderFrame = {
          voiced: cur.ph.voiced,
          voicedAmp: cur.ph.voicedAmp * 0.3,
          noise: cur.ph.noise * 0.3,
          pitchHz: cur.pitchHz,
          bands: cur.bands.map(g => g * 0.3),
        }
        engine.applyFrame(fadeFrame, offsetMs)
        await sleep(Math.max(5, offsetMs - 5))
      }

      if (cancelled) break

      // Insert pause if prosody dictates
      if (cur.pauseAfterMs > 0) {
        engine.applyFrame({
          voiced: false,
          noise: 0,
          pitchHz: cur.pitchHz,
          bands: SILENCE_BANDS,
        }, 20)
        await sleep(cur.pauseAfterMs)
      }
    }

    // Final ramp to silence
    engine.applyFrame({
      voiced: false,
      noise: 0.0,
      pitchHz: options.basePitch,
      bands: SILENCE_BANDS,
    }, 60)

    options.onDone?.()
  })()

  return {
    cancel: () => { cancelled = true },
    done: promise,
  }
}
