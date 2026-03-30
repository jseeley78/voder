/**
 * Word-level spectral comparison: eSpeak reference vs our Voder phoneme table.
 *
 * For each word:
 *   1. Reads the eSpeak WAV and computes a time-averaged spectral envelope
 *   2. Looks up our phoneme sequence for the same word
 *   3. Computes our predicted spectral envelope (weighted average of phoneme gains)
 *   4. Compares the two and reports discrepancies
 *
 * This catches issues that isolated phoneme analysis misses:
 *   - How phonemes blend in context
 *   - Whether our overall spectral balance matches a reference TTS
 *   - Which frequency bands are consistently too hot or too cold
 */

import * as fs from 'fs'
import { BAND_CENTERS, BAND_WIDTHS, BAND_COMPENSATION, PHONEMES } from '../src/phonemes'
import { textToPhonemes } from '../src/text-to-phoneme'

// ─── WAV reader ───

interface WavData { sampleRate: number; samples: Float32Array }

function readWav(path: string): WavData {
  const buf = fs.readFileSync(path)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let offset = 12
  let sampleRate = 44100, bitsPerSample = 16, numChannels = 1, dataStart = 0, dataSize = 0
  while (offset < buf.length - 8) {
    const id = String.fromCharCode(buf[offset], buf[offset+1], buf[offset+2], buf[offset+3])
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') {
      numChannels = view.getUint16(offset + 10, true)
      sampleRate = view.getUint32(offset + 12, true)
      bitsPerSample = view.getUint16(offset + 22, true)
    } else if (id === 'data') { dataStart = offset + 8; dataSize = size }
    offset += 8 + size; if (size % 2 !== 0) offset++
  }
  const numSamples = dataSize / (bitsPerSample / 8) / numChannels
  const samples = new Float32Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    const bo = dataStart + i * numChannels * (bitsPerSample / 8)
    samples[i] = bitsPerSample === 16 ? view.getInt16(bo, true) / 32768 : (buf[bo] - 128) / 128
  }
  return { sampleRate, samples }
}

// ─── FFT ───

function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    while (j & bit) { j ^= bit; bit >>= 1 }
    j ^= bit
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]] }
  }
  for (let len = 2; len <= n; len *= 2) {
    const half = len / 2, angle = -2 * Math.PI / len
    const wR = Math.cos(angle), wI = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let cR = 1, cI = 0
      for (let j = 0; j < half; j++) {
        const tR = cR * real[i+j+half] - cI * imag[i+j+half]
        const tI = cR * imag[i+j+half] + cI * real[i+j+half]
        real[i+j+half] = real[i+j] - tR; imag[i+j+half] = imag[i+j] - tI
        real[i+j] += tR; imag[i+j] += tI
        const nR = cR * wR - cI * wI; cI = cR * wI + cI * wR; cR = nR
      }
    }
  }
}

// ─── Analysis ───

const BAND_EDGES = [0, 225, 450, 700, 1000, 1400, 2000, 2700, 3800, 5400, 7500]

function analyzeWav(wav: WavData): number[] {
  const { sampleRate, samples } = wav
  const fftSize = 4096
  const start = Math.floor(samples.length * 0.15)
  const end = Math.floor(samples.length * 0.85)
  const numFrames = Math.max(1, Math.floor((end - start) / (fftSize / 2)) - 1)
  const avgMag = new Float64Array(fftSize / 2)

  for (let frame = 0; frame < numFrames; frame++) {
    const off = start + frame * (fftSize / 2)
    const real = new Float64Array(fftSize)
    const imag = new Float64Array(fftSize)
    for (let i = 0; i < fftSize; i++) {
      const w = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)))
      real[i] = (samples[off + i] || 0) * w
    }
    fft(real, imag)
    for (let i = 0; i < fftSize / 2; i++) {
      avgMag[i] += Math.sqrt(real[i] * real[i] + imag[i] * imag[i]) / numFrames
    }
  }

  const binHz = sampleRate / fftSize
  return BAND_CENTERS.map((_, i) => {
    const lo = Math.floor(BAND_EDGES[i] / binHz)
    const hi = Math.ceil(BAND_EDGES[i + 1] / binHz)
    let sum = 0, count = 0
    for (let bin = lo; bin < hi && bin < avgMag.length; bin++) { sum += avgMag[bin]; count++ }
    return count > 0 ? sum / count : 0
  })
}

function normalize(bands: number[]): number[] {
  const max = Math.max(...bands, 0.001)
  return bands.map(b => b / max)
}

