"""
Mel Cepstral Distortion (MCD) scoring against Samantha reference.

MCD measures spectral distance between two audio signals using
mel-frequency cepstral coefficients (MFCCs). Lower = more similar.

Standard in speech synthesis evaluation — doesn't care about
recognition, only spectral shape similarity.

Usage as module: mcd_score(voder_path, reference_path) -> float
Usage standalone: python3 mcd-score.py <voder_dir> <ref_dir> <words>
"""
import numpy as np
import wave
from scipy.signal import resample
from scipy.fftpack import dct


def read_wav_16k(path):
    with wave.open(path, 'rb') as wf:
        sr = wf.getframerate()
        n = wf.getnframes()
        raw = wf.readframes(n)
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if sr != 16000:
        samples = resample(samples, int(len(samples) * 16000 / sr)).astype(np.float32)
    return samples


def compute_mfcc(samples, sr=16000, n_mfcc=13, n_fft=512, hop=160, n_mels=40):
    """Compute MFCCs from audio samples."""
    # Pre-emphasis
    samples = np.append(samples[0], samples[1:] - 0.97 * samples[:-1])

    # Frame the signal
    frame_len = n_fft
    frames = []
    for i in range(0, len(samples) - frame_len, hop):
        frame = samples[i:i + frame_len] * np.hamming(frame_len)
        frames.append(frame)

    if not frames:
        return np.zeros((1, n_mfcc))

    frames = np.array(frames)

    # Power spectrum
    power = np.abs(np.fft.rfft(frames, n_fft)) ** 2 / n_fft

    # Mel filterbank
    low_mel = 0
    high_mel = 2595 * np.log10(1 + (sr / 2) / 700)
    mel_points = np.linspace(low_mel, high_mel, n_mels + 2)
    hz_points = 700 * (10 ** (mel_points / 2595) - 1)
    bins = np.floor((n_fft + 1) * hz_points / sr).astype(int)

    fbank = np.zeros((n_mels, n_fft // 2 + 1))
    for m in range(1, n_mels + 1):
        left, center, right = bins[m - 1], bins[m], bins[m + 1]
        for k in range(left, center):
            fbank[m - 1, k] = (k - left) / max(center - left, 1)
        for k in range(center, right):
            fbank[m - 1, k] = (right - k) / max(right - center, 1)

    mel_spec = np.dot(power, fbank.T)
    mel_spec = np.maximum(mel_spec, 1e-10)
    log_mel = np.log(mel_spec)

    # DCT to get MFCCs
    mfcc = dct(log_mel, type=2, axis=1, norm='ortho')[:, :n_mfcc]
    return mfcc


def mcd_score(voder_path, ref_path):
    """
    Compute Mel Cepstral Distortion between Voder output and reference.
    Returns MCD in dB — lower is better. Typical values:
    - < 4 dB: very similar (good synthesis)
    - 4-6 dB: similar (acceptable)
    - 6-8 dB: somewhat different
    - > 8 dB: very different
    """
    voder = read_wav_16k(voder_path)
    ref = read_wav_16k(ref_path)

    voder_mfcc = compute_mfcc(voder)
    ref_mfcc = compute_mfcc(ref)

    # Dynamic Time Warping alignment (simple version)
    # Just truncate to shorter length for now
    min_len = min(len(voder_mfcc), len(ref_mfcc))
    if min_len == 0:
        return 20.0  # very bad

    # Resample MFCCs to same length via linear interpolation
    if len(voder_mfcc) != len(ref_mfcc):
        indices = np.linspace(0, len(ref_mfcc) - 1, len(voder_mfcc))
        ref_resampled = np.zeros_like(voder_mfcc)
        for i in range(voder_mfcc.shape[1]):
            ref_resampled[:, i] = np.interp(indices, np.arange(len(ref_mfcc)), ref_mfcc[:, i])
        ref_mfcc = ref_resampled

    # MCD formula: (10*sqrt(2)/ln(10)) * mean(sqrt(sum((c1-c2)^2)))
    # Skip c0 (energy) — use coefficients 1-12
    diff = voder_mfcc[:, 1:] - ref_mfcc[:, 1:]
    frame_dist = np.sqrt(np.sum(diff ** 2, axis=1))
    mcd = (10.0 * np.sqrt(2) / np.log(10)) * np.mean(frame_dist)

    return float(mcd)


if __name__ == '__main__':
    import sys, os
    if len(sys.argv) < 4:
        print('Usage: python3 mcd-score.py <voder_dir> <ref_dir> <word1,word2,...>')
        sys.exit(1)

    voder_dir = sys.argv[1]
    ref_dir = sys.argv[2]
    words = sys.argv[3].split(',')

    print(f"{'Word':<15} {'MCD (dB)':>10}")
    print('-' * 28)
    total = 0
    count = 0
    for word in words:
        vp = os.path.join(voder_dir, word + '.wav')
        rp = os.path.join(ref_dir, word + '.wav')
        if os.path.exists(vp) and os.path.exists(rp):
            score = mcd_score(vp, rp)
            total += score
            count += 1
            print(f'{word:<15} {score:>10.2f}')
        else:
            print(f'{word:<15}    MISSING')

    if count > 0:
        print(f'\n{"Average":<15} {total/count:>10.2f}')
