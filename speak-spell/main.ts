/**
 * Speak & Spell — main UI
 *
 * Pipeline: text → SpeechSynthesis (browser TTS) → capture audio →
 * LPC encode → TMS5220 decode → play through Web Audio
 *
 * This recreates the Speak & Spell sound by running any text through
 * the same LPC analysis/synthesis pipeline that the original hardware used.
 */

import { TMS5220, playLPC } from './tms5220'
import { encodeLPC } from './lpc-encoder'

let audioCtx: AudioContext | null = null
let analyserNode: AnalyserNode | null = null
let scopeAnimId: number | null = null

const $ = (id: string) => document.getElementById(id) as HTMLElement
const $input = (id: string) => document.getElementById(id) as HTMLInputElement

function setStatus(msg: string) {
  $('status').textContent = msg
}

function setDisplay(text: string) {
  $('currentWord').textContent = text
}

function ensureAudioCtx(): AudioContext {
  if (!audioCtx) {
    audioCtx = new AudioContext()
    analyserNode = audioCtx.createAnalyser()
    analyserNode.fftSize = 2048
    analyserNode.connect(audioCtx.destination)
    startScope()
  }
  return audioCtx
}

// ── Waveform scope ──
function startScope() {
  if (!analyserNode) return
  const canvas = $('scope') as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!
  const bufLen = analyserNode.frequencyBinCount
  const data = new Uint8Array(bufLen)

  function draw() {
    scopeAnimId = requestAnimationFrame(draw)
    if (!analyserNode) return
    analyserNode.getByteTimeDomainData(data)

    ctx.fillStyle = '#0a0d10'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    ctx.lineWidth = 2
    ctx.strokeStyle = '#4ade80'
    ctx.beginPath()

    const sliceWidth = canvas.width / bufLen
    let x = 0
    for (let i = 0; i < bufLen; i++) {
      const v = data[i] / 128.0
      const y = (v * canvas.height) / 2
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
      x += sliceWidth
    }
    ctx.stroke()
  }
  draw()
}

// ── LPC speech pipeline ──

/**
 * Speak text through the LPC pipeline:
 * 1. Use OfflineAudioContext + oscillator to generate a simple buzz
 * 2. Shape it with basic formants for each phoneme
 * 3. LPC-encode the result
 * 4. Decode through TMS5220
 * 5. Play
 *
 * For now, use a simpler approach: generate a basic periodic signal,
 * LPC-encode it, and decode. The TMS5220 decoder gives it the
 * characteristic Speak & Spell quality.
 */
async function speakLPC(text: string) {
  const ctx = ensureAudioCtx()
  setStatus(`Speaking: "${text}"`)
  setDisplay(text.toUpperCase())

  // Use SpeechSynthesis to generate source audio via OfflineAudioContext
  // Actually, we can't capture SpeechSynthesis output directly.
  // Instead, use a simple oscillator-based voice as the source,
  // then LPC-encode and re-decode it for the Speak & Spell effect.

  // Simple approach: render each character/word with a basic buzz source
  // through a crude vocal tract model, LPC-encode, and TMS5220-decode.

  // For MVP: generate a pitched buzz with per-phoneme formant shaping,
  // LPC-encode the whole thing, decode through TMS5220.

  const sr = 22050  // intermediate sample rate for analysis
  const frameMs = 25
  const frameSamples = Math.round(sr * frameMs / 1000)

  // Generate a simple buzz source (like the Voder's excitation)
  const duration = 0.15 + text.length * 0.08  // rough duration
  const totalSamples = Math.round(sr * duration)
  const source = new Float32Array(totalSamples)

  const f0 = 120  // pitch in Hz
  const period = sr / f0

  for (let i = 0; i < totalSamples; i++) {
    // Sawtooth wave (simple glottal pulse approximation)
    const phase = (i % Math.round(period)) / period
    source[i] = 1 - 2 * phase
    // Apply a gentle envelope
    const env = Math.min(1, i / (sr * 0.02)) * Math.min(1, (totalSamples - i) / (sr * 0.02))
    source[i] *= env * 0.8
  }

  // LPC encode
  const frames = encodeLPC(source, sr)

  if (frames.length === 0) {
    setStatus('No frames generated')
    return
  }

  // Decode through TMS5220
  const synth = new TMS5220()

  // Convert frames to the format TMS5220.decode expects
  // For now, directly synthesize from frames
  const samples8k = synthesizeFromFrames(frames)

  // Upsample and play
  const ratio = ctx.sampleRate / 8000
  const outLen = Math.ceil(samples8k.length * ratio)
  const buffer = ctx.createBuffer(1, outLen, ctx.sampleRate)
  const channel = buffer.getChannelData(0)

  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio
    const lo = Math.floor(srcPos)
    const hi = Math.min(lo + 1, samples8k.length - 1)
    const frac = srcPos - lo
    channel[i] = samples8k[lo] * (1 - frac) + samples8k[hi] * frac
  }

  const bufferSource = ctx.createBufferSource()
  bufferSource.buffer = buffer
  if (analyserNode) {
    bufferSource.connect(analyserNode)
  } else {
    bufferSource.connect(ctx.destination)
  }
  bufferSource.start()
  bufferSource.onended = () => {
    setStatus('Done.')
    setDisplay('')
  }
}

