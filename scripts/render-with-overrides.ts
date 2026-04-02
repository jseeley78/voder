/**
 * Render words using VoderEngine with phoneme gain overrides from a JSON file.
 * Usage: tsx scripts/render-with-overrides.ts <overrides.json> <output_dir> word1 word2 ...
 */
import * as WAA from 'node-web-audio-api'
Object.assign(globalThis, {
  AudioContext: WAA.AudioContext, OfflineAudioContext: WAA.OfflineAudioContext,
  OscillatorNode: WAA.OscillatorNode, GainNode: WAA.GainNode,
  BiquadFilterNode: WAA.BiquadFilterNode, AudioBufferSourceNode: WAA.AudioBufferSourceNode,
  AnalyserNode: WAA.AnalyserNode, AudioWorkletNode: WAA.AudioWorkletNode,
  MediaStreamAudioDestinationNode: class { stream = null },
})

import * as fs from 'fs'
import { VoderEngine } from '../src/engine'
import { speakPhonemeSequence } from '../src/sequencer'
import { textToPhonemes } from '../src/text-to-phoneme'
import { PHONEMES } from '../src/phonemes'

const overridesPath = process.argv[2]
const outputDir = process.argv[3]
const words = process.argv.slice(4)

if (!overridesPath || !outputDir || words.length === 0) {
  console.error('Usage: tsx render-with-overrides.ts <overrides.json> <output_dir> word1 word2 ...')
  process.exit(1)
}

// Apply gain overrides
const overrides = JSON.parse(fs.readFileSync(overridesPath, 'utf-8'))
for (const [ph, bands] of Object.entries(overrides)) {
  if (PHONEMES[ph]) PHONEMES[ph].bands = bands as number[]
}

fs.mkdirSync(outputDir, { recursive: true })

const SR = 48000

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

async function main() {
  for (const word of words) {
    const safe = word.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
    const audio = await renderPhrase(word)
    writeWav(`${outputDir}/${safe}.wav`, audio)
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
