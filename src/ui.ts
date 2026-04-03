import { BAND_CENTERS, PHONEMES } from './phonemes'
import { VoderEngine } from './engine'
import { speakPhonemeSequence, type SequenceHandle, type TokenEvent, type StopKey } from './sequencer'
import { textToPhonemes, type WordSpan } from './text-to-phoneme'
import { PROPOSALS, createABTest, playWithGains, getABResults, type ABTestState } from './ab-test'
import { ANIMAL_SOUNDS, playAnimalSound } from './animals'

let engine: VoderEngine | null = null
let currentSequence: SequenceHandle | null = null
let manualMode: 'buzz' | 'hiss' | 'both' | 'silence' = 'buzz'
let sliderEls: HTMLInputElement[] = []
let scopeAnimId: number | null = null
/** The basePitch that the current sequence was scheduled with — detune is relative to this */
let sequenceBasePitch = 110

// ── Recording state (module-level so speakPhonemes/speakText can access) ──
let mediaRecorder: MediaRecorder | null = null
let recordChunks: Blob[] = []
let recordToggle: HTMLInputElement | null = null

function startRecording(eng: VoderEngine): void {
  if (!recordToggle?.checked || !eng.recordDest) return
  recordChunks = []
  mediaRecorder = new MediaRecorder(eng.recordDest.stream, { mimeType: 'audio/webm' })
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordChunks.push(e.data)
  }
  mediaRecorder.onstop = async () => {
    const webmBlob = new Blob(recordChunks, { type: 'audio/webm' })
    const arrayBuf = await webmBlob.arrayBuffer()
    const audioCtx = new AudioContext()
    const decoded = await audioCtx.decodeAudioData(arrayBuf)
    const samples = decoded.getChannelData(0)
    const sr = decoded.sampleRate
    const numSamples = samples.length
    const dataSize = numSamples * 2
    const buffer = new ArrayBuffer(44 + dataSize)
    const view = new DataView(buffer)
    const writeStr = (off: number, str: string) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)) }
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE')
    writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
    view.setUint16(22, 1, true); view.setUint32(24, sr, true); view.setUint32(28, sr * 2, true)
    view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    writeStr(36, 'data'); view.setUint32(40, dataSize, true)
    for (let i = 0; i < numSamples; i++) {
      view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true)
    }
    const wavBlob = new Blob([buffer], { type: 'audio/wav' })
    const url = URL.createObjectURL(wavBlob)
    const a = document.createElement('a')
    a.href = url; a.download = 'voder-recording.wav'; a.click()
    URL.revokeObjectURL(url); audioCtx.close()
    setStatus(`Recorded ${(numSamples / sr).toFixed(1)}s → voder-recording.wav`)
  }
  mediaRecorder.start()
}

function stopRecording(): void {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop()
  }
}

const $ = (id: string) => document.getElementById(id) as HTMLElement
const $input = (id: string) => document.getElementById(id) as HTMLInputElement

function setStatus(msg: string): void {
  $('status').textContent = msg
}

// Smooth slider animation — lerps toward target values each frame
const bandTargets = new Float64Array(10)
const bandCurrent = new Float64Array(10)
let bandAnimRunning = false

function loadBandsToUI(bands: number[]): void {
  for (let i = 0; i < 10; i++) {
    bandTargets[i] = bands[i] || 0
  }
  if (!bandAnimRunning) startBandAnim()
}

