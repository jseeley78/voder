#!/usr/bin/env python3
"""
Focused per-phoneme tuner with large vocabulary.

For each phoneme, tests small band gain changes against words that
use that phoneme. Keeps changes that improve wav2vec2 CTC scores.
Iterates until no more improvements found.

Uses MPS GPU for fast wav2vec2 inference.
"""
import os, sys, json, wave, subprocess, time, warnings, copy
import numpy as np

warnings.filterwarnings('ignore')
os.environ['TRANSFORMERS_NO_ADVISORY_WARNINGS'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

VODER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK_DIR = '/tmp/voder-phoneme-tuner'
NODE_PATH = '/Users/jeremiah/.nvm/versions/node/v20.19.5/bin'
os.makedirs(WORK_DIR, exist_ok=True)

# ── Model ──
_model = None
_processor = None
_device = None

def get_model():
    global _model, _processor, _device
    if _model is None:
        import torch
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
        _device = torch.device('mps') if torch.backends.mps.is_available() else torch.device('cpu')
        print(f'Loading wav2vec2 on {_device}...', flush=True)
        _processor = Wav2Vec2Processor.from_pretrained('facebook/wav2vec2-large-960h-lv60-self')
        _model = Wav2Vec2ForCTC.from_pretrained('facebook/wav2vec2-large-960h-lv60-self')
        _model.eval().to(_device)
        # Warmup
        dummy = _processor(np.zeros(16000, dtype=np.float32), sampling_rate=16000, return_tensors='pt', padding=True)
        import torch as th
        with th.no_grad():
            _model(**{k: v.to(_device) for k, v in dummy.items()})
        print('Ready.', flush=True)
    return _model, _processor, _device

def read_wav_16k(path):
    from scipy.signal import resample
    with wave.open(path, 'rb') as wf:
        sr = wf.getframerate()
        raw = wf.readframes(wf.getnframes())
        s = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if sr != 16000:
        s = resample(s, int(len(s) * 16000 / sr)).astype(np.float32)
    return s

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

# ── Test vocabulary ──
# Words chosen to cover all common phonemes with short, recognizable words
TEST_WORDS = [
    'yes', 'no', 'hello', 'bat', 'say', 'beat', 'boot', 'two', 'three',
    'one', 'go', 'see', 'me', 'he', 'she', 'we', 'be', 'do', 'to',
    'at', 'it', 'up', 'on', 'in', 'an', 'am', 'is', 'of', 'or',
    'the', 'that', 'this', 'with', 'but', 'not', 'you', 'all', 'can',
    'had', 'her', 'was', 'for', 'are', 'his', 'has', 'him', 'how',
    'man', 'new', 'now', 'old', 'out', 'own', 'day', 'get', 'got',
    'let', 'may', 'run', 'set', 'ten', 'too', 'use', 'way', 'who',
    'big', 'did', 'end', 'far', 'few', 'hot', 'low', 'off', 'put',
    'red', 'sit', 'six', 'top', 'why', 'boy', 'cut', 'eat', 'eye',
    'fly', 'gun', 'hit', 'job', 'key', 'lay', 'map', 'pay', 'ran',
    'sun', 'war', 'win', 'won', 'yet', 'bad', 'bed', 'bit', 'box',
    'bus', 'buy', 'car', 'cup', 'dog', 'dry', 'ear', 'fat', 'fun',
    'god', 'hat', 'ice', 'law', 'lie', 'lot', 'men', 'nor', 'oil',
    'pop', 'row', 'sea', 'sir', 'son', 'sum', 'tea', 'try', 'air',
]

# ── Phoneme → word mapping ──
# Load CMU dict to find which phonemes each word uses
def load_cmu_dict():
    cmu_path = os.path.join(VODER_DIR, 'node_modules', 'cmu-pronouncing-dictionary', 'index.js')
    cmu = {}
    import re
    with open(cmu_path) as f:
        for line in f:
            line = line.strip()
            if line.startswith('"') and '": "' in line:
                parts = line.split('": "', 1)
                word = parts[0].strip('"')
                pron = parts[1].rstrip('",')
                cmu[word] = pron
    return cmu

def strip_stress(ph):
    import re
    return re.sub(r'[0-9]', '', ph)

def get_phoneme_words(cmu):
    """Map each phoneme to the test words that use it."""
    ph_words = {}
    for word in TEST_WORDS:
        if word not in cmu:
            continue
        phones = [strip_stress(p) for p in cmu[word].split()]
        for ph in set(phones):
            if ph not in ph_words:
                ph_words[ph] = []
            ph_words[ph].append(word)
    return ph_words

# ── Rendering ──
def render_words(words, overrides=None):
    override_path = f'{WORK_DIR}/overrides.json'
    with open(override_path, 'w') as f:
        json.dump(overrides or {}, f)

    tsx_path = os.path.join(VODER_DIR, 'node_modules', '.bin', 'tsx')
    script_path = os.path.join(VODER_DIR, 'scripts', 'render-with-overrides.ts')

    try:
        result = subprocess.run(
            [tsx_path, script_path, override_path, WORK_DIR] + words,
            capture_output=True, timeout=60, cwd=VODER_DIR,
            env={**os.environ, 'PATH': f'{NODE_PATH}:{os.environ["PATH"]}'}
        )
        return result.returncode == 0
    except:
        return False

def score_words(words):
    """Score all words, return dict of word → (transcription, ctc_score)."""
    results = {}
    for word in words:
        safe = word.replace(' ', '_').lower()
        path = f'{WORK_DIR}/{safe}.wav'
        if not os.path.exists(path):
            results[word] = ('', -10.0)
            continue
        audio = read_wav_16k(path)
        text, score = ctc_score(audio, word)
        correct = text.strip().lower() == word.lower()
        results[word] = (text, score, correct)
    return results

# ── Current phoneme values ──
def load_current_phonemes():
    """Read current phoneme bands from phonemes.ts."""
    import re
    phonemes = {}
    path = os.path.join(VODER_DIR, 'src', 'phonemes.ts')
    with open(path) as f:
        content = f.read()

    # Parse each phoneme entry
    pattern = r"(\w+):\s*\{[^}]*bands:\s*\[([^\]]+)\][^}]*voicedAmp:\s*([\d.]+)[^}]*noise:\s*([\d.]+)[^}]*durationMs:\s*(\d+)"
    for m in re.finditer(pattern, content):
        ph = m.group(1)
        bands = [float(x.strip()) for x in m.group(2).split(',')]
        phonemes[ph] = {
            'bands': bands,
            'voicedAmp': float(m.group(3)),
            'noise': float(m.group(4)),
            'durationMs': int(m.group(5)),
        }
    return phonemes

# ── Main tuning loop ──
def main():
    print('=' * 60, flush=True)
    print('PHONEME TUNER — per-phoneme hill climbing', flush=True)
    print('=' * 60, flush=True)

    get_model()

    cmu = load_cmu_dict()
    ph_words = get_phoneme_words(cmu)
    phonemes = load_current_phonemes()

    # Filter test words to those in CMU dict
    valid_words = [w for w in TEST_WORDS if w in cmu]
    print(f'Test words: {len(valid_words)} (of {len(TEST_WORDS)})', flush=True)
    print(f'Phonemes with test coverage: {len(ph_words)}', flush=True)

    # Baseline
    print('\nRendering baseline...', flush=True)
    if not render_words(valid_words):
        print('ERROR: Render failed', flush=True)
        return

    print('Scoring baseline...', flush=True)
    baseline = score_words(valid_words)
    correct = sum(1 for _, v in baseline.items() if len(v) > 2 and v[2])
    total_ctc = sum(v[1] for v in baseline.values())
    print(f'Baseline: {correct}/{len(valid_words)} correct, total CTC: {total_ctc:.1f}', flush=True)
    for word, (text, score, *rest) in sorted(baseline.items()):
        c = rest[0] if rest else False
        if c or text.strip():
            mark = "✓" if c else " "
            print(f'  {mark} {word:>8} → "{text}" ({score:.2f})', flush=True)

    # Sort phonemes by number of test words (most coverage first)
    sorted_phonemes = sorted(ph_words.items(), key=lambda x: -len(x[1]))

    best_phonemes = copy.deepcopy(phonemes)
    total_improvements = 0
    round_num = 0

    # Iterate until no more improvements
    for round_num in range(1, 20):  # max 20 rounds
        print(f'\n{"="*60}', flush=True)
        print(f'ROUND {round_num}', flush=True)
        print(f'{"="*60}', flush=True)
        improvements_this_round = 0

        for ph, words in sorted_phonemes:
            if ph not in best_phonemes:
                continue
            if len(words) < 2:
                continue

            current = best_phonemes[ph]
            best_score = None

            # Score current state for this phoneme's words
            if not render_words(words, best_phonemes):
                continue
            current_results = score_words(words)
            best_score = sum(v[1] for v in current_results.values())

            # Try tweaking each band
            for b in range(10):
                for delta in [0.10, -0.10, 0.20, -0.20, 0.05, -0.05]:
                    orig = current['bands'][b]
                    new_val = max(0.0, min(1.0, orig + delta))
                    if abs(new_val - orig) < 0.01:
                        continue

                    trial = copy.deepcopy(best_phonemes)
                    trial[ph]['bands'][b] = new_val

                    if not render_words(words, trial):
                        continue
                    trial_results = score_words(words)
                    trial_score = sum(v[1] for v in trial_results.values())

                    if trial_score > best_score + 0.05:
                        best_score = trial_score
                        best_phonemes[ph]['bands'][b] = new_val
                        improvements_this_round += 1
                        total_improvements += 1
                        # Check if any new correct words
                        new_correct = [w for w, v in trial_results.items() if len(v) > 2 and v[2]]
                        nc_str = f' ✓ {",".join(new_correct)}' if new_correct else ''
                        print(f'  {ph} B{b} {delta:+.2f}: score {trial_score:.2f}{nc_str}', flush=True)
                        break  # take first improvement for this band

            # Try duration changes
            for delta_dur in [20, -20, 40, -40]:
                orig_dur = current['durationMs']
                new_dur = max(20, orig_dur + delta_dur)

                trial = copy.deepcopy(best_phonemes)
                trial[ph]['durationMs'] = new_dur

                if not render_words(words, trial):
                    continue
                trial_results = score_words(words)
                trial_score = sum(v[1] for v in trial_results.values())

                if trial_score > best_score + 0.05:
                    best_score = trial_score
                    best_phonemes[ph]['durationMs'] = new_dur
                    improvements_this_round += 1
                    total_improvements += 1
                    print(f'  {ph} dur {delta_dur:+d}ms: score {trial_score:.2f}', flush=True)
                    break

            # Try voicedAmp/noise changes
            for param in ['voicedAmp', 'noise']:
                for delta in [0.05, -0.05, 0.10, -0.10]:
                    orig = current[param]
                    new_val = max(0.0, min(1.0, orig + delta))
                    if abs(new_val - orig) < 0.01:
                        continue

                    trial = copy.deepcopy(best_phonemes)
                    trial[ph][param] = new_val

                    if not render_words(words, trial):
                        continue
                    trial_results = score_words(words)
                    trial_score = sum(v[1] for v in trial_results.values())

                    if trial_score > best_score + 0.05:
                        best_score = trial_score
                        best_phonemes[ph][param] = new_val
                        improvements_this_round += 1
                        total_improvements += 1
                        print(f'  {ph} {param} {delta:+.2f}: score {trial_score:.2f}', flush=True)
                        break

        print(f'\nRound {round_num}: {improvements_this_round} improvements', flush=True)

        # Save checkpoint
        with open(f'{WORK_DIR}/best_phonemes.json', 'w') as f:
            json.dump({'round': round_num, 'improvements': total_improvements, 'phonemes': best_phonemes}, f, indent=2)
        # Also copy to project dir for safety
        os.makedirs(os.path.join(VODER_DIR, 'tuning-checkpoints'), exist_ok=True)
        with open(os.path.join(VODER_DIR, 'tuning-checkpoints', 'phoneme-tuner-latest.json'), 'w') as f:
            json.dump({'round': round_num, 'improvements': total_improvements, 'phonemes': best_phonemes}, f, indent=2)

        if improvements_this_round == 0:
            print('No improvements — converged.', flush=True)
            break

    # Final scoring
    print(f'\n{"="*60}', flush=True)
    print('FINAL RESULTS', flush=True)
    print(f'{"="*60}', flush=True)

    render_words(valid_words, best_phonemes)
    final = score_words(valid_words)
    correct = sum(1 for v in final.values() if len(v) > 2 and v[2])
    total_ctc = sum(v[1] for v in final.values())
    print(f'Score: {correct}/{len(valid_words)} correct, CTC: {total_ctc:.1f}', flush=True)
    print(f'Total improvements: {total_improvements} over {round_num} rounds', flush=True)

    for word, (text, score, *rest) in sorted(final.items()):
        c = rest[0] if rest else False
        if c or text.strip():
            mark = "✓" if c else " "
            print(f'  {mark} {word:>8} → "{text}" ({score:.2f})')

    # Print changed phonemes
    print(f'\n{"="*60}', flush=True)
    print('CHANGED PHONEMES', flush=True)
    print(f'{"="*60}', flush=True)
    for ph in sorted(best_phonemes.keys()):
        if ph not in phonemes:
            continue
        orig = phonemes[ph]
        best = best_phonemes[ph]
        if orig['bands'] != best['bands'] or orig['durationMs'] != best['durationMs'] or orig['voicedAmp'] != best['voicedAmp'] or orig['noise'] != best['noise']:
            print(f'  {ph}: bands=[{",".join(f"{v:.2f}" for v in best["bands"])}] dur={best["durationMs"]} vAmp={best["voicedAmp"]:.2f} noise={best["noise"]:.2f}', flush=True)

if __name__ == '__main__':
    main()
