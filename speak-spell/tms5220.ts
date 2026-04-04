/**
 * TMS5100 LPC Speech Decoder
 * Direct port of Arduino Talkie library ISR + setNextSynthesizerData.
 * No interpretation — exact translation of the C code.
 */

// ── Coefficient tables (TI2802 / TMS5100) ──
const tmsEnergy = [0, 2, 3, 4, 5, 7, 10, 15, 20, 32, 41, 57, 81, 114, 161, 255]
const tmsPeriod = [
  0, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
  31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 45, 47, 49,
  51, 53, 54, 57, 59, 61, 63, 66, 69, 71, 73, 77, 79, 81, 85, 87,
  92, 95, 99, 102, 106, 110, 115, 119, 123, 128, 133, 138, 143, 149, 154, 160,
]

// K1,K2: int16
const tmsK1 = [-32064,-31872,-31808,-31680,-31552,-31424,-31232,-30848,-30592,-30336,-30016,-29696,-29376,-28928,-28480,-27968,-26368,-24256,-21632,-18368,-14528,-10048,-5184,0,5184,10048,14528,18368,21632,24256,26368,27968]
const tmsK2 = [-20992,-19328,-17536,-15552,-13440,-11200,-8768,-6272,-3712,-1088,1536,4160,6720,9216,11584,13824,15936,17856,19648,21248,22656,24000,25152,26176,27072,27840,28544,29120,29632,30080,30464,32384]
// K3-K10: int8
const tmsK3 = [-110,-97,-83,-70,-56,-43,-29,-16,-2,11,25,38,52,65,79,92]
const tmsK4 = [-82,-68,-54,-40,-26,-12,1,15,29,43,57,71,85,99,113,126]
const tmsK5 = [-82,-70,-59,-47,-35,-24,-12,-1,11,23,34,46,57,69,81,92]
const tmsK6 = [-64,-53,-42,-31,-20,-9,3,14,25,36,47,58,69,80,91,102]
const tmsK7 = [-77,-65,-53,-41,-29,-17,-5,7,19,31,43,55,67,79,90,102]
const tmsK8 = [-64,-40,-16,7,31,55,79,102]
const tmsK9 = [-64,-44,-24,-4,16,37,57,77]
const tmsK10 = [-51,-33,-15,4,22,32,59,77]

// Chirp (int8_t, 41 samples)
const chirp = [
  0x00,0x2A,0xD4,0x32,0xB2,0x12,0x25,0x14,
  0x02,0xE1,0xC5,0x02,0x5F,0x5A,0x05,0x0F,
  0x26,0xFC,0xA5,0xA5,0xD6,0xDD,0xDC,0xFC,
  0x25,0x2B,0x22,0x21,0x0F,0xFF,0xF8,0xEE,
  0xED,0xEF,0xF7,0xF6,0xFA,0x00,0x03,0x02,0x01,
]
// Convert uint8 chirp to signed
const chirpSigned = chirp.map(v => v > 127 ? v - 256 : v)

// ── Bit reader (LSB first, exact match to Talkie getBits) ──
class BitReader {
  private data: Uint8Array
  private ptrAddr = 0
  private ptrBit = 0

  constructor(data: Uint8Array | number[]) {
    this.data = data instanceof Uint8Array ? data : new Uint8Array(data)
  }

  getBits(numBits: number): number {
    let value = 0
    for (let i = 0; i < numBits; i++) {
      if (this.ptrAddr < this.data.length) {
        value |= ((this.data[this.ptrAddr] >> this.ptrBit) & 1) << i
      }
      this.ptrBit++
      if (this.ptrBit === 8) {
        this.ptrBit = 0
        this.ptrAddr++
      }
    }
    return value
  }

  get done(): boolean {
    return this.ptrAddr >= this.data.length
  }
}

