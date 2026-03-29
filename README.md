# Voder

Browser-based speech synthesizer inspired by the [1939 Bell Labs Voder](https://en.wikipedia.org/wiki/Voder) — the first electronic device to generate continuous human speech.

Type English text and hear it spoken through a 10-band filter bank with patent-accurate frequencies, buzz + noise excitation, and prosodic expression. The goal is not modern natural-sounding TTS — it's a mechanical, buzzy, historically-flavored voice.

## Try it

```bash
nvm use 20
npm install
npm run dev
```

Type a sentence and click Speak, or press Enter. Audio starts automatically on first interaction. Works offline as a PWA.

## How it works

The pipeline mirrors the original Voder's architecture, but driven programmatically instead of by a human operator:

```
English text
  → CMU Pronouncing Dictionary (134K words → ARPAbet phonemes with stress)
  → Prosody engine (phrase arcs, stress, declination, question rise)
  → Coarticulating sequencer (blended transitions, consonant cluster compression)
  → Humanize pass (timing drift, pitch drift, band wobble)
  → Voder engine (glottal pulse + noise → 10-band filter bank → audio)
```

### Engine

The synth engine models the Voder's physical controls:

- **Buzz source** — AudioWorklet glottal pulse train modeling the original relaxation oscillator's asymmetric charge/discharge cycle (~0.3ms charge, ~0.8ms discharge). Pulse width is fixed so the spectrum naturally brightens at lower pitches, matching real oscillator behavior. Includes cycle-to-cycle jitter for organic instability. Falls back to a custom PeriodicWave in browsers without AudioWorklet support.
- **Vibrato** — Sine LFO (default 5.2 Hz, 2.5 Hz depth) for the periodic pitch wobble that prevents sustained vowels from sounding like a foghorn. Separate from the random jitter.
- **Noise source** — Gaussian pink noise modeling the original gas-filled triode's ionic fluctuations. Box-Muller transform for normal distribution (smoother than uniform random), Paul Kellet 1/f filter for pink spectral tilt (warmer than white noise). Routed through the shared filter bank (not a separate path).
- **10-band filter bank** — Parallel bandpass filters with center frequencies and bandwidths from [US Patent 2,121,142](https://patents.google.com/patent/US2121142A/en) (Homer Dudley, 1939). Quasi-logarithmic spacing from 0–7500 Hz. Band energy compensation normalizes perceived loudness across bands of different widths.
- **3 stop keys** — Transient burst generators with distinct spectral shapes per place of articulation: bilabial (P/B, diffuse low-frequency), alveolar (T/D, energy at 3–4 kHz), velar (K/G, energy at 1.5–3 kHz). Aspiration noise after voiceless stops before vowels.
- **Spectral tilt** — Lowpass filter at 3400 Hz models the natural rolloff of the original gas triode circuit.

### Phoneme table

All 39 ARPAbet phonemes (complete CMU dictionary coverage):

- Band gains mapped to actual formant frequencies (Peterson & Barney 1952)
- Per-phoneme voiced amplitude hierarchy: open vowels (1.0) > mid vowels (0.9) > close vowels (0.8) > glides (0.7) > liquids (0.72) > nasals (0.6) > voiced fricatives (0.5) > voiced stops (0.45) > unvoiced (0)
- Diphthongs (AW, AY, EY, OY, OW) with onset→offset formant glide targets
- Phoneme-specific durations (stops 40–60ms, vowels 120–180ms, fricatives 80–120ms)
- Phoneme type classification (vowel, fricative, nasal, liquid, glide, stop) drives coarticulation timing

### Prosody

Three-level prosodic model:

- **Syllable** — CMU stress markers (0/1/2) control pitch (+14%/+8%/−8%), duration (+35%/+18%/−18%), and amplitude per vowel
- **Phrase** — Sentences split at punctuation into independent phrases, each with its own pitch arc (high onset → gradual fall). Nuclear accent on the last stressed vowel per phrase. Pre-boundary lengthening over the final 20%.
- **Sentence** — Topline declination across successive phrases (each starts lower). Question rise over the last 30%. Exclamation boost. Punctuation pauses (comma 150ms, period 220ms).

### Coarticulation

Per-phoneme-type timing profiles split each sound into onset/steady/offset phases:

| Type | Onset | Steady | Offset | Character |
|------|-------|--------|--------|-----------|
| Vowel | 20% | 50% | 30% | Clear target with smooth transitions |
| Fricative | 15% | 60% | 25% | Sustained noise |
| Nasal | 25% | 45% | 30% | Smooth resonance |
| Liquid | 30% | 35% | 35% | Formant transitions carry identity |
| Glide | 40% | 20% | 40% | Almost all movement |
| Stop | 5% | 25% | 70% | Fast attack, long release |

Consonant clusters (str, nk, spl) get compressed timing with more aggressive blending. Aspiration only fires before vowels/glides, not within clusters.

### Humanize

Models the imprecision of a live Voder operator performing each utterance uniquely:

- Timing drift: ±8% duration per phoneme
- Pitch drift: random walk with mean reversion across the utterance
- Band wobble: ±6% gain per band (imprecise finger pressure)
- Pause jitter: ±15% variation at punctuation
- Controllable via slider (0 = deterministic, 1 = loose)

### Text-to-phoneme

- CMU Pronouncing Dictionary (134K words) with custom overrides
- Number-to-words conversion (integers up to billions, decimals, negatives)
- Possessive handling ('s)
- Letter-by-letter spelling fallback for unknown words
- Punctuation pass-through for prosody

### Diagnostic

Built-in spectral diagnostic (`src/diagnostic.ts`) validates the synthesis pipeline:

```bash
npx tsx -e "import { runDiagnostic } from './src/diagnostic.ts'; runDiagnostic();"
```

Checks:
- Formant placement accuracy for all vowels against Peterson & Barney targets
- Vowel pair similarity (Euclidean distance in 10-D compensated gain space)
- Per-word transition analysis across 110+ words (top 100 English words + numbers 1–10 + phonetically complex words)
- Per-sentence analysis across 6 test sentences including the Rainbow Passage
- Effective output levels accounting for voicedAmp, gain scaling, and band compensation

## Visualization

The UI mirrors the physical controls a Voder operator used:

- **10 spectrum keys** — Animated band gain sliders (the operator's 10 finger keys)
- **Wrist bar** — Voiced/unvoiced indicator (buzz=green, hiss=amber, both=gradient)
- **Foot pedal** — Pitch shown relative to base in Hz and cents (like the real operator's preset range)
- **3 stop keys** — Flash red on transient bursts (bilabial P/B, alveolar T/D, velar K/G)
- **Scope** — Overlaid real-time waveform (blue) and frequency spectrum (orange) with band center markers

## Tech stack

- [Vite](https://vite.dev/) + TypeScript
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API) + AudioWorklet
- [cmu-pronouncing-dictionary](https://www.npmjs.com/package/cmu-pronouncing-dictionary) (134K words)
- [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) for offline support

## Historical accuracy

Filter bank frequencies and bandwidths are derived from Homer Dudley's 1939 patent (US 2,121,142). The original Voder used:

- 10 bandpass filters (0–7500 Hz, quasi-logarithmic spacing approximating critical bands)
- Relaxation oscillator buzz source (gas triode, ~0.3ms charge / ~0.8ms discharge)
- Ionic noise generator (gas-filled tube, full-spectrum)
- 3 stop-consonant keys (condenser discharge transients)
- 10 pressure-sensitive finger keys for band gain control
- Foot pedal for pitch (logarithmic response, operator-preset base + range)
- Wrist bar for voiced/unvoiced switching

Operators trained for approximately one year. Only 20–30 people ever learned to play it. Helen Harper was the primary demonstrator at the 1939 World's Fair.

## License

MIT
