"""
Generate transition curves for ALL phoneme pairs found in English.

1. Scan the CMU dictionary for every phoneme bigram that occurs
2. Find a short carrier word for each pair
3. Generate audio with Samantha
4. Analyze through our 10-band filter bank
5. Output transition curves for the sequencer
"""
import os, json, subprocess, re
import numpy as np
import wave
from scipy.signal import butter, sosfilt
from collections import Counter

BAND_CENTERS = [112, 338, 575, 850, 1200, 1700, 2350, 3250, 4600, 6450]
BAND_WIDTHS  = [225, 225, 250, 300,  400,  600,  700, 1100, 1600, 2100]

OUTPUT_DIR = '/tmp/voder-all-transitions'
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Load CMU dictionary
CMU_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        'node_modules', 'cmu-pronouncing-dictionary', 'index.js')

print('Loading CMU dictionary...', flush=True)
# Parse the ES module export: lines like '  "word": "P R AH0 N",'
cmu = {}
with open(CMU_PATH) as f:
    for line in f:
        line = line.strip()
        if line.startswith('"') and '": "' in line:
            parts = line.split('": "', 1)
            word = parts[0].strip('"')
            pron = parts[1].rstrip('",')
            cmu[word] = pron
print(f'  {len(cmu)} entries', flush=True)

# Strip stress markers from phonemes
def strip_stress(ph):
    return re.sub(r'[0-9]', '', ph)

# Find all phoneme bigrams and count occurrences
print('Finding all phoneme bigrams...', flush=True)
bigram_counts = Counter()
bigram_words = {}  # bigram -> shortest word containing it

for word, pron in cmu.items():
    phones = [strip_stress(p) for p in pron.split()]
    if len(phones) < 2:
        continue
    for i in range(len(phones) - 1):
        pair = (phones[i], phones[i+1])
        bigram_counts[pair] += 1
        key = f'{pair[0]}_{pair[1]}'
        # Prefer shorter words as carriers
        if key not in bigram_words or len(word) < len(bigram_words[key]):
            bigram_words[key] = word

print(f'  {len(bigram_counts)} unique bigrams found', flush=True)

# Filter to bigrams that occur at least 10 times (common enough to matter)
common = {k: v for k, v in bigram_counts.items() if v >= 10}
print(f'  {len(common)} occur >= 10 times', flush=True)

# Sort by frequency
sorted_bigrams = sorted(common.items(), key=lambda x: -x[1])

# Show top 30
print('\nTop 30 most common transitions:')
for (a, b), count in sorted_bigrams[:30]:
    word = bigram_words.get(f'{a}_{b}', '?')
    print(f'  {a:>3} → {b:<3}  {count:>5}x  (e.g. "{word}")')

# ── Generate audio and analyze ──

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

def extract_curve(samples, sr, n_points=8):
    frame_len = int(sr * 0.010)
    n_frames = len(samples) // frame_len
    if n_frames < 4:
        return None

    # Filter through all bands
    band_signals = []
    for center, bw in zip(BAND_CENTERS, BAND_WIDTHS):
        if center + bw/2 > sr/2:
            band_signals.append(np.zeros_like(samples))
        else:
            band_signals.append(bandpass(samples, sr, center, bw))

    energies = np.zeros((n_frames, 10))
    rms = np.zeros(n_frames)
    for f in range(n_frames):
        s, e = f * frame_len, (f+1) * frame_len
        rms[f] = np.sqrt(np.mean(samples[s:e]**2))
        for b in range(10):
            energies[f, b] = np.sqrt(np.mean(band_signals[b][s:e]**2))

    # Normalize per frame
    for f in range(n_frames):
        peak = np.max(energies[f])
        if peak > 0.001:
            energies[f] /= peak

    # Find active region
    active = [i for i, r in enumerate(rms) if r > np.max(rms) * 0.1]
    if len(active) < 4:
        return None

    active_e = energies[active[0]:active[-1]+1]
    if len(active_e) < 2:
        return None

    # Resample to n_points
    curve = np.zeros((n_points, 10))
    for b in range(10):
        curve[:, b] = np.interp(
            np.linspace(0, 1, n_points),
            np.linspace(0, 1, len(active_e)),
            active_e[:, b]
        )
    return curve.tolist()


