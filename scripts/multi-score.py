"""
Multi-listener scoring: Whisper (tiny + small) and Vosk.
Scores WAV files against expected text using different ASR engines.

Usage: python3 scripts/multi-score.py <wav_dir> <word1,word2,...> <output_json>
WAV files should be named <word>.wav (spaces replaced with _).
"""
import ssl; ssl._create_default_https_context = ssl._create_unverified_context
import os, sys, json, wave, struct
import numpy as np

wav_dir = sys.argv[1]
words = sys.argv[2].split(',')
output_file = sys.argv[3]

# ── Helpers ──

def read_wav_samples(path: str) -> tuple[np.ndarray, int]:
    """Read WAV file, return (float32 samples, sample_rate)."""
    with wave.open(path, 'rb') as wf:
        sr = wf.getframerate()
        n = wf.getnframes()
        raw = wf.readframes(n)
        samples = np.array(struct.unpack(f'<{n}h', raw), dtype=np.float32) / 32768.0
    return samples, sr

def resample_16k(samples: np.ndarray, sr: int) -> np.ndarray:
    """Resample to 16kHz using scipy (proper anti-aliasing)."""
    if sr == 16000:
        return samples
    from scipy.signal import resample as scipy_resample
    new_len = int(len(samples) * 16000 / sr)
    return scipy_resample(samples, new_len).astype(np.float32)

# ── Whisper ──

_whisper_models = {}

def get_whisper_model(size: str):
    import whisper
    if size not in _whisper_models:
        _whisper_models[size] = whisper.load_model(size)
    return _whisper_models[size]

def score_whisper(paths: dict[str, str], model_size: str = 'tiny') -> dict:
    try:
        import whisper
        model = get_whisper_model(model_size)
        results = {}
        for word, path in paths.items():
            samples, sr = read_wav_samples(path)
            # Whisper expects 16kHz — resample if needed
            if sr != 16000:
                samples = resample_16k(samples, sr)
            audio = whisper.pad_or_trim(samples)
            mel = whisper.log_mel_spectrogram(audio, n_mels=model.dims.n_mels).to(model.device)
            result = whisper.decode(model, mel, whisper.DecodingOptions(language='en', fp16=False))
            results[word] = {
                'text': result.text.strip(),
                'logprob': float(result.avg_logprob),
            }
        return results
    except Exception as e:
        print(f"  [whisper-{model_size} error: {e}]", file=sys.stderr)
        return {}

# ── Vosk ──

def score_vosk(paths: dict[str, str]) -> dict:
    try:
        from vosk import Model, KaldiRecognizer, SetLogLevel
        SetLogLevel(-1)
        model_path = '/tmp/vosk-model-small-en-us-0.15'
        if not os.path.exists(model_path):
            print("  [vosk: model not found]", file=sys.stderr)
            return {}
        model = Model(model_path)
        results = {}
        for word, path in paths.items():
            samples, sr = read_wav_samples(path)
            samples_16k = resample_16k(samples, sr)
            pcm = (samples_16k * 32767).astype(np.int16).tobytes()
            rec = KaldiRecognizer(model, 16000)
            chunk_size = 8000
            for i in range(0, len(pcm), chunk_size * 2):
                rec.AcceptWaveform(pcm[i:i + chunk_size * 2])
            final = json.loads(rec.FinalResult())
            results[word] = {
                'text': final.get('text', '').strip(),
                'logprob': 0.0,
            }
        return results
    except Exception as e:
        print(f"  [vosk error: {e}]", file=sys.stderr)
        return {}

# ── Main ──

paths = {}
for word in words:
    path = os.path.join(wav_dir, word + '.wav')
    if os.path.exists(path):
        paths[word] = path
    else:
        print(f"  [missing: {path}]", file=sys.stderr)

print("Scoring with Whisper tiny...", file=sys.stderr)
whisper_tiny = score_whisper(paths, 'tiny')

print("Scoring with Whisper small...", file=sys.stderr)
whisper_small = score_whisper(paths, 'small')

print("Scoring with Vosk...", file=sys.stderr)
vosk_results = score_vosk(paths)

# Combine
combined = {}
for word in words:
    expected = word.replace('_', ' ')
    combined[word] = {
        'expected': expected,
        'whisper_tiny': whisper_tiny.get(word, {'text': '???', 'logprob': -2.0}),
        'whisper_small': whisper_small.get(word, {'text': '???', 'logprob': -2.0}),
        'vosk': vosk_results.get(word, {'text': '???', 'logprob': -2.0}),
    }

with open(output_file, 'w') as f:
    json.dump(combined, f, indent=2)

# Print summary table
def mark(got, exp):
    clean = got.lower().rstrip('.,!?').strip()
    return f"{'✓' if clean == exp.lower() else '✗'} {got[:13]}"

print("\n" + "=" * 76, file=sys.stderr)
print(f"{'Expected':<20} {'Whisper-tiny':<18} {'Whisper-small':<18} {'Vosk':<18}", file=sys.stderr)
print("-" * 76, file=sys.stderr)
for word, data in combined.items():
    expected = data['expected']
    wt = data['whisper_tiny']['text'].lower().rstrip('.,!?')
    ws = data['whisper_small']['text'].lower().rstrip('.,!?')
    v = data['vosk']['text']
    print(f"{expected:<20} {mark(wt, expected):<18} {mark(ws, expected):<18} {mark(v, expected):<18}", file=sys.stderr)

# Count correct per listener
for name, key in [('Whisper-tiny', 'whisper_tiny'), ('Whisper-small', 'whisper_small'), ('Vosk', 'vosk')]:
    correct = sum(1 for d in combined.values()
                  if d[key]['text'].lower().rstrip('.,!?').strip() == d['expected'].lower())
    print(f"{name}: {correct}/{len(combined)}", file=sys.stderr)
