/**
 * Filter bank and phoneme definitions based on the Bell Labs Voder
 * (US Patent 2,121,142, Homer Dudley 1939).
 *
 * Band centers and bandwidths derived from the patent's 10-channel
 * filter bank specification. Bands are quasi-logarithmically spaced,
 * approximating the ear's critical bands.
 *
 * Phoneme band gains are tuned to actual formant frequencies:
 *   Band 0: 112 Hz (0-225)      — fundamental / voicing
 *   Band 1: 338 Hz (225-450)    — low F1 (IY, IH, UW)
 *   Band 2: 575 Hz (450-700)    — mid F1 (EH, AO, AH, ER)
 *   Band 3: 850 Hz (700-1000)   — high F1 (AA, AE)
 *   Band 4: 1200 Hz (1000-1400) — low F2 (back vowels)
 *   Band 5: 1700 Hz (1400-2000) — mid F2 (mid vowels)
 *   Band 6: 2350 Hz (2000-2700) — high F2 (front vowels), low F3
 *   Band 7: 3250 Hz (2700-3800) — F3
 *   Band 8: 4600 Hz (3800-5400) — F4 / sibilance
 *   Band 9: 6450 Hz (5400-7500) — high sibilance
 */

export interface TransientConfig {
  durationMs: number
  noise: number
  bands: number[]
}

export type PhonemeType = 'vowel' | 'fricative' | 'nasal' | 'liquid' | 'glide' | 'stop'

export interface PhonemeConfig {
  type: PhonemeType
  voiced: boolean
  noise: number
  /** Voiced source amplitude (0-1). Open vowels are loudest, nasals quieter. */
  voicedAmp: number
  bands: number[]
  durationMs: number
  transient?: TransientConfig
  /** For diphthongs: formant target at the start of the glide */
  onsetBands?: number[]
  /** For diphthongs: formant target at the end of the glide */
  offsetBands?: number[]
}

// Patent-accurate band edges:
// 0-225, 225-450, 450-700, 700-1000, 1000-1400,
// 1400-2000, 2000-2700, 2700-3800, 3800-5400, 5400-7500
export const BAND_CENTERS = [112, 338, 575, 850, 1200, 1700, 2350, 3250, 4600, 6450] as const
export const BAND_WIDTHS  = [225, 225, 250, 300,  400,  600,  700, 1100, 1600, 2100] as const

// Q = center / bandwidth
export const BAND_Q = BAND_CENTERS.map((c, i) => c / BAND_WIDTHS[i])

// Band energy compensation: wider bands pass more energy for the same gain.
// Normalize so that equal gain values produce equal perceived loudness.
// We scale inversely with sqrt(bandwidth) — sqrt because power scales with
// bandwidth but perceived loudness scales roughly with amplitude.
// Normalized so the narrowest band (225 Hz) = 1.0.
const minBW = Math.min(...BAND_WIDTHS)
export const BAND_COMPENSATION = BAND_WIDTHS.map(bw => Math.sqrt(minBW / bw))

//                                         B0    B1    B2    B3    B4    B5    B6    B7    B8    B9
//                                        112   338   575   850  1200  1700  2350  3250  4600  6450

