/**
 * Parameter sweep: renders test phrases across different settings
 * and scores with multi-listener pipeline.
 *
 * Usage: npx tsx scripts/sweep-params.ts
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

const SR = 48000
const OUTPUT_DIR = '/tmp/voder-sweep'
fs.mkdirSync(OUTPUT_DIR, { recursive: true })

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

interface RenderOpts {
  expressiveness: number
  basePitch: number
  transitionMs: number
  defaultDurationMs: number
  rateScale: number
  waveform: string
}

async function renderPhrase(text: string, opts: RenderOpts): Promise<Float32Array> {
  const offlineCtx = new WAA.OfflineAudioContext(1, SR * 10, SR)
  const engine = new VoderEngine()
  engine.waveformType = opts.waveform as any
  await engine.start(offlineCtx as any)

  const result = textToPhonemes(text)
  const handle = speakPhonemeSequence(engine, result.phonemes, {
    defaultDurationMs: opts.defaultDurationMs,
    transitionMs: opts.transitionMs,
    basePitch: opts.basePitch,
    rateScale: opts.rateScale,
    expressiveness: opts.expressiveness,
    humanize: 0,
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
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (e: any) {
    console.error(`  Score error: ${e.stderr?.toString() || e.message}`)
    return {}
  }
  return JSON.parse(fs.readFileSync(resultFile, 'utf-8'))
}

function countCorrect(results: Record<string, any>, listener: string): number {
  let correct = 0
  for (const [word, data] of Object.entries(results) as [string, any][]) {
    const expected = data.expected.toLowerCase()
    const got = (data[listener]?.text || '').toLowerCase().replace(/[.,!?]/g, '').trim()
    if (got === expected) correct++
  }
  return correct
}

const PHRASES = ['yes', 'no', 'one', 'two', 'three', 'she saw me', 'hello', 'hello how are you']

const DEFAULTS: RenderOpts = {
  expressiveness: 1.0,
  basePitch: 110,
  transitionMs: 35,
  defaultDurationMs: 110,
  rateScale: 1.0,
  waveform: 'damped-pulse',
}

interface SweepDim {
  name: keyof RenderOpts
  values: (number | string)[]
}

const SWEEPS: SweepDim[] = [
  { name: 'expressiveness', values: [0.0, 0.3, 0.5, 0.7, 1.0] },
  { name: 'waveform', values: ['damped-pulse', 'rosenberg', 'sawtooth', 'impulse', 'warm', 'buzzy'] },
  { name: 'basePitch', values: [90, 100, 110, 130, 150] },
  { name: 'transitionMs', values: [20, 35, 50, 70] },
  { name: 'defaultDurationMs', values: [80, 110, 140, 170] },
  { name: 'rateScale', values: [0.7, 0.85, 1.0, 1.2] },
]

async function main() {
  console.log('=== PARAMETER SWEEP ===')
  console.log(`Phrases: ${PHRASES.join(', ')}`)
  console.log()

  const allResults: { param: string; value: string | number; whisper_tiny: number; whisper_small: number; vosk: number; total: number }[] = []

  for (const sweep of SWEEPS) {
    console.log(`\n── Sweeping: ${sweep.name} ──`)

    for (const val of sweep.values) {
      const opts = { ...DEFAULTS, [sweep.name]: val }
      const sweepDir = `${OUTPUT_DIR}/${sweep.name}_${val}`
      fs.mkdirSync(sweepDir, { recursive: true })

      process.stdout.write(`  ${sweep.name}=${val} ... `)

      // Render all phrases
      const wordKeys: string[] = []
      for (const phrase of PHRASES) {
        const safe = phrase.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
        wordKeys.push(safe)
        try {
          const audio = await renderPhrase(phrase, opts)
          writeWav(`${sweepDir}/${safe}.wav`, audio)
        } catch (e: any) {
          console.error(`render error: ${e.message}`)
        }
      }

      // Score
      const results = multiScore(sweepDir, wordKeys)
      const wt = countCorrect(results, 'whisper_tiny')
      const ws = countCorrect(results, 'whisper_small')
      const vk = countCorrect(results, 'vosk')
      const total = wt + ws + vk

      console.log(`tiny=${wt}/${PHRASES.length}  small=${ws}/${PHRASES.length}  vosk=${vk}/${PHRASES.length}  total=${total}/${PHRASES.length * 3}`)

      allResults.push({ param: sweep.name, value: val, whisper_tiny: wt, whisper_small: ws, vosk: vk, total })
    }
  }

  // Summary: best setting per param
  console.log('\n\n=== BEST PER PARAMETER ===')
  for (const sweep of SWEEPS) {
    const paramResults = allResults.filter(r => r.param === sweep.name)
    paramResults.sort((a, b) => b.total - a.total)
    const best = paramResults[0]
    console.log(`  ${sweep.name}: ${best.value} (total=${best.total})`)
  }

  // Save full results
  fs.writeFileSync(`${OUTPUT_DIR}/sweep-results.json`, JSON.stringify(allResults, null, 2))
  console.log(`\nFull results: ${OUTPUT_DIR}/sweep-results.json`)
}

main().catch(console.error)
