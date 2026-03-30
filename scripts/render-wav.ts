/**
 * Offline Voder renderer: produces WAV files from text input
 * using the same phoneme table and synthesis logic as the browser engine,
 * but running as pure DSP math in Node.js.
 *
 * This lets us feed output to Whisper for intelligibility scoring
 * without needing a browser or microphone.
 */

import * as fs from 'fs'
import { BAND_CENTERS, BAND_WIDTHS, BAND_Q, BAND_COMPENSATION, PHONEMES } from '../src/phonemes'
import { textToPhonemes } from '../src/text-to-phoneme'
import { applyProsody } from '../src/prosody'

const SAMPLE_RATE = 22050  // Whisper's native rate
const TWO_PI = 2 * Math.PI

// ─── Simple biquad bandpass filter ───

class BiquadBandpass {
  private b0: number; private b1: number; private b2: number
  private a1: number; private a2: number
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0

  constructor(centerFreq: number, Q: number, sampleRate: number) {
    const w0 = TWO_PI * centerFreq / sampleRate
    const alpha = Math.sin(w0) / (2 * Q)
    const a0 = 1 + alpha
    this.b0 = alpha / a0
    this.b1 = 0
    this.b2 = -alpha / a0
    this.a1 = (-2 * Math.cos(w0)) / a0
    this.a2 = (1 - alpha) / a0
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1; this.x1 = x
    this.y2 = this.y1; this.y1 = y
    return y
  }
}

// ─── Simple biquad lowpass (for spectral tilt) ───

class BiquadLowpass {
  private b0: number; private b1: number; private b2: number
  private a1: number; private a2: number
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0

  constructor(freq: number, Q: number, sampleRate: number) {
    const w0 = TWO_PI * freq / sampleRate
    const alpha = Math.sin(w0) / (2 * Q)
    const cosw = Math.cos(w0)
    const a0 = 1 + alpha
    this.b0 = ((1 - cosw) / 2) / a0
    this.b1 = (1 - cosw) / a0
    this.b2 = ((1 - cosw) / 2) / a0
    this.a1 = (-2 * cosw) / a0
    this.a2 = (1 - alpha) / a0
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1; this.x1 = x
    this.y2 = this.y1; this.y1 = y
    return y
  }
}

// ─── Simple biquad peaking EQ ───

class BiquadPeaking {
  private b0: number; private b1: number; private b2: number
  private a1: number; private a2: number
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0

  constructor(freq: number, Q: number, gainDb: number, sampleRate: number) {
    const A = Math.pow(10, gainDb / 40)
    const w0 = TWO_PI * freq / sampleRate
    const alpha = Math.sin(w0) / (2 * Q)
    const a0 = 1 + alpha / A
    this.b0 = (1 + alpha * A) / a0
    this.b1 = (-2 * Math.cos(w0)) / a0
    this.b2 = (1 - alpha * A) / a0
    this.a1 = this.b1
    this.a2 = (1 - alpha / A) / a0
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1; this.x1 = x
    this.y2 = this.y1; this.y1 = y
    return y
  }
}

// ─── Glottal pulse generator (matches AudioWorklet) ───

class GlottalPulse {
  private phase = 0
  private chargeTime = 0.0003
  private dischargeTime = 0.0008

  generate(freq: number, sampleRate: number): number {
    const period = 1.0 / Math.max(freq, 20)
    this.phase += 1.0 / sampleRate

    if (this.phase >= period) {
      this.phase -= period
      this.chargeTime = 0.0003 * (1.0 + (Math.random() - 0.5) * 0.04)
      this.dischargeTime = 0.0008 * (1.0 + (Math.random() - 0.5) * 0.04)
    }

    const t = this.phase
    if (t < this.chargeTime) {
      const tau = this.chargeTime * 0.25
      return (1.0 - Math.exp(-t / tau) - 0.3) * 0.8
    } else if (t < this.chargeTime + this.dischargeTime) {
      const dt = t - this.chargeTime
      const tau = this.dischargeTime * 0.35
      return (Math.exp(-dt / tau) - 0.3) * 0.8
    }
    return (0.02 - 0.3) * 0.8
  }
}

