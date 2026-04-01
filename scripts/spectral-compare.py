"""
Compare spectral characteristics of Voder output vs eSpeak output.
Helps diagnose why ASR can't understand our synthesizer.
"""
import numpy as np
import wave, struct, subprocess, os

def read_wav(path):
    with wave.open(path, 'rb') as wf:
        sr = wf.getframerate()
        n = wf.getnframes()
        raw = wf.readframes(n)
        if wf.getsampwidth() == 2:
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        else:
            samples = np.frombuffer(raw, dtype=np.uint8).astype(np.float32) / 128.0 - 1.0
        ch = wf.getnchannels()
        if ch > 1:
            samples = samples.reshape(-1, ch)[:, 0]
    return samples, sr

def spectral_stats(samples, sr, label):
    """Print spectral statistics for audio."""
    # RMS
    rms = np.sqrt(np.mean(samples ** 2))
    peak = np.max(np.abs(samples))

    # Find active region
    frame_len = int(sr * 0.020)
    rms_frames = [np.sqrt(np.mean(samples[i:i+frame_len]**2))
                  for i in range(0, len(samples) - frame_len, frame_len)]
    threshold = max(rms_frames) * 0.2
    active = [r for r in rms_frames if r > threshold]
    active_rms = np.mean(active) if active else 0

    # FFT of active region
    active_start = next(i for i, r in enumerate(rms_frames) if r > threshold) * frame_len
    active_end = (len(rms_frames) - 1 - next(i for i, r in enumerate(reversed(rms_frames)) if r > threshold)) * frame_len
    segment = samples[active_start:active_end]
    if len(segment) < 512:
        segment = samples

    # Power spectrum
    n_fft = 2048
    if len(segment) < n_fft:
        segment = np.pad(segment, (0, n_fft - len(segment)))
    spectrum = np.abs(np.fft.rfft(segment[:n_fft]))
    freqs = np.fft.rfftfreq(n_fft, 1/sr)
    power = spectrum ** 2
    power_db = 10 * np.log10(power + 1e-12)

    # Spectral centroid
    centroid = np.sum(freqs * power) / (np.sum(power) + 1e-12)

    # Energy in bands
    bands = [(0, 500), (500, 1000), (1000, 2000), (2000, 4000), (4000, 8000)]
    band_energy = []
    for lo, hi in bands:
        mask = (freqs >= lo) & (freqs < hi)
        e = np.sum(power[mask])
        band_energy.append(e)
    total_e = sum(band_energy)
    band_pct = [e / total_e * 100 for e in band_energy]

    # Spectral tilt (slope of log power vs log freq)
    valid = freqs > 50
    log_f = np.log10(freqs[valid])
    log_p = power_db[valid]
    coeffs = np.polyfit(log_f, log_p, 1)
    tilt = coeffs[0]  # dB/decade

    # Harmonics detection
    # Look for peaks in autocorrelation
    corr = np.correlate(segment[:4096], segment[:4096], mode='full')
    corr = corr[len(corr)//2:]
    # Find first peak after zero crossing
    min_lag = int(sr / 400)  # 400 Hz max
    max_lag = int(sr / 60)   # 60 Hz min
    if max_lag < len(corr):
        peak_lag = min_lag + np.argmax(corr[min_lag:max_lag])
        f0 = sr / peak_lag
        harmonic_strength = corr[peak_lag] / corr[0]
    else:
        f0 = 0
        harmonic_strength = 0

    print(f"\n{'='*60}")
    print(f"  {label}")
    print(f"{'='*60}")
    print(f"  Duration:     {len(samples)/sr:.2f}s")
    print(f"  RMS:          {rms:.4f}  (active: {active_rms:.4f})")
    print(f"  Peak:         {peak:.4f}")
    print(f"  F0 estimate:  {f0:.1f} Hz (strength: {harmonic_strength:.2f})")
    print(f"  Centroid:     {centroid:.0f} Hz")
    print(f"  Tilt:         {tilt:.1f} dB/decade")
    print(f"  Band energy distribution:")
    for i, ((lo, hi), pct) in enumerate(zip(bands, band_pct)):
        bar = '#' * int(pct / 2)
        print(f"    {lo:>4}-{hi:<4} Hz: {pct:5.1f}% {bar}")

# Generate eSpeak reference
espeak_path = '/tmp/voder-analysis/espeak_hello.wav'
subprocess.run(['espeak', '-v', 'en-us', '-w', espeak_path, 'hello'], capture_output=True)

# Our renders
voder_path = '/tmp/voder-offline/hello.wav'

if os.path.exists(voder_path):
    samples, sr = read_wav(voder_path)
    spectral_stats(samples, sr, f"VODER 'hello' ({sr}Hz)")

if os.path.exists(espeak_path):
    samples, sr = read_wav(espeak_path)
    spectral_stats(samples, sr, f"eSpeak 'hello' ({sr}Hz)")

# Also check 'yes' since it was our best word
voder_yes = '/tmp/voder-offline/yes.wav'
espeak_yes = '/tmp/voder-analysis/espeak_yes.wav'
subprocess.run(['espeak', '-v', 'en-us', '-w', espeak_yes, 'yes'], capture_output=True)

if os.path.exists(voder_yes):
    samples, sr = read_wav(voder_yes)
    spectral_stats(samples, sr, f"VODER 'yes' ({sr}Hz)")

if os.path.exists(espeak_yes):
    samples, sr = read_wav(espeak_yes)
    spectral_stats(samples, sr, f"eSpeak 'yes' ({sr}Hz)")
