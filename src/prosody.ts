/**
 * Prosody engine — transforms a flat phoneme sequence into one with
 * expressive pitch contours, stress-based timing, and amplitude variation.
 *
 * Models three levels of prosodic structure:
 *   1. Syllable-level: stress → pitch/duration/amplitude
 *   2. Phrase-level: pitch arc (high onset, gradual fall), nuclear accent
 *   3. Sentence-level: declination, question rise, exclamation boost
 *
 * Input tokens can include:
 *   - CMU-style stress markers on vowels: AH0, AH1, AH2
 *   - Punctuation tokens: , . ? ! ; :
 *   - Plain phonemes without stress (default to moderate stress)
 *   - Word boundaries: |
 */

// Vowel phonemes that can carry stress
const VOWELS = new Set([
  'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW',
])

export interface ProsodyToken {
  phoneme: string
  stress: number
  pitchMul: number
  durationMul: number
  ampMul: number
  pauseAfterMs: number
}

export interface ProsodyOptions {
  /** How much pitch varies with stress (0 = flat, 1 = full expression) */
  expressiveness: number
  /** Sentence-level pitch declination rate */
  declination: number
}

const DEFAULT_OPTIONS: ProsodyOptions = {
  expressiveness: 0.7,
  declination: 0.012,
}

function parseToken(raw: string): { phoneme: string; stress: number } | { punct: string } | { wordBreak: true } {
  if (raw === '|') return { wordBreak: true }
  if (/^[,.\?!;:]$/.test(raw)) return { punct: raw }

  const stressMatch = raw.match(/^([A-Z]+)([012])$/)
  if (stressMatch) {
    return { phoneme: stressMatch[1], stress: parseInt(stressMatch[2]) }
  }

  const upper = raw.toUpperCase()
  if (VOWELS.has(upper)) {
    return { phoneme: upper, stress: 1 }
  }
  return { phoneme: upper, stress: -1 }
}

function detectSentenceType(tokens: string[]): 'question' | 'exclamation' | 'statement' {
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (tokens[i] === '?') return 'question'
    if (tokens[i] === '!') return 'exclamation'
    if (tokens[i] === '.') return 'statement'
  }
  return 'statement'
}

/** A phrase is a group of phonemes between pauses (punctuation/start/end) */
interface Phrase {
  startIdx: number   // index into parsed array
  endIdx: number     // exclusive
  phonemeCount: number
  lastStressedIdx: number  // index of the nuclear accent (last stressed vowel)
}

/**
 * Identify phrase boundaries from punctuation and word breaks.
 * Each phrase gets its own pitch arc.
 */
function findPhrases(parsed: Array<ReturnType<typeof parseToken>>): Phrase[] {
  const phrases: Phrase[] = []
  let start = 0

  function closePhrase(end: number) {
    // Count phonemes and find last stressed vowel in this phrase
    let count = 0
    let lastStressed = -1
    for (let j = start; j < end; j++) {
      const p = parsed[j]
      if ('phoneme' in p) {
        count++
        if (VOWELS.has(p.phoneme) && p.stress >= 1) {
          lastStressed = j
        }
      }
    }
    if (count > 0) {
      phrases.push({ startIdx: start, endIdx: end, phonemeCount: count, lastStressedIdx: lastStressed })
    }
    start = end
  }

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i]
    if ('punct' in p) {
      closePhrase(i)
      start = i + 1
    }
  }
  // Close final phrase
  closePhrase(parsed.length)

  return phrases
}