// ─── Gaussian pink noise (matches engine) ───

function generatePinkNoise(length: number): Float32Array {
  const data = new Float32Array(length)
  // Gaussian via Box-Muller
  for (let i = 0; i < length; i += 2) {
    const u1 = Math.random() || 1e-10
    const u2 = Math.random()
    const r = Math.sqrt(-2 * Math.log(u1))
    data[i] = r * Math.cos(TWO_PI * u2)
    if (i + 1 < length) data[i + 1] = r * Math.sin(TWO_PI * u2)
  }
  // Paul Kellet pink filter
  let b0 = 0, b1 = 0, b2 = 0
  for (let i = 0; i < length; i++) {
    const w = data[i]
    b0 = 0.99765 * b0 + w * 0.0990460
    b1 = 0.96300 * b1 + w * 0.2965164
    b2 = 0.57000 * b2 + w * 1.0526913
    data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.22
  }
  return data
}

// ─── WAV writer ───

function writeWav(path: string, samples: Float32Array, sampleRate: number): void {
  const numSamples = samples.length
  const bitsPerSample = 16
  const byteRate = sampleRate * bitsPerSample / 8
  const dataSize = numSamples * bitsPerSample / 8
  const buffer = Buffer.alloc(44 + dataSize)

  // RIFF header
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)       // chunk size
  buffer.writeUInt16LE(1, 20)        // PCM
  buffer.writeUInt16LE(1, 22)        // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(2, 32)        // block align
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }

  fs.writeFileSync(path, buffer)
}

// ─── Offline Voder renderer ───

interface RenderFrame {
  voiced: boolean
  voicedAmp: number
  noise: number
  pitchHz: number
  bands: number[]
  durationMs: number
}

function renderFrames(frames: RenderFrame[], sampleRate: number): Float32Array {
  const totalSamples = frames.reduce((s, f) => s + Math.round(f.durationMs / 1000 * sampleRate), 0)
  const output = new Float32Array(totalSamples)

  // Create filter bank
  const filters = BAND_CENTERS.map((c, i) => new BiquadBandpass(c, BAND_Q[i], sampleRate))
  const tilt = new BiquadLowpass(3400, 0.65, sampleRate)
  // Output EQ (1939 speaker model)
  const eqMid = new BiquadPeaking(2800, 0.8, 5, sampleRate)

  const glottal = new GlottalPulse()
  const noise = generatePinkNoise(totalSamples + 1000)
  let noiseIdx = 0

  let sampleIdx = 0
  let prevFrame: RenderFrame | null = null

  for (const frame of frames) {
    const numSamples = Math.round(frame.durationMs / 1000 * sampleRate)
    const transitionSamples = Math.min(numSamples, Math.round(0.035 * sampleRate)) // 35ms transition

    for (let i = 0; i < numSamples; i++) {
      // Smooth transition from previous frame
      const t = i < transitionSamples ? i / transitionSamples : 1.0
      const curVoicedAmp = frame.voiced ? frame.voicedAmp * 0.30 : 0
      const curNoiseAmp = frame.noise * 0.10

      let voicedAmp: number, noiseAmp: number, pitch: number
      const curBands = new Float64Array(10)

      if (prevFrame && t < 1.0) {
        const prevVA = prevFrame.voiced ? prevFrame.voicedAmp * 0.30 : 0
        const prevNA = prevFrame.noise * 0.10
        voicedAmp = prevVA * (1 - t) + curVoicedAmp * t
        noiseAmp = prevNA * (1 - t) + curNoiseAmp * t
        pitch = prevFrame.pitchHz * (1 - t) + frame.pitchHz * t
        for (let b = 0; b < 10; b++) {
          curBands[b] = (prevFrame.bands[b] || 0) * (1 - t) + (frame.bands[b] || 0) * t
        }
      } else {
        voicedAmp = curVoicedAmp
        noiseAmp = curNoiseAmp
        pitch = frame.pitchHz
        for (let b = 0; b < 10; b++) curBands[b] = frame.bands[b] || 0
      }

      // Generate sources
      const buzzSample = tilt.process(glottal.generate(pitch, sampleRate)) * voicedAmp
      const noiseSample = noise[noiseIdx++ % noise.length] * noiseAmp
      const excitation = buzzSample + noiseSample

      // Filter bank
      let sum = 0
      for (let b = 0; b < 10; b++) {
        const gain = Math.max(0, Math.min(1.5, curBands[b] * BAND_COMPENSATION[b]))
        sum += filters[b].process(excitation) * gain
      }

      // Output EQ
      sum = eqMid.process(sum)

      output[sampleIdx++] = sum
    }

    prevFrame = frame
  }

  // Normalize to prevent clipping
  let peak = 0
  for (let i = 0; i < output.length; i++) peak = Math.max(peak, Math.abs(output[i]))
  if (peak > 0.01) {
    const scale = 0.85 / peak
    for (let i = 0; i < output.length; i++) output[i] *= scale
  }

  return output
}

