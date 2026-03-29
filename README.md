# Voder

Browser-based speech synthesizer inspired by the [1939 Bell Labs Voder](https://en.wikipedia.org/wiki/Voder) — the first electronic device to generate continuous human speech.

Type English text and hear it spoken through a 10-band filter bank with patent-accurate frequencies, buzz + noise excitation, and prosodic expression. The goal is not modern natural-sounding TTS — it's a mechanical, buzzy, historically-flavored voice.

## Try it

```bash
nvm use 20
npm install
npm run dev
```

Type a sentence and click Speak. The audio starts automatically on first interaction.

## How it works

The pipeline mirrors the original Voder's architecture, but driven programmatically instead of by a human operator:

```
English text
  → CMU Pronouncing Dictionary (134K words → ARPAbet phonemes with stress)
  → Prosody engine (pitch contours, stress, timing, pauses)
  → Coarticulating sequencer (blended onset/steady/offset phases)
  → Voder engine (buzz + noise → 10-band filter bank → audio)
```

### Engine

The synth engine models the Voder's physical controls:

- **Buzz source** — Custom PeriodicWave approximating the original relaxation oscillator (gas triode with asymmetric charge/discharge pulse). Includes vibrato LFO and random pitch jitter.
- **Noise source** — Full-spectrum white noise for unvoiced sounds (fricatives, stop bursts, aspiration).
- **10-band filter bank** — Parallel bandpass filters with center frequencies and bandwidths from [US Patent 2,121,142](https://patents.google.com/patent/US2121142A/en) (Homer Dudley, 1939). Quasi-logarithmic spacing from 0–7500 Hz with band energy compensation.
- **3 stop keys** — Transient burst generators for bilabial (P/B), alveolar (T/D), and velar (K/G) stops, with aspiration noise after voiceless stops before vowels.

### Phoneme table

All 39 ARPAbet phonemes with:
- Band gains mapped to actual formant frequencies (Peterson & Barney 1952)
- Per-phoneme voiced amplitude (open vowels loudest, nasals quieter, stops near-silent)
- Diphthongs (AW, AY, EY, OY, OW) with onset→offset formant glide targets
- Phoneme-specific durations (stops ~60ms, vowels ~150ms, fricatives ~100ms)

### Prosody

Three-level prosodic model:
- **Syllable** — CMU stress markers (0/1/2) control pitch, duration, and amplitude per vowel
- **Phrase** — Each clause gets its own pitch arc (high onset, gradual fall), nuclear accent on the last stressed vowel, pre-boundary lengthening
- **Sentence** — Topline declination across phrases, question rise, exclamation boost, punctuation pauses

### Coarticulation

Per-phoneme-type timing profiles control how sounds blend:
- Vowels: 20% onset / 50% steady / 30% offset
- Glides: 45% onset / 10% steady / 45% offset (almost all transition)
- Stops: 5% onset / 25% steady / 70% offset (long release into next vowel)
- Consonant clusters (str, nk, spl): compressed timing with aggressive blending

## Visualization

The UI shows what a Voder operator would see/feel:
- **10 spectrum keys** — Animated band gain sliders (the operator's 10 finger keys)
- **Wrist bar** — Voiced/unvoiced indicator (buzz vs. hiss)
- **Foot pedal** — Pitch relative to base, shown in Hz and cents
- **3 stop keys** — Flash on transient bursts
- **Scope** — Overlaid waveform (blue) and frequency spectrum (orange) with band center markers

## Tech stack

- [Vite](https://vite.dev/) + TypeScript
- [Web Audio API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API)
- [cmu-pronouncing-dictionary](https://www.npmjs.com/package/cmu-pronouncing-dictionary)
- [vite-plugin-pwa](https://vite-pwa-org.netlify.app/) for offline support

## Historical accuracy

Filter bank frequencies and bandwidths are derived from Homer Dudley's 1939 patent. The original Voder used:
- 10 bandpass filters (0–7500 Hz, quasi-logarithmic spacing)
- Relaxation oscillator buzz source (gas triode)
- Ionic noise generator (gas-filled tube)
- 3 stop-consonant keys (condenser discharge transients)
- Pressure-sensitive finger keys for band gain control
- Foot pedal for pitch (logarithmic response)
- Wrist bar for voiced/unvoiced switching

Operators trained for approximately one year. Only 20–30 people ever learned to play it.

## License

MIT
