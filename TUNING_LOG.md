# Whisper Tuning Log

## Winning Configuration
- Sawtooth oscillator (not AudioWorklet glottal pulse)
- Transition tau = sec/8 (snappy, like real operator finger movement)
- Filter Q = patent values × 2.0 (sharper formant definition)
- Voiced gain: 1.50
- Noise gain: 0.45
- Spectral tilt: 3400 Hz, Q=0.65
- Output EQ: low shelf -4dB@200Hz, presence +5dB@2800Hz, high shelf -3dB@7kHz

## Key Findings
1. Raw sawtooth is MORE accurate to original AND more intelligible than custom waveforms
2. Filter Q from patent was too low for digital filters — 2x is the sweet spot
3. Whisper hears our output as a "buzzer" — the formant shaping needs to be more dramatic
4. Volume isn't the issue — spectral SHAPE is
5. eSpeak gets 100% on same phrases — the gap is closeable
6. "she saw me" → "Please follow me" shows word boundaries ARE coming through

## Best Whisper Scores (tiny model)
- yes: -0.857 (recognized as "Yes." in one run!)
- one: -0.869
- no: -0.907
- hello how are you: -0.909
- she saw me: -0.923

## Experiments Run
| # | Change | Best Result | Keep? |
|---|--------|-------------|-------|
| 1 | tau/8 (from /5) | yes→"Yes." ✓ | YES |
| 2 | voiced gain 3x | hello -0.845 | partial |
| 3 | no output EQ | worse | NO |
| 4 | no spectral tilt | one -0.709 | mixed |
| 5 | PeriodicWave | worse | NO |
| 8 | PeriodicWave (forced) | worse | NO |
| 9 | Raw sawtooth | yes -0.978, all better | YES |
| 10 | sawtooth+tau/8 | yes→"Yes." ✓ | YES |
| 11 | sawtooth+noTilt | one -0.709 | mixed |
| 12 | tilt at 5500Hz | worse | NO |
| 13 | no tilt + no EQ | worse | NO |
| 14 | rate scale 0.6 | worse | NO |
| 15 | noise 2x | worse | NO |
| 16 | vowel duration +50% | worse | NO |
| 17 | band gains 3x | she→"Please follow me" | partial |
| 18 | Q*2 | she -0.886 (best!) | YES |
| 19 | Q*3 | slightly worse than Q*2 | NO |
