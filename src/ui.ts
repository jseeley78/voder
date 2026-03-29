import { BAND_CENTERS, PHONEMES } from './phonemes'
import { VoderEngine } from './engine'
import { speakPhonemeSequence, type SequenceHandle, type TokenEvent, type StopKey } from './sequencer'
import { textToPhonemes } from './text-to-phoneme'

let engine: VoderEngine | null = null
let currentSequence: SequenceHandle | null = null
let manualMode: 'buzz' | 'hiss' | 'both' | 'silence' = 'buzz'
let sliderEls: HTMLInputElement[] = []
let scopeAnimId: number | null = null

const $ = (id: string) => document.getElementById(id) as HTMLElement
const $input = (id: string) => document.getElementById(id) as HTMLInputElement

function setStatus(msg: string): void {
  $('status').textContent = msg
}

function loadBandsToUI(bands: number[]): void {
  sliderEls.forEach((el, i) => {
    el.value = String(bands[i] || 0)
    $(`bval${i}`).textContent = Number(el.value).toFixed(2)
  })
}

function getBandsFromUI(): number[] {
  return sliderEls.map(el => parseFloat(el.value))
}

function getEngine(): VoderEngine {
  if (!engine) engine = new VoderEngine()
  return engine
}

function buildBandUI(): void {
  const wrap = $('bands')
  BAND_CENTERS.forEach((hz, idx) => {
    const d = document.createElement('div')
    d.className = 'band'
    d.innerHTML = `
      <div class="small center">${hz >= 1000 ? (hz / 1000).toFixed(1) + 'k' : hz}</div>
      <input class="vslider" data-band="${idx}" type="range"
             min="0" max="1" step="0.01" value="0"
             orient="vertical">
      <div class="small center" id="bval${idx}">0.00</div>
      <div class="small center">B${idx + 1}</div>
    `
    wrap.appendChild(d)
  })
  sliderEls = [...document.querySelectorAll<HTMLInputElement>('.vslider')]
  sliderEls.forEach((el, idx) => {
    el.addEventListener('input', () => {
      $(`bval${idx}`).textContent = Number(el.value).toFixed(2)
    })
  })
}

function buildPresetButtons(): void {
  const presetKeys = [
    'AA', 'AE', 'AH', 'AO', 'EH', 'ER', 'IH', 'IY', 'OW', 'UH', 'UW', 'AW', 'AY', 'EY', 'OY',
    'S', 'SH', 'Z', 'ZH', 'F', 'V', 'TH', 'DH', 'HH',
    'M', 'N', 'NG', 'L', 'R', 'W', 'Y',
    'B', 'D', 'G', 'P', 'T', 'K', 'CH', 'JH',
  ]
  const wrap = $('presetButtons')
  for (const key of presetKeys) {
    const btn = document.createElement('button')
    btn.textContent = key
    btn.addEventListener('click', async () => {
      const eng = await ensureStarted()
      const ph = PHONEMES[key]
      loadBandsToUI(ph.bands)
      if (ph.transient) await eng.transientBurst(ph.transient, parseFloat($input('pitch').value))
      eng.applyPhoneme(ph, parseFloat($input('pitch').value), parseFloat($input('transitionMs').value))
      setStatus(`Applied preset ${key}.`)
    })
    wrap.appendChild(btn)
  }
}

function manualFrame() {
  return {
    voiced: manualMode === 'buzz' || manualMode === 'both',
    noise: manualMode === 'hiss' ? 1.0 : (manualMode === 'both' ? 0.35 : 0.0),
    pitchHz: parseFloat($input('pitch').value),
    bands: getBandsFromUI(),
  }
}

function bindSliderDisplay(sliderId: string, displayId: string, format: (v: string) => string = x => x): void {
  const el = $input(sliderId)
  const display = $(displayId)
  el.addEventListener('input', () => { display.textContent = format(el.value) })
  display.textContent = format(el.value)
}

let stopKeyTimeout: ReturnType<typeof setTimeout> | null = null

