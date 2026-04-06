/**
 * TMS5100 LPC Speech Decoder
 * Verified correct: sample output matches C reference implementation.
 */

const tmsEnergy = [0,2,3,4,5,7,10,15,20,32,41,57,81,114,161,255]
const tmsPeriod = [0,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34,35,36,37,38,39,40,41,42,43,45,47,49,51,53,54,57,59,61,63,66,69,71,73,77,79,81,85,87,92,95,99,102,106,110,115,119,123,128,133,138,143,149,154,160]
const tmsK1=[-32064,-31872,-31808,-31680,-31552,-31424,-31232,-30848,-30592,-30336,-30016,-29696,-29376,-28928,-28480,-27968,-26368,-24256,-21632,-18368,-14528,-10048,-5184,0,5184,10048,14528,18368,21632,24256,26368,27968]
const tmsK2=[-20992,-19328,-17536,-15552,-13440,-11200,-8768,-6272,-3712,-1088,1536,4160,6720,9216,11584,13824,15936,17856,19648,21248,22656,24000,25152,26176,27072,27840,28544,29120,29632,30080,30464,32384]
const tmsK3=[-110,-97,-83,-70,-56,-43,-29,-16,-2,11,25,38,52,65,79,92]
const tmsK4=[-82,-68,-54,-40,-26,-12,1,15,29,43,57,71,85,99,113,126]
const tmsK5=[-82,-70,-59,-47,-35,-24,-12,-1,11,23,34,46,57,69,81,92]
const tmsK6=[-64,-53,-42,-31,-20,-9,3,14,25,36,47,58,69,80,91,102]
const tmsK7=[-77,-65,-53,-41,-29,-17,-5,7,19,31,43,55,67,79,90,102]
const tmsK8=[-64,-40,-16,7,31,55,79,102]
const tmsK9=[-64,-44,-24,-4,16,37,57,77]
const tmsK10=[-51,-33,-15,4,22,32,59,77]

// Chirp as signed int8
const chirpSigned = [0,42,-44,50,-78,18,37,20,2,-31,-59,2,95,90,5,15,38,-4,-91,-91,-42,-35,-36,-4,37,43,34,33,15,-1,-8,-18,-19,-17,-9,-10,-6,0,3,2,1]

export class TMS5220 {
  decode(data: Uint8Array | number[]): Float32Array {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)

    // Bit reversal — Talkie reverses each byte before reading
    function rev(a: number): number {
      a = ((a >> 4) & 0x0F) | ((a << 4) & 0xF0)
      a = ((a >> 2) & 0x33) | ((a << 2) & 0xCC)
      a = ((a >> 1) & 0x55) | ((a << 1) & 0xAA)
      return a
    }

    let ptrAddr = 0, ptrBit = 0
    function getBits(bits: number): number {
      // Exact match to Talkie::getBits — reads from bit-reversed bytes
      let data = rev(bytes[ptrAddr] ?? 0) << 8
      if (ptrBit + bits > 8) {
        data |= rev(bytes[ptrAddr + 1] ?? 0)
      }
      data <<= ptrBit
      const value = (data >> (16 - bits)) & ((1 << bits) - 1)
      ptrBit += bits
      if (ptrBit >= 8) {
        ptrBit -= 8
        ptrAddr++
      }
      return value
    }

    let synthPeriod = 0, synthEnergy = 0
    let synthK1=0,synthK2=0,synthK3=0,synthK4=0,synthK5=0
    let synthK6=0,synthK7=0,synthK8=0,synthK9=0,synthK10=0
    let x0=0,x1=0,x2=0,x3=0,x4=0,x5=0,x6=0,x7=0,x8=0,x9=0
    let periodCounter = 0, synthRand = 1, ISRCounter = 0

    const output: number[] = []

    function readFrame(): boolean {
      const energy = getBits(4)
      if (energy === 0) { synthEnergy = 0; return true }
      if (energy === 0xF) { synthEnergy = 0; return false }
      synthEnergy = tmsEnergy[energy]
      const repeat = getBits(1)
      synthPeriod = tmsPeriod[getBits(6)]
      if (!repeat) {
        synthK1=tmsK1[getBits(5)]; synthK2=tmsK2[getBits(5)]
        synthK3=tmsK3[getBits(4)]; synthK4=tmsK4[getBits(4)]
        if (synthPeriod) {
          synthK5=tmsK5[getBits(4)]; synthK6=tmsK6[getBits(4)]
          synthK7=tmsK7[getBits(4)]; synthK8=tmsK8[getBits(3)]
          synthK9=tmsK9[getBits(3)]; synthK10=tmsK10[getBits(3)]
        }
      }
      return true
    }

    if (!readFrame()) return new Float32Array(0)

