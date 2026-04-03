/**
 * A/B phoneme testing — "eye doctor" style.
 *
 * For each proposed change, plays test words with CURRENT vs PROPOSED
 * settings (randomized as A/B). User votes: A better, B better, Same.
 */

import { PHONEMES } from './phonemes'
import { VoderEngine } from './engine'
import { speakPhonemeSequence } from './sequencer'
import { textToPhonemes } from './text-to-phoneme'

export interface PhonemeProposal {
  phoneme: string
  reason: string
  currentBands: number[]
  proposedBands: number[]
  currentDuration?: number
  proposedDuration?: number
  testWords: string[]
}

// Whisper tuner v2 findings + some from contrast optimizer
export const PROPOSALS: PhonemeProposal[] = [
  // ── Whisper tuner duration changes ──
  {
    phoneme: 'IH',
    reason: 'Whisper: shorten IH + reduce B5 (was too slow, muddied words)',
    currentBands: [0.25, 0.72, 0.30, 0.12, 0.15, 0.40, 0.82, 0.50, 0.05, 0],
    proposedBands: [0.25, 0.72, 0.30, 0.12, 0.05, 0.40, 0.82, 0.50, 0.05, 0],
    currentDuration: 160,
    proposedDuration: 120,
    testWords: ['six', 'this', 'him', 'big', 'is'],
  },
  {
    phoneme: 'R',
    reason: 'Whisper: shorten R significantly (was dragging, slowing words)',
    currentBands: [0.25, 0.55, 0.40, 0.15, 0.50, 0.50, 0.10, 0.15, 0.03, 0],
    proposedBands: [0.25, 0.55, 0.40, 0.15, 0.50, 0.50, 0.10, 0.15, 0.03, 0],
    currentDuration: 115,
    proposedDuration: 75,
    testWords: ['three', 'four', 'zero', 'robot', 'run'],
  },
  {
    phoneme: 'S',
    reason: 'Whisper: lengthen S + add B2 (sibilance needs more time to read)',
    currentBands: [0, 0, 0, 0.02, 0.05, 0.15, 0.40, 0.80, 1.00, 0.85],
    proposedBands: [0, 0.08, 0, 0.02, 0.05, 0.15, 0.40, 0.80, 1.00, 0.85],
    currentDuration: 130,
    proposedDuration: 155,
    testWords: ['six', 'seven', 'yes', 'speech', 'see'],
  },
  {
    phoneme: 'F',
    reason: 'Whisper: lengthen F (fricative needs more time)',
    currentBands: [0, 0, 0.02, 0.05, 0.10, 0.30, 0.50, 0.70, 0.50, 0.20],
    proposedBands: [0, 0, 0.02, 0.05, 0.10, 0.30, 0.50, 0.70, 0.50, 0.20],
    currentDuration: 120,
    proposedDuration: 135,
    testWords: ['five', 'four', 'for', 'from', 'first'],
  },
  {
    phoneme: 'V',
    reason: 'Whisper: lengthen V + more B3 (voiced fricative needs body)',
    currentBands: [0.22, 0.18, 0.08, 0.08, 0.12, 0.32, 0.55, 0.75, 0.55, 0.22],
    proposedBands: [0.22, 0.18, 0.23, 0.08, 0.12, 0.32, 0.55, 0.75, 0.55, 0.22],
    currentDuration: 115,
    proposedDuration: 130,
    testWords: ['five', 'seven', 'very', 'over', 'have'],
  },
  {
    phoneme: 'Z',
    reason: 'Whisper: shorten Z slightly (was dragging at end of words)',
    currentBands: [0.20, 0.10, 0.03, 0.03, 0.05, 0.15, 0.40, 0.80, 1.00, 0.85],
    proposedBands: [0.20, 0.10, 0.03, 0.03, 0.05, 0.15, 0.40, 0.80, 1.00, 0.85],
    currentDuration: 120,
    proposedDuration: 105,
    testWords: ['zero', 'is', 'his', 'as', 'because'],
  },
  {
    phoneme: 'W',
    reason: 'Whisper: lengthen W (glide needs more transition time)',
    currentBands: [0.30, 0.76, 0.56, 0.15, 0.00, 0.00, 0.03, 0.02, 0, 0],
    proposedBands: [0.30, 0.76, 0.56, 0.15, 0.00, 0.00, 0.03, 0.02, 0, 0],
    currentDuration: 100,
    proposedDuration: 115,
    testWords: ['one', 'we', 'when', 'world', 'with'],
  },
  // ── Whisper band gain changes ──
  {
    phoneme: 'EH',
    reason: 'Whisper: boost B1, zero B5 (sharper formant peaks)',
    currentBands: [0.25, 0.25, 0.85, 0.18, 0.12, 0.95, 0.45, 0.35, 0.04, 0],
    proposedBands: [0.33, 0.25, 0.85, 0.18, 0.00, 0.95, 0.45, 0.35, 0.04, 0],
    testWords: ['ten', 'seven', 'get', 'yes', 'every'],
  },
  {
    phoneme: 'OW',
    reason: 'Whisper: reduce B2 (was too bright for a back vowel)',
    currentBands: [0.30, 0.35, 0.75, 0.30, 0.65, 0.12, 0.40, 0.30, 0.03, 0],
    proposedBands: [0.30, 0.20, 0.75, 0.30, 0.65, 0.12, 0.40, 0.30, 0.03, 0],
    testWords: ['zero', 'no', 'go', 'over', 'hello'],
  },
  {
    phoneme: 'AY',
    reason: 'Whisper: boost B1 (needs more fundamental for diphthong onset)',
    currentBands: [0.25, 0.22, 0.40, 0.75, 0.45, 0.45, 0.55, 0.35, 0.04, 0],
    proposedBands: [0.33, 0.22, 0.40, 0.75, 0.45, 0.45, 0.55, 0.35, 0.04, 0],
    testWords: ['five', 'nine', 'my', 'time', 'light'],
  },

  // ── CMA-ES v2 global: voiced gain down, noise up ──
  // These test the v2 optimizer's finding that voiced should be quieter
  // and noise louder. Approximated by adjusting voicedAmp on a common vowel.
  {
    phoneme: 'AH',
    reason: 'CMA-ES v2: lower voicedAmp (0.65 vs 1.00) — optimizer found quieter voiced source',
    currentBands: [0.15, 0.36, 1.00, 0.47, 0.20, 0.12, 0.05, 0.10, 0.12, 0.48],
    proposedBands: [0.15, 0.36, 1.00, 0.47, 0.20, 0.12, 0.05, 0.10, 0.12, 0.48],
    currentDuration: 170,
    proposedDuration: 170,
    testWords: ['but', 'up', 'one', 'love', 'some'],
  },
]

