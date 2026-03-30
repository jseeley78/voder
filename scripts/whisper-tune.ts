/**
 * Whisper-based intelligibility tuner.
 *
 * Optimizes phoneme gains by testing whether Whisper can recognize
 * the rendered speech. This directly optimizes for intelligibility
 * rather than spectral similarity.
 *
 * For each phoneme: try a gain adjustment → render affected words →
 * run Whisper → keep if recognition improves, revert if worse.
 */

import * as fs from 'fs'
import { execSync } from 'child_process'
import { BAND_CENTERS, BAND_WIDTHS, BAND_Q, BAND_COMPENSATION, PHONEMES } from '../src/phonemes'
import { textToPhonemes } from '../src/text-to-phoneme'
import { applyProsody } from '../src/prosody'

const SAMPLE_RATE = 16000  // Whisper's native rate
const TWO_PI = 2 * Math.PI
const OUTPUT_DIR = '/tmp/voder-whisper'
fs.mkdirSync(OUTPUT_DIR, { recursive: true })

// ─── DSP components (same as render-wav.ts) ───

class BiquadBandpass {
  private b0: number; private b2: number; private a1: number; private a2: number
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0
  constructor(cf: number, Q: number, sr: number) {
    const w0 = TWO_PI * cf / sr, alpha = Math.sin(w0) / (2 * Q), a0 = 1 + alpha
    this.b0 = alpha / a0; this.b2 = -alpha / a0; this.a1 = (-2 * Math.cos(w0)) / a0; this.a2 = (1 - alpha) / a0
  }
  process(x: number): number {
    const y = this.b0 * x + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y
  }
  reset() { this.x1 = this.x2 = this.y1 = this.y2 = 0 }
}

class BiquadLowpass {
  private b0: number; private b1: number; private b2: number; private a1: number; private a2: number
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0
  constructor(f: number, Q: number, sr: number) {
    const w0 = TWO_PI * f / sr, alpha = Math.sin(w0)/(2*Q), cosw = Math.cos(w0), a0 = 1+alpha
    this.b0 = ((1-cosw)/2)/a0; this.b1 = (1-cosw)/a0; this.b2 = this.b0; this.a1 = (-2*cosw)/a0; this.a2 = (1-alpha)/a0
  }
  process(x: number): number {
    const y = this.b0*x + this.b1*this.x1 + this.b2*this.x2 - this.a1*this.y1 - this.a2*this.y2
    this.x2=this.x1; this.x1=x; this.y2=this.y1; this.y1=y; return y
  }
  reset() { this.x1=this.x2=this.y1=this.y2=0 }
}

class BiquadPeaking {
  private b0: number; private b1: number; private b2: number; private a1: number; private a2: number
  private x1=0; private x2=0; private y1=0; private y2=0
  constructor(f: number, Q: number, dB: number, sr: number) {
    const A=Math.pow(10,dB/40), w0=TWO_PI*f/sr, alpha=Math.sin(w0)/(2*Q), a0=1+alpha/A
    this.b0=(1+alpha*A)/a0; this.b1=(-2*Math.cos(w0))/a0; this.b2=(1-alpha*A)/a0; this.a1=this.b1; this.a2=(1-alpha/A)/a0
  }
  process(x: number): number {
    const y=this.b0*x+this.b1*this.x1+this.b2*this.x2-this.a1*this.y1-this.a2*this.y2
    this.x2=this.x1;this.x1=x;this.y2=this.y1;this.y1=y; return y
  }
  reset() { this.x1=this.x2=this.y1=this.y2=0 }
}

class GlottalPulse {
  private phase=0; private ct=0.0003; private dt=0.0008
  generate(freq: number, sr: number): number {
    const period=1/Math.max(freq,20); this.phase+=1/sr
    if(this.phase>=period){this.phase-=period;this.ct=0.0003*(1+(Math.random()-0.5)*0.04);this.dt=0.0008*(1+(Math.random()-0.5)*0.04)}
    const t=this.phase
    if(t<this.ct){return(1-Math.exp(-t/(this.ct*0.25))-0.3)*0.8}
    if(t<this.ct+this.dt){return(Math.exp(-(t-this.ct)/(this.dt*0.35))-0.3)*0.8}
    return -0.224
  }
}

function generatePinkNoise(len: number): Float32Array {
  const d=new Float32Array(len)
  for(let i=0;i<len;i+=2){const u1=Math.random()||1e-10,u2=Math.random(),r=Math.sqrt(-2*Math.log(u1));d[i]=r*Math.cos(TWO_PI*u2);if(i+1<len)d[i+1]=r*Math.sin(TWO_PI*u2)}
  let b0=0,b1=0,b2=0
  for(let i=0;i<len;i++){const w=d[i];b0=0.99765*b0+w*0.0990460;b1=0.96300*b1+w*0.2965164;b2=0.57000*b2+w*1.0526913;d[i]=(b0+b1+b2+w*0.1848)*0.22}
  return d
}

// ─── Render + WAV write ───

