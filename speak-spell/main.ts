/**
 * Speak & Spell — main UI
 *
 * Pipeline options:
 * 1. Text → simple formant model (Web Audio oscillator+filters) → LPC → TMS5220
 * 2. Text → CMU dict phonemes → basic synthesis → LPC → TMS5220
 *
 * The browser's SpeechSynthesis API can't be captured as raw audio,
 * so we generate source audio with a simple Web Audio oscillator model,
 * then run it through LPC analysis/resynthesis to get the Speak & Spell sound.
 */

import { encodeLPC } from './lpc-encoder'
import { textToPhonemes } from '../src/text-to-phoneme'
import { PHONEMES } from '../src/phonemes'
import { TMS5220, playLPC } from './tms5220'
import { VOCABULARY, getWordList } from './vocabulary'

let audioCtx: AudioContext | null = null
let analyserNode: AnalyserNode | null = null

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

function startScope() {
  if (!analyserNode) return
  const canvas = $('scope') as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!
  const bufLen = analyserNode.frequencyBinCount
  const data = new Uint8Array(bufLen)

  function draw() {
    requestAnimationFrame(draw)
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

/**
 * Generate source audio using a simple oscillator + formant filter model.
 * Much simpler than the full Voder — just enough to give LPC something to work with.
 */
async function generateSourceAudio(text: string): Promise<Float32Array> {
  const sr = 22050
  const result = textToPhonemes(text)
  const phonemes = result.phonemes.split(/\s+/).filter(Boolean)

  // Calculate total duration
  let totalMs = 0
  for (const raw of phonemes) {
    const ph = raw.replace(/[0-9]/g, '').toUpperCase()
    if (ph === '|') { totalMs += 80; continue }
    if (/^[,.\?!;:]$/.test(ph)) { totalMs += 150; continue }
    const def = PHONEMES[ph]
    totalMs += def ? def.durationMs : 100
  }

  const totalSamples = Math.ceil(sr * (totalMs + 200) / 1000)
  const offlineCtx = new OfflineAudioContext(1, totalSamples, sr)

  // Create a sawtooth oscillator as the voiced source
  const osc = offlineCtx.createOscillator()
  osc.type = 'sawtooth'
  osc.frequency.value = 120

  // Create a noise source for unvoiced sounds
  const noiseBuffer = offlineCtx.createBuffer(1, sr * 2, sr)
  const noiseData = noiseBuffer.getChannelData(0)
  for (let i = 0; i < noiseData.length; i++) {
    noiseData[i] = Math.random() * 2 - 1
  }
  const noiseSrc = offlineCtx.createBufferSource()
  noiseSrc.buffer = noiseBuffer
  noiseSrc.loop = true

  // Gain nodes for voiced/unvoiced mixing
  const oscGain = offlineCtx.createGain()
  const noiseGain = offlineCtx.createGain()
  oscGain.gain.value = 0
  noiseGain.gain.value = 0

  // Simple formant filter (2 bandpass filters for F1 and F2)
  const f1 = offlineCtx.createBiquadFilter()
  f1.type = 'bandpass'
  f1.frequency.value = 500
  f1.Q.value = 5

  const f2 = offlineCtx.createBiquadFilter()
  f2.type = 'bandpass'
  f2.frequency.value = 1500
  f2.Q.value = 5

  const merger = offlineCtx.createGain()
  merger.gain.value = 1.0

  // Wire up
  osc.connect(oscGain)
  noiseSrc.connect(noiseGain)
  oscGain.connect(f1)
  oscGain.connect(f2)
  noiseGain.connect(f1)
  noiseGain.connect(f2)
  f1.connect(merger)
  f2.connect(merger)
  merger.connect(offlineCtx.destination)

  osc.start()
  noiseSrc.start()

  // Schedule phoneme parameters
  let t = 0.05  // small offset
  for (const raw of phonemes) {
    const ph = raw.replace(/[0-9]/g, '').toUpperCase()

    if (ph === '|') { t += 0.08; continue }
    if (/^[,.\?!;:]$/.test(ph)) { t += 0.15; continue }

    const def = PHONEMES[ph]
    if (!def) { t += 0.1; continue }

    const dur = def.durationMs / 1000

    // Set formant frequencies based on phoneme bands
    // Use the two highest-energy bands as F1/F2 approximation
    const bands = def.bands
    let maxB1 = 0, maxB1Idx = 0, maxB2 = 0, maxB2Idx = 0
    const centers = [112, 338, 575, 850, 1200, 1700, 2350, 3250, 4600, 6450]
    for (let i = 0; i < 10; i++) {
      if (bands[i] > maxB1) {
        maxB2 = maxB1; maxB2Idx = maxB1Idx
        maxB1 = bands[i]; maxB1Idx = i
      } else if (bands[i] > maxB2) {
        maxB2 = bands[i]; maxB2Idx = i
      }
    }
    // Ensure F1 < F2
    const f1Idx = Math.min(maxB1Idx, maxB2Idx)
    const f2Idx = Math.max(maxB1Idx, maxB2Idx)

    f1.frequency.setValueAtTime(centers[f1Idx], t)
    f2.frequency.setValueAtTime(centers[f2Idx], t)

    // Voiced/unvoiced mixing
    const vAmp = def.voiced ? (def.voicedAmp || 0.5) : 0
    const nAmp = def.noise || 0
    oscGain.gain.setValueAtTime(vAmp * 0.5, t)
    noiseGain.gain.setValueAtTime(nAmp * 0.3, t)

    t += dur
  }

  // Fade out
  oscGain.gain.setValueAtTime(0, t)
  noiseGain.gain.setValueAtTime(0, t)

  const rendered = await offlineCtx.startRendering()
  const data = rendered.getChannelData(0)

  // Trim silence
  let end = data.length - 1
  while (end > 0 && Math.abs(data[end]) < 0.001) end--
  return data.subarray(0, Math.min(end + Math.round(sr * 0.05), data.length))
}

/**
 * TMS5220 lattice filter synthesis from LPC frames.
 */
function synthesizeFromFrames(frames: { energy: number; pitch: number; k: number[] }[]): Float32Array {
  const samplesPerFrame = 200
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
    for (let interp = 0; interp < interpSteps; interp++) {
      const t = (interp + 1) / interpSteps
      const energy = currentEnergy + (frame.energy - currentEnergy) * t
      const pitch = Math.round(currentPitch + (frame.pitch - currentPitch) * t)
      const k: number[] = []
      for (let i = 0; i < 10; i++) {
        k.push(currentK[i] + (frame.k[i] - currentK[i]) * t)
      }

      for (let s = 0; s < samplesPerInterp; s++) {
        if (outIdx >= output.length) break
        let exc: number
        if (pitch === 0) {
          exc = (noise() * 2 - 1) * energy
        } else {
          exc = pitchCounter === 0 ? energy : 0
          pitchCounter++
          if (pitchCounter >= pitch) pitchCounter = 0
        }
        u[10] = exc
        for (let i = 9; i >= 0; i--) {
          u[i] = u[i + 1] - k[i] * x[i]
          x[i + 1] = x[i] + k[i] * u[i]
        }
        x[0] = u[0]
        output[outIdx++] = u[0] / 128
      }
    }
    currentEnergy = frame.energy
    currentPitch = frame.pitch
    for (let i = 0; i < 10; i++) currentK[i] = frame.k[i]
  }

  return output.subarray(0, outIdx)
}

/**
 * Full pipeline: text → source audio → LPC encode → TMS5220 decode → play
 */
async function speakLPC(text: string) {
  const ctx = ensureAudioCtx()
  setStatus('Generating source audio...')
  setDisplay(text.toUpperCase())

  try {
    // Generate source audio
    const sourceAudio = await generateSourceAudio(text)

    if (sourceAudio.length < 100) {
      setStatus('No audio generated')
      return
    }

    // LPC encode
    setStatus(`LPC encoding ${sourceAudio.length} samples...`)
    const frames = encodeLPC(sourceAudio, 22050)

    // TMS5220 decode
    setStatus(`Decoding ${frames.length} frames through TMS5220...`)
    const samples8k = synthesizeFromFrames(frames)

    // Normalize
    let peak = 0
    for (let i = 0; i < samples8k.length; i++) peak = Math.max(peak, Math.abs(samples8k[i]))
    if (peak > 0.01) {
      const sc = 0.85 / peak
      for (let i = 0; i < samples8k.length; i++) samples8k[i] *= sc
    }

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

    const source = ctx.createBufferSource()
    source.buffer = buffer
    if (analyserNode) source.connect(analyserNode)
    else source.connect(ctx.destination)

    setStatus(`Playing (${(samples8k.length / 8000).toFixed(1)}s, ${frames.length} LPC frames)`)
    source.start()
    source.onended = () => {
      setStatus('Done.')
      setTimeout(() => setDisplay(''), 500)
    }
  } catch (err: any) {
    setStatus(`Error: ${err.message}`)
    console.error(err)
  }
}

/**
 * Play a pre-encoded word from the TI-99 vocabulary ROM.
 */
async function playRomWord(name: string) {
  const ctx = ensureAudioCtx()
  const data = VOCABULARY[name]
  if (!data) {
    setStatus(`Word "${name}" not in vocabulary`)
    return
  }
  setDisplay(name.replace(/_/g, ' '))
  setStatus(`Playing ROM word: ${name}`)

  try {
    const authentic = ($('authenticMode') as HTMLInputElement).checked
    await playLPC(ctx, data, analyserNode ?? undefined, authentic)
    setStatus('Done.')
    setTimeout(() => setDisplay(''), 500)
  } catch (err: any) {
    setStatus(`Error: ${err.message}`)
  }
}

/**
 * Try to play text using ROM vocabulary first (word by word),
 * fall back to LPC synthesis for unknown words.
 */
async function speakText(text: string) {
  const words = text.trim().split(/\s+/)
  setDisplay(text.toUpperCase())

  for (const word of words) {
    const key = word.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (VOCABULARY[key]) {
      await playRomWord(key)
    } else {
      // Fall back to LPC synthesis
      await speakLPC(word)
    }
  }
}

// ── UI ──
function init() {
  $('speakBtn').addEventListener('click', () => speakText($input('textInput').value))
  $input('textInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') speakText($input('textInput').value)
  })

  // Example buttons — use ROM words where available
  const examples: [string, string][] = [
    ['exHello', 'HELLO'],
    ['exSpell', 'SPELL IT'],
    ['exCorrect', 'THAT IS CORRECT'],
    ['exWrong', 'WRONG TRY AGAIN'],
    ['exAlphabet', 'A B C D E'],
    ['exNumbers', 'ONE TWO THREE FOUR FIVE'],
  ]

  for (const [id, text] of examples) {
    $(id).addEventListener('click', () => {
      $input('textInput').value = text
      speakText(text)
    })
  }

  // Build vocabulary word grid
  const wordGrid = $('wordGrid') as HTMLElement
  if (wordGrid) {
    // Show a curated subset of interesting words
    const featured = [
      'HELLO', 'GOODBYE', 'YES', 'NO', 'PLEASE', 'THANK_YOU',
      'CORRECT', 'WRONG', 'SPELL', 'AGAIN', 'TRY',
      'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J',
      'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T',
      'U', 'V', 'W', 'X', 'Y', 'Z',
      'ZERO', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE',
      'SIX', 'SEVEN', 'EIGHT', 'NINE', 'TEN',
    ]

    // Add featured words that exist in vocabulary
    for (const name of featured) {
      if (!VOCABULARY[name]) continue
      const btn = document.createElement('button')
      btn.textContent = name.replace(/_/g, ' ')
      btn.className = 'ss-btn'
      btn.addEventListener('click', () => playRomWord(name))
      wordGrid.appendChild(btn)
    }

    // Add remaining words in a collapsed section
    const allWords = getWordList()
    const remaining = allWords.filter(w => !featured.includes(w))
    if (remaining.length > 0) {
      const details = document.createElement('details')
      details.style.marginTop = '8px'
      const summary = document.createElement('summary')
      summary.textContent = `All ${allWords.length} words...`
      summary.style.cursor = 'pointer'
      summary.style.fontSize = '12px'
      summary.style.opacity = '0.7'
      details.appendChild(summary)

      const grid = document.createElement('div')
      grid.style.display = 'flex'
      grid.style.flexWrap = 'wrap'
      grid.style.gap = '4px'
      grid.style.marginTop = '6px'
      for (const name of remaining) {
        const btn = document.createElement('button')
        btn.textContent = name.replace(/_/g, ' ')
        btn.className = 'ss-btn'
        btn.style.fontSize = '11px'
        btn.style.padding = '4px 8px'
        btn.addEventListener('click', () => playRomWord(name))
        grid.appendChild(btn)
      }
      details.appendChild(grid)
      wordGrid.appendChild(details)
    }
  }
}

init()
