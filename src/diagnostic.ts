/**
 * Offline diagnostic: analyzes phonemes individually and in word/sentence
 * context. Checks formant accuracy, vowel distinctiveness, transition
 * smoothness, energy continuity, and coarticulation blend quality.
 *
 * Run: npx tsx -e "import { runDiagnostic } from './src/diagnostic.ts'; runDiagnostic();"
 */

import { BAND_CENTERS, BAND_COMPENSATION, PHONEMES, type PhonemeConfig } from './phonemes'
import { textToPhonemes } from './text-to-phoneme'

// Known formant targets (Peterson & Barney 1952, male speakers)
const EXPECTED_FORMANTS: Record<string, { F1: number; F2: number; F3: number }> = {
  IY: { F1: 270, F2: 2290, F3: 3010 },
  IH: { F1: 390, F2: 1990, F3: 2550 },
  EH: { F1: 530, F2: 1840, F3: 2480 },
  AE: { F1: 660, F2: 1720, F3: 2410 },
  AA: { F1: 730, F2: 1090, F3: 2440 },
  AO: { F1: 570, F2: 840, F3: 2410 },
  AH: { F1: 640, F2: 1190, F3: 2390 },
  UH: { F1: 440, F2: 1020, F3: 2240 },
  UW: { F1: 300, F2: 870, F3: 2240 },
  OW: { F1: 570, F2: 1190, F3: 2300 },
  ER: { F1: 490, F2: 1350, F3: 1690 },
}

function freqToBand(freq: number): number {
  let bestIdx = 0
  let bestDist = Infinity
  for (let i = 0; i < BAND_CENTERS.length; i++) {
    const dist = Math.abs(freq - BAND_CENTERS[i])
    if (dist < bestDist) { bestDist = dist; bestIdx = i }
  }
  return bestIdx
}

function topBands(energies: number[], n: number): number[] {
  return energies.map((e, i) => ({ e, i })).sort((a, b) => b.e - a.e).slice(0, n).map(x => x.i)
}

function compensatedGains(ph: PhonemeConfig): number[] {
  return ph.bands.map((g, i) => g * BAND_COMPENSATION[i])
}

function effectiveOutput(ph: PhonemeConfig): number {
  const cg = compensatedGains(ph)
  return ph.voicedAmp * 0.30 * Math.max(...cg)
}

/** Euclidean distance between two compensated band gain vectors */
function spectralDistance(a: PhonemeConfig, b: PhonemeConfig): number {
  const ga = compensatedGains(a)
  const gb = compensatedGains(b)
  let sumSq = 0
  for (let i = 0; i < 10; i++) sumSq += (ga[i] - gb[i]) ** 2
  return Math.sqrt(sumSq)
}


// ─── Word & sentence analysis ───

interface TransitionReport {
  from: string
  to: string
  spectralDist: number
  energyRatio: number   // energy(to) / energy(from) — big drops = energy holes
  voicedSwitch: boolean // voiced↔unvoiced boundary
  issue: string | null
}

function analyzeTransition(fromPh: string, toPh: string): TransitionReport | null {
  const a = PHONEMES[fromPh]
  const b = PHONEMES[toPh]
  if (!a || !b) return null

  const dist = spectralDistance(a, b)
  const eA = a.voiced ? effectiveOutput(a) + a.noise * 0.10 : a.noise * 0.10
  const eB = b.voiced ? effectiveOutput(b) + b.noise * 0.10 : b.noise * 0.10
  const energyRatio = eA > 0.001 ? eB / eA : 0
  const voicedSwitch = a.voiced !== b.voiced

  let issue: string | null = null

  // Flag very large spectral jumps (hard for coarticulation to smooth)
  if (dist > 0.8) {
    issue = `LARGE spectral jump (${dist.toFixed(3)}) — may sound discontinuous`
  }

  // Flag energy holes (energy drops below 40% between adjacent phonemes)
  if (energyRatio < 0.4 && eA > 0.02) {
    issue = `Energy dip: ${fromPh}→${toPh} drops to ${(energyRatio * 100).toFixed(0)}% — may sound broken`
  }

  // Flag energy holes the other way
  if (energyRatio > 3.0 && eB > 0.02) {
    issue = (issue ? issue + '; ' : '') + `Energy spike: ${toPh} is ${energyRatio.toFixed(1)}x louder than ${fromPh}`
  }

  return { from: fromPh, to: toPh, spectralDist: dist, energyRatio, voicedSwitch, issue }
}

