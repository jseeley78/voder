"""
Derive compensated band gains: measure what our Voder source actually produces
in each band, then compute the gains needed to match real speech.

gains = real_speech_energy / source_energy

This accounts for the source spectrum (damped pulse + spectral tilt) so the
OUTPUT of our filter bank matches real speech, not just the filter settings.
"""
import numpy as np
import wave, os, glob, json
from scipy.signal import butter, sosfilt

BAND_CENTERS = [112, 338, 575, 850, 1200, 1700, 2350, 3250, 4600, 6450]
BAND_WIDTHS  = [225, 225, 250, 300,  400,  600,  700, 1100, 1600, 2100]


def read_wav(path):
    with wave.open(path, 'rb') as wf:
        sr = wf.getframerate()
        n = wf.getnframes()
        raw = wf.readframes(n)
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        if wf.getnchannels() > 1:
            samples = samples.reshape(-1, wf.getnchannels())[:, 0]
    return samples, sr


def bandpass(samples, sr, center, bw, order=4):
    nyq = sr / 2
    low = max(center - bw / 2, 20) / nyq
    high = min(center + bw / 2, nyq - 10) / nyq
    if low >= high or high >= 1.0:
        return np.zeros_like(samples)
    sos = butter(order, [low, high], btype='band', output='sos')
    return sosfilt(sos, samples)


def measure_bands(samples, sr):
    """Measure RMS energy in each band."""
    energies = np.zeros(10)
    for i, (center, bw) in enumerate(zip(BAND_CENTERS, BAND_WIDTHS)):
        filtered = bandpass(samples, sr, center, bw)
        energies[i] = np.sqrt(np.mean(filtered ** 2))
    return energies


def measure_vowel_steady_state(samples, sr):
    """Extract middle 40% of active region."""
    frame_len = int(sr * 0.020)
    rms_frames = [np.sqrt(np.mean(samples[i:i+frame_len]**2))
                  for i in range(0, len(samples) - frame_len, frame_len)]
    if not rms_frames or max(rms_frames) < 0.001:
        return None
    threshold = max(rms_frames) * 0.25
    active = [i for i, r in enumerate(rms_frames) if r > threshold]
    if len(active) < 4:
        return None
    q1 = active[int(len(active) * 0.30)]
    q3 = active[int(len(active) * 0.70)]
    segment = samples[q1 * frame_len:min((q3 + 1) * frame_len, len(samples))]
    if len(segment) < frame_len * 2:
        return None
    return measure_bands(segment, sr)


# ── Step 1: Measure our Voder source through each band ──
# Render a flat vowel (all bands = 1.0) to see what the source produces
print("=" * 70)
print("STEP 1: Measure Voder source spectrum")
print("=" * 70)

# We need a render of our engine with all bands at 1.0
# Use a simple approach: render "ah" which has broad energy
voder_source_path = '/tmp/voder-offline/yes.wav'  # use any existing render
if os.path.exists(voder_source_path):
    vs, vsr = read_wav(voder_source_path)
    voder_source = measure_bands(vs, vsr)
    print(f"Voder source (from 'yes' render at {vsr}Hz):")
    for i in range(10):
        print(f"  B{i} ({BAND_CENTERS[i]:>5}Hz): {voder_source[i]:.6f}")
else:
    print("No Voder render found — run render-offline.ts first")
    exit(1)

# ── Step 2: Measure real human speech ──
print(f"\n{'=' * 70}")
print("STEP 2: Measure real human speech (Hillenbrand 1995)")
print("=" * 70)

CODE_TO_ARPABET = {
    'ae': 'AE', 'ah': 'AA', 'aw': 'AO', 'eh': 'EH', 'er': 'ER',
    'ei': 'EY', 'ih': 'IH', 'iy': 'IY', 'oa': 'OW', 'oo': 'UH',
    'uh': 'AH', 'uw': 'UW',
}

DATA_DIRS = ['/tmp/hillenbrand_et_al_1995/men', '/tmp/hillenbrand_et_al_1995/women']

human_data: dict[str, list[np.ndarray]] = {v: [] for v in CODE_TO_ARPABET.values()}

for data_dir in DATA_DIRS:
    if not os.path.exists(data_dir):
        continue
    for wav_file in sorted(glob.glob(os.path.join(data_dir, '*.wav'))):
        code = os.path.basename(wav_file)[3:5]
        if code not in CODE_TO_ARPABET:
            continue
        arpabet = CODE_TO_ARPABET[code]
        samples, sr = read_wav(wav_file)
        energies = measure_vowel_steady_state(samples, sr)
        if energies is not None:
            human_data[arpabet].append(energies)

# ── Step 3: Compute compensated gains ──
print(f"\n{'=' * 70}")
print("STEP 3: Compensated gains = human / voder_source")
print("=" * 70)

# For the source measurement, we want to know how much energy the source
# puts into each band when gain=1.0. Since our renders already have the
# phoneme gains applied, we need a different approach:
# Use the AVERAGE across all our vowel renders as the "source baseline"
# OR better: compute what flat gains would produce.