function updateWristBar(voiced: boolean, noise: number): void {
  const indicator = $('wbIndicator')
  indicator.classList.remove('buzz', 'hiss', 'both')
  if (voiced && noise > 0.1) {
    indicator.classList.add('both')
  } else if (voiced) {
    indicator.classList.add('buzz')
  } else if (noise > 0.05) {
    indicator.classList.add('hiss')
  }
  // else: no class = idle/grey
}

function updateFootPedal(pitchHz: number): void {
  const fill = $('fpFill')
  const label = $('fpValue')
  const basePitch = parseFloat($input('pitch').value)
  // Show pitch as deviation from the base.
  // Center = 50%, full range = base * 0.7 to base * 1.4
  // (matching the prosody engine's max range of ~0.75x to ~1.35x)
  const ratio = pitchHz / basePitch
  const pct = Math.max(0, Math.min(100, ((ratio - 0.7) / (1.4 - 0.7)) * 100))
  fill.style.width = `${pct}%`
  const cents = Math.round(1200 * Math.log2(ratio))
  const sign = cents >= 0 ? '+' : ''
  label.textContent = `${Math.round(pitchHz)} Hz (${sign}${cents}¢)`
}

function updateStopKeys(key: StopKey): void {
  // Clear previous
  if (stopKeyTimeout) clearTimeout(stopKeyTimeout)
  $('skBilabialLight').classList.remove('active')
  $('skAlveolarLight').classList.remove('active')
  $('skVelarLight').classList.remove('active')

  if (key) {
    const el = key === 'bilabial' ? $('skBilabialLight')
             : key === 'alveolar' ? $('skAlveolarLight')
             : $('skVelarLight')
    el.classList.add('active')
    // Auto-clear after the transient duration
    stopKeyTimeout = setTimeout(() => el.classList.remove('active'), 120)
  }
}

function resetOperatorControls(): void {
  updateWristBar(false, 0)
  updateFootPedal(parseFloat($input('pitch').value))
  updateStopKeys(null)
}

// ── Scope rendering ──

function startScope(): void {
  if (scopeAnimId != null) return
  const canvas = $('scopeCanvas') as HTMLCanvasElement
  const ctx = canvas.getContext('2d')!

  function draw() {
    scopeAnimId = requestAnimationFrame(draw)
    const analyser = engine?.analyser
    if (!analyser || !ctx) return

    // Match canvas resolution to display size
    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    const w = Math.round(rect.width * dpr)
    const h = Math.round(rect.height * dpr)
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }

    ctx.fillStyle = '#0a0d10'
    ctx.fillRect(0, 0, w, h)

    // Draw both overlaid — spectrum first (background), waveform on top
    drawSpectrum(ctx, analyser, w, h)
    drawWaveform(ctx, analyser, w, h)
  }

  draw()
}

function stopScope(): void {
  if (scopeAnimId != null) {
    cancelAnimationFrame(scopeAnimId)
    scopeAnimId = null
  }
}

function drawWaveform(ctx: CanvasRenderingContext2D, analyser: AnalyserNode, w: number, h: number): void {
  const bufLen = analyser.fftSize
  const data = new Float32Array(bufLen)
  analyser.getFloatTimeDomainData(data)

  // Center line
  ctx.strokeStyle = '#1a2030'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, h / 2)
  ctx.lineTo(w, h / 2)
  ctx.stroke()

  // Waveform in blue
  ctx.strokeStyle = '#5dadec'
  ctx.lineWidth = 1.5
  ctx.beginPath()

  const sliceWidth = w / bufLen
  let x = 0
  for (let i = 0; i < bufLen; i++) {
    const v = data[i]
    const y = (1 - v) * h / 2
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
    x += sliceWidth
  }
  ctx.stroke()
}