// ─── Text to frames (simplified sequencer) ───

function textToFrames(text: string, basePitch: number): RenderFrame[] {
  const result = textToPhonemes(text)
  const rawTokens = result.phonemes.split(/\s+/).filter(Boolean).map(x => x.toUpperCase())
  const prosody = applyProsody(rawTokens, { expressiveness: 0.7 })

  const frames: RenderFrame[] = []

  for (const pt of prosody) {
    const ph = PHONEMES[pt.phoneme]
    if (!ph) continue

    const pitchHz = basePitch * pt.pitchMul
    const durationMs = (ph.durationMs * pt.durationMul)
    const bands = ph.bands.map(g => g * pt.ampMul)

    // Transient burst
    if (ph.transient) {
      frames.push({
        voiced: false,
        voicedAmp: 0,
        noise: ph.transient.noise,
        pitchHz,
        bands: ph.transient.bands,
        durationMs: ph.transient.durationMs,
      })
    }

    // Main phoneme
    frames.push({
      voiced: ph.voiced,
      voicedAmp: ph.voicedAmp,
      noise: ph.noise,
      pitchHz,
      bands,
      durationMs,
    })

    // Pause
    if (pt.pauseAfterMs > 0) {
      frames.push({
        voiced: false, voicedAmp: 0, noise: 0, pitchHz,
        bands: Array(10).fill(0),
        durationMs: pt.pauseAfterMs,
      })
    }
  }

  return frames
}

// ─── Main: render test words to WAV ───

const OUTPUT_DIR = '/tmp/voder-render'
fs.mkdirSync(OUTPUT_DIR, { recursive: true })

const testWords = process.argv.slice(2)
const words = testWords.length > 0 ? testWords : [
  'hello', 'world', 'the', 'one', 'two', 'three', 'four', 'five',
  'robot', 'computer', 'speech', 'beautiful', 'running', 'question',
]

console.log(`Rendering ${words.length} words to ${OUTPUT_DIR}/`)

for (const word of words) {
  const frames = textToFrames(word, 110)
  const audio = renderFrames(frames, SAMPLE_RATE)
  const path = `${OUTPUT_DIR}/${word}.wav`
  writeWav(path, audio, SAMPLE_RATE)
  console.log(`  ${word}: ${audio.length} samples (${(audio.length / SAMPLE_RATE).toFixed(2)}s)`)
}

console.log(`\nDone. Run Whisper:`)
console.log(`  whisper ${OUTPUT_DIR}/*.wav --model tiny --language en`)