// ── Decoder: exact port of Talkie ISR ──
export class TMS5220 {
  decode(data: Uint8Array | number[]): Float32Array {
    const reader = new BitReader(data)
    const output: number[] = []

    // Synth state — exact match to Talkie static variables
    let synthPeriod = 0
    let synthEnergy = 0
    let synthK1 = 0, synthK2 = 0
    let synthK3 = 0, synthK4 = 0, synthK5 = 0
    let synthK6 = 0, synthK7 = 0, synthK8 = 0
    let synthK9 = 0, synthK10 = 0

    // Filter state
    let x0 = 0, x1 = 0, x2 = 0, x3 = 0, x4 = 0
    let x5 = 0, x6 = 0, x7 = 0, x8 = 0, x9 = 0

    let periodCounter = 0
    let synthRand = 1
    let ISRCounter = 0
    let stopped = false

    // setNextSynthesizerData — called every 200 ISR ticks
    function readFrame(): boolean {
      if (reader.done) return false

      const energy = reader.getBits(4)
      if (energy === 0) {
        synthEnergy = 0
        return true
      }
      if (energy === 0xF) {
        synthEnergy = 0
        synthK1 = synthK2 = synthK3 = synthK4 = synthK5 = 0
        synthK6 = synthK7 = synthK8 = synthK9 = synthK10 = 0
        return false // stop
      }

      synthEnergy = tmsEnergy[energy]
      const repeat = reader.getBits(1)
      synthPeriod = tmsPeriod[reader.getBits(6)]

      if (!repeat) {
        synthK1 = tmsK1[reader.getBits(5)]
        synthK2 = tmsK2[reader.getBits(5)]
        synthK3 = tmsK3[reader.getBits(4)]
        synthK4 = tmsK4[reader.getBits(4)]
        if (synthPeriod) {
          synthK5 = tmsK5[reader.getBits(4)]
          synthK6 = tmsK6[reader.getBits(4)]
          synthK7 = tmsK7[reader.getBits(4)]
          synthK8 = tmsK8[reader.getBits(3)]
          synthK9 = tmsK9[reader.getBits(3)]
          synthK10 = tmsK10[reader.getBits(3)]
        }
      }
      return true
    }

    // Read first frame
    if (!readFrame()) return new Float32Array(0)

    // Main synthesis loop — exact port of timerInterrupt()
    const MAX_SAMPLES = 8000 * 10 // 10 seconds max
    for (let sample = 0; sample < MAX_SAMPLES; sample++) {
      if (stopped) break

      // Every 200 samples, read next frame
      ISRCounter++
      if (ISRCounter >= 200) {
        ISRCounter = 0
        if (!readFrame()) {
          stopped = true
          break
        }
      }

      let u0: number, u1: number, u2: number, u3: number, u4: number
      let u5: number, u6: number, u7: number, u8: number, u9: number, u10: number

      if (synthPeriod) {
        // Voiced source
        if (periodCounter < synthPeriod) {
          periodCounter++
        } else {
          periodCounter = 0
        }
        if (periodCounter < chirpSigned.length) {
          u10 = (chirpSigned[periodCounter] * synthEnergy) >> 8
        } else {
          u10 = 0
        }
      } else {
        // Unvoiced source
        synthRand = (synthRand >> 1) ^ ((synthRand & 1) ? 0xB800 : 0)
        u10 = (synthRand & 1) ? synthEnergy : -synthEnergy
      }

      // Lattice filter forward path
      // Use Math.imul for 32-bit integer multiply (avoids JS float precision issues)
      // K3-K10 are int8, shift >>7. K1-K2 are int16, shift >>15
      u9 = u10 - ((Math.imul(synthK10, x9)) >> 7)
      u8 = u9 - ((Math.imul(synthK9, x8)) >> 7)
      u7 = u8 - ((Math.imul(synthK8, x7)) >> 7)
      u6 = u7 - ((Math.imul(synthK7, x6)) >> 7)
      u5 = u6 - ((Math.imul(synthK6, x5)) >> 7)
      u4 = u5 - ((Math.imul(synthK5, x4)) >> 7)
      u3 = u4 - ((Math.imul(synthK4, x3)) >> 7)
      u2 = u3 - ((Math.imul(synthK3, x2)) >> 7)
      u1 = u2 - ((Math.imul(synthK2, x1)) >> 15)
      u0 = u1 - ((Math.imul(synthK1, x0)) >> 15)

      // Lattice filter reverse path
      x9 = x8 + ((Math.imul(synthK9, u8)) >> 7)
      x8 = x7 + ((Math.imul(synthK8, u7)) >> 7)
      x7 = x6 + ((Math.imul(synthK7, u6)) >> 7)
      x6 = x5 + ((Math.imul(synthK6, u5)) >> 7)
      x5 = x4 + ((Math.imul(synthK5, u4)) >> 7)
      x4 = x3 + ((Math.imul(synthK4, u3)) >> 7)
      x3 = x2 + ((Math.imul(synthK3, u2)) >> 7)
      x2 = x1 + ((Math.imul(synthK2, u1)) >> 15)
      x1 = x0 + ((Math.imul(synthK1, u0)) >> 15)
      x0 = u0

      // Output: Talkie outputs u0+128 as 8-bit unsigned for PWM
      // We output as float. u0 range is roughly -256..256
      output.push(u0 / 256)
    }

    return new Float32Array(output)
  }
}

/** Play LPC data through Web Audio */
export async function playLPC(ctx: AudioContext, data: Uint8Array | number[], analyser?: AnalyserNode): Promise<void> {
  const synth = new TMS5220()
  const samples8k = synth.decode(data)
  if (samples8k.length === 0) return

  let peak = 0
  for (let i = 0; i < samples8k.length; i++) peak = Math.max(peak, Math.abs(samples8k[i]))
  if (peak > 0.01) {
    const sc = 0.85 / peak
    for (let i = 0; i < samples8k.length; i++) samples8k[i] *= sc
  }

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
  return new Promise(resolve => { source.onended = () => resolve() })
}