function drawSpectrum(ctx: CanvasRenderingContext2D, analyser: AnalyserNode, w: number, h: number): void {
  const bufLen = analyser.frequencyBinCount
  const data = new Uint8Array(bufLen)
  analyser.getByteFrequencyData(data)

  // Only draw up to ~8000 Hz (relevant for speech)
  const sampleRate = engine?.ctx?.sampleRate ?? 44100
  const maxBin = Math.min(bufLen, Math.ceil((8000 / sampleRate) * bufLen * 2))

  const barWidth = w / maxBin

  // Spectrum in orange
  ctx.fillStyle = 'rgba(220, 140, 50, 0.35)'
  for (let i = 0; i < maxBin; i++) {
    const barHeight = (data[i] / 255) * h * 0.95
    const x = i * barWidth
    ctx.fillRect(x, h - barHeight, Math.max(barWidth - 0.5, 1), barHeight)
  }

  // Spectrum envelope line in brighter orange
  ctx.strokeStyle = 'rgba(240, 160, 60, 0.7)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let i = 0; i < maxBin; i++) {
    const barHeight = (data[i] / 255) * h * 0.95
    const x = i * barWidth + barWidth / 2
    const y = h - barHeight
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()

  // Band center frequency markers
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  ctx.lineWidth = 1
  const BAND_HZ = [112, 338, 575, 850, 1200, 1700, 2350, 3250, 4600, 6450]
  for (const freq of BAND_HZ) {
    const bin = Math.round((freq / sampleRate) * bufLen * 2)
    const x = bin * barWidth
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, h)
    ctx.stroke()
  }
}

function speakOpts() {
  return {
    defaultDurationMs: parseFloat($input('durInput').value),
    transitionMs: parseFloat($input('transitionMs').value),
    basePitch: parseFloat($input('pitch').value),
    rateScale: parseFloat($input('rateScale').value),
    expressiveness: parseFloat($input('expressiveness').value),
    onToken: (evt: TokenEvent) => {
      loadBandsToUI(evt.bands)
      updateWristBar(evt.voiced, evt.noise)
      updateFootPedal(evt.pitchHz)
      updateStopKeys(evt.stopKey)
      const stressLabel = evt.stress >= 0 ? ` s${evt.stress}` : ''
      setStatus(`${evt.phoneme}${stressLabel}  ${evt.pitchHz.toFixed(0)}Hz  ${evt.durationMs.toFixed(0)}ms`)
    },
    onDone: () => {
      setStatus('Done.')
      loadBandsToUI(Array(10).fill(0))
      resetOperatorControls()
    },
  }
}

/** Ensure engine is started (auto-starts on first use) */
async function ensureStarted(): Promise<VoderEngine> {
  const eng = getEngine()
  if (!eng.started) {
    await eng.start()
    startScope()
    setStatus('Audio started.')
  }
  return eng
}

async function speakPhonemes(text: string): Promise<void> {
  const eng = await ensureStarted()
  if (currentSequence) currentSequence.cancel()
  setStatus('Speaking...')
  currentSequence = speakPhonemeSequence(eng, text, speakOpts())
}

async function speakText(text: string): Promise<void> {
  const eng = await ensureStarted()
  if (currentSequence) currentSequence.cancel()

  const result = textToPhonemes(text)

  // Show the phoneme conversion in the phoneme input box
  $input('phonemeInput').value = result.phonemes

  if (result.unknownWords.length > 0) {
    setStatus(`Unknown words (spelled out): ${result.unknownWords.join(', ')}`)
    // Brief pause to show the warning before speaking
    await new Promise(r => setTimeout(r, 800))
  }

  setStatus('Speaking...')
  currentSequence = speakPhonemeSequence(eng, result.phonemes, speakOpts())
}

