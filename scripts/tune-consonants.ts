/**
 * Consonant tuning against Samantha reference.
 * Analyzes VCV (vowel-consonant-vowel) recordings to extract
 * the consonant's spectral contribution and compare against our table.
 */

import * as fs from 'fs'
import { BAND_CENTERS, BAND_WIDTHS, BAND_COMPENSATION, PHONEMES } from '../src/phonemes'

interface WavData { sampleRate: number; samples: Float32Array }

function readWav(path: string): WavData {
  const buf = fs.readFileSync(path)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let offset = 12, sampleRate = 44100, bitsPerSample = 16, numChannels = 1, dataStart = 0, dataSize = 0
  while (offset < buf.length - 8) {
    const id = String.fromCharCode(buf[offset], buf[offset+1], buf[offset+2], buf[offset+3])
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') { numChannels = view.getUint16(offset+10, true); sampleRate = view.getUint32(offset+12, true); bitsPerSample = view.getUint16(offset+22, true) }
    else if (id === 'data') { dataStart = offset + 8; dataSize = size }
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

function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; while (j & bit) { j ^= bit; bit >>= 1 }; j ^= bit
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]] }
  }
  for (let len = 2; len <= n; len *= 2) {
    const half = len / 2, angle = -2 * Math.PI / len, wR = Math.cos(angle), wI = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let cR = 1, cI = 0
      for (let j = 0; j < half; j++) {
        const tR = cR*real[i+j+half]-cI*imag[i+j+half], tI = cR*imag[i+j+half]+cI*real[i+j+half]
        real[i+j+half]=real[i+j]-tR; imag[i+j+half]=imag[i+j]-tI; real[i+j]+=tR; imag[i+j]+=tI
        const nR=cR*wR-cI*wI; cI=cR*wI+cI*wR; cR=nR
      }
    }
  }
}

const BAND_EDGES = [0, 225, 450, 700, 1000, 1400, 2000, 2700, 3800, 5400, 7500]

function analyzeWav(wav: WavData): number[] {
  const { sampleRate, samples } = wav
  const fftSize = 4096
  const start = Math.floor(samples.length * 0.15)
  const end = Math.floor(samples.length * 0.85)
  const hop = fftSize / 2
  const numFrames = Math.max(1, Math.floor((end - start) / hop) - 1)
  const avgMag = new Float64Array(fftSize / 2)
  for (let frame = 0; frame < numFrames; frame++) {
    const off = start + frame * hop
    const real = new Float64Array(fftSize), imag = new Float64Array(fftSize)
    for (let i = 0; i < fftSize; i++) { real[i] = (samples[off+i]||0) * 0.5*(1-Math.cos(2*Math.PI*i/(fftSize-1))) }
    fft(real, imag)
    for (let i = 0; i < fftSize/2; i++) avgMag[i] += Math.sqrt(real[i]*real[i]+imag[i]*imag[i]) / numFrames
  }
  const binHz = sampleRate / fftSize
  return BAND_CENTERS.map((_,i) => {
    const lo = Math.floor(BAND_EDGES[i]/binHz), hi = Math.ceil(BAND_EDGES[i+1]/binHz)
    let sum = 0, cnt = 0
    for (let b = lo; b < hi && b < avgMag.length; b++) { sum += avgMag[b]; cnt++ }
    return cnt > 0 ? sum/cnt : 0
  })
}

function normalize(bands: number[]): number[] {
  const max = Math.max(...bands, 0.001)
  return bands.map(b => b / max)
}

// Map file names to our ARPAbet phonemes
const CONSONANT_MAP: Record<string, string> = {
  's': 'S', 'sh': 'SH', 'f': 'F', 'th': 'TH', 'v': 'V', 'z': 'Z', 'hh': 'HH',
  'm': 'M', 'n': 'N', 'ng': 'NG',
  'l': 'L', 'r': 'R', 'w': 'W', 'y': 'Y',
}

const REF_DIR = '/tmp/voder-ref-mac/consonants'

console.log('=== CONSONANT TUNING (vs Samantha) ===')
console.log()

interface ConsonantResult {
  phoneme: string
  type: string
  distance: number
  refBands: number[]
  ourBands: number[]
  suggestedGains: number[]
}

const results: ConsonantResult[] = []

for (const [file, phoneme] of Object.entries(CONSONANT_MAP)) {
  const wavPath = `${REF_DIR}/${file}.wav`
  if (!fs.existsSync(wavPath)) { console.log(`  SKIP ${phoneme}: ${wavPath} not found`); continue }

  const wav = readWav(wavPath)
  const refRaw = analyzeWav(wav)
  const refBands = normalize(refRaw)

  const ph = PHONEMES[phoneme]
  if (!ph) continue

  const ourRaw = ph.bands.map((g, i) => g * BAND_COMPENSATION[i])
  const ourMax = Math.max(...ourRaw, 0.001)
  const ourBands = ourRaw.map(g => g / ourMax)

  let sumSq = 0
  for (let i = 0; i < 10; i++) sumSq += (refBands[i] - ourBands[i]) ** 2
  const distance = Math.sqrt(sumSq)

  // Compute suggested gains
  const suggestedGains = ph.bands.map((g, i) => {
    const diff = refBands[i] - ourBands[i]
    if (Math.abs(diff) > 0.12) {
      const targetNorm = refBands[i]
      return Math.max(0, Math.min(1.0, targetNorm * ourMax / BAND_COMPENSATION[i]))
    }
    return g
  })

  results.push({ phoneme, type: ph.type, distance, refBands, ourBands, suggestedGains })

  const bar = (v: number) => '█'.repeat(Math.round(v * 15)).padEnd(15)
  const flag = distance > 0.5 ? '✗' : distance > 0.3 ? '~' : '✓'
  console.log(`── ${phoneme} (${ph.type}) ${flag} distance: ${distance.toFixed(3)} ──`)
  for (let i = 0; i < 10; i++) {
    const d = Math.abs(refBands[i] - ourBands[i])
    const mark = d > 0.15 ? ' ◄' : ''
    console.log(`  B${(i+1).toString().padStart(2)}(${BAND_CENTERS[i].toString().padStart(4)}Hz)  ref=${bar(refBands[i])}${refBands[i].toFixed(2)}  ours=${bar(ourBands[i])}${ourBands[i].toFixed(2)}${mark}`)
  }
  if (distance > 0.3) {
    console.log(`  suggested: [${suggestedGains.map(g => g.toFixed(2)).join(', ')}]`)
  }
  console.log()
}

// Summary
results.sort((a, b) => b.distance - a.distance)
console.log('=== SUMMARY ===')
for (const r of results) {
  const flag = r.distance > 0.5 ? '✗' : r.distance > 0.3 ? '~' : '✓'
  console.log(`  ${flag} ${r.phoneme.padEnd(3)} (${r.type.padEnd(10)}) distance=${r.distance.toFixed(3)}`)
}
const avg = results.reduce((s, r) => s + r.distance, 0) / results.length
console.log(`\n  Average distance: ${avg.toFixed(3)}`)