/** Compute our predicted spectral envelope for a word */
function predictOurSpectrum(word: string): number[] {
  const result = textToPhonemes(word)
  const tokens = result.phonemes.split(/\s+/).filter(t => t !== '|' && !/^[,.\?!;:]$/.test(t))
  const keys = tokens.map(t => t.replace(/[012]$/, ''))

  // Weighted average of phoneme band gains, weighted by duration
  const totalBands = new Float64Array(10)
  let totalDuration = 0

  for (const k of keys) {
    const ph = PHONEMES[k]
    if (!ph) continue
    const dur = ph.durationMs
    for (let i = 0; i < 10; i++) {
      totalBands[i] += ph.bands[i] * BAND_COMPENSATION[i] * dur
    }
    totalDuration += dur
  }

  if (totalDuration > 0) {
    for (let i = 0; i < 10; i++) totalBands[i] /= totalDuration
  }

  return normalize(Array.from(totalBands))
}

// ─── Main ───

const REF_DIR = '/tmp/voder-ref/words'

const TEST_WORDS = [
  'hello', 'world', 'the', 'beautiful', 'speech', 'robot',
  'string', 'splash', 'think', 'running', 'yesterday',
  'computer', 'important', 'question', 'strength',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'people', 'because', 'about', 'would', 'could', 'their',
  'after', 'first', 'also', 'just', 'time', 'good', 'know',
]

console.log('=== WORD-LEVEL SPECTRAL COMPARISON ===')
console.log()

interface WordResult { word: string; distance: number; bandDiffs: number[] }
const results: WordResult[] = []

// Track per-band bias across all words
const bandBias = new Float64Array(10)  // positive = we're too hot, negative = too cold
let biasCount = 0

for (const word of TEST_WORDS) {
  const wavPath = `${REF_DIR}/${word}.wav`
  if (!fs.existsSync(wavPath)) continue

  const wav = readWav(wavPath)
  const refBands = normalize(analyzeWav(wav))
  const ourBands = predictOurSpectrum(word)

  let sumSq = 0
  const bandDiffs: number[] = []
  for (let i = 0; i < 10; i++) {
    const diff = ourBands[i] - refBands[i]
    bandDiffs.push(diff)
    sumSq += diff * diff
    bandBias[i] += diff
  }
  biasCount++
  const distance = Math.sqrt(sumSq)
  results.push({ word, distance, bandDiffs })
}

// Sort by distance (worst first)
results.sort((a, b) => b.distance - a.distance)

// Show worst 15 words
console.log('── WORST WORDS (by spectral distance) ──')
for (const r of results.slice(0, 15)) {
  const flag = r.distance > 0.5 ? '✗' : r.distance > 0.3 ? '~' : '✓'
  console.log(`  ${flag} ${r.word.padEnd(14)} dist=${r.distance.toFixed(3)}  band_diffs=[${r.bandDiffs.map(d => (d >= 0 ? '+' : '') + d.toFixed(2)).join(', ')}]`)
}

console.log()
console.log('── BEST WORDS ──')
for (const r of results.slice(-10)) {
  console.log(`  ✓ ${r.word.padEnd(14)} dist=${r.distance.toFixed(3)}`)
}

// Per-band systematic bias
console.log()
console.log('── SYSTEMATIC BAND BIAS (across all words) ──')
console.log('  (positive = our bands too hot, negative = too cold)')
for (let i = 0; i < 10; i++) {
  const avg = bandBias[i] / biasCount
  const bar = avg > 0
    ? '  ' + '█'.repeat(Math.round(avg * 40))
    : '█'.repeat(Math.round(-avg * 40)).padStart(Math.round(-avg * 40) + 2)
  const label = avg > 0.08 ? ' ◄ TOO HOT' : avg < -0.08 ? ' ◄ TOO COLD' : ''
  console.log(`  B${(i+1).toString().padStart(2)}(${BAND_CENTERS[i].toString().padStart(4)}Hz): ${avg >= 0 ? '+' : ''}${avg.toFixed(3)} ${bar}${label}`)
}

// Summary
console.log()
const avgDist = results.reduce((s, r) => s + r.distance, 0) / results.length
const goodCount = results.filter(r => r.distance < 0.3).length
const okCount = results.filter(r => r.distance >= 0.3 && r.distance < 0.5).length
const badCount = results.filter(r => r.distance >= 0.5).length
console.log(`── SUMMARY ──`)
console.log(`  ${results.length} words analyzed`)
console.log(`  Average distance: ${avgDist.toFixed(3)}`)
console.log(`  Good (<0.3): ${goodCount}  OK (<0.5): ${okCount}  Needs work (>0.5): ${badCount}`)
