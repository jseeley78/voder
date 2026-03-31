/**
 * Offline rendering using the EXACT same VoderEngine + sequencer.
 *
 * Creates an OfflineAudioContext, passes it to VoderEngine.start(),
 * then runs speakPhonemeSequence — the identical code path as live
 * playback. Zero reimplementation, zero approximation.
 *
 * Runs in Puppeteer because OfflineAudioContext is a browser API.
 *
 * Usage: npx tsx scripts/browser-render.ts "hello" "she saw me"
 */

import puppeteer from 'puppeteer'
import * as fs from 'fs'

const OUTPUT_DIR = '/tmp/voder-browser-render'
fs.mkdirSync(OUTPUT_DIR, { recursive: true })

const DEFAULT_PHRASES = [
  'yes', 'no', 'hello', 'one', 'two', 'three',
  'she saw me', 'hello how are you',
]

async function main() {
  const phrases = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_PHRASES

  console.log(`Rendering ${phrases.length} phrases via actual VoderEngine + OfflineAudioContext`)
  console.log(`Output: ${OUTPUT_DIR}/`)

  const browser = await puppeteer.launch({
    headless: false,
    args: ['--autoplay-policy=no-user-gesture-required'],
  })

  const page = await browser.newPage()
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' })
  console.log('Page loaded')

  for (const phrase of phrases) {
    const safeName = phrase.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
    process.stdout.write(`  "${phrase}"... `)

    const samples = await page.evaluate(async (txt: string) => {
      // Import the ACTUAL modules
      const { VoderEngine } = await import('/src/engine.ts')
      const { speakPhonemeSequence } = await import('/src/sequencer.ts')
      const { textToPhonemes } = await import('/src/text-to-phoneme.ts')

      const SAMPLE_RATE = 48000
      const MAX_DURATION = 10

      // Create OfflineAudioContext
      const offlineCtx = new OfflineAudioContext(1, SAMPLE_RATE * MAX_DURATION, SAMPLE_RATE)

      // Create a real VoderEngine and pass it the offline context
      const engine = new VoderEngine()
      await engine.start(offlineCtx as any)

      // Use the real text-to-phoneme + sequencer
      const result = textToPhonemes(txt)
      const handle = speakPhonemeSequence(engine, result.phonemes, {
        defaultDurationMs: 110,
        transitionMs: 35,
        basePitch: 110,
        rateScale: 1.0,
        expressiveness: 0.7,
        humanize: 0,
      })

      // Wait for sequencer to finish scheduling
      await handle.done

      // Small delay then render
      await new Promise(r => setTimeout(r, 100))
      const rendered = await offlineCtx.startRendering()
      const data = rendered.getChannelData(0)

      // Trim silence from end
      let end = data.length - 1
      while (end > 0 && Math.abs(data[end]) < 0.001) end--
      end = Math.min(end + Math.round(SAMPLE_RATE * 0.1), data.length)

      const trimmed = data.slice(0, end)

      // Normalize
      let peak = 0
      for (let i = 0; i < trimmed.length; i++) peak = Math.max(peak, Math.abs(trimmed[i]))
      if (peak > 0.01) {
        const sc = 0.85 / peak
        for (let i = 0; i < trimmed.length; i++) trimmed[i] *= sc
      }

      return Array.from(trimmed)
    }, phrase)

    if (samples && samples.length > 0) {
      const path = `${OUTPUT_DIR}/${safeName}.wav`
      const f32 = new Float32Array(samples)
      const n = f32.length, ds = n * 2, buf = Buffer.alloc(44 + ds)
      buf.write('RIFF', 0); buf.writeUInt32LE(36 + ds, 4); buf.write('WAVE', 8)
      buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
      buf.writeUInt16LE(1, 22); buf.writeUInt32LE(48000, 24); buf.writeUInt32LE(96000, 28)
      buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36)
      buf.writeUInt32LE(ds, 40)
      for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, f32[i])) * 32767), 44 + i * 2)
      fs.writeFileSync(path, buf)
      console.log(`${safeName}.wav (${(n / 48000).toFixed(1)}s)`)
    } else {
      console.log('FAILED')
    }
  }

  await browser.close()
  console.log('\nDone.')
}

main().catch(console.error)