# Save bigram → word mapping for reproducibility
bigram_list_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                'data', 'phoneme-bigrams.json')
os.makedirs(os.path.dirname(bigram_list_path), exist_ok=True)
bigram_list = {}
for (a, b), count in sorted_bigrams:
    key = f'{a}_{b}'
    word = bigram_words.get(key, '')
    if word:
        bigram_list[key] = {'word': word, 'count': count}
with open(bigram_list_path, 'w') as f:
    json.dump(bigram_list, f, indent=2)
print(f'Saved bigram list to {bigram_list_path} ({len(bigram_list)} pairs)', flush=True)

print(f'\nGenerating audio for {len(common)} transitions...', flush=True)

all_curves = {}
failed = 0
skipped = 0

for idx, ((from_ph, to_ph), count) in enumerate(sorted_bigrams):
    key = f'{from_ph}_{to_ph}'
    word = bigram_words.get(key)
    if not word:
        skipped += 1
        continue

    # Generate with Samantha
    aiff = f'{OUTPUT_DIR}/{key}.aiff'
    wav_path = f'{OUTPUT_DIR}/{key}.wav'

    if not os.path.exists(wav_path):
        try:
            subprocess.run(['say', '-v', 'Fred', '-r', '120', '-o', aiff, word],
                          capture_output=True, timeout=10)
            subprocess.run(['afconvert', '-f', 'WAVE', '-d', 'LEI16', aiff, wav_path],
                          capture_output=True, timeout=5)
            if os.path.exists(aiff):
                os.remove(aiff)
        except:
            failed += 1
            continue

    if not os.path.exists(wav_path):
        failed += 1
        continue

    # Analyze
    try:
        samples, sr = read_wav(wav_path)
        curve = extract_curve(samples, sr)
        if curve:
            all_curves[key] = curve
    except:
        failed += 1
        continue

    if (idx + 1) % 50 == 0:
        print(f'  {idx+1}/{len(common)} processed, {len(all_curves)} curves extracted', flush=True)

print(f'\nDone: {len(all_curves)} curves from {len(common)} pairs ({failed} failed, {skipped} skipped)', flush=True)

# Save raw curves
with open(f'{OUTPUT_DIR}/all-curves.json', 'w') as f:
    json.dump(all_curves, f)

# Generate TypeScript
print('\nGenerating TypeScript...', flush=True)
ts_lines = [
    '/**',
    ' * Phoneme transition curves measured from Samantha (macOS TTS).',
    f' * {len(all_curves)} transitions covering all common English phoneme pairs.',
    ' * Generated by scripts/generate-all-transitions.py',
    ' */',
    '',
    'export const TRANSITION_CURVES: Record<string, number[][]> = {',
]

for key in sorted(all_curves.keys()):
    curve = all_curves[key]
    frames_str = ', '.join(
        '[' + ', '.join(f'{v:.2f}' for v in frame) + ']'
        for frame in curve
    )
    ts_lines.append(f'  "{key}": [{frames_str}],')

ts_lines.append('}')
ts_lines.append('')
ts_lines.append('export function getTransitionCurve(from: string, to: string): number[][] | null {')
ts_lines.append('  return TRANSITION_CURVES[`${from}_${to}`] ?? null')
ts_lines.append('}')
ts_lines.append('')
ts_lines.append('export function interpolateTransition(curve: number[][], t: number): number[] {')
ts_lines.append('  const idx = Math.max(0, Math.min(1, t)) * (curve.length - 1)')
ts_lines.append('  const lo = Math.floor(idx), hi = Math.min(lo + 1, curve.length - 1)')
ts_lines.append('  const frac = idx - lo')
ts_lines.append('  return curve[lo].map((v, i) => v * (1 - frac) + curve[hi][i] * frac)')
ts_lines.append('}')

ts_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       'src', 'transitions.ts')
with open(ts_path, 'w') as f:
    f.write('\n'.join(ts_lines) + '\n')

print(f'Wrote {ts_path} ({len(all_curves)} transitions)', flush=True)
