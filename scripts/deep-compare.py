"""
Deep spectral comparison: analyze frame-by-frame spectral evolution
of Voder vs eSpeak through our exact 10-band filter bank.
"""
import numpy as np
import wave, struct, os
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
    low = max(center - bw/2, 20) / (sr/2)
    high = min(center + bw/2, sr/2 - 10) / (sr/2)
    if low >= high or high >= 1.0:
        return np.zeros_like(samples)
    sos = butter(order, [low, high], btype='band', output='sos')
    return sosfilt(sos, samples)

def frame_analysis(samples, sr, frame_ms=20):
    """Return per-frame 10-band energy matrix and total RMS."""
    frame_len = int(sr * frame_ms / 1000)
    n_frames = len(samples) // frame_len

    # Filter entire signal through each band
    band_signals = []
    for center, bw in zip(BAND_CENTERS, BAND_WIDTHS):
        filtered = bandpass(samples, sr, center, bw)
        band_signals.append(filtered)

    # Compute per-frame energy
    energies = np.zeros((n_frames, 10))
    total_rms = np.zeros(n_frames)

    for f in range(n_frames):
        start = f * frame_len
        end = start + frame_len
        total_rms[f] = np.sqrt(np.mean(samples[start:end]**2))
        for b in range(10):
            energies[f, b] = np.sqrt(np.mean(band_signals[b][start:end]**2))

    return energies, total_rms

def print_comparison(word, voder_path, espeak_path):
    if not os.path.exists(voder_path) or not os.path.exists(espeak_path):
        print(f"  Missing files for '{word}'")
        return

    v_samples, v_sr = read_wav(voder_path)
    e_samples, e_sr = read_wav(espeak_path)

    v_energies, v_rms = frame_analysis(v_samples, v_sr)
    e_energies, e_rms = frame_analysis(e_samples, e_sr)

    # Find active frames (above 20% of peak)
    v_active = v_rms > np.max(v_rms) * 0.2
    e_active = e_rms > np.max(e_rms) * 0.2

    # Average band energies across active frames
    v_avg = np.mean(v_energies[v_active], axis=0) if np.any(v_active) else np.zeros(10)
    e_avg = np.mean(e_energies[e_active], axis=0) if np.any(e_active) else np.zeros(10)

    # Normalize each to its own peak
    v_norm = v_avg / (np.max(v_avg) + 1e-12)
    e_norm = e_avg / (np.max(e_avg) + 1e-12)

    print(f"\n{'='*70}")
    print(f"  '{word}'")
    print(f"{'='*70}")
    print(f"  {'Band':>6}  {'Center':>6}  {'Voder':>8}  {'eSpeak':>8}  {'Ratio':>8}  {'Visual'}")
    print(f"  {'-'*64}")

    for i in range(10):
        ratio = v_norm[i] / (e_norm[i] + 1e-6)
        v_bar = '#' * int(v_norm[i] * 20)
        e_bar = '.' * int(e_norm[i] * 20)
        status = '  OK' if 0.5 < ratio < 2.0 else ' LOW' if ratio < 0.5 else 'HIGH'
        print(f"  B{i:<4}  {BAND_CENTERS[i]:>5}Hz  {v_norm[i]:>8.3f}  {e_norm[i]:>8.3f}  {ratio:>7.2f}x  V:{v_bar:<20} E:{e_bar:<20} {status}")

    # Also show absolute levels
    v_total = np.mean(v_rms[v_active]) if np.any(v_active) else 0
    e_total = np.mean(e_rms[e_active]) if np.any(e_active) else 0
    print(f"\n  Active RMS: Voder={v_total:.4f}  eSpeak={e_total:.4f}  ratio={v_total/(e_total+1e-6):.2f}x")

    # Dynamic range
    v_peak_band = np.argmax(v_avg)
    e_peak_band = np.argmax(e_avg)
    v_dr = np.max(v_avg) / (np.min(v_avg[v_avg > 0]) + 1e-12) if np.any(v_avg > 0) else 0
    e_dr = np.max(e_avg) / (np.min(e_avg[e_avg > 0]) + 1e-12) if np.any(e_avg > 0) else 0
    print(f"  Peak band:  Voder=B{v_peak_band}({BAND_CENTERS[v_peak_band]}Hz)  eSpeak=B{e_peak_band}({BAND_CENTERS[e_peak_band]}Hz)")
    print(f"  Dynamic range: Voder={20*np.log10(v_dr+1e-12):.1f}dB  eSpeak={20*np.log10(e_dr+1e-12):.1f}dB")

# Test words
words = ['yes', 'hello', 'beat', 'bat', 'say', 'no']
for word in words:
    print_comparison(
        word,
        f'/tmp/voder-offline/{word}.wav',
        f'/tmp/espeak-test/{word}.wav'
    )
