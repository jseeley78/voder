/**
 * Phonetically balanced test set for speech intelligibility testing.
 *
 * Combines:
 * - MRT-derived monosyllables for consonant discrimination
 * - Coverage words to hit all 39 ARPAbet phonemes
 * - Short phrases for coarticulation testing
 *
 * Each word is annotated with key phonemes being tested.
 */

export interface TestWord {
  text: string
  /** Primary phonemes this word tests */
  tests: string[]
  /** Category for grouping results */
  category: 'vowel' | 'stop' | 'fricative' | 'nasal' | 'liquid' | 'glide' | 'affricate' | 'phrase'
}

export const TEST_WORDS: TestWord[] = [
  // ── Vowels (one word per vowel phoneme, stressed position) ──
  { text: 'beat',   tests: ['IY'],       category: 'vowel' },
  { text: 'bit',    tests: ['IH'],       category: 'vowel' },
  { text: 'bet',    tests: ['EH'],       category: 'vowel' },
  { text: 'bat',    tests: ['AE'],       category: 'vowel' },
  { text: 'bot',    tests: ['AA'],       category: 'vowel' },
  { text: 'bought', tests: ['AO'],       category: 'vowel' },
  { text: 'but',    tests: ['AH'],       category: 'vowel' },
  { text: 'book',   tests: ['UH'],       category: 'vowel' },
  { text: 'boot',   tests: ['UW'],       category: 'vowel' },
  { text: 'bird',   tests: ['ER'],       category: 'vowel' },
  { text: 'boat',   tests: ['OW'],       category: 'vowel' },
  { text: 'buy',    tests: ['AY'],       category: 'vowel' },
  { text: 'boy',    tests: ['OY'],       category: 'vowel' },
  { text: 'how',    tests: ['AW'],       category: 'vowel' },
  { text: 'say',    tests: ['EY'],       category: 'vowel' },

  // ── Stops (voiced/unvoiced pairs at each place of articulation) ──
  { text: 'pat',    tests: ['P'],        category: 'stop' },
  { text: 'bat',    tests: ['B'],        category: 'stop' },
  { text: 'top',    tests: ['T'],        category: 'stop' },
  { text: 'dog',    tests: ['D'],        category: 'stop' },
  { text: 'cat',    tests: ['K'],        category: 'stop' },
  { text: 'go',     tests: ['G'],        category: 'stop' },

  // ── Fricatives ──
  { text: 'fat',    tests: ['F'],        category: 'fricative' },
  { text: 'van',    tests: ['V'],        category: 'fricative' },
  { text: 'sit',    tests: ['S'],        category: 'fricative' },
  { text: 'zoo',    tests: ['Z'],        category: 'fricative' },
  { text: 'she',    tests: ['SH'],       category: 'fricative' },
  { text: 'thin',   tests: ['TH'],       category: 'fricative' },
  { text: 'the',    tests: ['DH'],       category: 'fricative' },
  { text: 'hat',    tests: ['HH'],       category: 'fricative' },
  { text: 'beige',  tests: ['ZH'],       category: 'fricative' },

  // ── Nasals ──
  { text: 'man',    tests: ['M', 'N'],   category: 'nasal' },
  { text: 'ring',   tests: ['NG'],       category: 'nasal' },
  { text: 'ten',    tests: ['N'],        category: 'nasal' },

  // ── Liquids ──
  { text: 'let',    tests: ['L'],        category: 'liquid' },
  { text: 'red',    tests: ['R'],        category: 'liquid' },

  // ── Glides ──
  { text: 'wet',    tests: ['W'],        category: 'glide' },
  { text: 'yes',    tests: ['Y'],        category: 'glide' },

  // ── Affricates ──
  { text: 'chin',   tests: ['CH'],       category: 'affricate' },
  { text: 'jam',    tests: ['JH'],       category: 'affricate' },

  // ── MRT minimal pairs (consonant discrimination) ──
  { text: 'kit',    tests: ['K', 'IH'],  category: 'stop' },
  { text: 'hit',    tests: ['HH', 'IH'], category: 'fricative' },
  { text: 'fit',    tests: ['F', 'IH'],  category: 'fricative' },
  { text: 'wit',    tests: ['W', 'IH'],  category: 'glide' },
  { text: 'bed',    tests: ['B', 'EH'],  category: 'stop' },
  { text: 'red',    tests: ['R', 'EH'],  category: 'liquid' },
  { text: 'led',    tests: ['L', 'EH'],  category: 'liquid' },
  { text: 'sun',    tests: ['S', 'AH'],  category: 'fricative' },
  { text: 'run',    tests: ['R', 'AH'],  category: 'liquid' },
  { text: 'gun',    tests: ['G', 'AH'],  category: 'stop' },
  { text: 'no',     tests: ['N', 'OW'],  category: 'nasal' },

  // ── Short phrases (coarticulation + connected speech) ──
  { text: 'she saw me',        tests: ['SH', 'S', 'M'],  category: 'phrase' },
  { text: 'hello',             tests: ['HH', 'L', 'OW'], category: 'phrase' },
  { text: 'good morning',      tests: ['G', 'M', 'NG'],  category: 'phrase' },
  { text: 'thank you',         tests: ['TH', 'NG', 'Y'], category: 'phrase' },
  { text: 'one two three',     tests: ['W', 'T', 'TH'],  category: 'phrase' },
]

/** All unique words/phrases */
export const ALL_TEST_TEXTS = TEST_WORDS.map(w => w.text)

/** Just the single words (no phrases) */
export const SINGLE_WORDS = TEST_WORDS.filter(w => w.category !== 'phrase').map(w => w.text)

/** Just the phrases */
export const PHRASES = TEST_WORDS.filter(w => w.category === 'phrase').map(w => w.text)
