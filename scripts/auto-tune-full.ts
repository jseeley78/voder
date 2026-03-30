/**
 * Full-pipeline auto-tuner: optimizes phoneme gains + band compensation
 * together against word-level Samantha reference spectra.
 *
 * Unlike auto-tune.ts (isolated vowels only), this:
 *   1. Uses full word WAVs as reference (captures transitions)
 *   2. Predicts our spectral output for each word (weighted phoneme average)
 *   3. Optimizes ALL phoneme types (vowels, fricatives, nasals, liquids, glides)
 *   4. Also tunes the band compensation bias correction vector
 *   5. Validates against held-out words not used in optimization
 *
 * Respects the constraint: Voder architecture (10-band filter bank,
 * buzz+noise sources) is NOT changed. Only gain values and compensation.
 */

import * as fs from 'fs'
import {
  BAND_CENTERS, BAND_WIDTHS, PHONEMES,
  type PhonemeConfig,
} from '../src/phonemes'
import { textToPhonemes } from '../src/text-to-phoneme'

// ─── WAV + FFT ───

interface WavData { sampleRate: number; samples: Float32Array }

function readWav(path: string): WavData {
  const buf = fs.readFileSync(path)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let offset = 12, sampleRate = 44100, bitsPerSample = 16, numChannels = 1, dataStart = 0, dataSize = 0
  while (offset < buf.length - 8) {
    const id = String.fromCharCode(buf[offset], buf[offset+1], buf[offset+2], buf[offset+3])
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') { numChannels = view.getUint16(offset+10,true); sampleRate = view.getUint32(offset+12,true); bitsPerSample = view.getUint16(offset+22,true) }
    else if (id === 'data') { dataStart = offset+8; dataSize = size }
    offset += 8+size; if (size%2!==0) offset++
  }
  const n = dataSize/(bitsPerSample/8)/numChannels
  const samples = new Float32Array(n)
  for (let i = 0; i < n; i++) { const bo = dataStart+i*numChannels*(bitsPerSample/8); samples[i] = bitsPerSample===16 ? view.getInt16(bo,true)/32768 : (buf[bo]-128)/128 }
  return { sampleRate, samples }
}

function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length
  for (let i=1,j=0;i<n;i++){let b=n>>1;while(j&b){j^=b;b>>=1}j^=b;if(i<j){[real[i],real[j]]=[real[j],real[i]];[imag[i],imag[j]]=[imag[j],imag[i]]}}
  for (let len=2;len<=n;len*=2){const h=len/2,a=-2*Math.PI/len,wR=Math.cos(a),wI=Math.sin(a);for(let i=0;i<n;i+=len){let cR=1,cI=0;for(let j=0;j<h;j++){const tR=cR*real[i+j+h]-cI*imag[i+j+h],tI=cR*imag[i+j+h]+cI*real[i+j+h];real[i+j+h]=real[i+j]-tR;imag[i+j+h]=imag[i+j]-tI;real[i+j]+=tR;imag[i+j]+=tI;const nR=cR*wR-cI*wI;cI=cR*wI+cI*wR;cR=nR}}}
}

const BAND_EDGES = [0, 225, 450, 700, 1000, 1400, 2000, 2700, 3800, 5400, 7500]

function analyzeWav(wav: WavData): number[] {
  const {sampleRate, samples} = wav; const fftSize = 4096
  const start = Math.floor(samples.length*0.15), end = Math.floor(samples.length*0.85), hop = fftSize/2
  const nf = Math.max(1, Math.floor((end-start)/hop)-1); const avg = new Float64Array(fftSize/2)
  for (let f=0;f<nf;f++){const o=start+f*hop;const r=new Float64Array(fftSize),im=new Float64Array(fftSize);for(let i=0;i<fftSize;i++)r[i]=(samples[o+i]||0)*0.5*(1-Math.cos(2*Math.PI*i/(fftSize-1)));fft(r,im);for(let i=0;i<fftSize/2;i++)avg[i]+=Math.sqrt(r[i]*r[i]+im[i]*im[i])/nf}
  const bHz = sampleRate/fftSize
  return BAND_CENTERS.map((_,i) => { const lo=Math.floor(BAND_EDGES[i]/bHz),hi=Math.ceil(BAND_EDGES[i+1]/bHz);let s=0,c=0;for(let b=lo;b<hi&&b<avg.length;b++){s+=avg[b];c++}return c>0?s/c:0 })
}

function normalize(b: number[]): number[] { const m = Math.max(...b, 0.001); return b.map(v => v/m) }

