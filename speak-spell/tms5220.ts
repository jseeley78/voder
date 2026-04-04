/**
 * TMS5100/5220 LPC Speech Synthesizer Emulation
 *
 * Ported from the Talkie Arduino library (GPLv2).
 * Uses chirp excitation, LFSR noise, and 10-stage lattice filter.
 */

// ── TMS5100 Tables (for TI-99/Speak & Spell vocabulary) ──

const ENERGY = [0, 2, 3, 4, 5, 7, 10, 15, 20, 32, 41, 57, 81, 114, 161, 255]

const PERIOD = [
  0, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 45, 47, 49,
  51, 53, 54, 57, 59, 61, 63, 66, 69, 71, 73, 77, 79, 81, 85, 87,
  92, 95, 99, 102, 106, 110, 115, 119, 123, 128, 133, 138, 143, 149, 154, 160,
]

// K1-K2: 16-bit signed, scaled by 512
const K1 = [-501,-498,-497,-495,-493,-491,-488,-482,-478,-474,-469,-464,-459,-452,-445,-437,-412,-380,-339,-288,-227,-158,-81,-1,80,157,226,287,337,379,411,436]
const K2 = [-328,-303,-274,-244,-211,-175,-138,-99,-59,-18,24,64,105,143,180,215,248,278,306,331,354,374,392,408,422,435,445,455,463,470,476,506]

// K3-K10: 16-bit signed, scaled by 512
const K3 = [-441,-387,-333,-279,-225,-171,-117,-63,-9,45,98,152,206,260,314,368]
const K4 = [-328,-273,-217,-161,-106,-50,5,61,116,172,228,283,339,394,450,506]
const K5 = [-328,-282,-235,-189,-142,-96,-50,-3,43,90,136,182,229,275,322,368]
const K6 = [-256,-212,-168,-123,-79,-35,10,54,98,143,187,232,276,320,365,409]
const K7 = [-308,-260,-212,-164,-117,-69,-21,27,75,122,170,218,266,314,361,409]
const K8 = [-256,-161,-66,29,124,219,314,409]
const K9 = [-256,-176,-96,-15,65,146,226,307]
const K10 = [-205,-132,-59,14,87,160,234,307]

const K_TABLES = [K1, K2, K3, K4, K5, K6, K7, K8, K9, K10]
const K_BITS = [5, 5, 4, 4, 4, 4, 4, 3, 3, 3]

// Chirp excitation waveform (signed 8-bit, 21 samples)
const CHIRP = [0x00, 0x03, 0x0F, 0x28, 0x4C, 0x6C, 0x71, 0x50, 0x25, 0x26,
               0x4C, 0x44, 0x1A, 0x32, 0x3B, 0x13, 0x37, 0x1A, 0x25, 0x1F, 0x1D]

// ── Bit reader (LSB first) ──

class BitReader {
  private data: Uint8Array
  private bitPos = 0

  constructor(data: Uint8Array | number[]) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data)
  }

  read(bits: number): number {
    let value = 0
    for (let i = 0; i < bits; i++) {
      const byteIdx = this.bitPos >> 3
      const bitIdx = this.bitPos & 7
      if (byteIdx < this.data.length) {
        value |= ((this.data[byteIdx] >> bitIdx) & 1) << i
      }
      this.bitPos++
    }
    return value
  }

  get done(): boolean {
    return this.bitPos >= this.data.length * 8
  }
}

// ── TMS5220 Synthesizer ──

