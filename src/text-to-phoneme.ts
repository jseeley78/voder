/**
 * Text-to-phoneme conversion using the CMU Pronouncing Dictionary.
 *
 * Converts English text into ARPAbet phoneme sequences with stress
 * markers, word boundaries, and punctuation — ready for the prosody
 * engine and sequencer.
 *
 * Example:
 *   "Hello, how are you?" → "HH AH0 L OW1 , | HH AW1 | AA1 R | Y UW1 ?"
 */

import { dictionary } from 'cmu-pronouncing-dictionary'

// Punctuation that affects prosody (passed through as tokens)
const PROSODY_PUNCT = new Set([',', '.', '?', '!', ';', ':'])

// Custom pronunciations for words missing from the CMU dictionary.
// Add entries here as needed — same ARPAbet format with stress markers.
const CUSTOM_WORDS: Record<string, string> = {
  voder:    'V OW1 D ER0',
  vocoder:  'V OW1 K OW2 D ER0',
  dudley:   'D AH1 D L IY0',
}

/**
 * Look up a word in the CMU dictionary (with custom overrides).
 * Returns the phoneme string (e.g. "HH AH0 L OW1") or null.
 */
function lookupWord(word: string): string | null {
  const lower = word.toLowerCase().replace(/['']/g, "'")
  // Custom words first (allows overriding CMU entries too)
  if (CUSTOM_WORDS[lower]) return CUSTOM_WORDS[lower]
  // CMU dictionary
  if (dictionary[lower]) return dictionary[lower]
  // Try without trailing 's for possessives
  if (lower.endsWith("'s")) {
    const base = CUSTOM_WORDS[lower.slice(0, -2)] ?? dictionary[lower.slice(0, -2)]
    if (base) return base + ' Z'
  }
  return null
}

/**
 * Simple letter-to-phoneme fallback for words not in the dictionary.
 * This is crude but better than silence. Maps individual letters
 * to their "name" pronunciation.
 */
function spellOut(word: string): string {
  const letterPhonemes: Record<string, string> = {
    a: 'EY1', b: 'B IY1', c: 'S IY1', d: 'D IY1', e: 'IY1',
    f: 'EH1 F', g: 'JH IY1', h: 'EY1 CH', i: 'AY1', j: 'JH EY1',
    k: 'K EY1', l: 'EH1 L', m: 'EH1 M', n: 'EH1 N', o: 'OW1',
    p: 'P IY1', q: 'K Y UW1', r: 'AA1 R', s: 'EH1 S', t: 'T IY1',
    u: 'Y UW1', v: 'V IY1', w: 'D AH1 B AH0 L Y UW0', x: 'EH1 K S',
    y: 'W AY1', z: 'Z IY1',
  }
  const phonemes: string[] = []
  for (const ch of word.toLowerCase()) {
    if (letterPhonemes[ch]) {
      phonemes.push(letterPhonemes[ch])
    }
  }
  return phonemes.join(' | ') || 'AH0'
}

/**
 * Convert a number to English words.
 * 42 → "forty two", 1000 → "one thousand", etc.
 */
function numberToWords(n: number): string {
  if (n === 0) return 'zero'
  if (n < 0) return 'negative ' + numberToWords(-n)

  const ones = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

  function chunk(num: number): string {
    if (num === 0) return ''
    if (num < 20) return ones[num]
    if (num < 100) return tens[Math.floor(num / 10)] + (num % 10 ? ' ' + ones[num % 10] : '')
    if (num < 1000) return ones[Math.floor(num / 100)] + ' hundred' + (num % 100 ? ' ' + chunk(num % 100) : '')
    return ''
  }

  const parts: string[] = []
  const scales = [
    [1_000_000_000, 'billion'],
    [1_000_000, 'million'],
    [1_000, 'thousand'],
    [1, ''],
  ] as const

  let remaining = Math.floor(Math.abs(n))
  for (const [divisor, label] of scales) {
    const count = Math.floor(remaining / divisor)
    if (count > 0) {
      parts.push(chunk(count) + (label ? ' ' + label : ''))
      remaining %= divisor
    }
  }

  return parts.join(' ') || 'zero'
}

/**
 * Tokenize input text into words, numbers, and punctuation.
 * "Hello, how are you?" → ["Hello", ",", "how", "are", "you", "?"]
 * "I have 42 cats." → ["I", "have", "forty", "two", "cats", "."]
 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  // Match words, numbers, or individual punctuation
  const regex = /[a-zA-Z]+(?:[''][a-zA-Z]+)*|\d+(?:\.\d+)?|[,.\?!;:]/g
  let match
  while ((match = regex.exec(text)) !== null) {
    const tok = match[0]
    // Convert numbers to word tokens
    if (/^\d/.test(tok)) {
      const num = parseFloat(tok)
      if (tok.includes('.')) {
        // Decimal: "3.14" → "three point one four"
        const [whole, frac] = tok.split('.')
        const words = [numberToWords(parseInt(whole)), 'point']
        for (const digit of frac) {
          words.push(numberToWords(parseInt(digit)))
        }
        tokens.push(...words)
      } else {
        const words = numberToWords(num).split(' ')
        tokens.push(...words)
      }
    } else {
      tokens.push(tok)
    }
  }
  return tokens
}

export interface WordSpan {
  word: string
  /** Index of first phoneme token belonging to this word */
  startToken: number
  /** Index past the last phoneme token */
  endToken: number
}

export interface TextToPhonemeResult {
  /** Phoneme sequence ready for the sequencer (space-separated tokens) */
  phonemes: string
  /** Words that weren't found in the dictionary */
  unknownWords: string[]
  /** Maps each source word to its phoneme token range */
  wordSpans: WordSpan[]
}

/**
 * Convert English text to a phoneme sequence.
 *
 * Returns a string of space-separated ARPAbet tokens with:
 *   - Stress markers on vowels (0, 1, 2)
 *   - Word boundaries (|)
 *   - Punctuation tokens (, . ? !)
 */
export function textToPhonemes(text: string): TextToPhonemeResult {
  const words = tokenize(text)
  const parts: string[] = []
  const unknownWords: string[] = []
  const wordSpans: WordSpan[] = []

  // Track phoneme token count (excluding | and punctuation)
  let tokenIdx = 0

  for (let i = 0; i < words.length; i++) {
    const word = words[i]

    // Pass through punctuation directly
    if (PROSODY_PUNCT.has(word)) {
      parts.push(word)
      continue
    }

    // Add word boundary before each word (except the first)
    if (parts.length > 0) {
      parts.push('|')
    }

    // Look up the word
    const phonemes = lookupWord(word)
    const phStr = phonemes ?? spellOut(word)
    if (!phonemes) unknownWords.push(word)

    // Count how many phoneme tokens this word produces
    const phTokens = phStr.split(/\s+/).filter(t => t !== '|' && !PROSODY_PUNCT.has(t))
    const startToken = tokenIdx
    tokenIdx += phTokens.length

    wordSpans.push({ word, startToken, endToken: tokenIdx })
    parts.push(phStr)
  }

  return {
    phonemes: parts.join(' '),
    unknownWords,
    wordSpans,
  }
}