function distance(a: number[], b: number[]): number {
  let s = 0; for (let i = 0; i < a.length; i++) s += (a[i]-b[i])**2; return Math.sqrt(s)
}

// ─── Mutable state ───

// Clone all phoneme gains into a mutable structure
const gains: Record<string, number[]> = {}
for (const [ph, cfg] of Object.entries(PHONEMES)) {
  gains[ph] = [...cfg.bands]
}

// Mutable compensation bias correction
const minBW = Math.min(...BAND_WIDTHS)
const biasCor = [0.24, 0.04, 0.02, 0.10, 0.22, 0.10, 0.20, 0.18, 0.08, 0.04]

function getCompensation(): number[] {
  const base = BAND_WIDTHS.map(bw => Math.pow(minBW / bw, 0.7))
  return base.map((c, i) => Math.max(0.05, c - biasCor[i]))
}

function compensatedNorm(bands: number[]): number[] {
  const comp = getCompensation()
  const raw = bands.map((g, i) => g * comp[i])
  const max = Math.max(...raw, 0.001)
  return raw.map(g => g / max)
}

/** Predict our spectral envelope for a word given current gains */
function predictWord(word: string): number[] {
  const result = textToPhonemes(word)
  const tokens = result.phonemes.split(/\s+/).filter(t => t !== '|' && !/^[,.\?!;:]$/.test(t))
  const keys = tokens.map(t => t.replace(/[012]$/, ''))
  const comp = getCompensation()

  const totalBands = new Float64Array(10)
  let totalDuration = 0

  for (const k of keys) {
    const g = gains[k]
    const ph = PHONEMES[k]
    if (!g || !ph) continue
    const dur = ph.durationMs
    for (let i = 0; i < 10; i++) totalBands[i] += g[i] * comp[i] * dur
    totalDuration += dur
  }

  if (totalDuration > 0) {
    for (let i = 0; i < 10; i++) totalBands[i] /= totalDuration
  }

  return normalize(Array.from(totalBands))
}

// ─── Load word references ───

const REF_DIR = '/tmp/voder-ref-mac/words'

// Training words (optimize against these)
const TRAIN_WORDS = [
  'hello', 'world', 'the', 'beautiful', 'speech', 'robot',
  'think', 'running', 'computer', 'important', 'question',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'people', 'because', 'about', 'would', 'could', 'their',
  'after', 'first', 'also', 'just', 'time', 'good', 'know',
  'be', 'to', 'of', 'and', 'that', 'have', 'it', 'for', 'not', 'on',
  'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his',
  'from', 'they', 'we', 'say', 'her', 'she', 'will', 'my',
  'all', 'there', 'what', 'so', 'up', 'out', 'who', 'get',
  'which', 'go', 'me', 'when', 'make', 'can', 'like', 'no',
]

// Held-out words (validate but don't optimize against)
const VALIDATION_WORDS = [
  'string', 'splash', 'yesterday', 'strength',
  'him', 'take', 'into', 'year', 'some', 'them',
  'see', 'other', 'then', 'now', 'look', 'only',
  'come', 'over', 'back', 'use', 'how', 'our',
  'work', 'well', 'way', 'even', 'new', 'want',
  'these', 'give', 'day', 'most', 'us',
]

// Load reference spectra
const trainRefs = new Map<string, number[]>()
const valRefs = new Map<string, number[]>()

for (const w of TRAIN_WORDS) {
  const p = `${REF_DIR}/${w}.wav`
  if (fs.existsSync(p)) trainRefs.set(w, normalize(analyzeWav(readWav(p))))
}
for (const w of VALIDATION_WORDS) {
  const p = `${REF_DIR}/${w}.wav`
  if (fs.existsSync(p)) valRefs.set(w, normalize(analyzeWav(readWav(p))))
}

console.log(`Training words: ${trainRefs.size}, Validation words: ${valRefs.size}`)

function avgTrainDistance(): number {
  let sum = 0, count = 0
  for (const [w, ref] of trainRefs) {
    sum += distance(predictWord(w), ref)
    count++
  }
  return count > 0 ? sum / count : 0
}

function avgValDistance(): number {
  let sum = 0, count = 0
  for (const [w, ref] of valRefs) {
    sum += distance(predictWord(w), ref)
    count++
  }
  return count > 0 ? sum / count : 0
}

// ─── Optimization ───

const ITERATIONS = 800
const STEP_SIZES = [0.06, 0.04, 0.03, 0.02, 0.015, 0.01, 0.008, 0.005]

