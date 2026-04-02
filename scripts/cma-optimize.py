#!/usr/bin/env python3
"""
CMA-ES optimizer for Voder phoneme parameters.

Uses wav2vec2 CTC probability as the fitness function.
Optimizes band gains for vowel phonemes to maximize
speech recognition accuracy.
"""
import os, sys, json, wave, subprocess, time, warnings
import numpy as np
import cma

warnings.filterwarnings('ignore')
os.environ['TRANSFORMERS_NO_ADVISORY_WARNINGS'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

VODER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK_DIR = '/tmp/voder-cma'
NODE_PATH = '/Users/jeremiah/.nvm/versions/node/v20.19.5/bin'
os.makedirs(WORK_DIR, exist_ok=True)

# ── Lazy-load heavy models ──
_model = None
_processor = None
_device = None

def get_model():
    global _model, _processor, _device
    if _model is None:
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
        import torch
        _device = torch.device('mps') if torch.backends.mps.is_available() else torch.device('cpu')
        print(f'Loading wav2vec2 on {_device}...')
        _processor = Wav2Vec2Processor.from_pretrained('facebook/wav2vec2-large-960h-lv60-self')
        _model = Wav2Vec2ForCTC.from_pretrained('facebook/wav2vec2-large-960h-lv60-self')
        _model.eval().to(_device)
        # Warmup
        dummy = _processor(np.zeros(16000, dtype=np.float32), sampling_rate=16000, return_tensors='pt', padding=True)
        dummy = {k: v.to(_device) for k, v in dummy.items()}
        with torch.no_grad():
            _model(**dummy)
        print('Loaded and warmed up.')
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
    """CTC log-probability that audio matches target_text. Higher = better."""
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


# ── Parameters ──
TEST_WORDS = ['yes', 'no', 'hello', 'bat', 'say']
VOWELS_TO_OPTIMIZE = ['IY', 'IH', 'EH', 'AE', 'AA', 'AO', 'AH', 'UH', 'UW', 'ER', 'OW', 'EY']

CURRENT_GAINS = {
    'IY': [0.15, 0.36, 0.02, 0.00, 0.00, 0.01, 0.35, 1.00, 0.33, 0.20],
    'IH': [0.14, 1.00, 0.98, 0.01, 0.00, 0.11, 0.25, 0.32, 0.28, 0.23],
    'EH': [0.17, 0.51, 1.00, 0.35, 0.01, 0.48, 0.30, 0.29, 0.56, 0.09],
    'AE': [0.28, 0.57, 1.00, 0.70, 0.09, 0.96, 0.60, 0.42, 0.51, 0.26],
    'AA': [0.22, 0.47, 0.88, 0.58, 0.40, 0.28, 0.10, 0.26, 0.32, 0.15],
    'AO': [0.20, 0.60, 1.00, 0.65, 0.40, 0.09, 0.06, 0.15, 0.20, 0.15],
    'AH': [0.15, 0.36, 1.00, 0.47, 0.20, 0.12, 0.05, 0.10, 0.12, 0.48],
    'UH': [0.20, 0.85, 0.55, 0.10, 0.15, 0.08, 0.08, 0.08, 0.30, 0.20],
    'UW': [0.26, 1.00, 0.12, 0.01, 0.15, 0.05, 0.10, 0.11, 0.55, 0.34],
    'ER': [0.16, 1.00, 0.92, 0.02, 0.21, 0.30, 0.08, 0.05, 0.32, 0.73],
    'OW': [0.19, 0.86, 1.00, 0.29, 0.21, 0.00, 0.04, 0.04, 0.23, 0.25],
    'EY': [0.23, 0.97, 0.90, 0.01, 0.00, 0.19, 0.75, 1.00, 0.93, 0.30],
}

def gains_to_vector(gains_dict):
    vec = []
    for vowel in VOWELS_TO_OPTIMIZE:
        vec.extend(gains_dict[vowel])
    return np.array(vec)

def vector_to_gains(vec):
    gains = {}
    idx = 0
    for vowel in VOWELS_TO_OPTIMIZE:
        gains[vowel] = list(np.clip(vec[idx:idx+10], 0.0, 1.0))
        idx += 10
    return gains


def render_with_gains(gains, words):
    """Render words using the fixed render-with-overrides.ts script."""
    override_path = f'{WORK_DIR}/overrides.json'
    with open(override_path, 'w') as f:
        json.dump(gains, f)

    tsx_path = os.path.join(VODER_DIR, 'node_modules', '.bin', 'tsx')
    script_path = os.path.join(VODER_DIR, 'scripts', 'render-with-overrides.ts')

    try:
        result = subprocess.run(
            [tsx_path, script_path, override_path, WORK_DIR] + words,
            capture_output=True, timeout=30, cwd=VODER_DIR,
            env={**os.environ, 'PATH': f'{NODE_PATH}:{os.environ["PATH"]}'}
        )
        if result.returncode != 0:
            err = result.stderr.decode()[:200]
            print(f'  Render error: {err}', file=sys.stderr)
            return False
    except subprocess.TimeoutExpired:
        print('  Render timeout', file=sys.stderr)
        return False
    return True


def evaluate(gains_dict, words=TEST_WORDS):
    """Evaluate gains: render → score with wav2vec2. Returns cost (lower = better)."""
    if not render_with_gains(gains_dict, words):
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

    return -total_score  # negate: CMA-ES minimizes


def main():
    print('=' * 60)
    print('CMA-ES OPTIMIZER FOR VODER PHONEME GAINS')
    print(f'Device: MPS GPU' if 'mps' in str(_device or '') else 'CPU')
    print('=' * 60)
    print(f'Vowels: {", ".join(VOWELS_TO_OPTIMIZE)}')
    print(f'Parameters: {len(VOWELS_TO_OPTIMIZE) * 10}')
    print(f'Test words: {", ".join(TEST_WORDS)}')

    # Pre-load model
    get_model()

    # Test render first
    print('\nTesting render pipeline...')
    ok = render_with_gains(CURRENT_GAINS, ['yes'])
    if not ok:
        print('ERROR: Render failed. Fix before running optimizer.')
        return
    print('Render OK.')

    # Evaluate baseline
    print('\nEvaluating baseline...')
    t0 = time.time()
    baseline_cost = evaluate(CURRENT_GAINS)
    t1 = time.time()
    print(f'Baseline cost: {baseline_cost:.2f} (CTC: {-baseline_cost:.2f}) [{t1-t0:.1f}s]')

    # CMA-ES
    x0 = gains_to_vector(CURRENT_GAINS)
    opts = cma.CMAOptions()
    opts['maxiter'] = 100
    opts['popsize'] = 12
    opts['bounds'] = [0.0, 1.0]
    opts['tolfun'] = 0.01
    opts['verb_disp'] = 1
    opts['verb_log'] = 0

    es = cma.CMAEvolutionStrategy(x0, 0.15, opts)
    best_cost = baseline_cost
    best_gains = CURRENT_GAINS.copy()
    gen = 0

    while not es.stop():
        gen += 1
        solutions = es.ask()
        costs = []
        t0 = time.time()

        for sol in solutions:
            gains = vector_to_gains(sol)
            cost = evaluate(gains)
            costs.append(cost)
            if cost < best_cost:
                best_cost = cost
                best_gains = gains.copy()
                print(f'  ★ New best! cost={cost:.2f} (CTC={-cost:.2f})')

        es.tell(solutions, costs)
        elapsed = time.time() - t0
        print(f'Gen {gen}: best={best_cost:.2f} mean={np.mean(costs):.2f} [{elapsed:.0f}s]')

        with open(f'{WORK_DIR}/best_gains.json', 'w') as f:
            json.dump({'cost': best_cost, 'gains': best_gains, 'gen': gen}, f, indent=2)

    # Final
    print('\n' + '=' * 60)
    print(f'DONE: {baseline_cost:.2f} → {best_cost:.2f} (improvement: {baseline_cost - best_cost:.2f})')
    for vowel in VOWELS_TO_OPTIMIZE:
        if vowel in best_gains:
            g = best_gains[vowel]
            print(f'  {vowel}: [{", ".join(f"{v:.2f}" for v in g)}]')

    with open(f'{WORK_DIR}/final_gains.json', 'w') as f:
        json.dump(best_gains, f, indent=2)
    print(f'\nSaved to {WORK_DIR}/final_gains.json')


if __name__ == '__main__':
    main()
