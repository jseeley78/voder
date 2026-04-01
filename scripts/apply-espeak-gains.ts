/**
 * Apply eSpeak-derived band gains to vowel phonemes and test recognition.
 * Compares current hand-tuned gains vs eSpeak-measured gains.
 *
 * Usage: npx tsx scripts/apply-espeak-gains.ts
 */

import * as WAA from 'node-web-audio-api'
Object.assign(globalThis, {
  AudioContext: WAA.AudioContext,
  OfflineAudioContext: WAA.OfflineAudioContext,
  OscillatorNode: WAA.OscillatorNode,
  GainNode: WAA.GainNode,
  BiquadFilterNode: WAA.BiquadFilterNode,
  AudioBufferSourceNode: WAA.AudioBufferSourceNode,
  AnalyserNode: WAA.AnalyserNode,
  AudioWorkletNode: WAA.AudioWorkletNode,
  MediaStreamAudioDestinationNode: class { stream = null },
})

import * as fs from 'fs'
import { execSync } from 'child_process'
import { VoderEngine } from '../src/engine'
import { speakPhonemeSequence } from '../src/sequencer'
import { textToPhonemes } from '../src/text-to-phoneme'
import { PHONEMES } from '../src/phonemes'

const SR = 48000
const OUTPUT_DIR = '/tmp/voder-espeak-test'
fs.mkdirSync(OUTPUT_DIR, { recursive: true })

// eSpeak-derived band gains (from analyze-speech.py)
// These were measured by passing eSpeak output through our exact 10-band filter bank
const ESPEAK_GAINS: Record<string, number[]> = {
  // Vowels (reliable — measured from steady-state vowel portion)
  IY: [0.47, 1.00, 0.06, 0.01, 0.01, 0.07, 0.50, 0.61, 0.11, 0.03],
  IH: [0.28, 1.00, 0.46, 0.01, 0.01, 0.14, 0.21, 0.19, 0.07, 0.02],
  EH: [0.28, 0.55, 1.00, 0.29, 0.03, 0.53, 0.35, 0.25, 0.10, 0.02],
  AE: [0.47, 0.76, 1.00, 0.72, 0.19, 0.88, 0.41, 0.24, 0.14, 0.03],
  AA: [0.26, 0.40, 0.79, 0.97, 1.00, 0.11, 0.21, 0.28, 0.09, 0.02],
  AO: [0.17, 0.28, 1.00, 0.97, 0.61, 0.02, 0.16, 0.20, 0.02, 0.03],
  AH: [0.32, 0.47, 1.00, 0.38, 0.76, 0.27, 0.22, 0.21, 0.06, 0.03],
  UH: [0.44, 0.87, 1.00, 0.45, 0.59, 0.02, 0.14, 0.20, 0.06, 0.05],
  UW: [0.40, 1.00, 0.14, 0.02, 0.34, 0.30, 0.32, 0.23, 0.08, 0.03],
  ER: [0.42, 0.93, 1.00, 0.05, 0.68, 0.81, 0.55, 0.42, 0.11, 0.07],
  // Diphthongs — use steady-state measurement as midpoint
  OW: [0.39, 0.71, 1.00, 0.56, 0.55, 0.03, 0.25, 0.16, 0.07, 0.05],
  AY: [0.20, 0.29, 0.53, 1.00, 0.60, 0.27, 0.20, 0.20, 0.08, 0.01],
  EY: [0.42, 0.79, 1.00, 0.08, 0.02, 0.66, 0.47, 0.37, 0.16, 0.02],
  AW: [0.28, 0.38, 0.72, 1.00, 0.77, 0.29, 0.18, 0.20, 0.06, 0.03],
  OY: [0.27, 0.43, 1.00, 0.72, 0.43, 0.21, 0.22, 0.26, 0.04, 0.03],
}

function writeWav(path: string, samples: Float32Array): void {
  const n = samples.length, ds = n * 2, buf = Buffer.alloc(44 + ds)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + ds, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36)
  buf.writeUInt32LE(ds, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  fs.writeFileSync(path, buf)
}

async function renderPhrase(text: string): Promise<Float32Array> {
  const offlineCtx = new WAA.OfflineAudioContext(1, SR * 10, SR)
  const engine = new VoderEngine()
  await engine.start(offlineCtx as any)

  const result = textToPhonemes(text)
  const handle = speakPhonemeSequence(engine, result.phonemes, {
    defaultDurationMs: 110, transitionMs: 35, basePitch: 110,
    rateScale: 1.0, expressiveness: 1.0, humanize: 0,
  })
  await handle.done

  const rendered = await offlineCtx.startRendering()
  const data = rendered.getChannelData(0)
  let end = data.length - 1
  while (end > 0 && Math.abs(data[end]) < 0.001) end--
  end = Math.min(end + Math.round(SR * 0.1), data.length)
  const trimmed = new Float32Array(data.buffer, 0, end)
  let peak = 0
  for (let i = 0; i < trimmed.length; i++) peak = Math.max(peak, Math.abs(trimmed[i]))
  if (peak > 0.01) { const sc = 0.85 / peak; for (let i = 0; i < trimmed.length; i++) trimmed[i] *= sc }
  return trimmed
}

