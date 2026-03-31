/**
 * Whisper tuner v3: uses the ACTUAL VoderEngine via node-web-audio-api.
 * Same code as the browser — no reimplementation.
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
const OUTPUT_DIR = '/tmp/voder-tune-v3'
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

async function renderPhrase(text: string): Promise<Float32Array> {
  const offlineCtx = new WAA.OfflineAudioContext(1, SR * 10, SR)
  const engine = new VoderEngine()
  await engine.start(offlineCtx as any)

  const result = textToPhonemes(text)
  const handle = speakPhonemeSequence(engine, result.phonemes, {
    defaultDurationMs: 110, transitionMs: 35, basePitch: 110,
    rateScale: 1.0, expressiveness: 0.7, humanize: 0,
  })
  await handle.done

  const rendered = await offlineCtx.startRendering()
  const data = rendered.getChannelData(0)

  // Trim silence
  let end = data.length - 1
  while (end > 0 && Math.abs(data[end]) < 0.001) end--
  end = Math.min(end + Math.round(SR * 0.1), data.length)
  const trimmed = new Float32Array(data.buffer, 0, end)

  // Normalize
  let peak = 0
  for (let i = 0; i < trimmed.length; i++) peak = Math.max(peak, Math.abs(trimmed[i]))
  if (peak > 0.01) { const sc = 0.85 / peak; for (let i = 0; i < trimmed.length; i++) trimmed[i] *= sc }
  return trimmed
}

function whisperScore(words: string[]): Map<string, { text: string; logprob: number }> {
  const wordList = words.join(',')
  const resultFile = `${OUTPUT_DIR}/_results.json`
  const scriptPath = new URL('./whisper-score.py', import.meta.url).pathname
  try {
    execSync(`python3 ${scriptPath} ${OUTPUT_DIR} ${wordList} ${resultFile}`, {
      timeout: 180000, env: { ...process.env, PYTHONHTTPSVERIFY: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch { return new Map() }
  const parsed = JSON.parse(fs.readFileSync(resultFile, 'utf-8'))
  const result = new Map<string, { text: string; logprob: number }>()
  for (const [word, data] of Object.entries(parsed) as [string, any][]) {
    result.set(word, { text: data.text, logprob: data.logprob })
  }
  return result
}

async function scoreAll(phrases: string[]): Promise<{ correct: number; logprob: number; details: Map<string, { text: string; logprob: number }> }> {
  for (const phrase of phrases) {
    const safe = phrase.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
    try {
      const audio = await renderPhrase(phrase)
      writeWav(`${OUTPUT_DIR}/${safe}.wav`, audio)
    } catch (e: any) {
      console.error(`  render error for "${phrase}": ${e.message}`)
    }
  }
  const details = whisperScore(phrases.map(p => p.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()))
  let correct = 0, logprob = 0
  for (const [word, d] of details) {
    const expected = word.replace(/_/g, ' ')
    if (expected.toLowerCase() === d.text.toLowerCase().replace(/[.,!?]/g, '').trim()) correct++
    logprob += d.logprob
  }
  return { correct, logprob, details }
}

// ─── Main ───
const PHRASES = ['yes', 'no', 'one', 'two', 'three', 'she saw me']

async function main() {
  console.log('=== WHISPER TUNER V3 (actual engine, offline) ===')
  console.log()

  // Baseline
  console.log('── Baseline ──')
  const baseline = await scoreAll(PHRASES)
  console.log(`Score: ${baseline.correct}/${PHRASES.length}, logprob: ${baseline.logprob.toFixed(2)}`)
  for (const [w, d] of baseline.details) {
    const expected = w.replace(/_/g, ' ')
    const ok = expected.toLowerCase() === d.text.toLowerCase().replace(/[.,!?]/g, '').trim() ? '✓' : '✗'
    console.log(`  ${ok} "${expected}" → "${d.text}" (${d.logprob.toFixed(3)})`)
  }

  // Find which phonemes appear in test phrases
  const wordPhonemes = new Map<string, Set<string>>()
  for (const p of PHRASES) {
    const r = textToPhonemes(p)
    const tokens = r.phonemes.split(/\s+/).filter(t => t !== '|' && !/^[,.\?!;:]$/.test(t))
    wordPhonemes.set(p, new Set(tokens.map(t => t.replace(/[012]$/, ''))))
  }

  const allPh = new Set<string>()
  for (const s of wordPhonemes.values()) for (const p of s) allPh.add(p)
  const tunablePh = [...allPh].filter(p => PHONEMES[p])
  console.log(`\nTuning ${tunablePh.length} phonemes: ${tunablePh.join(', ')}`)

  let bestLogprob = baseline.logprob
  let bestCorrect = baseline.correct
  let totalImprovements = 0

  // Optimization
  for (const stepSize of [0.15, 0.10, 0.06]) {
    console.log(`\n── Step: ${stepSize} ──`)
    let improved = 0

    for (const ph of tunablePh) {
      const bands = PHONEMES[ph].bands

      for (let b = 0; b < 10; b++) {
        const orig = bands[b]

        for (const delta of [stepSize, -stepSize]) {
          bands[b] = Math.max(0, Math.min(1.0, orig + delta))
          const score = await scoreAll(PHRASES)

          if (score.correct > bestCorrect || (score.correct === bestCorrect && score.logprob > bestLogprob + 0.05)) {
            bestCorrect = score.correct
            bestLogprob = score.logprob
            improved++
            totalImprovements++
            console.log(`  ${ph} B${b + 1} ${delta > 0 ? '+' : ''}${delta.toFixed(2)}: ${score.correct}/${PHRASES.length} logprob=${score.logprob.toFixed(2)}`)
            break
          }
          bands[b] = orig
        }
      }

      // Duration
      const origDur = PHONEMES[ph].durationMs
      for (const delta of [30, -30]) {
        PHONEMES[ph].durationMs = Math.max(20, origDur + delta)
        const score = await scoreAll(PHRASES)
        if (score.correct > bestCorrect || (score.correct === bestCorrect && score.logprob > bestLogprob + 0.05)) {
          bestCorrect = score.correct
          bestLogprob = score.logprob
          improved++
          totalImprovements++
          console.log(`  ${ph} dur ${delta > 0 ? '+' : ''}${delta}ms: ${score.correct}/${PHRASES.length} logprob=${score.logprob.toFixed(2)}`)
          break
        }
        PHONEMES[ph].durationMs = origDur
      }
    }

    if (improved === 0) { console.log('  No improvements'); break }
  }

  // Final
  console.log('\n── Final ──')
  const final = await scoreAll(PHRASES)
  console.log(`Score: ${baseline.correct}→${final.correct}/${PHRASES.length}, logprob: ${baseline.logprob.toFixed(2)}→${final.logprob.toFixed(2)}`)
  for (const [w, d] of final.details) {
    const expected = w.replace(/_/g, ' ')
    const ok = expected.toLowerCase() === d.text.toLowerCase().replace(/[.,!?]/g, '').trim() ? '✓' : '✗'
    console.log(`  ${ok} "${expected}" → "${d.text}" (${d.logprob.toFixed(3)})`)
  }
  console.log(`Total improvements: ${totalImprovements}`)

  // Output changed phonemes
  console.log('\n=== CHANGED ===')
  for (const ph of tunablePh.sort()) {
    console.log(`  ${ph}: bands=[${PHONEMES[ph].bands.map(g => g.toFixed(2)).join(',')}] dur=${PHONEMES[ph].durationMs}`)
  }
}

main().catch(console.error)