function writeWav(path: string, samples: Float32Array, sr: number): void {
  const n=samples.length, dataSize=n*2, buf=Buffer.alloc(44+dataSize)
  buf.write('RIFF',0);buf.writeUInt32LE(36+dataSize,4);buf.write('WAVE',8);buf.write('fmt ',12)
  buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(1,22);buf.writeUInt32LE(sr,24)
  buf.writeUInt32LE(sr*2,28);buf.writeUInt16LE(2,32);buf.writeUInt16LE(16,34);buf.write('data',36);buf.writeUInt32LE(dataSize,40)
  for(let i=0;i<n;i++)buf.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),44+i*2)
  fs.writeFileSync(path,buf)
}

// Mutable gains
const gains: Record<string, number[]> = {}
for (const [ph, cfg] of Object.entries(PHONEMES)) gains[ph] = [...cfg.bands]

function renderWord(word: string): Float32Array {
  const result = textToPhonemes(word)
  const rawTokens = result.phonemes.split(/\s+/).filter(Boolean).map(x => x.toUpperCase())
  const prosody = applyProsody(rawTokens, { expressiveness: 0.7 })

  const filters = BAND_CENTERS.map((c, i) => new BiquadBandpass(c, BAND_Q[i], SAMPLE_RATE))
  const tilt = new BiquadLowpass(3400, 0.65, SAMPLE_RATE)
  const eqMid = new BiquadPeaking(2800, 0.8, 5, SAMPLE_RATE)
  const glottal = new GlottalPulse()
  const noise = generatePinkNoise(SAMPLE_RATE * 3)
  let ni = 0

  const chunks: Float32Array[] = []

  let prevVA = 0, prevNA = 0, prevPitch = 110
  const prevBands = new Float64Array(10)

  for (const pt of prosody) {
    const ph = PHONEMES[pt.phoneme]
    if (!ph) continue
    const g = gains[pt.phoneme] || ph.bands
    const pitchHz = 110 * pt.pitchMul
    const durMs = ph.durationMs * pt.durationMul
    const numSamples = Math.round(durMs / 1000 * SAMPLE_RATE)
    const transN = Math.min(numSamples, Math.round(0.030 * SAMPLE_RATE))
    const chunk = new Float32Array(numSamples)

    const tgtVA = ph.voiced ? ph.voicedAmp * 0.30 : 0
    const tgtNA = ph.noise * 0.10

    for (let i = 0; i < numSamples; i++) {
      const t = i < transN ? i / transN : 1.0
      const va = prevVA * (1-t) + tgtVA * t
      const na = prevNA * (1-t) + tgtNA * t
      const pitch = prevPitch * (1-t) + pitchHz * t
      const excitation = tilt.process(glottal.generate(pitch, SAMPLE_RATE)) * va + noise[ni++ % noise.length] * na
      let sum = 0
      for (let b = 0; b < 10; b++) {
        const bGain = ((prevBands[b] * (1-t) + (g[b] * pt.ampMul) * t)) * BAND_COMPENSATION[b]
        sum += filters[b].process(excitation) * Math.max(0, Math.min(1.5, bGain))
      }
      chunk[i] = eqMid.process(sum)
    }

    prevVA = tgtVA; prevNA = tgtNA; prevPitch = pitchHz
    for (let b = 0; b < 10; b++) prevBands[b] = g[b] * pt.ampMul

    chunks.push(chunk)

    // Pause
    if (pt.pauseAfterMs > 0) {
      const pauseN = Math.round(pt.pauseAfterMs / 1000 * SAMPLE_RATE)
      chunks.push(new Float32Array(pauseN))
      prevVA = 0; prevNA = 0
      for (let b = 0; b < 10; b++) prevBands[b] = 0
    }
  }

  const total = chunks.reduce((s, c) => s + c.length, 0)
  const out = new Float32Array(total)
  let off = 0
  for (const c of chunks) { out.set(c, off); off += c.length }

  // Normalize
  let peak = 0
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
  if (peak > 0.01) { const sc = 0.85/peak; for (let i=0;i<out.length;i++) out[i]*=sc }
  return out
}

// ─── Whisper scoring via Python subprocess ───