export const PHONEMES: Record<string, PhonemeConfig> = {
  // ─── Vowels ───
  // voicedAmp: open vowels (1.0) > mid (0.9) > close (0.8)
  // Compensated gains: eSpeak_output / Voder_output × Hillenbrand gains.
  // Accounts for our source spectrum so the output matches what ASR expects.

  // IY "beat": F1≈270 F2≈2290 F3≈3010
  IY: { type: 'vowel', voiced: true, voicedAmp: 0.80, noise: 0.01, durationMs: 175,
        bands: [0.15, 0.36, 0.02, 0.00, 0.00, 0.01, 0.35, 1.00, 0.33, 0.20] },

  // IH "bit": F1≈390 F2≈1990 F3≈2550
  IH: { type: 'vowel', voiced: true, voicedAmp: 0.85, noise: 0.01, durationMs: 120,
        bands: [0.14, 1.00, 0.98, 0.01, 0.00, 0.11, 0.25, 0.32, 0.28, 0.23] },

  // EH "bet": F1≈530 F2≈1840 F3≈2480
  EH: { type: 'vowel', voiced: true, voicedAmp: 0.90, noise: 0.02, durationMs: 170,
        bands: [0.17, 0.51, 1.00, 0.35, 0.01, 0.48, 0.30, 0.29, 0.56, 0.09] },

  // AE "bat": F1≈660 F2≈1720 F3≈2410
  AE: { type: 'vowel', voiced: true, voicedAmp: 1.00, noise: 0.02, durationMs: 185,
        bands: [0.28, 0.57, 1.00, 0.70, 0.09, 0.96, 0.60, 0.42, 0.51, 0.26] },

  // AA "bot/father": F1≈730 F2≈1090 F3≈2440
  AA: { type: 'vowel', voiced: true, voicedAmp: 1.00, noise: 0.02, durationMs: 185,
        bands: [0.22, 0.47, 0.88, 0.58, 0.40, 0.28, 0.10, 0.26, 0.32, 0.15] },

  // AO "bought": F1≈570 F2≈840 F3≈2410
  AO: { type: 'vowel', voiced: true, voicedAmp: 1.00, noise: 0.02, durationMs: 185,
        bands: [0.20, 0.60, 1.00, 0.65, 0.40, 0.09, 0.06, 0.15, 0.20, 0.15] },

  // AH "but": F1≈640 F2≈1190 F3≈2390
  AH: { type: 'vowel', voiced: true, voicedAmp: 1.00, noise: 0.02, durationMs: 170,
        bands: [0.15, 0.36, 1.00, 0.47, 0.20, 0.12, 0.05, 0.10, 0.12, 0.48] },

  // UH "book": F1≈440 F2≈1020 F3≈2240
  UH: { type: 'vowel', voiced: true, voicedAmp: 0.85, noise: 0.01, durationMs: 160,
        bands: [0.20, 0.85, 0.55, 0.10, 0.15, 0.08, 0.08, 0.08, 0.30, 0.20] },

  // UW "boot": F1≈300 F2≈870 F3≈2240
  UW: { type: 'vowel', voiced: true, voicedAmp: 0.80, noise: 0.01, durationMs: 200,
        bands: [0.26, 1.00, 0.12, 0.01, 0.15, 0.05, 0.10, 0.11, 0.55, 0.34] },

  // OW "boat": AO → UH glide
  OW: { type: 'vowel', voiced: true, voicedAmp: 0.90, noise: 0.01, durationMs: 195,
        bands:       [0.19, 0.86, 1.00, 0.29, 0.21, 0.00, 0.04, 0.04, 0.23, 0.25],
        onsetBands:  [0.20, 0.60, 1.00, 0.65, 0.40, 0.09, 0.06, 0.15, 0.20, 0.15],
        offsetBands: [0.20, 0.85, 0.55, 0.10, 0.15, 0.08, 0.08, 0.08, 0.30, 0.20] },

  // ER "bird": F1≈490 F2≈1350 F3≈1690
  ER: { type: 'vowel', voiced: true, voicedAmp: 0.85, noise: 0.02, durationMs: 175,
        bands: [0.16, 1.00, 0.92, 0.02, 0.21, 0.30, 0.08, 0.05, 0.32, 0.73] },

  // ─── Diphthongs ───
  // Onset/offset use compensated gains for component vowels.

  // AW "how/out": AA → UH
  AW: { type: 'vowel', voiced: true, voicedAmp: 0.95, noise: 0.01, durationMs: 210,
        bands:       [0.21, 0.66, 0.72, 0.34, 0.28, 0.18, 0.09, 0.17, 0.31, 0.18],
        onsetBands:  [0.22, 0.47, 0.88, 0.58, 0.40, 0.28, 0.10, 0.26, 0.32, 0.15],
        offsetBands: [0.20, 0.85, 0.55, 0.10, 0.15, 0.08, 0.08, 0.08, 0.30, 0.20] },

  // AY "my/time": AA → IH
  AY: { type: 'vowel', voiced: true, voicedAmp: 0.95, noise: 0.01, durationMs: 210,
        bands:       [0.18, 0.74, 0.93, 0.30, 0.20, 0.20, 0.18, 0.29, 0.30, 0.19],
        onsetBands:  [0.22, 0.47, 0.88, 0.58, 0.40, 0.28, 0.10, 0.26, 0.32, 0.15],
        offsetBands: [0.14, 1.00, 0.98, 0.01, 0.00, 0.11, 0.25, 0.32, 0.28, 0.23] },

  // EY "say/day": EH → IY
  EY: { type: 'vowel', voiced: true, voicedAmp: 0.90, noise: 0.01, durationMs: 200,
        bands:       [0.23, 0.97, 0.90, 0.01, 0.00, 0.19, 0.75, 1.00, 0.93, 0.30],
        onsetBands:  [0.17, 0.51, 1.00, 0.35, 0.01, 0.48, 0.30, 0.29, 0.56, 0.09],
        offsetBands: [0.15, 0.36, 0.02, 0.00, 0.00, 0.01, 0.35, 1.00, 0.33, 0.20] },

  // OY "boy/toy": AO → IY
  OY: { type: 'vowel', voiced: true, voicedAmp: 0.95, noise: 0.01, durationMs: 210,
        bands:       [0.18, 0.48, 0.51, 0.33, 0.20, 0.05, 0.21, 0.58, 0.27, 0.18],
        onsetBands:  [0.20, 0.60, 1.00, 0.65, 0.40, 0.09, 0.06, 0.15, 0.20, 0.15],
        offsetBands: [0.15, 0.36, 0.02, 0.00, 0.00, 0.01, 0.35, 1.00, 0.33, 0.20] },

  // ─── Fricatives / aspirates ───
  // These need strong noise and distinctive spectral shapes

  // voicedAmp: unvoiced = 0, voiced fricatives = 0.50

  HH: { type: 'fricative', voiced: false, voicedAmp: 0, noise: 0.80, durationMs: 95,
        bands: [0.02, 0.05, 0.10, 0.15, 0.25, 0.30, 0.25, 0.20, 0.12, 0.05] },
  F:  { type: 'fricative', voiced: false, voicedAmp: 0, noise: 0.90, durationMs: 135,
        bands: [0, 0, 0.02, 0.05, 0.10, 0.30, 0.50, 0.70, 0.50, 0.20] },
  S:  { type: 'fricative', voiced: false, voicedAmp: 0, noise: 1.00, durationMs: 155,
        bands: [0, 0.08, 0, 0.02, 0.05, 0.15, 0.40, 0.80, 1.00, 0.85] },
  SH: { type: 'fricative', voiced: false, voicedAmp: 0, noise: 1.00, durationMs: 140,
        bands: [0, 0, 0.03, 0.08, 0.20, 0.50, 0.90, 0.70, 0.35, 0.15] },
  TH: { type: 'fricative', voiced: false, voicedAmp: 0, noise: 0.70, durationMs: 80,
        bands: [0, 0.02, 0.04, 0.08, 0.15, 0.30, 0.40, 0.35, 0.20, 0.10] },
  V:  { type: 'fricative', voiced: true, voicedAmp: 0.62, noise: 0.48, durationMs: 130,
        bands: [0.22, 0.18, 0.23, 0.08, 0.12, 0.32, 0.55, 0.75, 0.55, 0.22] },
  Z:  { type: 'fricative', voiced: true, voicedAmp: 0.50, noise: 0.55, durationMs: 105,
        bands: [0.20, 0.10, 0.03, 0.03, 0.05, 0.15, 0.40, 0.80, 1.00, 0.85] },
  ZH: { type: 'fricative', voiced: true, voicedAmp: 0.50, noise: 0.55, durationMs: 120,
        bands: [0.20, 0.10, 0.05, 0.08, 0.20, 0.50, 0.90, 0.70, 0.35, 0.15] },
  DH: { type: 'fricative', voiced: true, voicedAmp: 0.55, noise: 0.35, durationMs: 90,
        bands: [0.25, 0.20, 0.08, 0.08, 0.15, 0.30, 0.40, 0.35, 0.20, 0.10] },

  // ─── Nasals ───
  // Strong low-frequency voicing, anti-resonance dip in mid-range

  // voicedAmp: 0.55 — sound exits through nose, lower energy
  // Nasals: each has a distinct anti-resonance location that separates them
  M:  { type: 'nasal', voiced: true, voicedAmp: 0.60, noise: 0.01, durationMs: 125,
        bands: [0.55, 0.75, 0.12, 0.04, 0.02, 0.02, 0.02, 0.02, 0, 0] },
  N:  { type: 'nasal', voiced: true, voicedAmp: 0.70, noise: 0.01, durationMs: 130,
        bands: [0.45, 0.62, 0.45, 0.18, 0.05, 0.03, 0.06, 0.04, 0, 0] },
  NG: { type: 'nasal', voiced: true, voicedAmp: 0.60, noise: 0.01, durationMs: 125,
        bands: [0.35, 0.40, 0.48, 0.28, 0.10, 0.04, 0.02, 0.02, 0, 0] },

  // ─── Liquids / glides ───
  // voicedAmp: liquids 0.65, glides 0.70
  L:  { type: 'liquid', voiced: true, voicedAmp: 0.72, noise: 0.01, durationMs: 115,
        bands: [0.30, 0.60, 0.30, 0.15, 0.55, 0.15, 0.10, 0.40, 0.03, 0] },
  R:  { type: 'liquid', voiced: true, voicedAmp: 0.72, noise: 0.01, durationMs: 115,
        bands: [0.25, 0.55, 0.40, 0.15, 0.50, 0.50, 0.10, 0.15, 0.03, 0] },
  // W: A/B tested — proposed was better (concentrate B2-B3, zero upper bands)
  W:  { type: 'glide', voiced: true, voicedAmp: 0.70, noise: 0.01, durationMs: 115,
        bands: [0.30, 0.76, 0.56, 0.15, 0.00, 0.00, 0.03, 0.02, 0, 0] },
  Y:  { type: 'glide', voiced: true, voicedAmp: 0.70, noise: 0.01, durationMs: 90,
        bands: [0.25, 0.60, 0.15, 0.08, 0.10, 0.20, 0.80, 0.40, 0.20, 0] },

  // ─── Stops ───
  // Burst then brief voiced/silent steady state
  // Burst spectral shape varies by place of articulation:
  //   bilabial (P/B): diffuse low-frequency burst
  //   alveolar (T/D): burst energy at 3000-4000 Hz
  //   velar (K/G): burst energy at 1500-3000 Hz (varies with vowel context)

  // Voiced stops: low-frequency murmur during closure (voice bar)
  B:  { type: 'stop', voiced: true, voicedAmp: 0.45, noise: 0.02, durationMs: 65,
        bands: [0.30, 0.35, 0.18, 0.08, 0.04, 0.02, 0.01, 0, 0, 0],
        transient: { durationMs: 12, noise: 0.80,
                     bands: [0.20, 0.40, 0.35, 0.25, 0.15, 0.08, 0.03, 0.01, 0, 0] } },

  // D: voiced alveolar — same high-frequency burst locus as T but with voicing
  D:  { type: 'stop', voiced: true, voicedAmp: 0.45, noise: 0.03, durationMs: 50,
        bands: [0.25, 0.28, 0.15, 0.08, 0.06, 0.04, 0.02, 0.02, 0, 0],
        transient: { durationMs: 14, noise: 0.90,
                     bands: [0.02, 0.04, 0.08, 0.12, 0.20, 0.28, 0.35, 0.60, 0.70, 0.15] } },

  G:  { type: 'stop', voiced: true, voicedAmp: 0.45, noise: 0.02, durationMs: 60,
        bands: [0.25, 0.28, 0.20, 0.10, 0.05, 0.03, 0.02, 0.01, 0, 0],
        transient: { durationMs: 14, noise: 0.85,
                     bands: [0.03, 0.05, 0.12, 0.20, 0.40, 0.50, 0.25, 0.08, 0.02, 0] } },

  P:  { type: 'stop', voiced: false, voicedAmp: 0, noise: 0.05, durationMs: 50,
        bands: [0.05, 0.08, 0.05, 0.03, 0.02, 0.01, 0, 0, 0, 0],
        transient: { durationMs: 15, noise: 1.00,
                     bands: [0.20, 0.40, 0.35, 0.25, 0.15, 0.08, 0.03, 0.01, 0, 0] } },

  // T: strongest burst of all stops — sharp alveolar spike at 4000-5000 Hz
  T:  { type: 'stop', voiced: false, voicedAmp: 0, noise: 0.08, durationMs: 40,
        bands: [0.03, 0.05, 0.04, 0.03, 0.03, 0.02, 0.01, 0.02, 0, 0],
        transient: { durationMs: 18, noise: 1.00,
                     bands: [0.02, 0.03, 0.06, 0.10, 0.18, 0.25, 0.35, 0.65, 0.80, 0.20] } },

  K:  { type: 'stop', voiced: false, voicedAmp: 0, noise: 0.06, durationMs: 50,
        bands: [0.03, 0.05, 0.04, 0.03, 0.02, 0.01, 0, 0, 0, 0],
        transient: { durationMs: 22, noise: 1.00,
                     bands: [0.04, 0.06, 0.15, 0.25, 0.50, 0.65, 0.30, 0.10, 0.03, 0] } },

  CH: { type: 'stop', voiced: false, voicedAmp: 0, noise: 0.70, durationMs: 70,
        bands: [0, 0, 0.03, 0.08, 0.20, 0.50, 0.90, 0.70, 0.35, 0.15],
        transient: { durationMs: 18, noise: 1.00,
                     bands: [0.02, 0.05, 0.12, 0.20, 0.35, 0.50, 0.40, 0.20, 0.05, 0.01] } },

  JH: { type: 'stop', voiced: true, voicedAmp: 0.45, noise: 0.50, durationMs: 65,
        bands: [0.15, 0.10, 0.05, 0.08, 0.20, 0.50, 0.85, 0.65, 0.30, 0.12],
        transient: { durationMs: 16, noise: 0.90,
                     bands: [0.02, 0.05, 0.12, 0.20, 0.35, 0.50, 0.40, 0.20, 0.05, 0.01] } },
}