interface WordReport {
  word: string
  phonemes: string
  transitions: TransitionReport[]
  issues: string[]
  avgEnergy: number
  energyRange: string  // min-max effective output
}

function analyzeWord(word: string): WordReport {
  const result = textToPhonemes(word)
  const tokens = result.phonemes.split(/\s+/).filter(t => t !== '|' && !/^[,.\?!;:]$/.test(t))
  // Strip stress markers for lookup
  const phonemeKeys = tokens.map(t => t.replace(/[012]$/, ''))

  const transitions: TransitionReport[] = []
  const issues: string[] = []

  if (result.unknownWords.length > 0) {
    issues.push(`Unknown words: ${result.unknownWords.join(', ')}`)
  }

  // Analyze each transition
  for (let i = 0; i < phonemeKeys.length - 1; i++) {
    const tr = analyzeTransition(phonemeKeys[i], phonemeKeys[i + 1])
    if (tr) {
      transitions.push(tr)
      if (tr.issue) issues.push(`  ${tr.from}→${tr.to}: ${tr.issue}`)
    }
  }

  // Compute energy stats
  const energies = phonemeKeys.map(k => {
    const ph = PHONEMES[k]
    if (!ph) return 0
    return ph.voiced ? effectiveOutput(ph) : ph.noise * 0.10
  }).filter(e => e > 0)

  const avgEnergy = energies.length > 0 ? energies.reduce((s, e) => s + e, 0) / energies.length : 0
  const minE = energies.length > 0 ? Math.min(...energies) : 0
  const maxE = energies.length > 0 ? Math.max(...energies) : 0

  // Flag if the dynamic range within a word is extreme
  if (maxE > 0 && minE / maxE < 0.25) {
    issues.push(`Wide energy range within word: ${minE.toFixed(3)}–${maxE.toFixed(3)} (${(minE / maxE * 100).toFixed(0)}% ratio)`)
  }

  return {
    word,
    phonemes: result.phonemes,
    transitions,
    issues,
    avgEnergy,
    energyRange: `${minE.toFixed(3)}–${maxE.toFixed(3)}`,
  }
}

// ─── Test sentences ───

const TEST_WORDS = [
  'hello', 'world', 'the', 'beautiful', 'speech', 'robot',
  'string', 'splash', 'think', 'running', 'yesterday',
  'computer', 'important', 'question', 'strength',
]

const TEST_SENTENCES = [
  'Hello, how are you?',
  'The quick brown fox jumps over the lazy dog.',
  'She sells sea shells by the sea shore.',
  'When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow.',
  'I am a robot.',
  'Peter Piper picked a peck of pickled peppers.',
]

