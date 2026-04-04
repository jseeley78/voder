/**
 * Analysis-resynthesis: play frame-by-frame band gains through the Voder engine.
 * Usage: tsx scripts/resynth-frames.ts <frames.json> <output.wav>
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

const framesPath = process.argv[2]
const outputPath = process.argv[3]

if (!framesPath || !outputPath) {
  console.error('Usage: tsx resynth-frames.ts <frames.json> <output.wav>')
  process.exit(1)
}

interface Frame {
  time: number
  bands: number[]
  voiced: boolean
  noise: number
  voicedAmp: number
  pitchHz: number
}

const frames: Frame[] = JSON.parse(fs.readFileSync(framesPath, 'utf-8'))
const totalDuration = frames[frames.length - 1].time + 0.1 // add 100ms padding
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

async function main() {
  const ctx = new WAA.OfflineAudioContext(1, SR * Math.ceil(totalDuration + 0.5), SR)
  const engine = new VoderEngine()
  await engine.start(ctx as any)

  // Schedule every frame at its exact time
  for (const frame of frames) {
    engine.applyFrame({
      voiced: frame.voiced,
      voicedAmp: frame.voicedAmp,
      noise: frame.noise,
      pitchHz: frame.pitchHz,
      bands: frame.bands,
    }, 8, 'smooth', frame.time + 0.05) // small offset to avoid t=0
  }

  // Fade to silence at end
  const lastTime = frames[frames.length - 1].time + 0.05
  engine.applyFrame({
    voiced: false, voicedAmp: 0, noise: 0, pitchHz: 110,
    bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  }, 30, 'expo', lastTime + 0.05)

  const rendered = await ctx.startRendering()
  const data = rendered.getChannelData(0)

  // Trim silence
  let end = data.length - 1
  while (end > 0 && Math.abs(data[end]) < 0.001) end--
  end = Math.min(end + Math.round(SR * 0.05), data.length)
  const trimmed = new Float32Array(data.buffer, 0, end)

  // Normalize
  let peak = 0
  for (let i = 0; i < trimmed.length; i++) peak = Math.max(peak, Math.abs(trimmed[i]))
  if (peak > 0.01) { const sc = 0.85 / peak; for (let i = 0; i < trimmed.length; i++) trimmed[i] *= sc }

  writeWav(outputPath, trimmed)
  console.log(`Resynthesized ${frames.length} frames → ${outputPath} (${(trimmed.length/SR).toFixed(2)}s)`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