// Phonemes to optimize (all that appear in training words)
const phonemesInTraining = new Set<string>()
for (const w of TRAIN_WORDS) {
  const result = textToPhonemes(w)
  const tokens = result.phonemes.split(/\s+/).filter(t => t !== '|' && !/^[,.\?!;:]$/.test(t))
  for (const t of tokens) phonemesInTraining.add(t.replace(/[012]$/, ''))
}

const tunablePhonemes = [...phonemesInTraining].filter(p => gains[p])
console.log(`Tunable phonemes: ${tunablePhonemes.length} (${tunablePhonemes.join(', ')})`)

const initTrain = avgTrainDistance()
const initVal = avgValDistance()
console.log(`Initial train: ${initTrain.toFixed(4)}, val: ${initVal.toFixed(4)}`)
console.log()

let totalImprovements = 0
let totalAttempts = 0

for (const stepSize of STEP_SIZES) {
  const itersPerStep = Math.ceil(ITERATIONS / STEP_SIZES.length)
  let stepImprovements = 0

  for (let iter = 0; iter < itersPerStep; iter++) {
    let improved = 0

    // ── Optimize phoneme gains ──
    for (const ph of tunablePhonemes) {
      const g = gains[ph]
      const baseline = avgTrainDistance()

      for (let b = 0; b < 10; b++) {
        const orig = g[b]

        // Try increase
        g[b] = Math.min(1.0, orig + stepSize)
        if (avgTrainDistance() < baseline - 0.0005) {
          improved++; continue
        }

        // Try decrease
        g[b] = Math.max(0, orig - stepSize)
        if (avgTrainDistance() < baseline - 0.0005) {
          improved++; continue
        }

        g[b] = orig
        totalAttempts++
      }
    }

    // ── Optimize compensation bias ──
    const compStep = stepSize * 0.5
    for (let b = 0; b < 10; b++) {
      const orig = biasCor[b]
      const baseline = avgTrainDistance()

      biasCor[b] = orig + compStep
      if (avgTrainDistance() < baseline - 0.0005) {
        improved++; continue
      }

      biasCor[b] = Math.max(0, orig - compStep)
      if (avgTrainDistance() < baseline - 0.0005) {
        improved++; continue
      }

      biasCor[b] = orig
      totalAttempts++
    }

    stepImprovements += improved
    totalImprovements += improved
    if (improved === 0) break
  }

  const td = avgTrainDistance()
  const vd = avgValDistance()
  console.log(`step=${stepSize.toFixed(3)}: train=${td.toFixed(4)} val=${vd.toFixed(4)} improvements=${stepImprovements}`)
}

// ─── Results ───

const finalTrain = avgTrainDistance()
const finalVal = avgValDistance()

console.log()
console.log('=== RESULTS ===')
console.log(`Train: ${initTrain.toFixed(4)} → ${finalTrain.toFixed(4)} (${((1-finalTrain/initTrain)*100).toFixed(0)}% better)`)
console.log(`Val:   ${initVal.toFixed(4)} → ${finalVal.toFixed(4)} (${((1-finalVal/initVal)*100).toFixed(0)}% better)`)
console.log(`Total improvements: ${totalImprovements}, attempts: ${totalAttempts}`)
console.log()

// Output optimized compensation
console.log('=== COMPENSATION BIAS ===')
console.log(`const biasCor = [${biasCor.map(v => v.toFixed(3)).join(', ')}]`)
console.log()

// Output optimized gains for all tuned phonemes
console.log('=== OPTIMIZED GAINS ===')
for (const ph of tunablePhonemes.sort()) {
  const before = PHONEMES[ph].bands
  const after = gains[ph]
  const changed = before.some((v, i) => Math.abs(v - after[i]) > 0.005)
  if (changed) {
    console.log(`  ${ph.padEnd(3)}: [${after.map(g => g.toFixed(2)).join(', ')}]`)
  }
}

// Show worst remaining words
console.log()
console.log('=== WORST TRAINING WORDS ===')
const wordDists: {w: string; d: number}[] = []
for (const [w, ref] of trainRefs) {
  wordDists.push({ w, d: distance(predictWord(w), ref) })
}
wordDists.sort((a, b) => b.d - a.d)
for (const wd of wordDists.slice(0, 10)) {
  console.log(`  ${wd.w.padEnd(14)} ${wd.d.toFixed(3)}`)
}

console.log()
console.log('=== WORST VALIDATION WORDS ===')
const valDists: {w: string; d: number}[] = []
for (const [w, ref] of valRefs) {
  valDists.push({ w, d: distance(predictWord(w), ref) })
}
valDists.sort((a, b) => b.d - a.d)
for (const wd of valDists.slice(0, 10)) {
  console.log(`  ${wd.w.padEnd(14)} ${wd.d.toFixed(3)}`)
}
