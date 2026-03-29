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
 * Tokenize input text into words and punctuation.
 * "Hello, how are you?" → ["Hello", ",", "how", "are", "you", "?"]
 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  // Match words (including contractions/apostrophes) and individual punctuation
  const regex = /[a-zA-Z]+(?:[''][a-zA-Z]+)*|[,.\?!;:]/g
  let match
  while ((match = regex.exec(text)) !== null) {
    tokens.push(match[0])
  }
  return tokens
}

export interface TextToPhonemeResult {
  /** Phoneme sequence ready for the sequencer (space-separated tokens) */
  phonemes: string
  /** Words that weren't found in the dictionary */
  unknownWords: string[]
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
    if (phonemes) {
      parts.push(phonemes)
    } else {
      unknownWords.push(word)
      parts.push(spellOut(word))
    }
  }

  return {
    phonemes: parts.join(' '),
    unknownWords,
  }
}
