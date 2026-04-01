"""
Extract 10-band filter gains from REAL HUMAN SPEECH.

Uses the Hillenbrand et al. (1995) vowel dataset: ~1,668 recordings of
12 vowels in /hVd/ context by 139 speakers (men, women, children).

Measures energy in each of our 10 Voder bandpass filters during the
steady-state vowel portion. Averages across all speakers to get
canonical band gains grounded in real acoustic data.

Audio: 16kHz 16-bit mono WAV
"""
import numpy as np
import wave, os, glob, json
from scipy.signal import butter, sosfilt

BAND_CENTERS = [112, 338, 575, 850, 1200, 1700, 2350, 3250, 4600, 6450]
BAND_WIDTHS  = [225, 225, 250, 300,  400,  600,  700, 1100, 1600, 2100]

# Hillenbrand vowel codes → ARPAbet
# Note: 'ei' = EY, 'oa' = OW, 'oo' = UH (hood)
CODE_TO_ARPABET = {
    'ae': 'AE',  # had
    'ah': 'AA',  # hod (Hillenbrand 'ah' = open back, our AA)
    'aw': 'AO',  # hawed
    'eh': 'EH',  # head
    'er': 'ER',  # heard
    'ei': 'EY',  # hayed
    'ih': 'IH',  # hid
    'iy': 'IY',  # heed
    'oa': 'OW',  # hoed
    'oo': 'UH',  # hood
    'uh': 'AH',  # hud (Hillenbrand 'uh' = strut vowel, our AH)
    'uw': 'UW',  # who'd
}

DATA_DIRS = [
    '/tmp/hillenbrand_et_al_1995/men',
    '/tmp/hillenbrand_et_al_1995/women',
]


def read_wav(path):
    with wave.open(path, 'rb') as wf:
        sr = wf.getframerate()
        n = wf.getnframes()
        raw = wf.readframes(n)
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return samples, sr


def bandpass(samples, sr, center, bw, order=4):
    nyq = sr / 2
    low = max(center - bw/2, 20) / nyq
    high = min(center + bw/2, nyq - 10) / nyq
    if low >= high or high >= 1.0:
        return np.zeros_like(samples)
    sos = butter(order, [low, high], btype='band', output='sos')
    return sosfilt(sos, samples)


def measure_vowel_bands(samples, sr):
    """
    Extract band energies from the steady-state vowel portion.
    The /hVd/ context means:
    - First ~15-20% is /h/ aspiration
    - Middle 50-70% is the vowel
    - Last ~15-20% is /d/ closure
    We take the middle 40% to avoid transitions.
    """
    frame_len = int(sr * 0.020)  # 20ms frames
    rms_frames = [np.sqrt(np.mean(samples[i:i+frame_len]**2))
                  for i in range(0, len(samples) - frame_len, frame_len)]

    if not rms_frames or max(rms_frames) < 0.001:
        return None

    # Find active region
    threshold = max(rms_frames) * 0.25
    active = [i for i, r in enumerate(rms_frames) if r > threshold]
    if len(active) < 4:
        return None

    # Take middle 40% of active region (pure vowel)
    n_active = len(active)
    start_idx = active[int(n_active * 0.30)]
    end_idx = active[int(n_active * 0.70)]
    start = start_idx * frame_len
    end = min((end_idx + 1) * frame_len, len(samples))
    segment = samples[start:end]

    if len(segment) < frame_len * 2:
        return None

    # Measure energy in each band
    energies = np.zeros(10)
    for i, (center, bw) in enumerate(zip(BAND_CENTERS, BAND_WIDTHS)):
        # Skip bands above Nyquist
        if center + bw/2 > sr/2:
            energies[i] = 0
            continue
        filtered = bandpass(segment, sr, center, bw)
        energies[i] = np.sqrt(np.mean(filtered**2))

    return energies