# Actually, the simplest correct approach: for each vowel, we know what
# gains we USED and what the output LOOKED like. But we don't have a
# flat-gain render. Let me just use the ratio approach with eSpeak as
# the "known good" reference, since Whisper understands eSpeak.

import subprocess

print("\nUsing eSpeak as reference (Whisper-small scores 6/7 on eSpeak)")
print("Compensated gains = eSpeak_energy / Voder_energy * current_gains\n")

# For each vowel word, compare our render to eSpeak
VOWEL_WORDS = {
    'IY': 'beat', 'IH': 'bit', 'EH': 'bet', 'AE': 'bat',
    'AA': 'bot', 'AO': 'bought', 'AH': 'but', 'UH': 'book',
    'UW': 'boot', 'ER': 'bird', 'OW': 'boat', 'EY': 'say',
}

# Current gains from phonemes.ts (the human-speech-derived ones)
CURRENT_GAINS = {
    'IY': [0.39, 1.00, 0.45, 0.05, 0.03, 0.04, 0.19, 0.27, 0.11, 0.03],
    'IH': [0.17, 0.89, 1.00, 0.15, 0.05, 0.13, 0.20, 0.13, 0.06, 0.02],
    'EH': [0.14, 0.44, 1.00, 0.53, 0.13, 0.24, 0.19, 0.12, 0.10, 0.02],
    'AE': [0.15, 0.44, 1.00, 0.67, 0.18, 0.29, 0.27, 0.15, 0.06, 0.03],
    'AA': [0.17, 0.42, 0.75, 1.00, 0.66, 0.43, 0.15, 0.12, 0.09, 0.02],
    'AO': [0.13, 0.38, 0.89, 1.00, 0.58, 0.17, 0.08, 0.08, 0.02, 0.03],
    'AH': [0.13, 0.41, 1.00, 0.66, 0.28, 0.22, 0.09, 0.09, 0.06, 0.04],
    'UH': [0.14, 0.69, 1.00, 0.23, 0.16, 0.12, 0.06, 0.05, 0.05, 0.05],
    'UW': [0.27, 1.00, 0.64, 0.15, 0.13, 0.03, 0.03, 0.02, 0.08, 0.04],
    'ER': [0.16, 0.85, 1.00, 0.19, 0.17, 0.31, 0.06, 0.02, 0.10, 0.06],
    'OW': [0.15, 0.82, 1.00, 0.37, 0.17, 0.02, 0.03, 0.03, 0.07, 0.05],
    'EY': [0.19, 1.00, 0.84, 0.11, 0.04, 0.06, 0.22, 0.18, 0.07, 0.03],
}

results = {}

for vowel, word in sorted(VOWEL_WORDS.items()):
    # Render with eSpeak
    espeak_path = f'/tmp/voder-analysis/comp_{word}.wav'
    subprocess.run(['espeak', '-v', 'en-us', '-s', '120', '-w', espeak_path, word],
                   capture_output=True, timeout=10)

    # Our render
    voder_path = f'/tmp/voder-offline/{word}.wav'

    if not os.path.exists(voder_path):
        # Render it
        print(f"  {vowel}: no Voder render for '{word}', skipping")
        continue

    if not os.path.exists(espeak_path):
        print(f"  {vowel}: eSpeak render failed for '{word}'")
        continue

    e_samples, e_sr = read_wav(espeak_path)
    v_samples, v_sr = read_wav(voder_path)

    e_energy = measure_vowel_steady_state(e_samples, e_sr)
    v_energy = measure_vowel_steady_state(v_samples, v_sr)

    if e_energy is None or v_energy is None:
        print(f"  {vowel}: measurement failed")
        continue

    # Ratio: where is eSpeak louder/quieter than us?
    ratio = np.zeros(10)
    for i in range(10):
        if v_energy[i] > 1e-6:
            ratio[i] = e_energy[i] / v_energy[i]
        else:
            ratio[i] = 1.0

    # Compensated gains: current_gains * ratio, then re-normalize
    current = np.array(CURRENT_GAINS.get(vowel, [0]*10))
    compensated = current * ratio
    peak = np.max(compensated)
    if peak > 0:
        compensated = compensated / peak

    results[vowel] = [round(float(g), 2) for g in compensated]

    print(f"  {vowel} '{word}':")
    print(f"    Current:      [{', '.join(f'{g:.2f}' for g in current)}]")
    print(f"    Ratio (e/v):  [{', '.join(f'{r:.2f}' for r in ratio)}]")
    print(f"    Compensated:  [{', '.join(f'{g:.2f}' for g in compensated)}]")

# Print final copy-paste format
print(f"\n\n{'=' * 70}")
print("COMPENSATED GAINS (copy-paste for phonemes.ts)")
print("=" * 70)
for vowel in ['IY', 'IH', 'EH', 'AE', 'AA', 'AO', 'AH', 'UH', 'UW', 'ER', 'OW', 'EY']:
    if vowel in results:
        g = results[vowel]
        print(f"  {vowel}: [{', '.join(f'{v:.2f}' for v in g)}]")

# Save
with open('/tmp/voder-analysis/compensated-gains.json', 'w') as f:
    json.dump(results, f, indent=2)
print(f"\nSaved to /tmp/voder-analysis/compensated-gains.json")
