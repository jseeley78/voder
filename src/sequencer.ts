import type { VoderEngine } from './engine'
import { PHONEMES } from './phonemes'

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export interface SequenceOptions {
  defaultDurationMs: number
  transitionMs: number
  basePitch: number
  rateScale: number
  onToken?: (index: number, token: string) => void
  onDone?: () => void
}

export interface SequenceHandle {
  cancel: () => void
  done: Promise<void>
}

export function speakPhonemeSequence(
  engine: VoderEngine,
  input: string,
  options: SequenceOptions,
): SequenceHandle {
  let cancelled = false

  const promise = (async () => {
    const tokens = input.trim().split(/\s+/).filter(Boolean).map(x => x.toUpperCase())
    if (!tokens.length) return

    for (let i = 0; i < tokens.length; i++) {
      if (cancelled) break

      const tok = tokens[i]
      const ph = PHONEMES[tok]
      if (!ph) {
        options.onToken?.(i, `?${tok}`)
        await sleep(90)
        continue
      }

      options.onToken?.(i, tok)

      const durationMs = (ph.durationMs || options.defaultDurationMs) / options.rateScale

      if (ph.transient) {
        await engine.transientBurst(ph.transient, options.basePitch)
      }

      engine.applyPhoneme(ph, options.basePitch, options.transitionMs)
      await sleep(Math.max(10, durationMs - 8))
    }

    // Ramp to silence
    engine.applyFrame({
      voiced: false,
      noise: 0.0,
      pitchHz: options.basePitch,
      bands: Array(10).fill(0),
    }, 45)

    options.onDone?.()
  })()

  return {
    cancel: () => { cancelled = true },
    done: promise,
  }
}