def main():
    print("=" * 80)
    print("BAND GAINS FROM REAL HUMAN SPEECH (Hillenbrand 1995)")
    print("=" * 80)
    print(f"Audio: 16kHz, /hVd/ carrier words, middle 40% = steady-state vowel")
    print(f"Note: Bands 8-9 (4600, 6450 Hz) near/above 8kHz Nyquist at 16kHz SR")
    print()

    # Collect all measurements per vowel
    vowel_data: dict[str, list[np.ndarray]] = {v: [] for v in CODE_TO_ARPABET.values()}

    total_files = 0
    for data_dir in DATA_DIRS:
        if not os.path.exists(data_dir):
            print(f"  Skipping {data_dir} (not found)")
            continue

        for wav_file in sorted(glob.glob(os.path.join(data_dir, '*.wav'))):
            basename = os.path.basename(wav_file)
            # Extract vowel code from filename (last 2 chars before .wav)
            code = basename[3:5]  # e.g., m01ae.wav → 'ae'
            if code not in CODE_TO_ARPABET:
                continue

            arpabet = CODE_TO_ARPABET[code]
            samples, sr = read_wav(wav_file)
            energies = measure_vowel_bands(samples, sr)

            if energies is not None:
                vowel_data[arpabet].append(energies)
                total_files += 1

    print(f"Analyzed {total_files} recordings from {len(DATA_DIRS)} speaker groups\n")

    # Compute average and normalize
    results = {}
    print(f"{'Vowel':<6} {'N':>4}  {'B0':>5} {'B1':>5} {'B2':>5} {'B3':>5} {'B4':>5} {'B5':>5} {'B6':>5} {'B7':>5} {'B8':>5} {'B9':>5}")
    print("-" * 72)

    for vowel in ['IY', 'IH', 'EH', 'AE', 'AA', 'AO', 'AH', 'UH', 'UW', 'ER', 'EY', 'OW']:
        measurements = vowel_data[vowel]
        if not measurements:
            print(f"  {vowel:<4} — no data")
            continue

        # Average across speakers
        avg = np.mean(measurements, axis=0)

        # Normalize peak = 1.0
        peak = np.max(avg)
        if peak > 0:
            normalized = avg / peak
        else:
            normalized = avg

        results[vowel] = [round(float(g), 2) for g in normalized]
        n = len(measurements)
        g_str = ' '.join(f'{g:5.2f}' for g in normalized)
        print(f"  {vowel:<4} {n:>4}  {g_str}")

    # Print phonemes.ts format
    print("\n\n" + "=" * 80)
    print("PHONEMES.TS FORMAT — from real human speech")
    print("=" * 80)
    for vowel in ['IY', 'IH', 'EH', 'AE', 'AA', 'AO', 'AH', 'UH', 'UW', 'ER']:
        if vowel in results:
            g = results[vowel]
            print(f"  // {vowel} — Hillenbrand (1995), averaged across {len(vowel_data[vowel])} speakers")
            print(f"  bands: [{', '.join(f'{v:.2f}' for v in g)}]")

    print("\n── Diphthongs/glides (whole-word average) ──")
    for vowel in ['EY', 'OW']:
        if vowel in results:
            g = results[vowel]
            print(f"  // {vowel} — Hillenbrand (1995), {len(vowel_data[vowel])} speakers")
            print(f"  bands: [{', '.join(f'{v:.2f}' for v in g)}]")

    # Save JSON
    output_path = '/tmp/voder-analysis/human-gains.json'
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'w') as f:
        json.dump(results, f, indent=2)
    print(f"\nSaved to {output_path}")

    # Also print comparison: human vs current eSpeak-derived
    print("\n\n" + "=" * 80)
    print("NOTE: Bands 8 (4600Hz) and 9 (6450Hz) are at/above Nyquist for 16kHz audio.")
    print("These bands will show 0.00 — use eSpeak or mathematical values for B8/B9.")
    print("=" * 80)


if __name__ == '__main__':
    main()
