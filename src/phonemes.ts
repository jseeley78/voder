/**
 * Filter bank and phoneme definitions based on the Bell Labs Voder
 * (US Patent 2,121,142, Homer Dudley 1939).
 *
 * Band centers and bandwidths derived from the patent's 10-channel
 * filter bank specification. Bands are quasi-logarithmically spaced,
 * approximating the ear's critical bands.
 */

export interface TransientConfig {
  durationMs: number
  noise: number
  bands: number[]
}

export interface PhonemeConfig {
  voiced: boolean
  noise: number
  bands: number[]
  durationMs?: number
  transient?: TransientConfig
}

// Patent-accurate band edges:
// 0-225, 225-450, 450-700, 700-1000, 1000-1400,
// 1400-2000, 2000-2700, 2700-3800, 3800-5400, 5400-7500
export const BAND_CENTERS = [112, 338, 575, 850, 1200, 1700, 2350, 3250, 4600, 6450] as const
export const BAND_WIDTHS  = [225, 225, 250, 300,  400,  600,  700, 1100, 1600, 2100] as const

// Q = center / bandwidth
export const BAND_Q = BAND_CENTERS.map((c, i) => c / BAND_WIDTHS[i])

export const PHONEMES: Record<string, PhonemeConfig> = {
  // --- Vowels ---
  AA: { voiced: true,  noise: 0.02, bands: [0.06, 0.18, 0.40, 0.62, 0.30, 0.12, 0.05, 0.01, 0, 0] },
  AE: { voiced: true,  noise: 0.02, bands: [0.05, 0.14, 0.34, 0.56, 0.34, 0.15, 0.05, 0.01, 0, 0] },
  AH: { voiced: true,  noise: 0.02, bands: [0.10, 0.24, 0.38, 0.32, 0.18, 0.08, 0.03, 0.01, 0, 0] },
  AO: { voiced: true,  noise: 0.02, bands: [0.16, 0.28, 0.26, 0.16, 0.08, 0.03, 0.01, 0, 0, 0] },
  EH: { voiced: true,  noise: 0.02, bands: [0.04, 0.12, 0.26, 0.45, 0.36, 0.14, 0.04, 0.01, 0, 0] },
  ER: { voiced: true,  noise: 0.02, bands: [0.06, 0.14, 0.22, 0.22, 0.18, 0.10, 0.05, 0.02, 0, 0] },
  IH: { voiced: true,  noise: 0.01, bands: [0.03, 0.08, 0.16, 0.24, 0.28, 0.22, 0.10, 0.03, 0.01, 0] },
  IY: { voiced: true,  noise: 0.01, bands: [0.02, 0.05, 0.10, 0.18, 0.30, 0.52, 0.36, 0.12, 0.03, 0] },
  OW: { voiced: true,  noise: 0.01, bands: [0.18, 0.28, 0.22, 0.12, 0.06, 0.03, 0.01, 0, 0, 0] },
  UH: { voiced: true,  noise: 0.01, bands: [0.12, 0.20, 0.18, 0.12, 0.08, 0.04, 0.01, 0, 0, 0] },
  UW: { voiced: true,  noise: 0.01, bands: [0.20, 0.32, 0.18, 0.08, 0.04, 0.02, 0.01, 0, 0, 0] },

  // --- Fricatives / aspirates ---
  HH: { voiced: false, noise: 0.60, bands: [0.01, 0.02, 0.04, 0.06, 0.10, 0.12, 0.10, 0.08, 0.05, 0.02] },
  F:  { voiced: false, noise: 0.85, bands: [0, 0, 0.01, 0.03, 0.08, 0.18, 0.30, 0.38, 0.24, 0.08] },
  S:  { voiced: false, noise: 1.00, bands: [0, 0, 0.01, 0.03, 0.08, 0.18, 0.35, 0.60, 0.75, 0.65] },
  SH: { voiced: false, noise: 1.00, bands: [0, 0, 0.02, 0.06, 0.14, 0.30, 0.52, 0.48, 0.24, 0.10] },
  TH: { voiced: false, noise: 0.80, bands: [0, 0.01, 0.02, 0.05, 0.12, 0.22, 0.28, 0.22, 0.10, 0.03] },
  V:  { voiced: true,  noise: 0.35, bands: [0, 0, 0.01, 0.03, 0.08, 0.18, 0.30, 0.38, 0.24, 0.08] },
  Z:  { voiced: true,  noise: 0.50, bands: [0, 0, 0.01, 0.03, 0.08, 0.18, 0.35, 0.60, 0.75, 0.65] },
  ZH: { voiced: true,  noise: 0.55, bands: [0, 0, 0.02, 0.06, 0.14, 0.30, 0.52, 0.48, 0.24, 0.10] },

  // --- Nasals / liquids / glides ---
  M:  { voiced: true,  noise: 0.02, bands: [0.30, 0.24, 0.08, 0.03, 0.01, 0, 0, 0, 0, 0] },
  N:  { voiced: true,  noise: 0.02, bands: [0.18, 0.20, 0.12, 0.05, 0.02, 0.01, 0, 0, 0, 0] },
  NG: { voiced: true,  noise: 0.02, bands: [0.10, 0.16, 0.18, 0.10, 0.03, 0.01, 0, 0, 0, 0] },
  L:  { voiced: true,  noise: 0.01, bands: [0.10, 0.20, 0.22, 0.18, 0.16, 0.10, 0.04, 0.01, 0, 0] },
  R:  { voiced: true,  noise: 0.01, bands: [0.08, 0.14, 0.20, 0.22, 0.15, 0.10, 0.05, 0.02, 0, 0] },
  W:  { voiced: true,  noise: 0.01, bands: [0.24, 0.25, 0.14, 0.06, 0.03, 0.01, 0, 0, 0, 0] },
  Y:  { voiced: true,  noise: 0.01, bands: [0.03, 0.06, 0.10, 0.18, 0.26, 0.40, 0.28, 0.10, 0.02, 0] },

  // --- Stops with transient bursts ---
  // Timing inspired by patent specs (e.g. K: 6ms burst, 40ms gap, 31ms noise)
  B:  { voiced: true,  noise: 0.04, bands: [0.10, 0.18, 0.22, 0.14, 0.08, 0.03, 0.01, 0, 0, 0],
        transient: { durationMs: 18, noise: 0.75, bands: [0.12, 0.18, 0.16, 0.08, 0.03, 0.01, 0, 0, 0, 0] } },
  D:  { voiced: true,  noise: 0.04, bands: [0.08, 0.14, 0.22, 0.20, 0.12, 0.06, 0.02, 0.01, 0, 0],
        transient: { durationMs: 16, noise: 0.78, bands: [0.02, 0.05, 0.12, 0.24, 0.28, 0.18, 0.06, 0.01, 0, 0] } },
  G:  { voiced: true,  noise: 0.04, bands: [0.10, 0.14, 0.20, 0.18, 0.10, 0.05, 0.02, 0, 0, 0],
        transient: { durationMs: 18, noise: 0.82, bands: [0.02, 0.06, 0.14, 0.22, 0.28, 0.18, 0.05, 0.01, 0, 0] } },
  P:  { voiced: false, noise: 0.01, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        transient: { durationMs: 18, noise: 0.95, bands: [0.12, 0.18, 0.16, 0.08, 0.03, 0.01, 0, 0, 0, 0] } },
  T:  { voiced: false, noise: 0.01, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        transient: { durationMs: 16, noise: 0.98, bands: [0.02, 0.05, 0.12, 0.24, 0.28, 0.18, 0.06, 0.01, 0, 0] } },
  K:  { voiced: false, noise: 0.01, bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        transient: { durationMs: 18, noise: 1.00, bands: [0.02, 0.06, 0.14, 0.22, 0.28, 0.18, 0.05, 0.01, 0, 0] } },

  CH: { voiced: false, noise: 0.65, bands: [0, 0, 0.02, 0.06, 0.14, 0.30, 0.52, 0.48, 0.24, 0.10],
        transient: { durationMs: 22, noise: 1.00, bands: [0.02, 0.06, 0.14, 0.22, 0.28, 0.18, 0.05, 0.01, 0, 0] } },
  JH: { voiced: true,  noise: 0.45, bands: [0, 0, 0.02, 0.06, 0.14, 0.30, 0.52, 0.48, 0.24, 0.10],
        transient: { durationMs: 20, noise: 0.90, bands: [0.02, 0.06, 0.14, 0.22, 0.28, 0.18, 0.05, 0.01, 0, 0] } },
}
