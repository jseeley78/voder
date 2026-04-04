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

    // Current synthesis parameters (accumulate via interpolation)
    let synthEnergy = 0
    let synthPeriod = 0
    const synthK = new Array(10).fill(0)

    // Target parameters (read from bitstream)
    let targetEnergy = 0
    let targetPeriod = 0
    const targetK = new Array(10).fill(0)

    // Lattice filter state
    const x = new Array(10).fill(0)

    // Noise LFSR
    let synthRand = 1

    // Pitch counter
    let periodCounter = 0

    // ISR sample counter (200 samples per frame = 8 sub-frames of 25)
    let sampleCount = 0

    while (!reader.done) {
      // Read next frame
      const energyIdx = reader.read(4)

      if (energyIdx === 0) {
        // Silence frame — zero energy, generate 200 silent samples
        targetEnergy = 0
        targetPeriod = 0
        for (let i = 0; i < 10; i++) targetK[i] = 0
        // Generate silence with interpolation toward zero
        for (let s = 0; s < 200; s++) {
          synthEnergy = 0
          output.push(0)
        }
        synthPeriod = 0
        for (let i = 0; i < 10; i++) synthK[i] = 0
        continue
      }

      if (energyIdx === 15) {
        // Stop frame
        break
      }

      targetEnergy = ENERGY[energyIdx]
      const repeat = reader.read(1)
      const pitchIdx = reader.read(6)
      targetPeriod = PERIOD[pitchIdx]

      if (!repeat) {
        for (let i = 0; i < 4; i++) {
          targetK[i] = K_TABLES[i][reader.read(K_BITS[i])]
        }
        if (targetPeriod > 0) {
          for (let i = 4; i < 10; i++) {
            targetK[i] = K_TABLES[i][reader.read(K_BITS[i])]
          }
        } else {
          for (let i = 4; i < 10; i++) targetK[i] = 0
        }
      }
      // If repeat, targetK stays the same (already set from previous non-repeat frame)

      // Generate 200 samples (8 sub-frames of 25 samples)
      for (sampleCount = 0; sampleCount < 200; sampleCount++) {
        // Every 25 samples, interpolate parameters toward target
        if (sampleCount % 25 === 0) {
          const subFrame = sampleCount / 25
          if (subFrame === 7) {
            // Last sub-frame: snap to target
            synthEnergy = targetEnergy
            synthPeriod = targetPeriod
            for (let i = 0; i < 10; i++) synthK[i] = targetK[i]
          } else {
            // Interpolate: move 1/8 of the way toward target each sub-frame
            synthEnergy += (targetEnergy - synthEnergy) >> 3
            synthPeriod += (targetPeriod - synthPeriod) >> 3
            for (let i = 0; i < 10; i++) {
              synthK[i] += (targetK[i] - synthK[i]) >> 3
            }
          }
        }

        // Excitation source
        let u10: number

        if (synthPeriod > 0) {
          // Voiced: chirp excitation
          if (periodCounter < CHIRP.length) {
            u10 = ((CHIRP[periodCounter] | 0) * synthEnergy) >> 8
          } else {
            u10 = 0
          }
          periodCounter++
          if (periodCounter >= synthPeriod) periodCounter = 0
        } else {
          // Unvoiced: LFSR noise
          synthRand = (synthRand >> 1) ^ ((synthRand & 1) ? 0xB800 : 0)
          u10 = (synthRand & 1) ? synthEnergy : -synthEnergy
        }

        // 10-stage lattice filter
        // Process from stage 10 down to stage 1
        let u = u10
        for (let i = 9; i >= 0; i--) {
          const kVal = synthK[i]
          u = u - ((kVal * x[i]) >> 9)
          x[i] = x[i > 0 ? i - 1 : 0] + ((kVal * u) >> 9)
        }
        x[0] = u

        // Scale output: values are roughly in -512..512 range
        output.push(Math.max(-1, Math.min(1, u / 256)))
      }
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
