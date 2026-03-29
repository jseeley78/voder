import { BAND_CENTERS, PHONEMES } from './phonemes'
import { VoderEngine } from './engine'
import { speakPhonemeSequence, type SequenceHandle } from './sequencer'

let engine: VoderEngine | null = null
let currentSequence: SequenceHandle | null = null
let manualMode: 'buzz' | 'hiss' | 'both' | 'silence' = 'buzz'
let sliderEls: HTMLInputElement[] = []

// UI element references
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
    'AA', 'AE', 'AH', 'EH', 'ER', 'IH', 'IY', 'OW', 'UW',
    'S', 'SH', 'Z', 'M', 'N', 'L', 'R', 'W', 'Y',
    'B', 'D', 'G', 'P', 'T', 'K', 'CH', 'JH',
  ]
  const wrap = $('presetButtons')
  for (const key of presetKeys) {
    const btn = document.createElement('button')
    btn.textContent = key
    btn.addEventListener('click', async () => {
      const eng = getEngine()
      if (!eng.started) return setStatus('Start audio first.')
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

async function speak(text: string): Promise<void> {
  const eng = getEngine()
  if (!eng.started) return setStatus('Start audio first.')
  if (currentSequence) currentSequence.cancel()

  setStatus(`Speaking: ${text}`)
  currentSequence = speakPhonemeSequence(eng, text, {
    defaultDurationMs: parseFloat($input('durInput').value),
    transitionMs: parseFloat($input('transitionMs').value),
    basePitch: parseFloat($input('pitch').value),
    rateScale: parseFloat($input('rateScale').value),
    onToken: (_i, tok) => setStatus(`Speaking: ${tok}`),
    onDone: () => setStatus('Done.'),
  })
}

export function initUI(): void {
  buildBandUI()
  buildPresetButtons()

  // Slider displays
  bindSliderDisplay('pitch', 'pitchVal')
  bindSliderDisplay('master', 'masterVal', v => Number(v).toFixed(2))
  bindSliderDisplay('transitionMs', 'transitionVal')
  bindSliderDisplay('jitter', 'jitterVal', v => Number(v).toFixed(1))
  bindSliderDisplay('durInput', 'durVal')
  bindSliderDisplay('rateScale', 'rateVal', v => Number(v).toFixed(2))

  // Start / stop
  $('startBtn').addEventListener('click', async () => {
    const eng = getEngine()
    await eng.start()
    setStatus('Audio started.')
  })
  $('stopBtn').addEventListener('click', () => {
    if (engine) engine.stop()
    setStatus('Audio stopped.')
  })

  // Master level
  $input('master').addEventListener('input', () => {
    engine?.setMaster(parseFloat($input('master').value))
  })

  // Jitter sync
  $input('jitter').addEventListener('input', () => {
    if (engine) engine.jitterValue = parseFloat($input('jitter').value)
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
  $('applyManual').addEventListener('click', () => {
    if (!engine?.started) return setStatus('Start audio first.')
    engine.applyFrame(manualFrame(), parseFloat($input('transitionMs').value))
    setStatus('Applied manual sliders.')
  })

  // Speak controls
  $('speakBtn').addEventListener('click', () => {
    speak($input('phonemeInput').value)
  })
  $('speakWordHello').addEventListener('click', () => {
    $input('phonemeInput').value = 'HH EH L OW'
    speak('HH EH L OW')
  })
  $('speakWordRobot').addEventListener('click', () => {
    $input('phonemeInput').value = 'R OW B AA T'
    speak('R OW B AA T')
  })
  $('speakWordVoder').addEventListener('click', () => {
    $input('phonemeInput').value = 'V OW D ER'
    speak('V OW D ER')
  })
}