function whisperScore(words: string[]): Map<string, { text: string; correct: boolean; logprob: number }> {
  // Render all words
  for (const w of words) {
    const audio = renderWord(w)
    writeWav(`${OUTPUT_DIR}/${w}.wav`, audio, SAMPLE_RATE)
  }

  // Run Whisper via Python script, output to temp file
  const resultFile = `${OUTPUT_DIR}/_results.json`
  const wordList = words.join(',')
  const scriptPath = new URL('./whisper-score.py', import.meta.url).pathname
  execSync(`python3 ${scriptPath} ${OUTPUT_DIR} ${wordList} ${resultFile}`, {
    timeout: 120000,
    env: { ...process.env, PYTHONHTTPSVERIFY: '0' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const parsed = JSON.parse(fs.readFileSync(resultFile, 'utf-8'))
  const result = new Map<string, { text: string; correct: boolean; logprob: number }>()
  for (const [word, data] of Object.entries(parsed) as [string, { text: string; logprob: number }][]) {
    result.set(word, {
      text: data.text,
      correct: data.text.includes(word.toLowerCase()),
      logprob: data.logprob,
    })
  }
  return result
}

// ─── Main optimization loop ───

const TRAIN_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five',
  'six', 'seven', 'eight', 'nine', 'ten',
]

// Find which phonemes appear in each word
const wordPhonemes = new Map<string, Set<string>>()
for (const w of TRAIN_WORDS) {
  const r = textToPhonemes(w)
  const tokens = r.phonemes.split(/\s+/).filter(t => t !== '|' && !/^[,.\?!;:]$/.test(t))
  const phs = new Set(tokens.map(t => t.replace(/[012]$/, '')))
  wordPhonemes.set(w, phs)
}

// Which words contain a given phoneme?
function wordsWithPhoneme(ph: string): string[] {
  return TRAIN_WORDS.filter(w => wordPhonemes.get(w)?.has(ph))
}

console.log('=== WHISPER-BASED INTELLIGIBILITY TUNER ===')
console.log(`Training words: ${TRAIN_WORDS.length}`)
console.log()

// Baseline score
console.log('── Baseline ──')
const baseline = whisperScore(TRAIN_WORDS)
let correctCount = 0
for (const [w, r] of baseline) {
  const flag = r.correct ? '✓' : '✗'
  console.log(`  ${flag} ${w.padEnd(14)} → "${r.text}" (${r.logprob.toFixed(3)})`)
  if (r.correct) correctCount++
}
console.log(`  Score: ${correctCount}/${TRAIN_WORDS.length}`)

// Optimization
const STEP_SIZES = [0.10, 0.06, 0.04]
const phonemesToTune = [...new Set([...wordPhonemes.values()].flatMap(s => [...s]))].filter(p => gains[p])
console.log(`\nTuning ${phonemesToTune.length} phonemes: ${phonemesToTune.join(', ')}`)

let totalImprovements = 0

for (const stepSize of STEP_SIZES) {
  console.log(`\n── Step: ${stepSize} ──`)
  let improved = 0

  for (const ph of phonemesToTune) {
    const affectedWords = wordsWithPhoneme(ph)
    if (affectedWords.length === 0) continue

    const g = gains[ph]
    // Get current score for affected words
    const beforeScore = whisperScore(affectedWords)
    const beforeCorrect = [...beforeScore.values()].filter(r => r.correct).length
    const beforeLogprob = [...beforeScore.values()].reduce((s, r) => s + r.logprob, 0)

    for (let b = 0; b < 10; b++) {
      const orig = g[b]

      // Try increase
      g[b] = Math.min(1.0, orig + stepSize)
      const upScore = whisperScore(affectedWords)
      const upCorrect = [...upScore.values()].filter(r => r.correct).length
      const upLogprob = [...upScore.values()].reduce((s, r) => s + r.logprob, 0)

      if (upCorrect > beforeCorrect || (upCorrect === beforeCorrect && upLogprob > beforeLogprob + 0.05)) {
        improved++
        totalImprovements++
        console.log(`  ${ph} B${b+1} +${stepSize}: ${beforeCorrect}→${upCorrect} correct, logprob ${beforeLogprob.toFixed(2)}→${upLogprob.toFixed(2)}`)
        continue
      }

      // Try decrease
      g[b] = Math.max(0, orig - stepSize)
      const downScore = whisperScore(affectedWords)
      const downCorrect = [...downScore.values()].filter(r => r.correct).length
      const downLogprob = [...downScore.values()].reduce((s, r) => s + r.logprob, 0)

      if (downCorrect > beforeCorrect || (downCorrect === beforeCorrect && downLogprob > beforeLogprob + 0.05)) {
        improved++
        totalImprovements++
        console.log(`  ${ph} B${b+1} -${stepSize}: ${beforeCorrect}→${downCorrect} correct, logprob ${beforeLogprob.toFixed(2)}→${downLogprob.toFixed(2)}`)
        continue
      }

      g[b] = orig  // revert
    }
  }

  if (improved === 0) break
}

// Final score
console.log('\n── Final ──')
const final = whisperScore(TRAIN_WORDS)
let finalCorrect = 0
for (const [w, r] of final) {
  const flag = r.correct ? '✓' : '✗'
  console.log(`  ${flag} ${w.padEnd(14)} → "${r.text}" (${r.logprob.toFixed(3)})`)
  if (r.correct) finalCorrect++
}
console.log(`\n  Score: ${correctCount}→${finalCorrect}/${TRAIN_WORDS.length} (${totalImprovements} improvements)`)

// Output optimized gains
console.log('\n=== OPTIMIZED GAINS ===')
for (const ph of phonemesToTune.sort()) {
  const orig = PHONEMES[ph].bands
  const opt = gains[ph]
  const changed = orig.some((v, i) => Math.abs(v - opt[i]) > 0.005)
  if (changed) console.log(`  ${ph.padEnd(3)}: [${opt.map(g => g.toFixed(2)).join(', ')}]`)
}