export class TMS5220 {
  decode(data: Uint8Array | number[]): Float32Array {
    const reader = new BitReader(data)
    const output: number[] = []

    // Synthesis state
    let synthEnergy = 0
    let synthPeriod = 0
    const synthK = new Int32Array(10)

    // Lattice filter state
    const x = new Int32Array(10)

    // Noise LFSR
    let synthRand = 1

    // Pitch counter
    let periodCounter = 0

    while (!reader.done) {
      // Read frame
      const energyIdx = reader.read(4)

      if (energyIdx === 0) {
        // Silence frame
        synthEnergy = 0
        for (let s = 0; s < 200; s++) output.push(0)
        continue
      }
      if (energyIdx === 15) {
        // Stop frame
        break
      }

      const newEnergy = ENERGY[energyIdx]
      const repeat = reader.read(1)
      const pitchIdx = reader.read(6)
      const newPeriod = PERIOD[pitchIdx]

      const newK = new Int32Array(10)
      if (!repeat) {
        // Read K1-K4 always
        for (let i = 0; i < 4; i++) {
          newK[i] = K_TABLES[i][reader.read(K_BITS[i])]
        }
        // Read K5-K10 only for voiced frames
        if (newPeriod > 0) {
          for (let i = 4; i < 10; i++) {
            newK[i] = K_TABLES[i][reader.read(K_BITS[i])]
          }
        }
      } else {
        // Repeat: keep previous K values
        for (let i = 0; i < 10; i++) newK[i] = synthK[i]
      }

      // Interpolation coefficients (8 sub-frames of 25 samples)
      const interp = [0, 3, 3, 3, 2, 2, 1, 1] // right-shift amounts for interpolation

      for (let sub = 0; sub < 8; sub++) {
        // Interpolate parameters
        const shift = interp[sub]
        if (sub === 0) {
          // First sub-frame: snap to new target (actually start interpolating)
        }
        // Linear interpolation via bit shifting
        const curEnergy = synthEnergy + ((newEnergy - synthEnergy) >> shift)
        const curPeriod = synthPeriod + ((newPeriod - synthPeriod) >> shift)
        const curK = new Int32Array(10)
        for (let i = 0; i < 10; i++) {
          curK[i] = synthK[i] + ((newK[i] - synthK[i]) >> shift)
        }

        // Generate 25 samples per sub-frame
        for (let s = 0; s < 25; s++) {
          let u10: number

          if (curPeriod > 0) {
            // Voiced: chirp excitation
            if (periodCounter < CHIRP.length) {
              // Chirp values are unsigned 0-127, convert to signed and scale by energy
              u10 = (CHIRP[periodCounter] * curEnergy) >> 8
            } else {
              u10 = 0
            }
            periodCounter++
            if (periodCounter >= curPeriod) periodCounter = 0
          } else {
            // Unvoiced: LFSR noise
            synthRand = (synthRand >> 1) ^ ((synthRand & 1) ? 0xB800 : 0)
            u10 = (synthRand & 1) ? curEnergy : -curEnergy
          }

          // 10-stage lattice filter (from K10 down to K1)
          // All math in integer, K values scaled by 512
          let u9 = u10 - ((curK[9] * x[9]) >> 9)
          x[9] = x[8] + ((curK[9] * u9) >> 9)

          let u8 = u9 - ((curK[8] * x[8]) >> 9)
          x[8] = x[7] + ((curK[8] * u8) >> 9)

          let u7 = u8 - ((curK[7] * x[7]) >> 9)
          x[7] = x[6] + ((curK[7] * u7) >> 9)

          let u6 = u7 - ((curK[6] * x[6]) >> 9)
          x[6] = x[5] + ((curK[6] * u6) >> 9)

          let u5 = u6 - ((curK[5] * x[5]) >> 9)
          x[5] = x[4] + ((curK[5] * u5) >> 9)

          let u4 = u5 - ((curK[4] * x[4]) >> 9)
          x[4] = x[3] + ((curK[4] * u4) >> 9)

          let u3 = u4 - ((curK[3] * x[3]) >> 9)
          x[3] = x[2] + ((curK[3] * u3) >> 9)

          let u2 = u3 - ((curK[2] * x[2]) >> 9)
          x[2] = x[1] + ((curK[2] * u2) >> 9)

          let u1 = u2 - ((curK[1] * x[1]) >> 9)
          x[1] = x[0] + ((curK[1] * u1) >> 9)

          let u0 = u1 - ((curK[0] * x[0]) >> 9)
          x[0] = u0

          // Clamp and output
          output.push(Math.max(-1, Math.min(1, u0 / 512)))
        }
      }

      // Update synthesis parameters for next frame
      synthEnergy = newEnergy
      synthPeriod = newPeriod
      for (let i = 0; i < 10; i++) synthK[i] = newK[i]
    }

    return new Float32Array(output)
  }
}

/**
 * Play LPC data through Web Audio.
 */
export async function playLPC(ctx: AudioContext, data: Uint8Array | number[], analyser?: AnalyserNode): Promise<void> {
  const synth = new TMS5220()
  const samples8k = synth.decode(data)

  if (samples8k.length === 0) return

  // Normalize
  let peak = 0
  for (let i = 0; i < samples8k.length; i++) peak = Math.max(peak, Math.abs(samples8k[i]))
  if (peak > 0.01) {
    const sc = 0.85 / peak
    for (let i = 0; i < samples8k.length; i++) samples8k[i] *= sc
  }

  // Upsample from 8kHz to AudioContext rate
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
  if (analyser) source.connect(analyser)
  else source.connect(ctx.destination)
  source.start()

  return new Promise(resolve => {
    source.onended = () => resolve()
  })
}
