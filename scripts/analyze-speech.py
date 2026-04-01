"""
Analysis-resynthesis: extract 10-band filter gains from real speech.

Generates each phoneme using eSpeak, then measures the energy in each of
our 10 Voder bandpass filters. The resulting gains can be used directly
as phoneme definitions — no guessing, pure acoustic measurement.

Usage: python3 scripts/analyze-speech.py [output_json]
"""

import subprocess, struct, wave, json, sys, os, math
import numpy as np
from scipy.signal import butter, sosfilt

# Our exact Voder filter bank parameters (from phonemes.ts)
BANDS = [
    # (center_hz, bandwidth_hz)
    (112,  225),   # Band 0
    (338,  225),   # Band 1
    (575,  250),   # Band 2
    (850,  300),   # Band 3
    (1200, 400),   # Band 4
    (1700, 600),   # Band 5
    (2350, 700),   # Band 6
    (3250, 1100),  # Band 7
    (4600, 1600),  # Band 8
    (6450, 2100),  # Band 9
]

# ARPAbet phonemes and their IPA equivalents for eSpeak
# eSpeak uses its own phoneme notation, but we can use IPA via -v en
PHONEME_WORDS = {
    # Vowels — use a carrier word with the vowel in stressed position
    'IY': 'beat',
    'IH': 'bit',
    'EH': 'bet',
    'AE': 'bat',
    'AA': 'bot',
    'AO': 'bought',
    'AH': 'but',
    'UH': 'book',
    'UW': 'boot',
    'ER': 'bird',
    # Diphthongs
    'OW': 'boat',
    'AY': 'buy',
    'EY': 'say',
    'AW': 'how',
    'OY': 'boy',
    # Nasals
    'M':  'mom',
    'N':  'nun',
    'NG': 'sing',
    # Liquids
    'L':  'lull',
    'R':  'roar',
    # Glides
    'W':  'woe',
    'Y':  'yay',
    # Fricatives
    'F':  'fife',
    'V':  'verve',
    'S':  'sis',
    'Z':  'zoos',
    'SH': 'shush',
    'ZH': 'beige',
    'TH': 'thatch',
    'DH': 'these',
    'HH': 'haha',
    # Stops
    'P':  'pop',
    'B':  'bob',
    'T':  'tot',
    'D':  'dad',
    'K':  'kick',
    'G':  'gag',
    # Affricates
    'CH': 'church',
    'JH': 'judge',
}

OUTPUT_DIR = '/tmp/voder-analysis'
os.makedirs(OUTPUT_DIR, exist_ok=True)


def espeak_to_wav(text: str, path: str, rate: int = 120) -> bool:
    """Generate speech with eSpeak and save as WAV."""
    try:
        subprocess.run(
            ['espeak', '-v', 'en-us', '-s', str(rate), '-w', path, text],
            check=True, capture_output=True, timeout=10
        )
        return True
    except Exception as e:
        print(f"  eSpeak error for '{text}': {e}", file=sys.stderr)
        return False


def read_wav(path: str) -> tuple[np.ndarray, int]:
    """Read WAV file, return float32 samples and sample rate."""
    with wave.open(path, 'rb') as wf:
        sr = wf.getframerate()
        n = wf.getnframes()
        ch = wf.getnchannels()
        raw = wf.readframes(n)
        if wf.getsampwidth() == 2:
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        elif wf.getsampwidth() == 1:
            samples = np.frombuffer(raw, dtype=np.uint8).astype(np.float32) / 128.0 - 1.0
        else:
            raise ValueError(f"Unsupported sample width: {wf.getsampwidth()}")
        if ch > 1:
            samples = samples.reshape(-1, ch)[:, 0]
    return samples, sr


def bandpass_energy(samples: np.ndarray, sr: int, center: float, bw: float) -> float:
    """Compute RMS energy in a bandpass filter band."""
    low = max(center - bw / 2, 20) / (sr / 2)
    high = min(center + bw / 2, sr / 2 - 10) / (sr / 2)
    if low >= high or high >= 1.0:
        return 0.0
    sos = butter(4, [low, high], btype='band', output='sos')
    filtered = sosfilt(sos, samples)
    rms = np.sqrt(np.mean(filtered ** 2))
    return float(rms)


def analyze_phoneme_in_word(samples: np.ndarray, sr: int) -> list[float]:
    """
    Analyze the middle portion of the word (where the target phoneme is most stable).
    Returns normalized 10-band energy profile.
    """
    # Find the voiced/active region (above noise floor)
    frame_len = int(sr * 0.020)  # 20ms frames
    rms_frames = []
    for i in range(0, len(samples) - frame_len, frame_len):
        rms = np.sqrt(np.mean(samples[i:i+frame_len] ** 2))
        rms_frames.append(rms)

    if not rms_frames:
        return [0.0] * 10

    threshold = max(rms_frames) * 0.25
    active_frames = [i for i, r in enumerate(rms_frames) if r > threshold]

    if not active_frames:
        return [0.0] * 10

    # Take middle 50% of active region (stable portion, avoid transitions)
    start_frame = active_frames[len(active_frames) // 4]
    end_frame = active_frames[3 * len(active_frames) // 4]
    start_sample = start_frame * frame_len
    end_sample = min((end_frame + 1) * frame_len, len(samples))

    segment = samples[start_sample:end_sample]
    if len(segment) < frame_len:
        segment = samples  # fallback to full

    # Measure energy in each band
    energies = []
    for center, bw in BANDS:
        e = bandpass_energy(segment, sr, center, bw)
        energies.append(e)

    # Normalize to [0, 1] range (peak = 1.0)
    peak = max(energies) if max(energies) > 0 else 1.0
    normalized = [e / peak for e in energies]

    return normalized


def main():
    output_file = sys.argv[1] if len(sys.argv) > 1 else f'{OUTPUT_DIR}/phoneme-gains.json'

    print("=== PHONEME ANALYSIS FROM ESPEAK ===")
    print(f"Analyzing {len(PHONEME_WORDS)} phonemes through 10-band filter bank\n")

    results = {}

    for phoneme, word in sorted(PHONEME_WORDS.items()):
        wav_path = f'{OUTPUT_DIR}/{phoneme.lower()}.wav'
        sys.stdout.write(f"  {phoneme:4s} ({word:10s}) → ")

        if not espeak_to_wav(word, wav_path):
            print("FAILED")
            continue

        samples, sr = read_wav(wav_path)
        bands = analyze_phoneme_in_word(samples, sr)

        # Format for display
        band_str = ' '.join(f'{b:.2f}' for b in bands)
        print(band_str)

        results[phoneme] = {
            'word': word,
            'bands': [round(b, 3) for b in bands],
            'sample_rate': sr,
        }

    # Save results
    with open(output_file, 'w') as f:
        json.dump(results, f, indent=2)

    print(f"\nResults saved to {output_file}")

    # Print in phonemes.ts format for easy copy-paste
    print("\n\n=== COPY-PASTE FORMAT (for phonemes.ts) ===\n")
    for phoneme in sorted(results.keys()):
        bands = results[phoneme]['bands']
        band_str = ', '.join(f'{b:.2f}' for b in bands)
        print(f"  // {phoneme} (from eSpeak '{results[phoneme]['word']}')")
        print(f"  // bands: [{band_str}]")


if __name__ == '__main__':
    main()
