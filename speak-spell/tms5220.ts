/**
 * TMS5100 LPC Speech Decoder — faithful port of the Arduino Talkie library.
 *
 * Decodes LPC bitstreams from the TI-99/4A speech system vocabulary
 * through a 10-stage lattice filter at 8kHz.
 *
 * Based on Talkie by Peter Knight (GPLv2), ArminJo fork.
 */

// ── TMS5100 (TI2802) coefficient tables ──
// These match the Talkie library's default tables exactly

const tmsEnergy = [0, 2, 3, 4, 5, 7, 10, 15, 20, 32, 41, 57, 81, 114, 161, 255]

const tmsPeriod = [
  0, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 45, 47, 49,
  51, 53, 54, 57, 59, 61, 63, 66, 69, 71, 73, 77, 79, 81, 85, 87,
  92, 95, 99, 102, 106, 110, 115, 119, 123, 128, 133, 138, 143, 149, 154, 160,
]

// K1, K2: 16-bit signed
const tmsK1 = [-32064,-31872,-31808,-31680,-31552,-31424,-31232,-30848,-30592,-30336,-30016,-29696,-29376,-28928,-28480,-27968,-26368,-24256,-21632,-18368,-14528,-10048,-5184,0,5184,10048,14528,18368,21632,24256,26368,27968]
const tmsK2 = [-20992,-19328,-17536,-15552,-13440,-11200,-8768,-6272,-3712,-1088,1536,4160,6720,9216,11584,13824,15936,17856,19648,21248,22656,24000,25152,26176,27072,27840,28544,29120,29632,30080,30464,32384]

// K3-K10: 8-bit signed
const tmsK3 = [-110,-97,-83,-70,-56,-43,-29,-16,-2,11,25,38,52,65,79,92]
const tmsK4 = [-82,-68,-54,-40,-26,-12,1,15,29,43,57,71,85,99,113,126]
const tmsK5 = [-82,-70,-59,-47,-35,-24,-12,-1,11,23,34,46,57,69,81,92]
const tmsK6 = [-64,-53,-42,-31,-20,-9,3,14,25,36,47,58,69,80,91,102]
const tmsK7 = [-77,-65,-53,-41,-29,-17,-5,7,19,31,43,55,67,79,90,102]
const tmsK8 = [-64,-40,-16,7,31,55,79,102]
const tmsK9 = [-64,-44,-24,-4,16,37,57,77]
const tmsK10 = [-51,-33,-15,4,22,32,59,77]

const K_TABLES = [tmsK1, tmsK2, tmsK3, tmsK4, tmsK5, tmsK6, tmsK7, tmsK8, tmsK9, tmsK10]
const K_BITS = [5, 5, 4, 4, 4, 4, 4, 3, 3, 3]

// Chirp excitation (TMC0280/TMS5100) — 41 signed int8 samples
const chirp = [
  0x00, 0x2A, 0xD4, 0x32, 0xB2, 0x12, 0x25, 0x14,
  0x02, 0xE1, 0xC5, 0x02, 0x5F, 0x5A, 0x05, 0x0F,
  0x26, 0xFC, 0xA5, 0xA5, 0xD6, 0xDD, 0xDC, 0xFC,
  0x25, 0x2B, 0x22, 0x21, 0x0F, 0xFF, 0xF8, 0xEE,
  0xED, 0xEF, 0xF7, 0xF6, 0xFA, 0x00, 0x03, 0x02, 0x01,
]

// Convert chirp to signed int8
function toInt8(v: number): number {
  return v > 127 ? v - 256 : v
}

// ── Bitstream reader (LSB first) ──

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

// ── Decoder ──

