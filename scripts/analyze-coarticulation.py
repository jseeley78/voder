"""
Extract coarticulation data from Samantha's speech.

Analyzes frame-by-frame band energies through our 10-band filter bank
to capture how formants actually transition between phonemes in connected speech.

This provides data-driven transition curves to replace the sequencer's
simple onset/steady/offset model.
"""
import numpy as np
import wave, os, json, subprocess
from scipy.signal import butter, sosfilt, resample

BAND_CENTERS = [112, 338, 575, 850, 1200, 1700, 2350, 3250, 4600, 6450]
BAND_WIDTHS  = [225, 225, 250, 300,  400,  600,  700, 1100, 1600, 2100]

OUTPUT_DIR = '/tmp/voder-coarticulation'
os.makedirs(OUTPUT_DIR, exist_ok=True)


def read_wav(path):
    with wave.open(path, 'rb') as wf:
        sr = wf.getframerate()
        n = wf.getnframes()
        raw = wf.readframes(n)
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    return samples, sr


def bandpass(samples, sr, center, bw, order=4):
    nyq = sr / 2
    low = max(center - bw / 2, 20) / nyq
    high = min(center + bw / 2, nyq - 10) / nyq
    if low >= high or high >= 1.0:
        return np.zeros_like(samples)
    sos = butter(order, [low, high], btype='band', output='sos')
    return sosfilt(sos, samples)


def frame_band_energies(samples, sr, frame_ms=10):
    """Compute per-frame energy in each of our 10 bands.
    Returns (n_frames, 10) array and time axis."""
    frame_len = int(sr * frame_ms / 1000)
    n_frames = len(samples) // frame_len

    # Pre-filter entire signal through each band
    band_signals = []
    for center, bw in zip(BAND_CENTERS, BAND_WIDTHS):
        if center + bw / 2 > sr / 2:
            band_signals.append(np.zeros_like(samples))
        else:
            band_signals.append(bandpass(samples, sr, center, bw))

    energies = np.zeros((n_frames, 10))
    for f in range(n_frames):
        start = f * frame_len
        end = start + frame_len
        for b in range(10):
            energies[f, b] = np.sqrt(np.mean(band_signals[b][start:end] ** 2))

    # Normalize per-frame to peak=1
    for f in range(n_frames):
        peak = np.max(energies[f])
        if peak > 0.001:
            energies[f] /= peak

    times = np.arange(n_frames) * frame_ms / 1000
    return energies, times


def analyze_phrase(phrase, wav_path):
    """Analyze a phrase's band energy trajectory."""
    samples, sr = read_wav(wav_path)
    energies, times = frame_band_energies(samples, sr)

    # Also compute total RMS per frame for activity detection
    frame_len = int(sr * 0.010)
    rms = np.array([np.sqrt(np.mean(samples[i*frame_len:(i+1)*frame_len]**2))
                     for i in range(len(times))])

    return {
        'phrase': phrase,
        'sample_rate': sr,
        'n_frames': len(times),
        'frame_ms': 10,
        'energies': energies.tolist(),
        'times': times.tolist(),
        'rms': rms.tolist(),
    }


def main():
    phrases_dir = '/tmp/voder-reference/phrases'
    words_dir = '/tmp/voder-reference'

    print('=' * 60)
    print('COARTICULATION ANALYSIS FROM SAMANTHA')
    print('=' * 60)

    results = {}

    # Analyze single words
    print('\n── Single words ──')
    for word in ['yes', 'no', 'hello', 'beat', 'bat', 'boot', 'say', 'bird', 'boat', 'boy', 'how', 'buy']:
        path = os.path.join(words_dir, word + '.wav')
        if not os.path.exists(path):
            continue
        data = analyze_phrase(word, path)
        results[word] = data
        active = sum(1 for r in data['rms'] if r > 0.01)
        print(f'  {word:15s}: {data["n_frames"]} frames, {active} active')

    # Analyze phrases
    print('\n── Phrases ──')
    for fname in sorted(os.listdir(phrases_dir)):
        if not fname.endswith('.wav'):
            continue
        phrase = fname.replace('.wav', '').replace('_', ' ')
        path = os.path.join(phrases_dir, fname)
        data = analyze_phrase(phrase, path)
        results[phrase] = data
        active = sum(1 for r in data['rms'] if r > 0.01)
        print(f'  {phrase:25s}: {data["n_frames"]} frames, {active} active')

    # Save all data
    output_path = os.path.join(OUTPUT_DIR, 'samantha-trajectories.json')
    with open(output_path, 'w') as f:
        json.dump(results, f)
    print(f'\nSaved to {output_path} ({os.path.getsize(output_path) / 1024:.0f} KB)')

    # Print example: "hello" frame-by-frame
    if 'hello' in results:
        print('\n── Example: "hello" band energy trajectory ──')
        data = results['hello']
        print(f'  {"Time":>6}  {"RMS":>5}  {"B0":>5} {"B1":>5} {"B2":>5} {"B3":>5} {"B4":>5} {"B5":>5} {"B6":>5} {"B7":>5} {"B8":>5} {"B9":>5}')
        for i in range(0, data['n_frames'], 3):  # every 30ms
            t = data['times'][i]
            rms = data['rms'][i]
            if rms < 0.005:
                continue
            bands = data['energies'][i]
            bstr = ' '.join(f'{b:5.2f}' for b in bands)
            print(f'  {t:6.3f}  {rms:5.3f}  {bstr}')

    # Compute average transition shapes
    # For each word, find the "attack" shape (first 50ms of active audio)
    print('\n── Average attack shapes (first 50ms of voicing) ──')
    for word in ['hello', 'yes', 'bat', 'say', 'beat']:
        if word not in results:
            continue
        data = results[word]
        rms = np.array(data['rms'])
        energies = np.array(data['energies'])
        threshold = np.max(rms) * 0.15
        active_start = next((i for i, r in enumerate(rms) if r > threshold), 0)
        # First 5 frames (50ms) after onset
        attack = energies[active_start:active_start + 5]
        if len(attack) > 0:
            avg = np.mean(attack, axis=0)
            bstr = ' '.join(f'{b:.2f}' for b in avg)
            print(f'  {word:10s}: [{bstr}]')


if __name__ == '__main__':
    main()
