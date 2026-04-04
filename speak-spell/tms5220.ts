/**
 * TMS5220 LPC Speech Synthesizer Emulation
 *
 * Faithful implementation of the Texas Instruments TMS5220 chip used in
 * the Speak & Spell (1978). Decodes LPC bitstreams through a 10-stage
 * lattice filter at 8kHz.
 *
 * References:
 *   - TMS5220 datasheet
 *   - MAME tms5220.cpp (Frank Palazzolo, Aaron Giles, et al.)
 *   - Talkie Arduino library (going-digital)
 */

// ── TMS5220 Quantization Tables ──
// From the TMS5220 chip (not the older TMS5100/TMC0281)

const ENERGY_TABLE = [0, 1, 2, 3, 4, 6, 8, 11, 16, 23, 33, 47, 63, 85, 114, 0]
// Index 0 = silence, index 15 = stop code

const PITCH_TABLE = [
  0, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
  30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45,
  46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61,
  62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77,
]

// Reflection coefficients K1-K10
// These are the integer values used internally by the chip (scaled by 512)
// Converted to float by dividing by 512

const K1_TABLE = [
 -501, -498, -497, -495, -493, -491, -488, -482,
 -478, -474, -469, -464, -459, -452, -445, -437,
 -412, -380, -339, -288, -227, -158,  -81,   -1,
   80,  157,  226,  287,  337,  379,  411,  436,
]

const K2_TABLE = [
 -328, -303, -274, -244, -211, -175, -138,  -99,
  -59,  -18,   24,   64,  105,  143,  180,  215,
  248,  278,  306,  331,  354,  374,  392,  408,
  422,  435,  445,  455,  463,  470,  476,  506,
]

const K3_TABLE = [
 -441, -387, -333, -279, -225, -171, -117,  -63,
   -9,   45,   98,  152,  206,  260,  314,  368,
]

const K4_TABLE = [
 -328, -273, -217, -161, -106,  -50,    5,   61,
  116,  172,  228,  283,  339,  394,  450,  506,
]

const K5_TABLE = [
 -328, -282, -235, -189, -142,  -96,  -50,   -3,
   43,   90,  136,  182,  229,  275,  322,  368,
]

const K6_TABLE = [
 -256, -212, -168, -123,  -79,  -35,   10,   54,
   98,  143,  187,  232,  276,  320,  365,  409,
]

const K7_TABLE = [
 -308, -260, -212, -164, -117,  -69,  -21,   27,
   75,  122,  170,  218,  266,  314,  361,  409,
]

const K8_TABLE = [-256, -161, -66, 29, 124, 219, 314, 409]
const K9_TABLE = [-256, -176, -96, -15, 65, 146, 226, 307]
const K10_TABLE = [-205, -132, -59, 14, 87, 160, 234, 307]

const K_TABLES = [K1_TABLE, K2_TABLE, K3_TABLE, K4_TABLE, K5_TABLE,
                  K6_TABLE, K7_TABLE, K8_TABLE, K9_TABLE, K10_TABLE]

// Bit widths for each K parameter
const K_BITS = [5, 5, 4, 4, 4, 4, 4, 3, 3, 3]

// ── Bitstream reader (LSB first) ──

class BitReader {
  private data: Uint8Array
  private bitPos: number = 0