function multiScore(wavDir: string, words: string[]): Record<string, any> {
  const wordList = words.join(',')
  const resultFile = `${wavDir}/_results.json`
  const scriptPath = new URL('./multi-score.py', import.meta.url).pathname
  try {
    execSync(`python3 ${scriptPath} ${wavDir} ${wordList} ${resultFile}`, {
      timeout: 300000,
      env: { ...process.env, PYTHONHTTPSVERIFY: '0' },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
  } catch (e: any) {
    console.error(`Score error: ${e.message}`)
    return {}
  }
  return JSON.parse(fs.readFileSync(resultFile, 'utf-8'))
}

const PHRASES = ['yes', 'no', 'one', 'two', 'three', 'she saw me', 'hello', 'hello how are you',
                 'beat', 'bit', 'bet', 'bat', 'but', 'boot', 'boat', 'bird', 'buy', 'say', 'how', 'boy']

async function main() {
  // ── Step 1: Baseline with current gains ──
  console.log('=== BASELINE (current hand-tuned gains) ===')
  const baseDir = `${OUTPUT_DIR}/baseline`
  fs.mkdirSync(baseDir, { recursive: true })

  const wordKeys: string[] = []
  for (const phrase of PHRASES) {
    const safe = phrase.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
    wordKeys.push(safe)
    process.stdout.write(`  Rendering "${phrase}"... `)
    const audio = await renderPhrase(phrase)
    writeWav(`${baseDir}/${safe}.wav`, audio)
    console.log(`${(audio.length / SR).toFixed(1)}s`)
  }
  console.log('\nScoring baseline...')
  const baseResults = multiScore(baseDir, wordKeys)

  // ── Step 2: Apply eSpeak gains ──
  console.log('\n=== APPLYING ESPEAK-DERIVED GAINS ===')
  // Save originals
  const originals: Record<string, number[]> = {}
  for (const [ph, gains] of Object.entries(ESPEAK_GAINS)) {
    if (PHONEMES[ph]) {
      originals[ph] = [...PHONEMES[ph].bands]
      PHONEMES[ph].bands = [...gains]
      console.log(`  ${ph}: [${originals[ph].map(g => g.toFixed(2)).join(', ')}] → [${gains.map(g => g.toFixed(2)).join(', ')}]`)
    }
  }

  // ── Step 3: Render with eSpeak gains ──
  console.log('\n=== ESPEAK GAINS ===')
  const espeakDir = `${OUTPUT_DIR}/espeak`
  fs.mkdirSync(espeakDir, { recursive: true })

  for (const phrase of PHRASES) {
    const safe = phrase.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
    process.stdout.write(`  Rendering "${phrase}"... `)
    const audio = await renderPhrase(phrase)
    writeWav(`${espeakDir}/${safe}.wav`, audio)
    console.log(`${(audio.length / SR).toFixed(1)}s`)
  }
  console.log('\nScoring eSpeak gains...')
  const espeakResults = multiScore(espeakDir, wordKeys)

  // ── Step 4: Compare ──
  console.log('\n\n' + '='.repeat(80))
  console.log('COMPARISON: Baseline vs eSpeak-derived gains')
  console.log('='.repeat(80))
  console.log(`${'Word':<20} ${'Baseline':<30} ${'eSpeak':<30}`)
  console.log('-'.repeat(80))

  let baseCorrect = { tiny: 0, small: 0, vosk: 0 }
  let espeakCorrect = { tiny: 0, small: 0, vosk: 0 }

  for (const key of wordKeys) {
    const expected = key.replace(/_/g, ' ')
    const b = baseResults[key] || {}
    const e = espeakResults[key] || {}

    const bt = (b.whisper_tiny?.text || '').toLowerCase().replace(/[.,!?]/g, '').trim()
    const bs = (b.whisper_small?.text || '').toLowerCase().replace(/[.,!?]/g, '').trim()
    const bv = (b.vosk?.text || '').trim()

    const et = (e.whisper_tiny?.text || '').toLowerCase().replace(/[.,!?]/g, '').trim()
    const es = (e.whisper_small?.text || '').toLowerCase().replace(/[.,!?]/g, '').trim()
    const ev = (e.vosk?.text || '').trim()

    if (bt === expected) baseCorrect.tiny++
    if (bs === expected) baseCorrect.small++
    if (bv === expected) baseCorrect.vosk++
    if (et === expected) espeakCorrect.tiny++
    if (es === expected) espeakCorrect.small++
    if (ev === expected) espeakCorrect.vosk++

    const bStr = `t:${bt.slice(0,8)} s:${bs.slice(0,8)} v:${bv.slice(0,8)}`
    const eStr = `t:${et.slice(0,8)} s:${es.slice(0,8)} v:${ev.slice(0,8)}`
    console.log(`${expected:<20} ${bStr:<30} ${eStr:<30}`)
  }

  console.log('-'.repeat(80))
  console.log(`Baseline  — tiny:${baseCorrect.tiny}  small:${baseCorrect.small}  vosk:${baseCorrect.vosk}  total:${baseCorrect.tiny + baseCorrect.small + baseCorrect.vosk}/${PHRASES.length * 3}`)
  console.log(`eSpeak    — tiny:${espeakCorrect.tiny}  small:${espeakCorrect.small}  vosk:${espeakCorrect.vosk}  total:${espeakCorrect.tiny + espeakCorrect.small + espeakCorrect.vosk}/${PHRASES.length * 3}`)
}

main().catch(console.error)