export function initUI(): void {
  buildBandUI()
  buildPresetButtons()

  bindSliderDisplay('pitch', 'pitchVal')
  bindSliderDisplay('master', 'masterVal', v => Number(v).toFixed(2))
  bindSliderDisplay('transitionMs', 'transitionVal')
  bindSliderDisplay('jitter', 'jitterVal', v => Number(v).toFixed(1))
  bindSliderDisplay('vibratoRate', 'vibratoRateVal', v => Number(v).toFixed(1))
  bindSliderDisplay('vibratoDepth', 'vibratoDepthVal', v => Number(v).toFixed(1))
  bindSliderDisplay('durInput', 'durVal')
  bindSliderDisplay('rateScale', 'rateVal', v => Number(v).toFixed(2))
  bindSliderDisplay('expressiveness', 'expressVal', v => Number(v).toFixed(2))

  // Start / stop
  $('startBtn').addEventListener('click', async () => {
    const eng = getEngine()
    await eng.start()
    startScope()
    setStatus('Audio started.')
  })
  $('stopBtn').addEventListener('click', () => {
    if (engine) engine.stop()
    stopScope()
    setStatus('Audio stopped.')
  })

  // Master level
  $input('master').addEventListener('input', () => {
    engine?.setMaster(parseFloat($input('master').value))
  })

  // Jitter + vibrato sync
  $input('jitter').addEventListener('input', () => {
    if (engine) engine.jitterValue = parseFloat($input('jitter').value)
  })
  $input('vibratoRate').addEventListener('input', () => {
    engine?.setVibratoRate(parseFloat($input('vibratoRate').value))
  })
  $input('vibratoDepth').addEventListener('input', () => {
    engine?.setVibratoDepth(parseFloat($input('vibratoDepth').value))
  })

  // Manual mode buttons
  $('manualBuzz').addEventListener('click', () => { manualMode = 'buzz'; setStatus('Manual mode: buzz.') })
  $('manualHiss').addEventListener('click', () => { manualMode = 'hiss'; setStatus('Manual mode: hiss.') })
  $('manualBoth').addEventListener('click', () => { manualMode = 'both'; setStatus('Manual mode: both.') })
  $('manualSilence').addEventListener('click', () => {
    manualMode = 'silence'
    if (engine?.started) {
      engine.applyFrame({
        voiced: false, noise: 0, pitchHz: parseFloat($input('pitch').value),
        bands: Array(10).fill(0),
      }, 20)
    }
    setStatus('Manual mode: silence.')
  })
  $('applyManual').addEventListener('click', async () => {
    const eng = await ensureStarted()
    eng.applyFrame(manualFrame(), parseFloat($input('transitionMs').value))
    setStatus('Applied manual sliders.')
  })

  // ── Text input (type English) ──
  $('speakTextBtn').addEventListener('click', () => {
    speakText($input('textInput').value)
  })
  // Allow Enter key in text input to speak
  $input('textInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      speakText($input('textInput').value)
    }
  })

  // Convert button (show phonemes without speaking)
  $('convertBtn').addEventListener('click', () => {
    const result = textToPhonemes($input('textInput').value)
    $input('phonemeInput').value = result.phonemes
    if (result.unknownWords.length > 0) {
      setStatus(`Unknown: ${result.unknownWords.join(', ')}`)
    } else {
      setStatus('Converted to phonemes.')
    }
  })

  // ── Phoneme input (direct) ──
  $('speakBtn').addEventListener('click', () => {
    speakPhonemes($input('phonemeInput').value)
  })

  // ── Example text buttons ──
  $('exHello').addEventListener('click', () => {
    $input('textInput').value = 'Hello, how are you?'
    speakText('Hello, how are you?')
  })
  $('exRobot').addEventListener('click', () => {
    $input('textInput').value = 'I am a robot.'
    speakText('I am a robot.')
  })
  $('exVoder').addEventListener('click', () => {
    $input('textInput').value = 'The Voder can speak.'
    speakText('The Voder can speak.')
  })
  $('exLong').addEventListener('click', () => {
    $input('textInput').value = 'She saw him running through the park.'
    speakText('She saw him running through the park.')
  })
  $('exRainbow').addEventListener('click', () => {
    const text = 'When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. The rainbow is a division of white light into many beautiful colors.'
    $input('textInput').value = text
    speakText(text)
  })
}