  constructor(data: Uint8Array | number[]) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data)
  }

  read(bits: number): number {
    let value = 0
    for (let i = 0; i < bits; i++) {
      const byteIdx = Math.floor(this.bitPos / 8)
      const bitIdx = this.bitPos % 8
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

  reset(): void {
    this.bitPos = 0
  }
}

// ── LPC Frame ──

interface LPCFrame {
  energy: number     // 0-114 (0 = silence)
  pitch: number      // 0 = unvoiced, 15-77 = pitch period in samples
  k: number[]        // K1-K10 reflection coefficients (float, -1 to +1)
  repeat: boolean
  stop: boolean
}

// ── TMS5220 Synthesizer ──

export class TMS5220 {
  private sampleRate = 8000
  private samplesPerFrame = 200  // 25ms at 8kHz
  private interpSteps = 8        // interpolation steps per frame
  private samplesPerInterp = 25  // 200/8

  // Filter state
  private u: Float32Array = new Float32Array(11)  // forward path
  private x: Float32Array = new Float32Array(11)  // backward path

  // Current and target parameters
  private currentEnergy = 0
  private currentPitch = 0
  private currentK: number[] = new Array(10).fill(0)

  private targetEnergy = 0
  private targetPitch = 0
  private targetK: number[] = new Array(10).fill(0)

  // Excitation
  private pitchCounter = 0
  private noiseReg = 0x1FFFF  // 17-bit LFSR for noise

  /**
   * Decode an LPC bitstream into audio samples.
   * @param data The encoded LPC data (byte array from ROM)
   * @returns Float32Array of audio samples at 8kHz
   */
  decode(data: Uint8Array | number[]): Float32Array {
    const reader = new BitReader(data)
    const frames: LPCFrame[] = []

    // Parse all frames
    while (!reader.done) {
      const frame = this.readFrame(reader)
      if (frame.stop) break
      frames.push(frame)
    }

    // Synthesize
    const totalSamples = frames.length * this.samplesPerFrame + this.samplesPerFrame
    const output = new Float32Array(totalSamples)
    let outIdx = 0

    this.reset()

    for (const frame of frames) {
      // Set targets
      this.targetEnergy = frame.energy
      this.targetPitch = frame.pitch
      if (!frame.repeat) {
        for (let i = 0; i < 10; i++) this.targetK[i] = frame.k[i]
      }

      // Generate samples with interpolation
      for (let interp = 0; interp < this.interpSteps; interp++) {
        // Interpolate parameters
        const t = (interp + 1) / this.interpSteps
        const energy = this.currentEnergy + (this.targetEnergy - this.currentEnergy) * t
        const pitch = Math.round(this.currentPitch + (this.targetPitch - this.currentPitch) * t)
        const k: number[] = []
        for (let i = 0; i < 10; i++) {
          k.push(this.currentK[i] + (this.targetK[i] - this.currentK[i]) * t)
        }

        for (let s = 0; s < this.samplesPerInterp; s++) {
          if (outIdx >= output.length) break

          // Excitation source
          let excitation: number
          if (pitch === 0) {
            // Unvoiced: white noise from LFSR
            excitation = (this.noise() * 2 - 1) * energy
          } else {
            // Voiced: impulse train
            if (this.pitchCounter === 0) {
              excitation = energy
            } else {
              excitation = 0
            }
            this.pitchCounter++
            if (this.pitchCounter >= pitch) this.pitchCounter = 0
          }

          // 10-stage lattice filter
          this.u[10] = excitation
          for (let i = 9; i >= 0; i--) {
            this.u[i] = this.u[i + 1] - k[i] * this.x[i]
            this.x[i + 1] = this.x[i] + k[i] * this.u[i]
          }
          this.x[0] = this.u[0]

          output[outIdx++] = this.u[0] / 128  // scale to -1..1
        }
      }

      // Update current parameters
      this.currentEnergy = this.targetEnergy
      this.currentPitch = this.targetPitch
      for (let i = 0; i < 10; i++) this.currentK[i] = this.targetK[i]
    }

    return output.subarray(0, outIdx)
  }

  private readFrame(reader: BitReader): LPCFrame {
    const energyIdx = reader.read(4)

    if (energyIdx === 0) {
      return { energy: 0, pitch: 0, k: new Array(10).fill(0), repeat: false, stop: false }
    }
    if (energyIdx === 15) {
      return { energy: 0, pitch: 0, k: new Array(10).fill(0), repeat: false, stop: true }
    }

    const energy = ENERGY_TABLE[energyIdx]
    const repeat = reader.read(1) === 1
    const pitchIdx = reader.read(6)
    const pitch = PITCH_TABLE[pitchIdx]
    const voiced = pitch > 0

    if (repeat) {
      return { energy, pitch, k: [...this.targetK], repeat: true, stop: false }
    }

    // Read K coefficients
    const k: number[] = []
    for (let i = 0; i < (voiced ? 10 : 4); i++) {
      const idx = reader.read(K_BITS[i])
      k.push(K_TABLES[i][idx] / 512)
    }
    // Pad unvoiced frames with zeros for K5-K10
    while (k.length < 10) k.push(0)

    return { energy, pitch, k, repeat: false, stop: false }
  }

  private noise(): number {
    // 17-bit LFSR: taps at bit 0 and bit 3
    const bit = ((this.noiseReg >> 0) ^ (this.noiseReg >> 3)) & 1
    this.noiseReg = (this.noiseReg >> 1) | (bit << 16)
    return bit
  }

  private reset(): void {
    this.u.fill(0)
    this.x.fill(0)
    this.currentEnergy = 0
    this.currentPitch = 0
    this.currentK.fill(0)
    this.targetK.fill(0)
    this.pitchCounter = 0
    this.noiseReg = 0x1FFFF
  }
}

/**
 * Play LPC data through Web Audio.
 * Upsamples from 8kHz to the AudioContext sample rate.
 */
export async function playLPC(ctx: AudioContext, data: Uint8Array | number[], analyser?: AnalyserNode): Promise<void> {
  const synth = new TMS5220()
  const samples8k = synth.decode(data)

  // Normalize
  let peak = 0
  for (let i = 0; i < samples8k.length; i++) peak = Math.max(peak, Math.abs(samples8k[i]))
  if (peak > 0.01) {
    const sc = 0.85 / peak
    for (let i = 0; i < samples8k.length; i++) samples8k[i] *= sc
  }

  // Upsample to AudioContext rate
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
