/**
 * Automated browser recording: launches headless Chrome with our Voder,
 * speaks phrases, captures the Web Audio output as WAV files.
 *
 * This captures the EXACT same audio the user hears — same filters,
 * same transitions, same everything. No offline renderer approximation.
 *
 * Usage: npx tsx scripts/browser-record.ts "hello how are you" "she saw me"
 *   or:  npx tsx scripts/browser-record.ts   (uses default test phrases)
 */

import puppeteer from 'puppeteer'
import * as fs from 'fs'
import { execSync } from 'child_process'

const OUTPUT_DIR = '/tmp/voder-browser-recordings'
fs.mkdirSync(OUTPUT_DIR, { recursive: true })

const DEFAULT_PHRASES = [
  'hello how are you',
  'she saw me',
  'one two three four five',
  'good afternoon',
  'the quick brown fox',
  'zero',
  'seven',
  'yes',
  'no',
  'hello',
]

async function recordPhrase(page: puppeteer.Page, text: string, outputPath: string): Promise<void> {
  // Type text and speak it, with recording
  await page.evaluate(async (txt: string) => {
    // Access the engine through the global scope
    const textInput = document.getElementById('textInput') as HTMLTextAreaElement
    const speakBtn = document.getElementById('speakTextBtn') as HTMLButtonElement
    const recordBtn = document.getElementById('recordBtn') as HTMLButtonElement

    // Set text
    textInput.value = txt

    // Start recording
    recordBtn.click()
    await new Promise(r => setTimeout(r, 200))

    // Speak
    speakBtn.click()

    // Wait for speech to finish (poll the status)
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        const status = document.getElementById('status')?.textContent || ''
        if (status.includes('Done')) {
          clearInterval(check)
          setTimeout(resolve, 300) // extra buffer after done
        }
      }, 100)
      // Timeout after 15 seconds
      setTimeout(() => { clearInterval(check); resolve() }, 15000)
    })

    // Stop recording
    recordBtn.click()

    // Wait for the download to be triggered
    await new Promise(r => setTimeout(r, 500))
  }, text)
}

async function main() {
  const phrases = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_PHRASES

  console.log(`Recording ${phrases.length} phrases...`)
  console.log(`Output: ${OUTPUT_DIR}/`)
  console.log()

  // Start the dev server check
  try {
    execSync('curl -s http://localhost:5173/ > /dev/null 2>&1')
  } catch {
    console.error('Dev server not running! Start it with: npm run dev')
    process.exit(1)
  }

  const browser = await puppeteer.launch({
    headless: false,  // Need non-headless for Web Audio
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
    ],
  })

  const page = await browser.newPage()

  // Set up download handling
  const client = await page.createCDPSession()
  await client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: OUTPUT_DIR,
  })

  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle0' })
  console.log('Page loaded')

  // Click somewhere to enable audio context (user gesture requirement)
  await page.click('#startBtn')
  await new Promise(r => setTimeout(r, 1000))
  console.log('Audio started')

  for (const phrase of phrases) {
    const safeName = phrase.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
    console.log(`  Recording: "${phrase}"...`)

    await recordPhrase(page, phrase)

    // Wait for download and rename
    await new Promise(r => setTimeout(r, 1000))

    // Find the most recent voder-recording*.wav in the output dir
    const files = fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.startsWith('voder-recording') && f.endsWith('.wav'))
      .map(f => ({ name: f, time: fs.statSync(`${OUTPUT_DIR}/${f}`).mtimeMs }))
      .sort((a, b) => b.time - a.time)

    if (files.length > 0) {
      const src = `${OUTPUT_DIR}/${files[0].name}`
      const dst = `${OUTPUT_DIR}/${safeName}.wav`
      fs.renameSync(src, dst)
      const size = fs.statSync(dst).size
      console.log(`    → ${safeName}.wav (${(size / 1024).toFixed(0)}KB)`)
    } else {
      console.log(`    ⚠ No WAV file found`)
    }

    await new Promise(r => setTimeout(r, 500))
  }

  await browser.close()

  // Now run Whisper on all recordings
  console.log('\n=== Running Whisper ===')
  const wavFiles = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.wav') && !f.startsWith('voder-recording'))

  if (wavFiles.length > 0) {
    const wordList = wavFiles.map(f => f.replace('.wav', '')).join(',')
    const pyScript = `
import ssl; ssl._create_default_https_context = ssl._create_unverified_context
import whisper, numpy as np, struct, os

model = whisper.load_model('tiny')
wav_dir = '${OUTPUT_DIR}'

for fname in sorted(os.listdir(wav_dir)):
    if not fname.endswith('.wav') or fname.startswith('voder-recording'): continue
    word = fname.replace('.wav', '')
    path = os.path.join(wav_dir, fname)
    with open(path, 'rb') as f:
        f.read(44); data = f.read()
    if len(data) < 100: continue
    bps = 2
    samples = np.array(struct.unpack(f'<{len(data)//bps}h', data), dtype=np.float32) / 32768.0
    # Detect sample rate from file size and duration estimate
    # Assume 48000 (browser default)
    ratio = 16000/48000
    new_len = int(len(samples)*ratio)
    if new_len < 100: continue
    idx = np.arange(new_len)/ratio
    fl = np.floor(idx).astype(int)
    ce = np.minimum(fl+1, len(samples)-1)
    fr = (idx-fl).astype(np.float32)
    resampled = samples[fl]*(1-fr) + samples[ce]*fr
    audio = whisper.pad_or_trim(resampled)
    mel = whisper.log_mel_spectrogram(audio, n_mels=model.dims.n_mels).to(model.device)
    result = whisper.decode(model, mel, whisper.DecodingOptions(language='en', fp16=False))
    text = result.text.strip()
    expected = word.replace('_', ' ')
    ok = '✓' if expected.lower() in text.lower() else '✗'
    print(f'{ok} "{expected}" → "{text}" ({result.avg_logprob:.3f})')
`
    execSync(`python3 -c '${pyScript.replace(/'/g, "'\\''")}'`, { stdio: 'inherit', timeout: 300000 })
  }

  console.log('\nDone.')
}

main().catch(console.error)