export function applyProsody(
  rawTokens: string[],
  opts: Partial<ProsodyOptions> = {},
): ProsodyToken[] {
  const o = { ...DEFAULT_OPTIONS, ...opts }
  const sentenceType = detectSentenceType(rawTokens)

  const parsed: Array<ReturnType<typeof parseToken>> = rawTokens.map(parseToken)
  const phrases = findPhrases(parsed)
  const totalPhrases = phrases.length

  // Build a lookup: for each parsed index, which phrase is it in?
  const phraseMap = new Map<number, { phrase: Phrase; phraseIdx: number }>()
  phrases.forEach((phrase, pi) => {
    for (let j = phrase.startIdx; j < phrase.endIdx; j++) {
      phraseMap.set(j, { phrase, phraseIdx: pi })
    }
  })

  // Count total phonemes for sentence-level progress
  let totalPhonemes = 0
  parsed.forEach(p => { if ('phoneme' in p) totalPhonemes++ })

  const result: ProsodyToken[] = []
  let phonemeCount = 0
  // Track phoneme count within current phrase
  let phrasePhonemeCount = 0
  let currentPhraseIdx = -1

  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i]

    // Word breaks — small pause
    if ('wordBreak' in p) {
      if (result.length > 0) {
        result[result.length - 1].pauseAfterMs += 30
      }
      continue
    }

    // Punctuation
    if ('punct' in p) {
      if (result.length > 0) {
        const prev = result[result.length - 1]
        switch (p.punct) {
          case ',':
          case ';':
          case ':':
            prev.pauseAfterMs += 150
            prev.durationMul *= 1.3
            break
          case '.':
            prev.pauseAfterMs += 220
            prev.durationMul *= 1.4
            prev.pitchMul *= 0.88
            break
          case '?':
            prev.pauseAfterMs += 200
            prev.durationMul *= 1.3
            break
          case '!':
            prev.pauseAfterMs += 200
            prev.durationMul *= 1.2
            prev.ampMul *= 1.15
            break
        }
      }
      continue
    }

    // Reset phrase phoneme counter when entering a new phrase
    const pm = phraseMap.get(i)
    if (pm && pm.phraseIdx !== currentPhraseIdx) {
      currentPhraseIdx = pm.phraseIdx
      phrasePhonemeCount = 0
    }

    const isVowel = VOWELS.has(p.phoneme)
    const sentenceProgress = totalPhonemes > 1 ? phonemeCount / (totalPhonemes - 1) : 0
    const phrase = pm?.phrase
    const phraseProgress = phrase && phrase.phonemeCount > 1
      ? phrasePhonemeCount / (phrase.phonemeCount - 1)
      : 0

    let pitchMul = 1.0
    let durationMul = 1.0
    let ampMul = 1.0

    // ── Syllable-level: stress ──
    if (isVowel && p.stress >= 0) {
      const expr = o.expressiveness
      switch (p.stress) {
        case 1:
          pitchMul += 0.12 * expr
          durationMul += 0.25 * expr
          ampMul += 0.10 * expr
          break
        case 2:
          pitchMul += 0.05 * expr
          durationMul += 0.12 * expr
          ampMul += 0.05 * expr
          break
        case 0:
          pitchMul -= 0.06 * expr
          durationMul -= 0.15 * expr
          ampMul -= 0.08 * expr
          break
      }
    }

    // ── Phrase-level: pitch arc ──
    // Each phrase starts slightly high and falls. This creates the
    // natural "hat pattern" of English intonation within each phrase.
    if (phrase) {
      // Phrase-initial boost: pitch starts ~8% above neutral, falls to ~4% below
      const phrasePitchArc = 0.08 - phraseProgress * 0.12
      pitchMul += phrasePitchArc * o.expressiveness

      // Topline declination: successive phrases start lower
      // (models the gradual pitch reset across a sentence)
      if (totalPhrases > 1 && pm) {
        const toplineDropPerPhrase = 0.03 * o.expressiveness
        pitchMul -= pm.phraseIdx * toplineDropPerPhrase
      }

      // Nuclear accent: the last stressed vowel in the phrase gets
      // an extra pitch boost — it's the most informationally prominent
      if (i === phrase.lastStressedIdx) {
        pitchMul += 0.06 * o.expressiveness
        durationMul += 0.10 * o.expressiveness
        ampMul += 0.05 * o.expressiveness
      }

      // Pre-boundary lengthening: phonemes near the end of a phrase slow down
      // (not just the last one — the whole final ~20% of the phrase)
      if (phraseProgress > 0.8) {
        const slowdown = (phraseProgress - 0.8) / 0.2  // 0→1 over last 20%
        durationMul += slowdown * 0.20 * o.expressiveness
      }
    }

    // ── Sentence-level: declination ──
    pitchMul -= sentenceProgress * o.declination * totalPhonemes * 0.10

    // ── Question rise ──
    if (sentenceType === 'question' && sentenceProgress > 0.7) {
      const riseProgress = (sentenceProgress - 0.7) / 0.3
      pitchMul += riseProgress * 0.25 * o.expressiveness
    }

    // ── Exclamation boost ──
    if (sentenceType === 'exclamation') {
      ampMul *= 1.08
      if (sentenceProgress < 0.3) pitchMul += 0.08 * o.expressiveness
    }

    // ── Phrase-initial reset ──
    // After a pause, pitch resets upward (already handled by phrase arc,
    // but add a small extra bump for perceptibility)
    if (result.length > 0 && result[result.length - 1].pauseAfterMs > 100) {
      pitchMul += 0.04 * o.expressiveness
    }

    // Clamp
    pitchMul = Math.max(0.75, Math.min(1.40, pitchMul))
    durationMul = Math.max(0.6, Math.min(1.8, durationMul))
    ampMul = Math.max(0.7, Math.min(1.3, ampMul))

    result.push({
      phoneme: p.phoneme,
      stress: p.stress,
      pitchMul,
      durationMul,
      ampMul,
      pauseAfterMs: 0,
    })
    phonemeCount++
    phrasePhonemeCount++
  }

  return result
}