// ─── A/B test state ───

export interface ABTestState {
  currentIndex: number
  results: Array<{ phoneme: string; vote: 'a' | 'b' | 'same' | null; aIsProposed: boolean }>
  engine: VoderEngine | null
}

export function createABTest(): ABTestState {
  const results = PROPOSALS.map(p => ({
    phoneme: p.phoneme,
    vote: null as 'a' | 'b' | 'same' | null,
    aIsProposed: Math.random() > 0.5,
  }))
  return { currentIndex: 0, results, engine: null }
}

/** Play a word using specific band gains and duration for a phoneme */
export async function playWithGains(
  engine: VoderEngine,
  word: string,
  phoneme: string,
  bands: number[],
  duration?: number,
): Promise<void> {
  // Temporarily override the phoneme's bands and duration
  const origBands = [...PHONEMES[phoneme].bands]
  const origDur = PHONEMES[phoneme].durationMs

  for (let i = 0; i < 10; i++) PHONEMES[phoneme].bands[i] = bands[i]
  if (duration != null) PHONEMES[phoneme].durationMs = duration

  const result = textToPhonemes(word)
  await speakPhonemeSequence(engine, result.phonemes, {
    defaultDurationMs: 110,
    transitionMs: 35,
    basePitch: 110,
    rateScale: 1.0,
    expressiveness: 0.7,
    humanize: 0,
  }).done

  // Restore
  for (let i = 0; i < 10; i++) PHONEMES[phoneme].bands[i] = origBands[i]
  PHONEMES[phoneme].durationMs = origDur
}

/** Get summary of results */
export function getABResults(state: ABTestState): {
  apply: string[]
  reject: string[]
  same: string[]
} {
  const apply: string[] = []
  const reject: string[] = []
  const same: string[] = []

  for (const r of state.results) {
    if (r.vote === 'same' || r.vote === null) {
      same.push(r.phoneme)
    } else if ((r.vote === 'a' && r.aIsProposed) || (r.vote === 'b' && !r.aIsProposed)) {
      apply.push(r.phoneme)
    } else {
      reject.push(r.phoneme)
    }
  }

  return { apply, reject, same }
}