export class TMS5220 {
  decode(data: Uint8Array | number[]): Float32Array {
    const reader = new BitReader(data)
    const output: number[] = []

    // Current parameters (interpolated)
    let synthEnergy = 0
    let synthPeriod = 0
    let synthK1 = 0, synthK2 = 0
    let synthK3 = 0, synthK4 = 0, synthK5 = 0, synthK6 = 0
    let synthK7 = 0, synthK8 = 0, synthK9 = 0, synthK10 = 0

    // Lattice filter state
    let x0 = 0, x1 = 0, x2 = 0, x3 = 0, x4 = 0
    let x5 = 0, x6 = 0, x7 = 0, x8 = 0, x9 = 0

    // Excitation state
    let periodCounter = 0
    let synthRand = 1

    // Frame counter
    let nextFrameIn = 0  // samples until next frame read

    // Target parameters
    let newEnergy = 0, newPeriod = 0
    let newK1 = 0, newK2 = 0, newK3 = 0, newK4 = 0, newK5 = 0
    let newK6 = 0, newK7 = 0, newK8 = 0, newK9 = 0, newK10 = 0

    let frameCount = 0
    let stopped = false

    while (!stopped) {
      // Read next frame
      if (reader.done) break
      const energyIdx = reader.read(4)

      if (energyIdx === 0) {
        // Silence
        newEnergy = 0
        newPeriod = 0
        newK1 = newK2 = newK3 = newK4 = newK5 = 0
        newK6 = newK7 = newK8 = newK9 = newK10 = 0
      } else if (energyIdx === 15) {
        // Stop
        stopped = true
        newEnergy = 0
        newPeriod = 0
      } else {
        newEnergy = tmsEnergy[energyIdx]
        const repeat = reader.read(1)
        newPeriod = tmsPeriod[reader.read(6)]

        if (!repeat) {
          newK1 = tmsK1[reader.read(5)]
          newK2 = tmsK2[reader.read(5)]
          newK3 = tmsK3[reader.read(4)]
          newK4 = tmsK4[reader.read(4)]
          if (newPeriod > 0) {
            newK5 = tmsK5[reader.read(4)]
            newK6 = tmsK6[reader.read(4)]
            newK7 = tmsK7[reader.read(4)]
            newK8 = tmsK8[reader.read(3)]
            newK9 = tmsK9[reader.read(3)]
            newK10 = tmsK10[reader.read(3)]
          } else {
            newK5 = newK6 = newK7 = newK8 = newK9 = newK10 = 0
          }
        }
      }

      // Generate 200 samples (8 sub-frames × 25 samples) for this frame
      for (let subFrame = 0; subFrame < 8; subFrame++) {
        // Interpolate at the START of each sub-frame
        // Talkie uses: synth += (new - synth) >> 3 for sub-frames 0-6, snap on 7
        if (subFrame < 7) {
          synthEnergy += (newEnergy - synthEnergy) >> 3
          synthPeriod += (newPeriod - synthPeriod) >> 3
          synthK1 += (newK1 - synthK1) >> 3
          synthK2 += (newK2 - synthK2) >> 3
          synthK3 += (newK3 - synthK3) >> 3
          synthK4 += (newK4 - synthK4) >> 3
          synthK5 += (newK5 - synthK5) >> 3
          synthK6 += (newK6 - synthK6) >> 3
          synthK7 += (newK7 - synthK7) >> 3
          synthK8 += (newK8 - synthK8) >> 3
          synthK9 += (newK9 - synthK9) >> 3
          synthK10 += (newK10 - synthK10) >> 3
        } else {
          synthEnergy = newEnergy
          synthPeriod = newPeriod
          synthK1 = newK1; synthK2 = newK2; synthK3 = newK3; synthK4 = newK4
          synthK5 = newK5; synthK6 = newK6; synthK7 = newK7; synthK8 = newK8
          synthK9 = newK9; synthK10 = newK10
        }

        for (let s = 0; s < 25; s++) {
          let u10: number

          if (synthPeriod > 0) {
            // Voiced: chirp excitation
            // Matches Talkie: ((int8_t)chirp[periodCounter]) * synthEnergy >> 8
            if (periodCounter < chirp.length) {
              u10 = (toInt8(chirp[periodCounter]) * synthEnergy) >> 8
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
          // Forward path: u[i] = u[i+1] - K[i+1] * x[i]
          // K1, K2 are 16-bit (/32768), K3-K10 are 8-bit (/128)
          const u9 = u10 - ((synthK10 * x9) >> 7)
          const u8 = u9 - ((synthK9 * x8) >> 7)
          const u7 = u8 - ((synthK8 * x7) >> 7)
          const u6 = u7 - ((synthK7 * x6) >> 7)
          const u5 = u6 - ((synthK6 * x5) >> 7)
          const u4 = u5 - ((synthK5 * x4) >> 7)
          const u3 = u4 - ((synthK4 * x3) >> 7)
          const u2 = u3 - ((synthK3 * x2) >> 7)
          const u1 = u2 - ((synthK2 * x1) >> 15)
          const u0 = u1 - ((synthK1 * x0) >> 15)

          // Reverse path: x[i+1] = x[i] + K[i] * u[i]
          x9 = x8 + ((synthK9 * u8) >> 7)
          x8 = x7 + ((synthK8 * u7) >> 7)
          x7 = x6 + ((synthK7 * u6) >> 7)
          x6 = x5 + ((synthK6 * u5) >> 7)
          x5 = x4 + ((synthK5 * u4) >> 7)
          x4 = x3 + ((synthK4 * u3) >> 7)
          x3 = x2 + ((synthK3 * u2) >> 7)
          x2 = x1 + ((synthK2 * u1) >> 15)
          x1 = x0 + ((synthK1 * u0) >> 15)
          x0 = u0

          // Output: scale to float [-1, 1]
          // u0 is roughly in range -512..512 for 8-bit output
          output.push(u0 / 512)
        }
      }

      frameCount++
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
