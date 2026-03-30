/**
 * Phoneme contrast maximizer.
 *
 * Intelligibility in a 10-band system depends on each phoneme being
 * as DIFFERENT as possible from every other phoneme. This optimizer
 * maximizes the minimum pairwise spectral distance between phonemes
 * that are commonly confused.
 *
 * Fast — pure math, no Whisper calls. Runs in seconds.
 */

import { BAND_CENTERS, BAND_COMPENSATION, PHONEMES, type PhonemeConfig } from '../src/phonemes'

// ─── Confusable pairs ───
// These are phoneme pairs that listeners commonly mix up.
// Organized by type of contrast.

const CONFUSABLE_PAIRS: [string, string][] = [
  // Vowels that are spectrally close
  ['IY', 'IH'],   // beat vs bit
  ['EH', 'AE'],   // bet vs bat
  ['AH', 'AE'],   // but vs bat
  ['AA', 'AO'],   // bot vs bought
  ['UH', 'UW'],   // book vs boot
  ['AH', 'ER'],   // but vs bird
  ['OW', 'AO'],   // boat vs bought
  ['EH', 'AH'],   // bet vs but
  ['IH', 'EH'],   // bit vs bet

  // Voiced/voiceless pairs (must differ in voicing AND spectral shape)
  ['P', 'B'],
  ['T', 'D'],
  ['K', 'G'],
  ['F', 'V'],
  ['S', 'Z'],
  ['SH', 'ZH'],
  ['TH', 'DH'],
  ['CH', 'JH'],

  // Fricatives that sound similar
  ['S', 'SH'],    // see vs she
  ['F', 'TH'],    // fin vs thin
  ['S', 'TH'],    // sin vs thin
  ['Z', 'ZH'],    // zip vs measure

  // Nasals
  ['M', 'N'],
  ['N', 'NG'],

  // Liquids/glides
  ['L', 'R'],
  ['W', 'R'],

  // Stops vs fricatives
  ['T', 'S'],     // top vs sop
  ['P', 'F'],     // pat vs fat
  ['K', 'HH'],    // could vs hood

  // Vowels vs similar consonants
  ['IY', 'Y'],    // beat vs yet (glide confusion)
  ['UW', 'W'],    // boot vs wet
]

// ─── Analysis ───

function compensatedGains(bands: number[]): number[] {
  return bands.map((g, i) => g * BAND_COMPENSATION[i])
}

function spectralDistance(a: number[], b: number[]): number {
  const ga = compensatedGains(a)
  const gb = compensatedGains(b)
  let sumSq = 0
  for (let i = 0; i < 10; i++) sumSq += (ga[i] - gb[i]) ** 2
  return Math.sqrt(sumSq)
}

/** Score: weighted sum of pairwise distances. Lower minimum = worse. */
function contrastScore(gains: Record<string, number[]>): {
  minDist: number
  minPair: string
  avgDist: number
  worstPairs: { pair: string; dist: number }[]
} {
  const dists: { pair: string; dist: number }[] = []

  for (const [a, b] of CONFUSABLE_PAIRS) {
    const ga = gains[a]
    const gb = gains[b]
    if (!ga || !gb) continue
    const dist = spectralDistance(ga, gb)
    dists.push({ pair: `${a}/${b}`, dist })
  }

  dists.sort((a, b) => a.dist - b.dist)
  const minDist = dists[0]?.dist ?? 0
  const minPair = dists[0]?.pair ?? '?'
  const avgDist = dists.reduce((s, d) => s + d.dist, 0) / dists.length

  return { minDist, minPair, avgDist, worstPairs: dists.slice(0, 10) }
}

// ─── Optimization ───

// Clone gains
const gains: Record<string, number[]> = {}
for (const [ph, cfg] of Object.entries(PHONEMES)) {
  gains[ph] = [...cfg.bands]
}

// All phonemes that appear in confusable pairs
const tunablePhonemes = new Set<string>()
for (const [a, b] of CONFUSABLE_PAIRS) {
  if (PHONEMES[a]) tunablePhonemes.add(a)
  if (PHONEMES[b]) tunablePhonemes.add(b)
}

console.log('=== PHONEME CONTRAST MAXIMIZER ===')
console.log(`${CONFUSABLE_PAIRS.length} confusable pairs, ${tunablePhonemes.size} phonemes`)
console.log()

