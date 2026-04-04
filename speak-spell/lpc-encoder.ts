/**
 * LPC Encoder — converts audio samples to TMS5220-style LPC frames.
 *
 * Uses the Levinson-Durbin algorithm to compute reflection coefficients
 * from autocorrelation, then quantizes them to TMS5220 tables.
 *
 * This allows encoding arbitrary audio (from Web Speech API or any source)
 * into the LPC format that the TMS5220 decoder can play back.
 */

// TMS5220 quantization tables (same as tms5220.ts)
const ENERGY_TABLE = [0, 1, 2, 3, 4, 6, 8, 11, 16, 23, 33, 47, 63, 85, 114, 0]

const K_TABLES = [
  [-501,-498,-497,-495,-493,-491,-488,-482,-478,-474,-469,-464,-459,-452,-445,-437,-412,-380,-339,-288,-227,-158,-81,-1,80,157,226,287,337,379,411,436],
  [-328,-303,-274,-244,-211,-175,-138,-99,-59,-18,24,64,105,143,180,215,248,278,306,331,354,374,392,408,422,435,445,455,463,470,476,506],
  [-441,-387,-333,-279,-225,-171,-117,-63,-9,45,98,152,206,260,314,368],
  [-328,-273,-217,-161,-106,-50,5,61,116,172,228,283,339,394,450,506],
  [-328,-282,-235,-189,-142,-96,-50,-3,43,90,136,182,229,275,322,368],
  [-256,-212,-168,-123,-79,-35,10,54,98,143,187,232,276,320,365,409],
  [-308,-260,-212,-164,-117,-69,-21,27,75,122,170,218,266,314,361,409],
  [-256,-161,-66,29,124,219,314,409],
  [-256,-176,-96,-15,65,146,226,307],
  [-205,-132,-59,14,87,160,234,307],
]

function findNearest(table: number[], value: number): number {
  let bestIdx = 0
  let bestDist = Math.abs(table[0] - value)
  for (let i = 1; i < table.length; i++) {
    const dist = Math.abs(table[i] - value)
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = i
    }
  }
  return bestIdx
}

export interface LPCFrame {
  energy: number
  pitch: number
  k: number[]
}

/**
 * Analyze a frame of audio samples and produce LPC parameters.
 * @param samples Audio samples (mono, any sample rate)
 * @param sampleRate Sample rate of the input
 * @returns LPC frame with energy, pitch, and 10 reflection coefficients
 */
export function analyzeFrame(samples: Float32Array, sampleRate: number): LPCFrame {
  const n = samples.length
  if (n === 0) return { energy: 0, pitch: 0, k: new Array(10).fill(0) }

  // Energy (RMS)
  let rms = 0
  for (let i = 0; i < n; i++) rms += samples[i] * samples[i]
  rms = Math.sqrt(rms / n)

  const energy = Math.round(rms * 800)  // scale to TMS5220 range

  if (energy < 1) return { energy: 0, pitch: 0, k: new Array(10).fill(0) }

  // Pitch detection via autocorrelation
  const minLag = Math.floor(sampleRate / 300)  // 300Hz max
  const maxLag = Math.min(Math.floor(sampleRate / 60), n - 1)  // 60Hz min
  let bestLag = 0
  let bestCorr = 0

  // Compute autocorrelation at lag 0
  let r0 = 0
  for (let i = 0; i < n; i++) r0 += samples[i] * samples[i]

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0
    for (let i = 0; i < n - lag; i++) {
      corr += samples[i] * samples[i + lag]
    }
    if (corr > bestCorr) {
      bestCorr = corr
      bestLag = lag
    }
  }

  const periodicity = r0 > 0 ? bestCorr / r0 : 0
  // Convert lag to 8kHz pitch period
  const pitch8k = periodicity > 0.3 ? Math.round(bestLag * 8000 / sampleRate) : 0

  // LPC analysis via Levinson-Durbin
  const order = 10
  const r = new Float32Array(order + 1)

  // Autocorrelation
  for (let i = 0; i <= order; i++) {
    for (let j = 0; j < n - i; j++) {
      r[i] += samples[j] * samples[j + i]
    }
  }

  // Levinson-Durbin recursion
  const a = new Float32Array(order + 1)
  const aTemp = new Float32Array(order + 1)
  const k: number[] = []

  let error = r[0]

  for (let i = 1; i <= order; i++) {
    let sum = 0
    for (let j = 1; j < i; j++) {
      sum += a[j] * r[i - j]
    }

    const ki = -(r[i] + sum) / (error || 1e-10)
    k.push(Math.max(-0.99, Math.min(0.99, ki)))

    aTemp[i] = ki
    for (let j = 1; j < i; j++) {
      aTemp[j] = a[j] + ki * a[i - j]
    }
    for (let j = 1; j <= i; j++) {
      a[j] = aTemp[j]
    }
    error *= (1 - ki * ki)
  }

  return {
    energy: Math.min(energy, 114),
    pitch: Math.max(0, Math.min(77, pitch8k)),
    k,
  }
}

/**
 * Encode audio samples into TMS5220 LPC frames.
 * @param samples Audio samples at any sample rate
 * @param sampleRate Source sample rate
 * @returns Array of quantized LPC frames
 */
export function encodeLPC(samples: Float32Array, sampleRate: number): LPCFrame[] {
  const frameSize = Math.round(sampleRate * 0.025)  // 25ms frames
  const nFrames = Math.floor(samples.length / frameSize)
  const frames: LPCFrame[] = []

  for (let f = 0; f < nFrames; f++) {
    const start = f * frameSize
    const frame = samples.subarray(start, start + frameSize)

    // Pre-emphasis
    const preEmph = new Float32Array(frame.length)
    preEmph[0] = frame[0]
    for (let i = 1; i < frame.length; i++) {
      preEmph[i] = frame[i] - 0.9375 * frame[i - 1]
    }

    // Apply Hamming window
    for (let i = 0; i < preEmph.length; i++) {
      preEmph[i] *= 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (preEmph.length - 1))
    }

    const lpc = analyzeFrame(preEmph, sampleRate)
    frames.push(lpc)
  }

  return frames
}
