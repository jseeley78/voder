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
  // Gains derived from standard male formant frequencies (Peterson & Barney 1952)

  // IY "beat": F1≈270 F2≈2290 F3≈3010
  IY: { type: 'vowel', voiced: true, voicedAmp: 0.80, noise: 0.01, durationMs: 140,
        bands: [0.25, 0.80, 0.15, 0.08, 0.10, 0.15, 0.90, 0.60, 0.08, 0] },

  // IH "bit": F1≈390 F2≈1990 F3≈2550
  IH: { type: 'vowel', voiced: true, voicedAmp: 0.80, noise: 0.01, durationMs: 120,
        bands: [0.25, 0.70, 0.25, 0.10, 0.12, 0.30, 0.80, 0.50, 0.06, 0] },

  // EH "bet": F1≈530 F2≈1840 F3≈2480
  EH: { type: 'vowel', voiced: true, voicedAmp: 0.90, noise: 0.02, durationMs: 130,
        bands: [0.25, 0.30, 0.85, 0.20, 0.15, 0.80, 0.50, 0.40, 0.05, 0] },

  // AE "bat": F1≈660 F2≈1720 F3≈2410
  AE: { type: 'vowel', voiced: true, voicedAmp: 1.00, noise: 0.02, durationMs: 150,
        bands: [0.25, 0.20, 0.60, 0.80, 0.20, 0.85, 0.45, 0.35, 0.05, 0] },

  // AA "bot/father": F1≈730 F2≈1090 F3≈2440
  AA: { type: 'vowel', voiced: true, voicedAmp: 1.00, noise: 0.02, durationMs: 150,
        bands: [0.25, 0.20, 0.35, 0.90, 0.70, 0.20, 0.45, 0.35, 0.04, 0] },

  // AO "bought": F1≈570 F2≈840 F3≈2410
  AO: { type: 'vowel', voiced: true, voicedAmp: 1.00, noise: 0.02, durationMs: 150,
        bands: [0.30, 0.30, 0.75, 0.70, 0.30, 0.10, 0.40, 0.35, 0.04, 0] },

  // AH "but": F1≈640 F2≈1190 F3≈2390
  AH: { type: 'vowel', voiced: true, voicedAmp: 0.95, noise: 0.02, durationMs: 130,
        bands: [0.25, 0.25, 0.55, 0.70, 0.70, 0.25, 0.45, 0.35, 0.04, 0] },

  // UH "book": F1≈440 F2≈1020 F3≈2240
  UH: { type: 'vowel', voiced: true, voicedAmp: 0.80, noise: 0.01, durationMs: 120,
        bands: [0.30, 0.60, 0.40, 0.25, 0.60, 0.12, 0.40, 0.30, 0.03, 0] },

  // UW "boot": F1≈300 F2≈870 F3≈2240
  UW: { type: 'vowel', voiced: true, voicedAmp: 0.80, noise: 0.01, durationMs: 140,
        bands: [0.30, 0.80, 0.25, 0.60, 0.30, 0.08, 0.40, 0.30, 0.03, 0] },

  // OW "boat": AO-like → UH-like glide
  OW: { type: 'vowel', voiced: true, voicedAmp: 0.90, noise: 0.01, durationMs: 160,
        bands:       [0.30, 0.35, 0.75, 0.30, 0.65, 0.12, 0.40, 0.30, 0.03, 0],
        onsetBands:  [0.30, 0.30, 0.75, 0.70, 0.30, 0.10, 0.40, 0.35, 0.04, 0],
        offsetBands: [0.30, 0.60, 0.40, 0.25, 0.60, 0.12, 0.40, 0.30, 0.03, 0] },

  // ER "bird": F1≈490 F2≈1350 F3≈1690
  ER: { type: 'vowel', voiced: true, voicedAmp: 0.85, noise: 0.02, durationMs: 140,
        bands: [0.25, 0.40, 0.65, 0.25, 0.55, 0.55, 0.20, 0.20, 0.03, 0] },

  // ─── Diphthongs ───
  // Each has onsetBands (starting vowel) and offsetBands (ending vowel).
  // The bands field is the midpoint for compatibility; the sequencer
  // uses onset→offset for the actual glide.

  // AW "how/out": AA → UH
  AW: { type: 'vowel', voiced: true, voicedAmp: 0.95, noise: 0.01, durationMs: 180,
        bands:       [0.28, 0.25, 0.45, 0.80, 0.55, 0.15, 0.40, 0.30, 0.03, 0],
        onsetBands:  [0.25, 0.20, 0.35, 0.90, 0.70, 0.20, 0.45, 0.35, 0.04, 0],
        offsetBands: [0.30, 0.60, 0.40, 0.25, 0.60, 0.12, 0.40, 0.30, 0.03, 0] },

  // AY "my/time": AA → IH
  AY: { type: 'vowel', voiced: true, voicedAmp: 0.95, noise: 0.01, durationMs: 180,
        bands:       [0.25, 0.22, 0.40, 0.75, 0.45, 0.45, 0.55, 0.35, 0.04, 0],
        onsetBands:  [0.25, 0.20, 0.35, 0.90, 0.70, 0.20, 0.45, 0.35, 0.04, 0],
        offsetBands: [0.25, 0.70, 0.25, 0.10, 0.12, 0.30, 0.80, 0.50, 0.06, 0] },

  // EY "say/day": EH → IY
  EY: { type: 'vowel', voiced: true, voicedAmp: 0.90, noise: 0.01, durationMs: 170,
        bands:       [0.25, 0.30, 0.60, 0.30, 0.20, 0.65, 0.70, 0.45, 0.05, 0],
        onsetBands:  [0.25, 0.30, 0.85, 0.20, 0.15, 0.80, 0.50, 0.40, 0.05, 0],
        offsetBands: [0.25, 0.80, 0.15, 0.08, 0.10, 0.15, 0.90, 0.60, 0.08, 0] },

  // OY "boy/toy": AO → IY
  OY: { type: 'vowel', voiced: true, voicedAmp: 0.95, noise: 0.01, durationMs: 180,
        bands:       [0.28, 0.30, 0.65, 0.50, 0.25, 0.30, 0.60, 0.40, 0.04, 0],
        onsetBands:  [0.30, 0.30, 0.75, 0.70, 0.30, 0.10, 0.40, 0.35, 0.04, 0],
        offsetBands: [0.25, 0.80, 0.15, 0.08, 0.10, 0.15, 0.90, 0.60, 0.08, 0] },

  // ─── Fricatives / aspirates ───
  // These need strong noise and distinctive spectral shapes

  // voicedAmp: unvoiced = 0, voiced fricatives = 0.50

  HH: { type: 'fricative', voiced: false, voicedAmp: 0, noise: 0.80, durationMs: 80,
        bands: [0.02, 0.05, 0.10, 0.15, 0.25, 0.30, 0.25, 0.20, 0.12, 0.05] },
  F:  { type: 'fricative', voiced: false, voicedAmp: 0, noise: 0.90, durationMs: 100,
        bands: [0, 0, 0.02, 0.05, 0.10, 0.30, 0.50, 0.70, 0.50, 0.20] },
  S:  { type: 'fricative', voiced: false, voicedAmp: 0, noise: 1.00, durationMs: 110,
        bands: [0, 0, 0, 0.02, 0.05, 0.15, 0.40, 0.80, 1.00, 0.85] },
  SH: { type: 'fricative', voiced: false, voicedAmp: 0, noise: 1.00, durationMs: 120,
        bands: [0, 0, 0.03, 0.08, 0.20, 0.50, 0.90, 0.70, 0.35, 0.15] },
  TH: { type: 'fricative', voiced: false, voicedAmp: 0, noise: 0.70, durationMs: 90,
        bands: [0, 0.02, 0.04, 0.08, 0.15, 0.30, 0.40, 0.35, 0.20, 0.10] },
  V:  { type: 'fricative', voiced: true, voicedAmp: 0.50, noise: 0.40, durationMs: 90,
        bands: [0.20, 0.15, 0.05, 0.05, 0.10, 0.30, 0.50, 0.70, 0.50, 0.20] },
  Z:  { type: 'fricative', voiced: true, voicedAmp: 0.50, noise: 0.55, durationMs: 100,
        bands: [0.20, 0.10, 0.03, 0.03, 0.05, 0.15, 0.40, 0.80, 1.00, 0.85] },
  ZH: { type: 'fricative', voiced: true, voicedAmp: 0.50, noise: 0.55, durationMs: 100,
        bands: [0.20, 0.10, 0.05, 0.08, 0.20, 0.50, 0.90, 0.70, 0.35, 0.15] },
  DH: { type: 'fricative', voiced: true, voicedAmp: 0.55, noise: 0.35, durationMs: 70,
        bands: [0.25, 0.20, 0.08, 0.08, 0.15, 0.30, 0.40, 0.35, 0.20, 0.10] },

  // ─── Nasals ───
  // Strong low-frequency voicing, anti-resonance dip in mid-range

  // voicedAmp: 0.55 — sound exits through nose, lower energy
  M:  { type: 'nasal', voiced: true, voicedAmp: 0.55, noise: 0.01, durationMs: 100,
        bands: [0.50, 0.70, 0.15, 0.05, 0.03, 0.02, 0.02, 0.02, 0, 0] },
  N:  { type: 'nasal', voiced: true, voicedAmp: 0.55, noise: 0.01, durationMs: 90,
        bands: [0.40, 0.60, 0.30, 0.10, 0.04, 0.03, 0.05, 0.03, 0, 0] },
  NG: { type: 'nasal', voiced: true, voicedAmp: 0.55, noise: 0.01, durationMs: 100,
        bands: [0.35, 0.45, 0.40, 0.20, 0.08, 0.03, 0.02, 0.02, 0, 0] },

  // ─── Liquids / glides ───
  // voicedAmp: liquids 0.65, glides 0.70
  L:  { type: 'liquid', voiced: true, voicedAmp: 0.65, noise: 0.01, durationMs: 90,
        bands: [0.30, 0.60, 0.30, 0.15, 0.55, 0.15, 0.10, 0.40, 0.03, 0] },
  R:  { type: 'liquid', voiced: true, voicedAmp: 0.65, noise: 0.01, durationMs: 90,
        bands: [0.25, 0.55, 0.40, 0.15, 0.50, 0.50, 0.10, 0.15, 0.03, 0] },
  W:  { type: 'glide', voiced: true, voicedAmp: 0.70, noise: 0.01, durationMs: 80,
        bands: [0.30, 0.70, 0.50, 0.15, 0.08, 0.05, 0.03, 0.02, 0, 0] },
  Y:  { type: 'glide', voiced: true, voicedAmp: 0.70, noise: 0.01, durationMs: 70,
        bands: [0.25, 0.60, 0.15, 0.08, 0.10, 0.20, 0.80, 0.40, 0.05, 0] },

  // ─── Stops ───
  // Burst then brief voiced/silent steady state
  // Burst spectral shape varies by place of articulation:
  //   bilabial (P/B): diffuse low-frequency burst
  //   alveolar (T/D): burst energy at 3000-4000 Hz
  //   velar (K/G): burst energy at 1500-3000 Hz (varies with vowel context)

  // voicedAmp: voiced stops 0.40 (quiet voicing during closure), unvoiced 0
  B:  { type: 'stop', voiced: true, voicedAmp: 0.40, noise: 0.02, durationMs: 70,
        bands: [0.20, 0.30, 0.20, 0.10, 0.05, 0.02, 0.01, 0, 0, 0],
        transient: { durationMs: 12, noise: 0.80,
                     bands: [0.20, 0.40, 0.35, 0.25, 0.15, 0.08, 0.03, 0.01, 0, 0] } },

  D:  { type: 'stop', voiced: true, voicedAmp: 0.40, noise: 0.02, durationMs: 60,
        bands: [0.15, 0.20, 0.15, 0.10, 0.08, 0.05, 0.03, 0.02, 0, 0],
        transient: { durationMs: 10, noise: 0.85,
                     bands: [0.03, 0.05, 0.10, 0.15, 0.25, 0.30, 0.20, 0.50, 0.10, 0.02] } },

  G:  { type: 'stop', voiced: true, voicedAmp: 0.40, noise: 0.02, durationMs: 70,
        bands: [0.15, 0.20, 0.18, 0.12, 0.06, 0.04, 0.02, 0.01, 0, 0],
        transient: { durationMs: 14, noise: 0.85,
                     bands: [0.03, 0.05, 0.12, 0.20, 0.40, 0.50, 0.25, 0.08, 0.02, 0] } },

  P:  { type: 'stop', voiced: false, voicedAmp: 0, noise: 0.01, durationMs: 80,
        bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        transient: { durationMs: 15, noise: 1.00,
                     bands: [0.20, 0.40, 0.35, 0.25, 0.15, 0.08, 0.03, 0.01, 0, 0] } },

  T:  { type: 'stop', voiced: false, voicedAmp: 0, noise: 0.01, durationMs: 70,
        bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        transient: { durationMs: 12, noise: 1.00,
                     bands: [0.03, 0.05, 0.10, 0.15, 0.25, 0.30, 0.20, 0.55, 0.12, 0.03] } },

  K:  { type: 'stop', voiced: false, voicedAmp: 0, noise: 0.01, durationMs: 80,
        bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        transient: { durationMs: 16, noise: 1.00,
                     bands: [0.03, 0.05, 0.12, 0.20, 0.40, 0.55, 0.25, 0.08, 0.02, 0] } },

  CH: { type: 'stop', voiced: false, voicedAmp: 0, noise: 0.70, durationMs: 90,
        bands: [0, 0, 0.03, 0.08, 0.20, 0.50, 0.90, 0.70, 0.35, 0.15],
        transient: { durationMs: 18, noise: 1.00,
                     bands: [0.02, 0.05, 0.12, 0.20, 0.35, 0.50, 0.40, 0.20, 0.05, 0.01] } },

  JH: { type: 'stop', voiced: true, voicedAmp: 0.40, noise: 0.50, durationMs: 80,
        bands: [0.15, 0.10, 0.05, 0.08, 0.20, 0.50, 0.85, 0.65, 0.30, 0.12],
        transient: { durationMs: 16, noise: 0.90,
                     bands: [0.02, 0.05, 0.12, 0.20, 0.35, 0.50, 0.40, 0.20, 0.05, 0.01] } },
}
