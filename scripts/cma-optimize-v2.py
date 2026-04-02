#!/usr/bin/env python3
"""
CMA-ES optimizer v2: ALL parameters that affect speech intelligibility.

Optimizes:
- All 39 phoneme band gains (10 bands each)
- Per-phoneme voicedAmp, noise, durationMs
- Stop burst bands and burst duration/noise
- Global: voiced gain multiplier, noise gain multiplier, filter Q multiplier
- Global: EQ settings (low shelf, presence peak, high shelf)
- Global: vibrato rate/depth

Uses wav2vec2 CTC probability on MPS GPU as fitness function.
"""
import os, sys, json, wave, subprocess, time, warnings
import numpy as np
import cma

warnings.filterwarnings('ignore')
os.environ['TRANSFORMERS_NO_ADVISORY_WARNINGS'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

VODER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK_DIR = '/tmp/voder-cma-v2'
NODE_PATH = '/Users/jeremiah/.nvm/versions/node/v20.19.5/bin'
os.makedirs(WORK_DIR, exist_ok=True)

# ── Model ──
_model = None
_processor = None
_device = None

def get_model():
    global _model, _processor, _device
    if _model is None:
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
        import torch
        _device = torch.device('mps') if torch.backends.mps.is_available() else torch.device('cpu')
        print(f'Loading wav2vec2 on {_device}...', flush=True)
        _processor = Wav2Vec2Processor.from_pretrained('facebook/wav2vec2-large-960h-lv60-self')
        _model = Wav2Vec2ForCTC.from_pretrained('facebook/wav2vec2-large-960h-lv60-self')
        _model.eval().to(_device)
        # Warmup
        dummy = _processor(np.zeros(16000, dtype=np.float32), sampling_rate=16000, return_tensors='pt', padding=True)
        with torch.no_grad():
            _model(**{k: v.to(_device) for k, v in dummy.items()})
        print('Model ready.', flush=True)
    return _model, _processor, _device


def read_wav_16k(path):
    from scipy.signal import resample
    with wave.open(path, 'rb') as wf:
        sr = wf.getframerate()
        n = wf.getnframes()
        raw = wf.readframes(n)
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if sr != 16000:
        samples = resample(samples, int(len(samples) * 16000 / sr)).astype(np.float32)
    return samples


def ctc_score(audio, target_text):
    import torch
    model, processor, device = get_model()
    inputs = processor(audio, sampling_rate=16000, return_tensors='pt', padding=True)
    inputs = {k: v.to(device) for k, v in inputs.items()}
    with torch.no_grad():
        logits = model(**inputs).logits.cpu()
    predicted_ids = torch.argmax(logits, dim=-1)
    transcription = processor.batch_decode(predicted_ids)[0]
    target_ids = processor.tokenizer(target_text.upper(), return_tensors='pt').input_ids
    log_probs = torch.nn.functional.log_softmax(logits, dim=-1)
    ctc_loss = torch.nn.functional.ctc_loss(
        log_probs.transpose(0, 1), target_ids[0],
        input_lengths=torch.tensor([log_probs.shape[1]]),
        target_lengths=torch.tensor([target_ids.shape[1]]),
        blank=processor.tokenizer.pad_token_id, reduction='mean')
    return transcription, -float(ctc_loss)


# ── Test words ──
TEST_WORDS = ['yes', 'no', 'hello', 'bat', 'say', 'beat', 'boot', 'one']

# ── All phonemes ──
ALL_PHONEMES = [
    # Vowels
    'IY', 'IH', 'EH', 'AE', 'AA', 'AO', 'AH', 'UH', 'UW', 'ER',
    # Diphthongs
    'OW', 'AW', 'AY', 'EY', 'OY',
    # Fricatives
    'HH', 'F', 'S', 'SH', 'TH', 'V', 'Z', 'ZH', 'DH',
    # Nasals
    'M', 'N', 'NG',
    # Liquids
    'L', 'R',
    # Glides
    'W', 'Y',
    # Stops
    'B', 'D', 'G', 'P', 'T', 'K', 'CH', 'JH',
]

# ── Parameter layout ──
# For each phoneme: 10 bands + voicedAmp + noise + durationMs (scaled 0-1) = 13 params
# Global params: voicedGainMul, noiseGainMul, filterQMul, eqLowGain, eqMidGain, eqMidFreq, eqHighGain = 7
# Total: 39 * 13 + 7 = 514 params

PARAMS_PER_PHONEME = 13  # 10 bands + voicedAmp + noise + durationMs_scaled
N_GLOBAL = 7

def get_current_values():
    """Read current phoneme values from phonemes.ts (hardcoded snapshot)."""
    # This is read from the explore agent's output above
    phonemes = {
        'IY': {'bands': [0.15, 0.36, 0.02, 0.00, 0.00, 0.01, 0.35, 1.00, 0.33, 0.20], 'voicedAmp': 0.80, 'noise': 0.01, 'durationMs': 175},
        'IH': {'bands': [0.14, 1.00, 0.98, 0.01, 0.00, 0.11, 0.25, 0.32, 0.28, 0.23], 'voicedAmp': 0.85, 'noise': 0.01, 'durationMs': 120},
        'EH': {'bands': [0.17, 0.51, 1.00, 0.35, 0.01, 0.48, 0.30, 0.29, 0.56, 0.09], 'voicedAmp': 0.90, 'noise': 0.02, 'durationMs': 170},
        'AE': {'bands': [0.28, 0.57, 1.00, 0.70, 0.09, 0.96, 0.60, 0.42, 0.51, 0.26], 'voicedAmp': 1.00, 'noise': 0.02, 'durationMs': 185},
        'AA': {'bands': [0.22, 0.47, 0.88, 0.58, 0.40, 0.28, 0.10, 0.26, 0.32, 0.15], 'voicedAmp': 1.00, 'noise': 0.02, 'durationMs': 185},
        'AO': {'bands': [0.20, 0.60, 1.00, 0.65, 0.40, 0.09, 0.06, 0.15, 0.20, 0.15], 'voicedAmp': 1.00, 'noise': 0.02, 'durationMs': 185},
        'AH': {'bands': [0.15, 0.36, 1.00, 0.47, 0.20, 0.12, 0.05, 0.10, 0.12, 0.48], 'voicedAmp': 1.00, 'noise': 0.02, 'durationMs': 170},
        'UH': {'bands': [0.20, 0.85, 0.55, 0.10, 0.15, 0.08, 0.08, 0.08, 0.30, 0.20], 'voicedAmp': 0.85, 'noise': 0.01, 'durationMs': 160},
        'UW': {'bands': [0.26, 1.00, 0.12, 0.01, 0.15, 0.05, 0.10, 0.11, 0.55, 0.34], 'voicedAmp': 0.80, 'noise': 0.01, 'durationMs': 200},
        'ER': {'bands': [0.16, 1.00, 0.92, 0.02, 0.21, 0.30, 0.08, 0.05, 0.32, 0.73], 'voicedAmp': 0.85, 'noise': 0.02, 'durationMs': 175},
        'OW': {'bands': [0.19, 0.86, 1.00, 0.29, 0.21, 0.00, 0.04, 0.04, 0.23, 0.25], 'voicedAmp': 0.90, 'noise': 0.01, 'durationMs': 195},
        'AW': {'bands': [0.21, 0.66, 0.72, 0.34, 0.28, 0.18, 0.09, 0.17, 0.31, 0.18], 'voicedAmp': 0.95, 'noise': 0.01, 'durationMs': 210},
        'AY': {'bands': [0.18, 0.74, 0.93, 0.30, 0.20, 0.20, 0.18, 0.29, 0.30, 0.19], 'voicedAmp': 0.95, 'noise': 0.01, 'durationMs': 210},
        'EY': {'bands': [0.23, 0.97, 0.90, 0.01, 0.00, 0.19, 0.75, 1.00, 0.93, 0.30], 'voicedAmp': 0.90, 'noise': 0.01, 'durationMs': 200},
        'OY': {'bands': [0.18, 0.48, 0.51, 0.33, 0.20, 0.05, 0.21, 0.58, 0.27, 0.18], 'voicedAmp': 0.95, 'noise': 0.01, 'durationMs': 210},
        'HH': {'bands': [0.02, 0.05, 0.10, 0.15, 0.25, 0.30, 0.25, 0.20, 0.12, 0.05], 'voicedAmp': 0.00, 'noise': 0.80, 'durationMs': 95},
        'F':  {'bands': [0.00, 0.00, 0.02, 0.05, 0.10, 0.30, 0.50, 0.70, 0.50, 0.20], 'voicedAmp': 0.00, 'noise': 0.90, 'durationMs': 135},
        'S':  {'bands': [0.00, 0.08, 0.00, 0.02, 0.05, 0.15, 0.40, 0.80, 1.00, 0.85], 'voicedAmp': 0.00, 'noise': 1.00, 'durationMs': 155},
        'SH': {'bands': [0.00, 0.00, 0.03, 0.08, 0.20, 0.50, 0.90, 0.70, 0.35, 0.15], 'voicedAmp': 0.00, 'noise': 1.00, 'durationMs': 140},
        'TH': {'bands': [0.00, 0.02, 0.04, 0.08, 0.15, 0.30, 0.40, 0.35, 0.20, 0.10], 'voicedAmp': 0.00, 'noise': 0.70, 'durationMs': 80},
        'V':  {'bands': [0.22, 0.18, 0.23, 0.08, 0.12, 0.32, 0.55, 0.75, 0.55, 0.22], 'voicedAmp': 0.62, 'noise': 0.48, 'durationMs': 130},
        'Z':  {'bands': [0.20, 0.10, 0.03, 0.03, 0.05, 0.15, 0.40, 0.80, 1.00, 0.85], 'voicedAmp': 0.50, 'noise': 0.55, 'durationMs': 105},
        'ZH': {'bands': [0.20, 0.10, 0.05, 0.08, 0.20, 0.50, 0.90, 0.70, 0.35, 0.15], 'voicedAmp': 0.50, 'noise': 0.55, 'durationMs': 120},
        'DH': {'bands': [0.25, 0.20, 0.08, 0.08, 0.15, 0.30, 0.40, 0.35, 0.20, 0.10], 'voicedAmp': 0.55, 'noise': 0.35, 'durationMs': 90},
        'M':  {'bands': [0.55, 0.75, 0.12, 0.04, 0.02, 0.02, 0.02, 0.02, 0.00, 0.00], 'voicedAmp': 0.60, 'noise': 0.01, 'durationMs': 125},
        'N':  {'bands': [0.45, 0.62, 0.45, 0.18, 0.05, 0.03, 0.06, 0.04, 0.00, 0.00], 'voicedAmp': 0.70, 'noise': 0.01, 'durationMs': 130},
        'NG': {'bands': [0.35, 0.40, 0.48, 0.28, 0.10, 0.04, 0.02, 0.02, 0.00, 0.00], 'voicedAmp': 0.60, 'noise': 0.01, 'durationMs': 125},
        'L':  {'bands': [0.30, 0.60, 0.30, 0.15, 0.55, 0.15, 0.10, 0.40, 0.03, 0.00], 'voicedAmp': 0.72, 'noise': 0.01, 'durationMs': 115},
        'R':  {'bands': [0.25, 0.55, 0.40, 0.15, 0.50, 0.50, 0.10, 0.15, 0.03, 0.00], 'voicedAmp': 0.72, 'noise': 0.01, 'durationMs': 115},
        'W':  {'bands': [0.30, 0.76, 0.56, 0.15, 0.00, 0.00, 0.03, 0.02, 0.00, 0.00], 'voicedAmp': 0.70, 'noise': 0.01, 'durationMs': 115},
        'Y':  {'bands': [0.25, 0.60, 0.15, 0.08, 0.10, 0.20, 0.80, 0.40, 0.20, 0.00], 'voicedAmp': 0.70, 'noise': 0.01, 'durationMs': 90},
        'B':  {'bands': [0.30, 0.35, 0.18, 0.08, 0.04, 0.02, 0.01, 0.00, 0.00, 0.00], 'voicedAmp': 0.45, 'noise': 0.02, 'durationMs': 65},
        'D':  {'bands': [0.25, 0.28, 0.15, 0.08, 0.06, 0.04, 0.02, 0.02, 0.00, 0.00], 'voicedAmp': 0.45, 'noise': 0.03, 'durationMs': 50},
        'G':  {'bands': [0.25, 0.28, 0.20, 0.10, 0.05, 0.03, 0.02, 0.01, 0.00, 0.00], 'voicedAmp': 0.45, 'noise': 0.02, 'durationMs': 60},
        'P':  {'bands': [0.05, 0.08, 0.05, 0.03, 0.02, 0.01, 0.00, 0.00, 0.00, 0.00], 'voicedAmp': 0.00, 'noise': 0.05, 'durationMs': 50},
        'T':  {'bands': [0.03, 0.05, 0.04, 0.03, 0.03, 0.02, 0.01, 0.02, 0.00, 0.00], 'voicedAmp': 0.00, 'noise': 0.08, 'durationMs': 40},
        'K':  {'bands': [0.03, 0.05, 0.04, 0.03, 0.02, 0.01, 0.00, 0.00, 0.00, 0.00], 'voicedAmp': 0.00, 'noise': 0.06, 'durationMs': 50},
        'CH': {'bands': [0.00, 0.00, 0.03, 0.08, 0.20, 0.50, 0.90, 0.70, 0.35, 0.15], 'voicedAmp': 0.00, 'noise': 0.45, 'durationMs': 70},
        'JH': {'bands': [0.15, 0.10, 0.05, 0.08, 0.20, 0.50, 0.85, 0.65, 0.30, 0.12], 'voicedAmp': 0.45, 'noise': 0.50, 'durationMs': 65},
    }
    # Global params: voicedGainMul, noiseGainMul, filterQMul, eqLowGain, eqMidGain, eqMidFreq(scaled), eqHighGain
    globals_ = {
        'voicedGainMul': 1.50,
        'noiseGainMul': 0.80,
        'filterQMul': 2.0,
        'eqLowGain': -4.0,   # dB, range -10 to +5
        'eqMidGain': 5.0,    # dB, range -5 to +12
        'eqMidFreq': 2800,   # Hz, range 1500 to 5000
        'eqHighGain': -3.0,  # dB, range -10 to +5
    }
    return phonemes, globals_


def params_to_vector(phonemes, globals_):
    """Flatten all params into a CMA-ES vector."""
    vec = []
    for ph in ALL_PHONEMES:
        p = phonemes[ph]
        vec.extend(p['bands'])             # 10 values, 0-1
        vec.append(p['voicedAmp'])         # 0-1
        vec.append(p['noise'])             # 0-1
        vec.append(p['durationMs'] / 300)  # normalize to ~0-1
    # Global params (normalized to ~0-1 range)
    vec.append(globals_['voicedGainMul'] / 3.0)    # 0-3 → 0-1
    vec.append(globals_['noiseGainMul'] / 2.0)     # 0-2 → 0-1
    vec.append(globals_['filterQMul'] / 4.0)       # 0-4 → 0-1
    vec.append((globals_['eqLowGain'] + 10) / 15)  # -10..+5 → 0-1
    vec.append((globals_['eqMidGain'] + 5) / 17)   # -5..+12 → 0-1
    vec.append((globals_['eqMidFreq'] - 1500) / 3500)  # 1500-5000 → 0-1
    vec.append((globals_['eqHighGain'] + 10) / 15) # -10..+5 → 0-1
    return np.array(vec)


def vector_to_params(vec):
    """Convert CMA-ES vector back to phoneme dict + globals."""
    phonemes = {}
    idx = 0
    for ph in ALL_PHONEMES:
        bands = list(np.clip(vec[idx:idx+10], 0.0, 1.0))
        voicedAmp = float(np.clip(vec[idx+10], 0.0, 1.0))
        noise = float(np.clip(vec[idx+11], 0.0, 1.0))
        durationMs = float(np.clip(vec[idx+12] * 300, 20, 400))
        phonemes[ph] = {'bands': bands, 'voicedAmp': voicedAmp, 'noise': noise, 'durationMs': durationMs}
        idx += PARAMS_PER_PHONEME

    globals_ = {
        'voicedGainMul': float(np.clip(vec[idx] * 3.0, 0.3, 3.0)),
        'noiseGainMul': float(np.clip(vec[idx+1] * 2.0, 0.1, 2.0)),
        'filterQMul': float(np.clip(vec[idx+2] * 4.0, 0.5, 4.0)),
        'eqLowGain': float(np.clip(vec[idx+3] * 15 - 10, -10, 5)),
        'eqMidGain': float(np.clip(vec[idx+4] * 17 - 5, -5, 12)),
        'eqMidFreq': float(np.clip(vec[idx+5] * 3500 + 1500, 1500, 5000)),
        'eqHighGain': float(np.clip(vec[idx+6] * 15 - 10, -10, 5)),
    }
    return phonemes, globals_


def render_with_params(phonemes, globals_, words):
    """Render using render-with-overrides.ts with full param overrides."""
    # Write combined override file
    override = {'phonemes': phonemes, 'globals': globals_}
    override_path = f'{WORK_DIR}/overrides.json'
    with open(override_path, 'w') as f:
        json.dump(override, f)

    tsx_path = os.path.join(VODER_DIR, 'node_modules', '.bin', 'tsx')
    script_path = os.path.join(VODER_DIR, 'scripts', 'render-with-overrides-v2.ts')

    try:
        result = subprocess.run(
            [tsx_path, script_path, override_path, WORK_DIR] + words,
            capture_output=True, timeout=30, cwd=VODER_DIR,
            env={**os.environ, 'PATH': f'{NODE_PATH}:{os.environ["PATH"]}'}
        )
        if result.returncode != 0:
            return False
    except subprocess.TimeoutExpired:
        return False
    return True


def evaluate(phonemes, globals_, words=TEST_WORDS):
    if not render_with_params(phonemes, globals_, words):
        return 1000.0

    total_score = 0.0
    for word in words:
        safe = word.replace(' ', '_').lower()
        wav_path = f'{WORK_DIR}/{safe}.wav'
        if not os.path.exists(wav_path):
            total_score -= 10.0
            continue
        audio = read_wav_16k(wav_path)
        _, score = ctc_score(audio, word)
        total_score += score

    return -total_score


def main():
    phonemes, globals_ = get_current_values()
    n_params = len(ALL_PHONEMES) * PARAMS_PER_PHONEME + N_GLOBAL

    print('=' * 60, flush=True)
    print('CMA-ES v2: ALL PARAMETERS', flush=True)
    print('=' * 60, flush=True)
    print(f'Phonemes: {len(ALL_PHONEMES)}', flush=True)
    print(f'Per-phoneme params: {PARAMS_PER_PHONEME} (10 bands + voicedAmp + noise + duration)', flush=True)
    print(f'Global params: {N_GLOBAL}', flush=True)
    print(f'Total params: {n_params}', flush=True)
    print(f'Test words: {", ".join(TEST_WORDS)}', flush=True)

    get_model()

    # Test render
    print('\nTesting render...', flush=True)
    ok = render_with_params(phonemes, globals_, ['yes'])
    if not ok:
        print('ERROR: Render failed!', flush=True)
        return
    print('Render OK.', flush=True)

    # Baseline
    print('\nBaseline...', flush=True)
    t0 = time.time()
    baseline_cost = evaluate(phonemes, globals_)
    print(f'Baseline: {baseline_cost:.2f} (CTC: {-baseline_cost:.2f}) [{time.time()-t0:.1f}s]', flush=True)

    # CMA-ES
    x0 = params_to_vector(phonemes, globals_)
    opts = cma.CMAOptions()
    opts['maxiter'] = 200
    opts['popsize'] = 20  # larger population for more params
    opts['bounds'] = [0.0, 1.0]
    opts['tolfun'] = 0.005
    opts['verb_disp'] = 0
    opts['verb_log'] = 0

    es = cma.CMAEvolutionStrategy(x0, 0.10, opts)  # smaller sigma for fine-tuning
    best_cost = baseline_cost
    best_phonemes = phonemes.copy()
    best_globals = globals_.copy()
    gen = 0

    while not es.stop():
        gen += 1
        solutions = es.ask()
        costs = []
        t0 = time.time()

        for sol in solutions:
            ph, gl = vector_to_params(sol)
            cost = evaluate(ph, gl)
            costs.append(cost)
            if cost < best_cost:
                best_cost = cost
                best_phonemes = ph.copy()
                best_globals = gl.copy()
                print(f'  ★ Gen {gen}: new best {cost:.2f} (CTC={-cost:.2f})', flush=True)

        es.tell(solutions, costs)
        elapsed = time.time() - t0
        print(f'Gen {gen}: best={best_cost:.2f} mean={np.mean(costs):.2f} [{elapsed:.0f}s]', flush=True)

        with open(f'{WORK_DIR}/best_params.json', 'w') as f:
            json.dump({'cost': best_cost, 'gen': gen, 'phonemes': best_phonemes, 'globals': best_globals}, f, indent=2)

    print(f'\nDONE: {baseline_cost:.2f} → {best_cost:.2f}', flush=True)
    print(f'Globals: {json.dumps(best_globals, indent=2)}', flush=True)
    with open(f'{WORK_DIR}/final_params.json', 'w') as f:
        json.dump({'phonemes': best_phonemes, 'globals': best_globals}, f, indent=2)


if __name__ == '__main__':
    main()
