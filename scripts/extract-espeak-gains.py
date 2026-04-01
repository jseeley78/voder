"""
Extract band gains from eSpeak's actual audio output.

For each phoneme, generate a carrier word with eSpeak, then measure the
energy in each of our 10 bandpass filters during the steady-state portion.

Unlike the mathematical derivation, this captures the ACTUAL spectral shape
that a working formant synthesizer produces — including realistic formant
widths, spectral tilt, and inter-band energy distribution.
"""
import numpy as np
import wave, struct, subprocess, os
from scipy.signal import butter, sosfilt

BAND_CENTERS = [112, 338, 575, 850, 1200, 1700, 2350, 3250, 4600, 6450]
BAND_WIDTHS  = [225, 225, 250, 300,  400,  600,  700, 1100, 1600, 2100]

OUTPUT_DIR = '/tmp/voder-espeak-extract'
os.makedirs(OUTPUT_DIR, exist_ok=True)

# For vowels, use words where the vowel is dominant
# Use multiple carrier words and average the results
VOWEL_WORDS = {
    'IY': ['beat', 'see', 'bee'],
    'IH': ['bit', 'sit', 'lid'],
    'EH': ['bet', 'set', 'red'],
    'AE': ['bat', 'sat', 'had'],
    'AA': ['bot', 'cot', 'hot'],
    'AO': ['bought', 'caught', 'law'],
    'AH': ['but', 'cut', 'hut'],
    'UH': ['book', 'put', 'good'],
    'UW': ['boot', 'two', 'who'],
    'ER': ['bird', 'her', 'fur'],
    # Diphthongs — measure the whole glide
    'OW': ['boat', 'go', 'no'],
    'AY': ['buy', 'my', 'fly'],
    'EY': ['say', 'day', 'may'],
    'AW': ['how', 'cow', 'now'],
    'OY': ['boy', 'toy', 'joy'],
}

# For consonants, analyze the consonant portion specifically
# Use VCV (vowel-consonant-vowel) context for best isolation
CONSONANT_WORDS = {
    'S':  ['sis', 'sassy'],
    'SH': ['shush', 'shash'],
    'F':  ['fife', 'safe'],
    'TH': ['thatch', 'teeth'],
    'Z':  ['zoos', 'fizz'],
    'V':  ['verve', 'vivid'],
    'HH': ['haha', 'hay'],
    'DH': ['these', 'the'],
    'ZH': ['beige'],
    'M':  ['mom', 'ham'],
    'N':  ['nun', 'ten'],
    'NG': ['sing', 'ring'],
    'L':  ['lull', 'bell'],
    'R':  ['roar', 'rear'],
    'W':  ['woe', 'wow'],
    'Y':  ['yay', 'yes'],
}


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
    low = max(center - bw/2, 20) / (sr/2)
    high = min(center + bw/2, sr/2 - 10) / (sr/2)
    if low >= high or high >= 1.0:
        return np.zeros_like(samples)
    sos = butter(order, [low, high], btype='band', output='sos')
    return sosfilt(sos, samples)


def measure_bands(samples, sr):
    """Measure 10-band energy of the middle 50% of active audio."""
    frame_len = int(sr * 0.020)
    rms_frames = [np.sqrt(np.mean(samples[i:i+frame_len]**2))
                  for i in range(0, len(samples) - frame_len, frame_len)]

    if not rms_frames or max(rms_frames) < 0.001:
        return np.zeros(10)

    threshold = max(rms_frames) * 0.25
    active = [i for i, r in enumerate(rms_frames) if r > threshold]
    if not active:
        return np.zeros(10)

    # Middle 50%
    q1 = active[len(active) // 4]
    q3 = active[3 * len(active) // 4]
    start = q1 * frame_len
    end = min((q3 + 1) * frame_len, len(samples))
    segment = samples[start:end]

    if len(segment) < frame_len:
        segment = samples

    energies = np.zeros(10)
    for i, (center, bw) in enumerate(zip(BAND_CENTERS, BAND_WIDTHS)):
        filtered = bandpass(segment, sr, center, bw)
        energies[i] = np.sqrt(np.mean(filtered**2))

    return energies


def extract_gains(words, phoneme):
    """Generate eSpeak audio for each word, measure bands, and average."""
    all_energies = []

    for word in words:
        wav_path = f'{OUTPUT_DIR}/{phoneme}_{word}.wav'
        subprocess.run(['espeak', '-v', 'en-us', '-s', '120', '-w', wav_path, word],
                      capture_output=True, timeout=10)

        if not os.path.exists(wav_path):
            continue

        samples, sr = read_wav(wav_path)
        energies = measure_bands(samples, sr)

        if np.max(energies) > 0:
            # Normalize to peak = 1.0
            energies = energies / np.max(energies)
            all_energies.append(energies)

    if not all_energies:
        return np.zeros(10)

    # Average across all carrier words
    avg = np.mean(all_energies, axis=0)
    # Re-normalize
    avg = avg / (np.max(avg) + 1e-12)

    return avg


def main():
    print("=" * 80)
    print("BAND GAINS EXTRACTED FROM ESPEAK AUDIO")
    print("=" * 80)
    print()

    results = {}

    # Vowels
    print("── Vowels ──")
    for ph in ['IY', 'IH', 'EH', 'AE', 'AA', 'AO', 'AH', 'UH', 'UW', 'ER',
               'OW', 'AY', 'EY', 'AW', 'OY']:
        words = VOWEL_WORDS[ph]
        gains = extract_gains(words, ph)
        results[ph] = gains
        g_str = ', '.join(f'{g:.2f}' for g in gains)
        print(f"  {ph:<4} ({', '.join(words):<25}) [{g_str}]")

    # Consonants
    print("\n── Consonants ──")
    for ph in ['S', 'SH', 'F', 'TH', 'Z', 'V', 'HH', 'DH', 'ZH',
               'M', 'N', 'NG', 'L', 'R', 'W', 'Y']:
        words = CONSONANT_WORDS[ph]
        gains = extract_gains(words, ph)
        results[ph] = gains
        g_str = ', '.join(f'{g:.2f}' for g in gains)
        print(f"  {ph:<4} ({', '.join(words):<25}) [{g_str}]")

    # Print phonemes.ts format
    print("\n\n" + "=" * 80)
    print("PHONEMES.TS VOWEL GAINS (from eSpeak audio analysis)")
    print("=" * 80)
    for ph in ['IY', 'IH', 'EH', 'AE', 'AA', 'AO', 'AH', 'UH', 'UW', 'ER']:
        g = results[ph]
        print(f"  {ph}: bands: [{', '.join(f'{v:.2f}' for v in g)}]")

    print("\n── Diphthongs (whole-word average) ──")
    for ph in ['OW', 'AY', 'EY', 'AW', 'OY']:
        g = results[ph]
        print(f"  {ph}: bands: [{', '.join(f'{v:.2f}' for v in g)}]")

    print("\n── Consonants ──")
    for ph in ['S', 'SH', 'F', 'TH', 'Z', 'V', 'HH', 'DH', 'ZH',
               'M', 'N', 'NG', 'L', 'R', 'W', 'Y']:
        g = results[ph]
        print(f"  {ph}: bands: [{', '.join(f'{v:.2f}' for v in g)}]")


if __name__ == '__main__':
    main()