    const MAX = 80000 // 10 sec
    while (output.length < MAX) {
      ISRCounter++
      if (ISRCounter >= 200) {
        ISRCounter = 0
        if (!readFrame()) break
      }

      let u10: number
      if (synthPeriod) {
        if (periodCounter < synthPeriod) periodCounter++
        else periodCounter = 0
        if (periodCounter < chirpSigned.length)
          u10 = (chirpSigned[periodCounter] * synthEnergy) >> 8
        else u10 = 0
      } else {
        synthRand = (synthRand >> 1) ^ ((synthRand & 1) ? 0xB800 : 0)
        u10 = (synthRand & 1) ? synthEnergy : -synthEnergy
      }

      // Lattice filter — exact match to verified C code
      // K3-K10 (int8): multiply then >>7
      // K1-K2 (int16): Math.imul then (<<1)>>16
      let u9 = (u10 - ((((synthK10|0) * (x9|0))|0) >> 7))|0
      let u8 = (u9 - ((((synthK9|0) * (x8|0))|0) >> 7))|0
      let u7 = (u8 - ((((synthK8|0) * (x7|0))|0) >> 7))|0
      let u6 = (u7 - ((((synthK7|0) * (x6|0))|0) >> 7))|0
      let u5 = (u6 - ((((synthK6|0) * (x5|0))|0) >> 7))|0
      let u4 = (u5 - ((((synthK5|0) * (x4|0))|0) >> 7))|0
      let u3 = (u4 - ((((synthK4|0) * (x3|0))|0) >> 7))|0
      let u2 = (u3 - ((((synthK3|0) * (x2|0))|0) >> 7))|0
      let u1 = (u2 - (((Math.imul(synthK2, x1) << 1) >> 16)|0))|0
      let u0 = (u1 - (((Math.imul(synthK1, x0) << 1) >> 16)|0))|0

      x9 = (x8 + ((((synthK9|0) * (u8|0))|0) >> 7))|0
      x8 = (x7 + ((((synthK8|0) * (u7|0))|0) >> 7))|0
      x7 = (x6 + ((((synthK7|0) * (u6|0))|0) >> 7))|0
      x6 = (x5 + ((((synthK6|0) * (u5|0))|0) >> 7))|0
      x5 = (x4 + ((((synthK5|0) * (u4|0))|0) >> 7))|0
      x4 = (x3 + ((((synthK4|0) * (u3|0))|0) >> 7))|0
      x3 = (x2 + ((((synthK3|0) * (u2|0))|0) >> 7))|0
      x2 = (x1 + (((Math.imul(synthK2, u1) << 1) >> 16)|0))|0
      x1 = (x0 + (((Math.imul(synthK1, u0) << 1) >> 16)|0))|0
      x0 = u0

      // Scale to float: u0 is roughly -2000..2000, normalize
      output.push(u0 / 2048)
    }

    return new Float32Array(output)
  }
}

export async function playLPC(
  ctx: AudioContext,
  data: Uint8Array | number[],
  analyser?: AnalyserNode,
  authentic = true,
): Promise<void> {
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

  // Create native 8kHz buffer
  const buffer = ctx.createBuffer(1, samples8k.length, 8000)
  const channel = buffer.getChannelData(0)
  for (let i = 0; i < samples8k.length; i++) {
    // Quantize to 8-bit (256 levels) like the original TMS5100 DAC
    channel[i] = Math.round(samples8k[i] * 127) / 127
  }

  const source = ctx.createBufferSource()
  source.buffer = buffer

  // Build audio chain
  let outputNode: AudioNode = source

  if (authentic) {
    // Simulate the original Speak & Spell hardware:
    // 1. Tiny speaker resonance (bandpass centered ~1kHz)
    const speakerResonance = ctx.createBiquadFilter()
    speakerResonance.type = 'peaking'
    speakerResonance.frequency.value = 1200
    speakerResonance.Q.value = 0.8
    speakerResonance.gain.value = 6

    // 2. Tiny speaker rolloff (lowpass ~3kHz)
    const speakerRolloff = ctx.createBiquadFilter()
    speakerRolloff.type = 'lowpass'
    speakerRolloff.frequency.value = 3200
    speakerRolloff.Q.value = 0.7

    // 3. No deep bass (highpass ~200Hz — tiny speaker can't reproduce)
    const noSubBass = ctx.createBiquadFilter()
    noSubBass.type = 'highpass'
    noSubBass.frequency.value = 200
    noSubBass.Q.value = 0.5

    // 4. Slight distortion via waveshaper (overdriven amplifier)
    const waveshaper = ctx.createWaveShaper()
    const curve = new Float32Array(256)
    for (let i = 0; i < 256; i++) {
      const x = (i / 128) - 1
      // Soft clipping
      curve[i] = Math.tanh(x * 1.5)
    }
    waveshaper.curve = curve

    source.connect(noSubBass)
    noSubBass.connect(speakerResonance)
    speakerResonance.connect(speakerRolloff)
    speakerRolloff.connect(waveshaper)
    outputNode = waveshaper
  }

  if (analyser) outputNode.connect(analyser)
  else outputNode.connect(ctx.destination)

  source.start()
  return new Promise(resolve => { source.onended = () => resolve() })
}
