import * as WAA from "node-web-audio-api"
Object.assign(globalThis, {
  AudioContext: WAA.AudioContext, OfflineAudioContext: WAA.OfflineAudioContext,
  OscillatorNode: WAA.OscillatorNode, GainNode: WAA.GainNode,
  BiquadFilterNode: WAA.BiquadFilterNode, AudioBufferSourceNode: WAA.AudioBufferSourceNode,
  AnalyserNode: WAA.AnalyserNode, AudioWorkletNode: WAA.AudioWorkletNode,
  MediaStreamAudioDestinationNode: class { stream = null },
})
import * as fs from "fs"
import { VoderEngine } from "../src/engine"
import { speakPhonemeSequence } from "../src/sequencer"
import { textToPhonemes } from "../src/text-to-phoneme"
const SR = 48000
const tMs = parseInt(process.argv[2] || "35")
function writeWav(path: string, samples: Float32Array) {
  const n = samples.length, ds = n * 2, buf = Buffer.alloc(44 + ds)
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + ds, 4); buf.write("WAVE", 8)
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36)
  buf.writeUInt32LE(ds, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  fs.writeFileSync(path, buf)
}
async function render(text: string): Promise<Float32Array> {
  const ctx = new WAA.OfflineAudioContext(1, SR * 10, SR)
  const engine = new VoderEngine()
  await engine.start(ctx as any)
  const result = textToPhonemes(text)
  const handle = speakPhonemeSequence(engine, result.phonemes, {
    defaultDurationMs: 110, transitionMs: tMs, basePitch: 110,
    rateScale: 1.0, expressiveness: 0.35, humanize: 0,
  })
  await handle.done
  const rendered = await ctx.startRendering()
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
  const words = process.argv.slice(3)
  for (const word of words) {
    const safe = word.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()
    const audio = await render(word)
    writeWav("/tmp/voder-offline/" + safe + ".wav", audio)
  }
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