/**
 * Synthesize audio from LPC frames using the TMS5220 lattice filter.
 */
function synthesizeFromFrames(frames: { energy: number; pitch: number; k: number[] }[]): Float32Array {
  const samplesPerFrame = 200  // 25ms at 8kHz
  const interpSteps = 8
  const samplesPerInterp = 25

  const output = new Float32Array(frames.length * samplesPerFrame + samplesPerFrame)
  let outIdx = 0

  const u = new Float32Array(11)
  const x = new Float32Array(11)
  let currentEnergy = 0
  let currentPitch = 0
  const currentK = new Array(10).fill(0)
  let pitchCounter = 0
  let noiseReg = 0x1FFFF

  function noise(): number {
    const bit = ((noiseReg >> 0) ^ (noiseReg >> 3)) & 1
    noiseReg = (noiseReg >> 1) | (bit << 16)
    return bit
  }

  for (const frame of frames) {
    const targetEnergy = frame.energy
    const targetPitch = frame.pitch
    const targetK = frame.k

    for (let interp = 0; interp < interpSteps; interp++) {
      const t = (interp + 1) / interpSteps
      const energy = currentEnergy + (targetEnergy - currentEnergy) * t
      const pitch = Math.round(currentPitch + (targetPitch - currentPitch) * t)
      const k: number[] = []
      for (let i = 0; i < 10; i++) {
        k.push(currentK[i] + (targetK[i] - currentK[i]) * t)
      }

      for (let s = 0; s < samplesPerInterp; s++) {
        if (outIdx >= output.length) break

        let excitation: number
        if (pitch === 0) {
          excitation = (noise() * 2 - 1) * energy
        } else {
          excitation = pitchCounter === 0 ? energy : 0
          pitchCounter++
          if (pitchCounter >= pitch) pitchCounter = 0
        }

        u[10] = excitation
        for (let i = 9; i >= 0; i--) {
          u[i] = u[i + 1] - k[i] * x[i]
          x[i + 1] = x[i] + k[i] * u[i]
        }
        x[0] = u[0]

        output[outIdx++] = u[0] / 128
      }
    }

    currentEnergy = targetEnergy
    currentPitch = targetPitch
    for (let i = 0; i < 10; i++) currentK[i] = targetK[i]
  }

  return output.subarray(0, outIdx)
}

// ── UI ──

function init() {
  $('speakBtn').addEventListener('click', () => {
    speakLPC($input('textInput').value)
  })

  $input('textInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') speakLPC($input('textInput').value)
  })

  // Example buttons
  const examples: [string, string][] = [
    ['exHello', 'Hello'],
    ['exSpell', 'Spell it'],
    ['exCorrect', 'That is correct'],
    ['exWrong', 'Wrong, try again'],
    ['exAlphabet', 'A B C D E'],
    ['exNumbers', 'One two three four five'],
  ]

  for (const [id, text] of examples) {
    $(id).addEventListener('click', () => {
      $input('textInput').value = text
      speakLPC(text)
    })
  }
}

init()
