"""
Extract phoneme transition curves from Samantha's speech.

For each word, analyzes the band energy trajectory at 10ms resolution
and identifies the transition region between phonemes. Outputs transition
curves that can be used by the sequencer for data-driven coarticulation.
"""
import numpy as np
import wave, os, json
from scipy.signal import butter, sosfilt, resample

BAND_CENTERS = [112, 338, 575, 850, 1200, 1700, 2350, 3250, 4600, 6450]
BAND_WIDTHS  = [225, 225, 250, 300,  400,  600,  700, 1100, 1600, 2100]

TRANS_DIR = '/tmp/voder-transitions'
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


def frame_analysis(samples, sr, frame_ms=10):
    """Returns (n_frames, 10) band energies and RMS per frame."""
    frame_len = int(sr * frame_ms / 1000)
    n_frames = len(samples) // frame_len

    band_signals = []
    for center, bw in zip(BAND_CENTERS, BAND_WIDTHS):
        if center + bw / 2 > sr / 2:
            band_signals.append(np.zeros_like(samples))
        else:
            band_signals.append(bandpass(samples, sr, center, bw))

    energies = np.zeros((n_frames, 10))
    rms = np.zeros(n_frames)
    for f in range(n_frames):
        s, e = f * frame_len, (f + 1) * frame_len
        rms[f] = np.sqrt(np.mean(samples[s:e] ** 2))
        for b in range(10):
            energies[f, b] = np.sqrt(np.mean(band_signals[b][s:e] ** 2))

    # Normalize each frame to peak=1
    for f in range(n_frames):
        peak = np.max(energies[f])
        if peak > 0.001:
            energies[f] /= peak

    return energies, rms


def find_transition_region(energies, rms):
    """Find where the spectral shape changes most rapidly.
    Returns (start_frame, end_frame) of the transition region."""
    # Compute frame-to-frame spectral change
    n = len(energies)
    if n < 3:
        return 0, n

    changes = np.zeros(n)
    for f in range(1, n):
        changes[f] = np.sqrt(np.sum((energies[f] - energies[f-1]) ** 2))

    # Find active region
    threshold = np.max(rms) * 0.15
    active = [i for i, r in enumerate(rms) if r > threshold]
    if len(active) < 4:
        return 0, n

    # The transition is where spectral change is highest
    # Look at the active region only
    active_start = active[0]
    active_end = active[-1]

    # Smooth the change signal
    kernel = np.ones(3) / 3
    smooth_changes = np.convolve(changes[active_start:active_end], kernel, mode='same')

    if len(smooth_changes) < 2:
        return active_start, active_end

    # Find the peak change region
    peak_idx = np.argmax(smooth_changes) + active_start

    # Transition spans ~30-60ms around the peak
    trans_start = max(active_start, peak_idx - 3)
    trans_end = min(active_end, peak_idx + 3)

    return trans_start, trans_end


def extract_transition_curve(energies, rms, n_points=8):
    """Extract a normalized transition curve with n_points samples.
    Returns array of shape (n_points, 10) — the band energy trajectory."""
    active_mask = rms > np.max(rms) * 0.1
    active_indices = np.where(active_mask)[0]

    if len(active_indices) < 2:
        return np.zeros((n_points, 10))

    active_energies = energies[active_indices[0]:active_indices[-1]+1]

    if len(active_energies) < 2:
        return np.zeros((n_points, 10))

    # Resample to n_points
    curve = np.zeros((n_points, 10))
    for b in range(10):
        curve[:, b] = np.interp(
            np.linspace(0, 1, n_points),
            np.linspace(0, 1, len(active_energies)),
            active_energies[:, b]
        )

    return curve


TRANSITIONS = [
    ('EH', 'L', 'hello'), ('EH', 'S', 'yes'), ('AE', 'T', 'bat'),
    ('IY', 'T', 'beat'), ('UW', 'T', 'boot'), ('OW', 'N', 'bone'),
    ('AH', 'N', 'bun'), ('IY', 'Z', 'breeze'), ('AE', 'N', 'ban'),
    ('EY', 'K', 'bake'),
    ('HH', 'EH', 'hello'), ('L', 'OW', 'hello'), ('B', 'AE', 'bat'),
    ('B', 'IY', 'beat'), ('S', 'EY', 'say'), ('SH', 'IY', 'she'),
    ('N', 'OW', 'no'), ('W', 'AH', 'one'), ('TH', 'R', 'three'),
    ('M', 'IY', 'me'),
    ('S', 'T', 'stop'), ('N', 'D', 'and'), ('L', 'D', 'hold'),
]


def main():
    print('=' * 60)
    print('PHONEME TRANSITION CURVES FROM SAMANTHA')
    print('=' * 60)

    all_curves = {}

    for from_ph, to_ph, word in TRANSITIONS:
        safe = word.replace(' ', '_').lower()
        wav_path = os.path.join(TRANS_DIR, safe + '.wav')
        if not os.path.exists(wav_path):
            print(f'  {from_ph}→{to_ph} ({word}): MISSING')
            continue

        samples, sr = read_wav(wav_path)
        energies, rms = frame_analysis(samples, sr)
        curve = extract_transition_curve(energies, rms, n_points=8)

        key = f'{from_ph}_{to_ph}'
        all_curves[key] = {
            'from': from_ph,
            'to': to_ph,
            'word': word,
            'curve': curve.tolist(),
        }

        # Print the curve
        print(f'\n  {from_ph} → {to_ph} ({word}):')
        for i, frame in enumerate(curve):
            pct = i / (len(curve) - 1) * 100
            bstr = ' '.join(f'{b:.2f}' for b in frame)
            print(f'    {pct:5.1f}%: [{bstr}]')

    # Save
    output_path = os.path.join(OUTPUT_DIR, 'transition-curves.json')
    with open(output_path, 'w') as f:
        json.dump(all_curves, f, indent=2)
    print(f'\nSaved {len(all_curves)} transitions to {output_path}')

    # Print as TypeScript format for the sequencer
    print('\n\n' + '=' * 60)
    print('TRANSITION LOOKUP TABLE (for sequencer.ts)')
    print('=' * 60)
    print('export const TRANSITION_CURVES: Record<string, number[][]> = {')
    for key, data in sorted(all_curves.items()):
        curves_str = ', '.join(
            '[' + ', '.join(f'{v:.2f}' for v in frame) + ']'
            for frame in data['curve']
        )
        print(f'  "{key}": [{curves_str}],')
    print('}')


if __name__ == '__main__':
    main()
