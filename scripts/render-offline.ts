/**
 * Offline rendering using the ACTUAL VoderEngine + sequencer.
 *
 * Uses node-web-audio-api to provide AudioContext/BiquadFilterNode/etc
 * in Node.js. Imports and runs the SAME engine.ts and sequencer.ts
 * that the browser uses. Zero reimplementation.
 *
 * Usage: npx tsx scripts/render-offline.ts "hello" "she saw me"
 */

// Polyfill Web Audio APIs into globalThis so our engine code can use them
import * as WAA from 'node-web-audio-api'

// Make Web Audio APIs globally available so our engine.ts can use them
Object.assign(globalThis, {
  AudioContext: WAA.AudioContext,
  OfflineAudioContext: WAA.OfflineAudioContext,
  OscillatorNode: WAA.OscillatorNode,
  GainNode: WAA.GainNode,
  BiquadFilterNode: WAA.BiquadFilterNode,
  AudioBufferSourceNode: WAA.AudioBufferSourceNode,
  AnalyserNode: WAA.AnalyserNode,
  AudioWorkletNode: WAA.AudioWorkletNode,
  // Stub for MediaStreamAudioDestinationNode (not available in node, not needed offline)
  MediaStreamAudioDestinationNode: class { stream = null },
})

import * as fs from 'fs'
import { VoderEngine } from '../src/engine'
import { speakPhonemeSequence } from '../src/sequencer'
import { textToPhonemes } from '../src/text-to-phoneme'

const OUTPUT_DIR = '/tmp/voder-offline'
fs.mkdirSync(OUTPUT_DIR, { recursive: true })

const DEFAULT_PHRASES = [
  'yes', 'no', 'hello', 'one', 'two', 'three',
  'she saw me', 'hello how are you',
]

function writeWav(path: string, samples: Float32Array, sr: number): void {
  const n = samples.length, ds = n * 2, buf = Buffer.alloc(44 + ds)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + ds, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36)
  buf.writeUInt32LE(ds, 40)
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  }
  fs.writeFileSync(path, buf)
}

async function renderPhrase(text: string): Promise<Float32Array> {
  const SR = 48000
  const MAX_DUR = 10 // seconds

  // Create OfflineAudioContext — renders to a buffer, not speakers
  const offlineCtx = new WAA.OfflineAudioContext(1, SR * MAX_DUR, SR)

  // Create the REAL VoderEngine with the offline context
  const engine = new VoderEngine()
  await engine.start(offlineCtx as any)

  // Run the REAL text-to-phoneme + sequencer
  const result = textToPhonemes(text)
  const handle = speakPhonemeSequence(engine, result.phonemes, {
    defaultDurationMs: 110,
    transitionMs: 35,
    basePitch: 110,
    rateScale: 1.0,
    expressiveness: 0.7,
    humanize: 0,
  })

  await handle.done

  // Render the offline context to a buffer
  const rendered = await offlineCtx.startRendering()
  const data = rendered.getChannelData(0)

  // Trim trailing silence
  let end = data.length - 1
  while (end > 0 && Math.abs(data[end]) < 0.001) end--
  end = Math.min(end + Math.round(SR * 0.1), data.length)
  const trimmed = new Float32Array(data.buffer, 0, end)

  // Normalize
  let peak = 0
  for (let i = 0; i < trimmed.length; i++) peak = Math.max(peak, Math.abs(trimmed[i]))
  if (peak > 0.01) {
    const sc = 0.85 / peak
    for (let i = 0; i < trimmed.length; i++) trimmed[i] *= sc
  }

  return trimmed
}

async function main() {
  const phrases = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_PHRASES
  console.log(`Rendering ${phrases.length} phrases using actual VoderEngine`)
  console.log(`Output: ${OUTPUT_DIR}/`)

  for (const phrase of phrases) {
    const safeName = phrase.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
    process.stdout.write(`  "${phrase}"... `)

    try {
      const samples = await renderPhrase(phrase)
      if (samples.length > 0) {
        const path = `${OUTPUT_DIR}/${safeName}.wav`
        writeWav(path, samples, 48000)
        console.log(`${safeName}.wav (${(samples.length / 48000).toFixed(1)}s)`)
      } else {
        console.log(`rendered (no capture yet)`)
      }
    } catch (e: any) {
      console.log(`ERROR: ${e.message}`)
    }
  }

  console.log('\nDone.')
}

main().catch(console.error)