// Baseline
const baseline = contrastScore(gains)
console.log('── Baseline ──')
console.log(`  Min distance: ${baseline.minDist.toFixed(4)} (${baseline.minPair})`)
console.log(`  Avg distance: ${baseline.avgDist.toFixed(4)}`)
console.log('  Worst pairs:')
for (const wp of baseline.worstPairs) {
  console.log(`    ${wp.pair.padEnd(8)} ${wp.dist.toFixed(4)}`)
}

// Optimize: maximize minimum pairwise distance
const STEP_SIZES = [0.08, 0.05, 0.03, 0.02, 0.01, 0.008, 0.005]
const ITERS_PER_STEP = 200
let totalImprovements = 0

for (const stepSize of STEP_SIZES) {
  let stepImprovements = 0

  for (let iter = 0; iter < ITERS_PER_STEP; iter++) {
    let improved = 0

    for (const ph of tunablePhonemes) {
      const g = gains[ph]
      const before = contrastScore(gains)

      for (let b = 0; b < 10; b++) {
        const orig = g[b]

        // Sparsity constraint: don't let more than 5 bands have significant energy
        // This keeps formant peaks sharp instead of spreading energy everywhere
        function isTooDiffuse(bands: number[]): boolean {
          const activeBands = bands.filter(g => g > 0.15).length
          return activeBands > 6
        }

        // Try increase
        g[b] = Math.min(1.0, orig + stepSize)
        let after = contrastScore(gains)
        if (!isTooDiffuse(g) &&
            (after.minDist > before.minDist + 0.001 ||
            (after.minDist >= before.minDist - 0.0005 && after.avgDist > before.avgDist + 0.002))) {
          improved++
          continue
        }

        // Try decrease (always allowed — reducing energy increases sparsity)
        g[b] = Math.max(0, orig - stepSize)
        after = contrastScore(gains)
        if (after.minDist > before.minDist + 0.001 ||
            (after.minDist >= before.minDist - 0.0005 && after.avgDist > before.avgDist + 0.002)) {
          improved++
          continue
        }

        g[b] = orig // revert
      }
    }

    stepImprovements += improved
    totalImprovements += improved
    if (improved === 0) break
  }

  const score = contrastScore(gains)
  console.log(`\n  step=${stepSize.toFixed(3)}: min=${score.minDist.toFixed(4)} avg=${score.avgDist.toFixed(4)} improvements=${stepImprovements}`)
}

// Final results
const final = contrastScore(gains)
console.log('\n── Final ──')
console.log(`  Min distance: ${baseline.minDist.toFixed(4)} → ${final.minDist.toFixed(4)} (${((final.minDist/baseline.minDist - 1) * 100).toFixed(0)}% better)`)
console.log(`  Avg distance: ${baseline.avgDist.toFixed(4)} → ${final.avgDist.toFixed(4)} (${((final.avgDist/baseline.avgDist - 1) * 100).toFixed(0)}% better)`)
console.log(`  Total improvements: ${totalImprovements}`)
console.log('\n  Worst remaining pairs:')
for (const wp of final.worstPairs) {
  console.log(`    ${wp.pair.padEnd(8)} ${wp.dist.toFixed(4)}`)
}

// Output changed gains
console.log('\n=== CHANGED GAINS ===')
let changedCount = 0
for (const ph of [...tunablePhonemes].sort()) {
  const orig = PHONEMES[ph].bands
  const opt = gains[ph]
  const changed = orig.some((v, i) => Math.abs(v - opt[i]) > 0.005)
  if (changed) {
    changedCount++
    console.log(`  ${ph.padEnd(3)}: [${opt.map(g => g.toFixed(2)).join(', ')}]`)
  }
}
console.log(`\n${changedCount} phonemes changed`)

// Show the full pairwise distance matrix for vowels
console.log('\n=== VOWEL DISTANCE MATRIX ===')
const vowels = ['IY', 'IH', 'EH', 'AE', 'AA', 'AH', 'AO', 'UH', 'UW', 'OW', 'ER']
process.stdout.write('     ')
for (const v of vowels) process.stdout.write(v.padEnd(6))
console.log()
for (const a of vowels) {
  process.stdout.write(a.padEnd(5))
  for (const b of vowels) {
    if (a === b) { process.stdout.write('  -   '); continue }
    const d = spectralDistance(gains[a], gains[b])
    const flag = d < 0.15 ? '!' : d < 0.25 ? '~' : ' '
    process.stdout.write(`${d.toFixed(2)}${flag} `)
  }
  console.log()
}