function startBandAnim(): void {
  bandAnimRunning = true
  function tick() {
    if (!bandAnimRunning) return
    let settled = true
    for (let i = 0; i < 10; i++) {
      // Exponential approach matching the engine's setTargetAtTime
      const diff = bandTargets[i] - bandCurrent[i]
      if (Math.abs(diff) > 0.005) {
        bandCurrent[i] += diff * 0.18  // ~5-6 frames to settle
        settled = false
      } else {
        bandCurrent[i] = bandTargets[i]
      }
      sliderEls[i].value = String(bandCurrent[i])
      $(`bval${i}`).textContent = bandCurrent[i].toFixed(2)
    }
    if (!settled) {
      requestAnimationFrame(tick)
    } else {
      bandAnimRunning = false
    }
  }
  requestAnimationFrame(tick)
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
      if (ph.transient) eng.transientBurst(ph.transient, parseFloat($input('pitch').value))
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

// Smooth foot pedal animation
let fpTarget = 50  // target percentage
let fpCurrent = 50
let fpAnimRunning = false

function updateFootPedal(pitchHz: number): void {
  const basePitch = parseFloat($input('pitch').value)
  const ratio = pitchHz / basePitch
  fpTarget = Math.max(0, Math.min(100, ((ratio - 0.7) / (1.4 - 0.7)) * 100))
  const cents = Math.round(1200 * Math.log2(ratio))
  const sign = cents >= 0 ? '+' : ''
  $('fpValue').textContent = `${Math.round(pitchHz)} Hz (${sign}${cents}¢)`
  if (!fpAnimRunning) startFpAnim()
}

function startFpAnim(): void {
  fpAnimRunning = true
  function tick() {
    const diff = fpTarget - fpCurrent
    if (Math.abs(diff) > 0.3) {
      fpCurrent += diff * 0.15
      $('fpFill').style.width = `${fpCurrent}%`
      requestAnimationFrame(tick)
    } else {
      fpCurrent = fpTarget
      $('fpFill').style.width = `${fpCurrent}%`
      fpAnimRunning = false
    }
  }
  requestAnimationFrame(tick)
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
  // Amplify 3x for visible waveform (signal is now properly loud)
  const gain = 3.0
  let x = 0
  for (let i = 0; i < bufLen; i++) {
    const v = data[i] * gain
    const y = Math.max(0, Math.min(h, (1 - v) * h / 2))
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
    humanize: parseFloat($input('humanize').value),
    onToken: (evt: TokenEvent) => {
      // Schedule UI update at the token's absolute start time.
      // With absolute-time scheduling, all callbacks fire immediately
      // during the scheduling loop. Use setTimeout to sync with audio.
      const audioCtx = engine?.ctx
      const now = audioCtx ? audioCtx.currentTime : 0
      const delayMs = Math.max(0, (evt.startTime - now) * 1000)

      setTimeout(() => {
        loadBandsToUI(evt.bands)
        updateWristBar(evt.voiced, evt.noise)
        updateFootPedal(evt.pitchHz)
        updateStopKeys(evt.stopKey)
        const stressLabel = evt.stress >= 0 ? ` s${evt.stress}` : ''
        setStatus(`${evt.phoneme}${stressLabel}  ${evt.pitchHz.toFixed(0)}Hz  ${evt.durationMs.toFixed(0)}ms`)
      }, delayMs)
    },
    onDone: () => {
      setStatus('Done.')
      loadBandsToUI(Array(10).fill(0))
      stopRecording()
      resetOperatorControls()
    },
  }
}

/** Ensure engine is started (auto-starts on first use) */
async function ensureStarted(): Promise<VoderEngine> {
  const eng = getEngine()
  if (!eng.started) {
    // Sync waveform from UI before starting
    eng.waveformType = ($('waveform') as HTMLSelectElement).value as any
    await eng.start()
    startScope()
    setStatus('Audio started.')
  }
  return eng
}

async function speakPhonemes(text: string): Promise<void> {
  const eng = await ensureStarted()
  if (currentSequence) currentSequence.cancel()
  eng.restoreDetune(0)
  sequenceBasePitch = parseFloat($input('pitch').value)
  startRecording(eng)
  setStatus('Speaking...')
  currentSequence = speakPhonemeSequence(eng, text, speakOpts())
}

/** Find which word a phoneme token index belongs to */
function tokenToWord(spans: WordSpan[], tokenIdx: number): string {
  for (const span of spans) {
    if (tokenIdx >= span.startToken && tokenIdx < span.endToken) return span.word
  }
  return ''
}

async function speakText(text: string): Promise<void> {
  const eng = await ensureStarted()
  if (currentSequence) currentSequence.cancel()
  eng.restoreDetune(0)
  sequenceBasePitch = parseFloat($input('pitch').value)
  startRecording(eng)

  const result = textToPhonemes(text)

  // Show the phoneme conversion in the phoneme input box
  $input('phonemeInput').value = result.phonemes

  if (result.unknownWords.length > 0) {
    setStatus(`Unknown words (spelled out): ${result.unknownWords.join(', ')}`)
    await new Promise(r => setTimeout(r, 800))
  }

  setStatus('Speaking...')
  const opts = speakOpts()
  const baseOnToken = opts.onToken
  opts.onToken = (evt: TokenEvent) => {
    baseOnToken?.(evt)
    // Show current word — delayed to sync with audio playback
    const audioCtx = engine?.ctx
    const now = audioCtx ? audioCtx.currentTime : 0
    const delayMs = Math.max(0, (evt.startTime - now) * 1000)
    setTimeout(() => {
      const word = tokenToWord(result.wordSpans, evt.index)
      $('currentWord').textContent = word
    }, delayMs)
  }
  const baseOnDone = opts.onDone
  opts.onDone = () => {
    baseOnDone?.()
    $('currentWord').textContent = ''
  }
  currentSequence = speakPhonemeSequence(eng, result.phonemes, opts)
}

export function initUI(): void {
  buildBandUI()
  buildPresetButtons()

  bindSliderDisplay('pitch', 'pitchVal')
  // Live pitch: compute detune relative to the basePitch the current sequence was
  // scheduled with, so the shift is applied once (not double-stacked).
  $input('pitch').addEventListener('input', () => {
    if (!engine) return
    const newPitch = parseFloat($input('pitch').value)
    const cents = 1200 * Math.log2(newPitch / sequenceBasePitch)
    engine.restoreDetune(cents)
  })
  bindSliderDisplay('filterQ', 'filterQVal', v => Number(v).toFixed(1))
  $input('filterQ').addEventListener('input', () => {
    engine?.setFilterQ(parseFloat($input('filterQ').value))
  })
  bindSliderDisplay('master', 'masterVal', v => Number(v).toFixed(2))
  bindSliderDisplay('transitionMs', 'transitionVal')
  bindSliderDisplay('jitter', 'jitterVal', v => Number(v).toFixed(1))
  bindSliderDisplay('vibratoRate', 'vibratoRateVal', v => Number(v).toFixed(1))
  bindSliderDisplay('vibratoDepth', 'vibratoDepthVal', v => Number(v).toFixed(1))
  bindSliderDisplay('durInput', 'durVal')
  bindSliderDisplay('rateScale', 'rateVal', v => Number(v).toFixed(2))
  bindSliderDisplay('expressiveness', 'expressVal', v => Number(v).toFixed(2))
  bindSliderDisplay('humanize', 'humanizeVal', v => Number(v).toFixed(2))

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
  // Vibrato toggle + sliders
  const vibratoToggle = $('vibratoToggle') as HTMLInputElement
  const vibratoRateSlider = $input('vibratoRate')
  const vibratoDepthSlider = $input('vibratoDepth')

  // Waveform selector — works on the fly
  $('waveform').addEventListener('change', async () => {
    const type = ($('waveform') as HTMLSelectElement).value as any
    const eng = await ensureStarted()
    eng.setWaveform(type)
    setStatus(`Waveform: ${type}`)
  })

  vibratoToggle.addEventListener('change', () => {
    const on = vibratoToggle.checked
    vibratoRateSlider.disabled = !on
    vibratoDepthSlider.disabled = !on
    engine?.setVibratoDepth(on ? parseFloat(vibratoDepthSlider.value) : 0)
  })
  vibratoRateSlider.addEventListener('input', () => {
    if (vibratoToggle.checked) engine?.setVibratoRate(parseFloat(vibratoRateSlider.value))
  })
  vibratoDepthSlider.addEventListener('input', () => {
    if (vibratoToggle.checked) engine?.setVibratoDepth(parseFloat(vibratoDepthSlider.value))
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

  // Initialize record toggle reference
  recordToggle = $('recordToggle') as HTMLInputElement

  // ── Phoneme input (direct) ──
  $('speakBtn').addEventListener('click', () => {
    speakPhonemes($input('phonemeInput').value)
  })

  // ── Example text buttons ──
  function exBtn(id: string, text: string) {
    $(id).addEventListener('click', () => {
      $input('textInput').value = text
      speakText(text)
    })
  }

  exBtn('exHello', 'Hello, how are you?')
  exBtn('exRobot', 'I am a robot.')
  exBtn('exRainbow', 'When the sunlight strikes raindrops in the air, they act as a prism and form a rainbow. The rainbow is a division of white light into many beautiful colors.')
  exBtn('exSheSaw', 'She saw me.')
  exBtn('exGreeting', 'Good afternoon, radio audience.')
  exBtn('exConcentration', 'Concentration.')
  exBtn('exMary', 'Mary had a little lamb, its fleece was white as snow.')
  exBtn('exSF', 'Hello, San Francisco. This is New York speaking. Greetings to you.')

  // ── Animal sounds ──
  const animalContainer = $('animalButtons')
  for (const sound of ANIMAL_SOUNDS) {
    const btn = document.createElement('button')
    btn.textContent = sound.label
    btn.addEventListener('click', async () => {
      const eng = await ensureStarted()
      if (currentSequence) currentSequence.cancel()
      setStatus(`${sound.label}...`)
      $('currentWord').textContent = sound.label
      playAnimalSound(eng, sound)
    })
    animalContainer.appendChild(btn)
  }

  // ── A/B Test ──
  let abState: ABTestState | null = null

  function showABTest(index: number) {
    if (!abState) return
    const proposal = PROPOSALS[index]
    const result = abState.results[index]

    $('abProgress').textContent = `${index + 1} / ${PROPOSALS.length}`
    const durInfo = proposal.proposedDuration
      ? `<br>Duration: ${proposal.currentDuration}ms → ${proposal.proposedDuration}ms`
      : ''
    $('abPhonemeInfo').innerHTML = `
      <strong>${proposal.phoneme}</strong>: ${proposal.reason}${durInfo}<br>
      Test words: ${proposal.testWords.map(w => `<em>${w}</em>`).join(', ')}
    `

    // Build word buttons
    const wordsDiv = $('abWords')
    wordsDiv.innerHTML = ''
    for (const word of proposal.testWords) {
      const btn = document.createElement('button')
      btn.className = 'ab-word-btn'
      btn.textContent = word
      btn.dataset.word = word
      wordsDiv.appendChild(btn)
    }

    // Highlight current vote if any
    $('abVoteA').style.borderColor = result.vote === 'a' ? 'var(--accent)' : ''
    $('abVoteB').style.borderColor = result.vote === 'b' ? 'var(--accent)' : ''
    $('abVoteSame').style.borderColor = result.vote === 'same' ? 'var(--accent)' : ''
  }

  async function abPlay(version: 'a' | 'b', word?: string) {
    if (!abState) return
    const eng = await ensureStarted()
    const index = abState.currentIndex
    const proposal = PROPOSALS[index]
    const result = abState.results[index]

    const isProposed = (version === 'a' && result.aIsProposed) || (version === 'b' && !result.aIsProposed)
    const bands = isProposed ? proposal.proposedBands : proposal.currentBands
    const duration = isProposed ? proposal.proposedDuration : proposal.currentDuration
    const testWord = word || proposal.testWords[0]

    const durInfo = proposal.proposedDuration ? ` ${proposal.currentDuration}→${proposal.proposedDuration}ms` : ''
    setStatus(`Playing ${version.toUpperCase()}: "${testWord}" (${proposal.phoneme}${durInfo})`)
    await playWithGains(eng, testWord, proposal.phoneme, bands, duration)
    setStatus(`Done — ${version.toUpperCase()}`)
  }

  function abVote(vote: 'a' | 'b' | 'same') {
    if (!abState) return
    abState.results[abState.currentIndex].vote = vote
    showABTest(abState.currentIndex)

    // Auto-advance after a short delay
    setTimeout(() => {
      if (!abState) return
      if (abState.currentIndex < PROPOSALS.length - 1) {
        abState.currentIndex++
        showABTest(abState.currentIndex)
      } else {
        showABResults()
      }
    }, 300)
  }

  function showABResults() {
    if (!abState) return
    const { apply, reject, same } = getABResults(abState)

    let text = '=== A/B TEST RESULTS ===\n'
    text += `Apply (proposed was better): ${apply.length ? apply.join(', ') : 'none'}\n`
    text += `Reject (current was better): ${reject.length ? reject.join(', ') : 'none'}\n`
    text += `Same (no difference): ${same.length ? same.join(', ') : 'none'}\n\n`

    for (const r of abState.results) {
      const proposal = PROPOSALS.find(p => p.phoneme === r.phoneme)!
      const votedFor = r.vote === 'same' ? 'SAME' :
        ((r.vote === 'a' && r.aIsProposed) || (r.vote === 'b' && !r.aIsProposed)) ? 'PROPOSED' : 'CURRENT'
      text += `${r.phoneme}: ${votedFor}\n`
      if (votedFor === 'PROPOSED') {
        text += `  bands: [${proposal.proposedBands.map(g => g.toFixed(2)).join(', ')}]\n`
        if (proposal.proposedDuration) {
          text += `  duration: ${proposal.currentDuration}→${proposal.proposedDuration}ms\n`
        }
      }
    }

    const resultsDiv = $('abResults')
    resultsDiv.style.display = 'block'
    resultsDiv.innerHTML = `
      <h3>Results</h3>
      <div class="ab-results-text">${text}</div>
      <div class="row" style="margin-top: 8px; gap: 8px;">
        <button id="abCopyBtn" class="primary">Copy Results</button>
        <button id="abRestartBtn">Start Over</button>
      </div>
    `

    $('abCopyBtn').addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => setStatus('Results copied to clipboard!'))
    })

    $('abRestartBtn').addEventListener('click', () => {
      abState = createABTest()
      abState.currentIndex = 0
      resultsDiv.style.display = 'none'
      showABTest(0)
    })
  }

  $('abStartBtn').addEventListener('click', async () => {
    await ensureStarted()
    abState = createABTest()
    $('abPanel').style.display = 'block'
    $('abStartBtn').style.display = 'none'
    showABTest(0)
  })

  $('abPlayA').addEventListener('click', () => abPlay('a'))
  $('abPlayB').addEventListener('click', () => abPlay('b'))

  // Click on individual test words to play them
  $('abWords').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.ab-word-btn') as HTMLElement
    if (!btn) return
    // Toggle: first click plays A, second plays B
    if (btn.classList.contains('active')) {
      btn.classList.remove('active')
      abPlay('b', btn.dataset.word)
    } else {
      document.querySelectorAll('.ab-word-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      abPlay('a', btn.dataset.word)
    }
  })

  $('abVoteA').addEventListener('click', () => abVote('a'))
  $('abVoteB').addEventListener('click', () => abVote('b'))
  $('abVoteSame').addEventListener('click', () => abVote('same'))
}