export function runDiagnostic(): string {
  const lines: string[] = []
  lines.push('=== VODER DIAGNOSTIC ===')

  // ── Individual phonemes ──
  lines.push('')
  lines.push('── VOWEL FORMANTS ──')
  const vowelKeys = Object.keys(EXPECTED_FORMANTS)
  let phonemeIssues = 0

  for (const key of vowelKeys) {
    const ph = PHONEMES[key]
    if (!ph) continue
    const cg = compensatedGains(ph)
    const peaks = topBands(cg, 3)
    const expected = EXPECTED_FORMANTS[key]
    const f1b = freqToBand(expected.F1)
    const f2b = freqToBand(expected.F2)
    const f1ok = peaks.includes(f1b) || peaks.includes(f1b - 1) || peaks.includes(f1b + 1)
    const f2ok = peaks.includes(f2b) || peaks.includes(f2b - 1) || peaks.includes(f2b + 1)
    if (!f1ok || !f2ok) phonemeIssues++
    const eff = effectiveOutput(ph)
    lines.push(`  ${key}: F1=${expected.F1}Hz→B${f1b + 1}${f1ok ? '✓' : '✗'}  F2=${expected.F2}Hz→B${f2b + 1}${f2ok ? '✓' : '✗'}  output=${eff.toFixed(3)}`)
  }

  // ── Vowel similarity ──
  lines.push('')
  lines.push('── VOWEL PAIRS (closest) ──')
  const pairs: { a: string; b: string; dist: number }[] = []
  for (let i = 0; i < vowelKeys.length; i++) {
    for (let j = i + 1; j < vowelKeys.length; j++) {
      const a = vowelKeys[i], b = vowelKeys[j]
      if (!PHONEMES[a] || !PHONEMES[b]) continue
      pairs.push({ a, b, dist: spectralDistance(PHONEMES[a], PHONEMES[b]) })
    }
  }
  pairs.sort((a, b) => a.dist - b.dist)
  for (const p of pairs.slice(0, 8)) {
    const flag = p.dist < 0.12 ? ' ⚠ VERY SIMILAR' : p.dist < 0.20 ? ' ~ close' : ''
    lines.push(`  ${p.a}/${p.b}: ${p.dist.toFixed(3)}${flag}`)
  }

  // ── Word analysis ──
  lines.push('')
  lines.push('── WORD ANALYSIS ──')
  let wordIssues = 0
  for (const word of TEST_WORDS) {
    const report = analyzeWord(word)
    const issueStr = report.issues.length > 0 ? ` ⚠ ${report.issues.length} issues` : ' ✓'
    lines.push(`  ${word.padEnd(14)} [${report.phonemes.substring(0, 40).padEnd(40)}]  energy=${report.energyRange}${issueStr}`)
    for (const issue of report.issues) {
      lines.push(`    ${issue}`)
      wordIssues++
    }
  }

  // ── Sentence analysis ──
  lines.push('')
  lines.push('── SENTENCE ANALYSIS ──')
  let sentenceIssues = 0
  for (const sentence of TEST_SENTENCES) {
    const result = textToPhonemes(sentence)
    const tokens = result.phonemes.split(/\s+/).filter(t => t !== '|' && !/^[,.\?!;:]$/.test(t))
    const phonemeKeys = tokens.map(t => t.replace(/[012]$/, ''))

    let issues = 0
    let largestJump = { dist: 0, from: '', to: '' }
    let worstDip = { ratio: 1, from: '', to: '' }

    for (let i = 0; i < phonemeKeys.length - 1; i++) {
      const tr = analyzeTransition(phonemeKeys[i], phonemeKeys[i + 1])
      if (!tr) continue
      if (tr.spectralDist > largestJump.dist) {
        largestJump = { dist: tr.spectralDist, from: tr.from, to: tr.to }
      }
      if (tr.energyRatio < worstDip.ratio && tr.energyRatio > 0) {
        worstDip = { ratio: tr.energyRatio, from: tr.from, to: tr.to }
      }
      if (tr.issue) issues++
    }

    // Count unknown words
    if (result.unknownWords.length > 0) issues++

    const maxJumpStr = `max_jump=${largestJump.from}→${largestJump.to}(${largestJump.dist.toFixed(2)})`
    const dipStr = worstDip.ratio < 0.5 ? `  worst_dip=${worstDip.from}→${worstDip.to}(${(worstDip.ratio * 100).toFixed(0)}%)` : ''
    const unknownStr = result.unknownWords.length > 0 ? `  UNKNOWN:[${result.unknownWords.join(',')}]` : ''

    lines.push(`  "${sentence.substring(0, 50)}${sentence.length > 50 ? '...' : ''}"`)
    lines.push(`    ${phonemeKeys.length} phonemes  ${issues} issues  ${maxJumpStr}${dipStr}${unknownStr}`)
    sentenceIssues += issues
  }

  // ── Summary ──
  lines.push('')
  lines.push('── SUMMARY ──')
  lines.push(`  Phoneme issues: ${phonemeIssues}`)
  lines.push(`  Word issues: ${wordIssues}`)
  lines.push(`  Sentence issues: ${sentenceIssues}`)
  lines.push('=== END DIAGNOSTIC ===')

  const output = lines.join('\n')
  console.log(output)
  return output
}
