/**
 * A/B phoneme testing — "eye doctor" style.
 *
 * For each phoneme the contrast optimizer wants to change,
 * plays a test word with the CURRENT gains and the PROPOSED gains
 * (randomized as A/B so the user doesn't know which is which).
 * User votes: A better, B better, or Same.
 *
 * Results determine which optimizer changes to keep.
 */

import { PHONEMES } from './phonemes'
import { VoderEngine } from './engine'
import { speakPhonemeSequence } from './sequencer'
import { textToPhonemes } from './text-to-phoneme'

// ─── Proposed changes from contrast optimizer ───
// Only phonemes where the optimizer found meaningful improvements

export interface PhonemeProposal {
  phoneme: string
  reason: string
  currentBands: number[]
  proposedBands: number[]
  testWords: string[]  // words containing this phoneme
}

export const PROPOSALS: PhonemeProposal[] = [
  {
    phoneme: 'IY',
    reason: 'Sharpen F1(B2) and F2(B7) peaks, reduce B4-B6 leakage',
    currentBands: [0.25, 0.85, 0.10, 0.05, 0.08, 0.12, 0.95, 0.65, 0.08, 0],
    proposedBands: [0.25, 1.00, 0.10, 0.05, 0.08, 0.12, 1.00, 0.81, 0.08, 0],
    testWords: ['see', 'three', 'be', 'me'],
  },
  {
    phoneme: 'EH',
    reason: 'Stronger F1(B3) and F2(B6) contrast, reduce B4',
    currentBands: [0.25, 0.25, 0.85, 0.18, 0.12, 0.95, 0.45, 0.35, 0.04, 0],
    proposedBands: [0.25, 0.25, 1.00, 0.02, 0.12, 1.00, 0.61, 0.51, 0.04, 0],
    testWords: ['ten', 'seven', 'when', 'get'],
  },
  {
    phoneme: 'AH',
    reason: 'Sharpen F1(B3-B4) and F2(B5), reduce upper band spread',
    currentBands: [0.25, 0.22, 0.55, 0.65, 0.88, 0.35, 0.42, 0.32, 0.03, 0],
    proposedBands: [0.25, 0.22, 0.55, 0.90, 1.00, 0.35, 0.42, 0.10, 0.03, 0],
    testWords: ['one', 'but', 'the', 'up'],
  },
  {
    phoneme: 'AO',
    reason: 'Concentrate energy in B3, reduce B5 leakage',
    currentBands: [0.30, 0.30, 0.80, 0.65, 0.25, 0.10, 0.38, 0.30, 0.03, 0],
    proposedBands: [0.30, 0.30, 0.96, 0.81, 0.05, 0.10, 0.38, 0.30, 0.03, 0],
    testWords: ['four', 'all', 'or', 'call'],
  },
  {
    phoneme: 'CH',
    reason: 'Shift burst energy higher (B6-B7), differentiate from JH',
    currentBands: [0, 0, 0.03, 0.08, 0.20, 0.50, 0.90, 0.70, 0.35, 0.15],
    proposedBands: [0, 0, 0.11, 0.32, 0.44, 0.74, 1.00, 0.94, 0.35, 0.07],
    testWords: ['each', 'change', 'which'],
  },
  {
    phoneme: 'DH',
    reason: 'More B1 presence, shift noise energy up to differentiate from TH',
    currentBands: [0.25, 0.20, 0.08, 0.08, 0.15, 0.30, 0.40, 0.35, 0.20, 0.10],
    proposedBands: [0.41, 0.36, 0.08, 0.08, 0.15, 0.46, 0.56, 0.51, 0.20, 0.10],
    testWords: ['the', 'they', 'this', 'that'],
  },
  {
    phoneme: 'NG',
    reason: 'More B3 energy to differentiate from N',
    currentBands: [0.35, 0.40, 0.48, 0.28, 0.10, 0.04, 0.02, 0.02, 0, 0],
    proposedBands: [0.35, 0.32, 0.56, 0.36, 0.18, 0.12, 0.10, 0.10, 0, 0],
    testWords: ['running', 'sing', 'thing'],
  },
  {
    phoneme: 'HH',
    reason: 'Reshape: more B5 energy, less B6-B7',
    currentBands: [0.02, 0.05, 0.10, 0.15, 0.25, 0.30, 0.25, 0.20, 0.12, 0.05],
    proposedBands: [0.10, 0.13, 0.18, 0.23, 0.33, 0.38, 0.25, 0.20, 0.04, 0.05],
    testWords: ['hello', 'how', 'he', 'her'],
  },
  {
    phoneme: 'F',
    reason: 'Boost B1 presence, sharpen high-frequency peak at B8',
    currentBands: [0, 0, 0.02, 0.05, 0.10, 0.30, 0.50, 0.70, 0.50, 0.20],
    proposedBands: [0.16, 0, 0.08, 0.11, 0.10, 0.40, 0.50, 0.86, 0.50, 0.20],
    testWords: ['five', 'for', 'from', 'first'],
  },
  {
    phoneme: 'W',
    reason: 'Reduce upper band spread, concentrate in B2-B3',
    currentBands: [0.30, 0.70, 0.50, 0.15, 0.08, 0.05, 0.03, 0.02, 0, 0],
    proposedBands: [0.30, 0.76, 0.56, 0.15, 0.00, 0.00, 0.03, 0.02, 0, 0],
    testWords: ['when', 'we', 'world', 'one'],
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
    aIsProposed: Math.random() > 0.5,  // randomize which is A vs B
  }))
  return { currentIndex: 0, results, engine: null }
}

/** Play a word using specific band gains for a phoneme */
export async function playWithGains(
  engine: VoderEngine,
  word: string,
  phoneme: string,
  bands: number[],
): Promise<void> {
  // Temporarily override the phoneme's bands
  const original = [...PHONEMES[phoneme].bands]
  for (let i = 0; i < 10; i++) PHONEMES[phoneme].bands[i] = bands[i]

  const result = textToPhonemes(word)
  await speakPhonemeSequence(engine, result.phonemes, {
    defaultDurationMs: 110,
    transitionMs: 35,
    basePitch: 110,
    rateScale: 1.0,
    expressiveness: 0.7,
    humanize: 0,  // no randomness for A/B comparison
  }).done

  // Restore original
  for (let i = 0; i < 10; i++) PHONEMES[phoneme].bands[i] = original[i]
}

/** Get summary of results */
export function getABResults(state: ABTestState): {
  apply: string[]   // phonemes where proposed was better
  reject: string[]  // phonemes where current was better
  same: string[]    // no difference
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
