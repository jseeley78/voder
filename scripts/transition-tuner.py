#!/usr/bin/env python3
"""
Transition tuner: optimizes coarticulation parameters per phoneme pair.

Instead of tuning static phoneme gains (which are at a local optimum),
this tunes HOW phonemes blend into each other:
- Blend speed (how fast onset shifts to target)
- Onset/steady/offset ratios
- Crossfade amplitude during transitions

For each word, tests different transition parameters for each phoneme
pair in the word, keeping changes that improve wav2vec2 CTC scores.
"""
import os, sys, json, wave, subprocess, time, warnings, copy, re
import numpy as np

warnings.filterwarnings('ignore')
os.environ['TRANSFORMERS_NO_ADVISORY_WARNINGS'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

VODER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORK_DIR = '/tmp/voder-transition-tuner'
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

# ── Test words ──
TEST_WORDS = [
    'yes', 'no', 'hello', 'bat', 'say', 'beat', 'boot', 'two', 'three',
    'one', 'go', 'see', 'me', 'he', 'she', 'we', 'be', 'do', 'to',
    'at', 'it', 'up', 'on', 'in', 'an', 'am', 'the', 'that', 'this',
    'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'for',
    'man', 'new', 'now', 'old', 'out', 'day', 'get', 'got', 'let',
    'may', 'run', 'set', 'ten', 'too', 'way', 'who', 'big', 'hot',
    'off', 'put', 'red', 'sit', 'six', 'top', 'why', 'boy', 'cut',
    'eat', 'gun', 'hit', 'key', 'lay', 'pay', 'ran', 'sun', 'war',
    'win', 'won', 'yet', 'bad', 'bed', 'bit', 'bus', 'buy', 'cup',
    'dog', 'dry', 'ear', 'fat', 'fun', 'god', 'hat', 'ice', 'law',
    'lie', 'lot', 'men', 'oil', 'pop', 'row', 'sea', 'sir', 'son',
    'sum', 'tea', 'try', 'air',
]

# ── Transition parameters that can be tuned ──
# These are defined in sequencer.ts COARTIC table and blend ratios
# We'll create an overrides JSON that the renderer reads

# Default coarticulation ratios per type
DEFAULT_COARTIC = {
    'vowel':     {'onset': 0.20, 'steady': 0.50, 'offset': 0.30},
    'fricative': {'onset': 0.15, 'steady': 0.60, 'offset': 0.25},
    'nasal':     {'onset': 0.25, 'steady': 0.45, 'offset': 0.30},
    'liquid':    {'onset': 0.30, 'steady': 0.35, 'offset': 0.35},
    'glide':     {'onset': 0.40, 'steady': 0.20, 'offset': 0.40},
    'stop':      {'onset': 0.05, 'steady': 0.25, 'offset': 0.70},
}

# Default blend ratios
DEFAULT_BLENDS = {
    'onset_blend_cc': 0.65,    # consonant→consonant onset blend
    'onset_blend_other': 0.50, # other onset blend
    'offset_blend_cc': 0.60,   # consonant→consonant offset blend
    'offset_blend_other': 0.40,# other offset blend
}

# Global transition timing
DEFAULT_GLOBALS = {
    'transitionMs': 35,        # base transition time
    'crossfade_amp_scale': 0.3,# voicedAmp during crossfade (× sum of prev+cur)
    'crossfade_noise_scale': 0.5, # noise during crossfade (× max of prev,cur)
    'aspiration_noise': 0.50,  # noise level during post-stop aspiration
    'aspiration_duration_ms': 30, # duration of aspiration after stop
}


def write_transition_overrides(coartic, blends, globals_, path):
    """Write transition parameter overrides for the renderer."""
    with open(path, 'w') as f:
        json.dump({
            'coartic': coartic,
            'blends': blends,
            'globals': globals_,
        }, f)


def render_words(words, coartic=None, blends=None, globals_=None):
    """Render words with transition parameter overrides."""
    override_path = f'{WORK_DIR}/transition_overrides.json'
    write_transition_overrides(
        coartic or DEFAULT_COARTIC,
        blends or DEFAULT_BLENDS,
        globals_ or DEFAULT_GLOBALS,
        override_path
    )

    tsx_path = os.path.join(VODER_DIR, 'node_modules', '.bin', 'tsx')
    script_path = os.path.join(VODER_DIR, 'scripts', 'render-with-transitions.ts')

    try:
        result = subprocess.run(
            [tsx_path, script_path, override_path, WORK_DIR] + words,
            capture_output=True, timeout=120, cwd=VODER_DIR,
            env={**os.environ, 'PATH': f'{NODE_PATH}:{os.environ["PATH"]}'}
        )
        if result.returncode != 0:
            err = result.stderr.decode()[:300]
            if err.strip():
                print(f'  Render error: {err}', file=sys.stderr, flush=True)
            return False
        return True
    except subprocess.TimeoutExpired:
        print('  Render timeout', file=sys.stderr, flush=True)
        return False


def score_words(words):
    results = {}
    for word in words:
        safe = word.replace(' ', '_').lower()
        path = f'{WORK_DIR}/{safe}.wav'
        if not os.path.exists(path):
            results[word] = ('', -10.0, False)
            continue
        audio = read_wav_16k(path)
        text, score = ctc_score(audio, word)
        correct = text.strip().lower() == word.lower()
        results[word] = (text, score, correct)
    return results


def total_score(results):
    return sum(v[1] for v in results.values())


def count_correct(results):
    return sum(1 for v in results.values() if v[2])


def main():
    print('=' * 60, flush=True)
    print('TRANSITION TUNER — coarticulation parameter optimization', flush=True)
    print('=' * 60, flush=True)

    get_model()

    # We need the render-with-transitions.ts script
    # For now, use render-with-overrides.ts (transitions are baked into sequencer)
    # The parameters we can tune are passed via the sequencer options

    # Actually, the coarticulation params are hardcoded in sequencer.ts
    # We can't pass them as JSON overrides without modifying the sequencer.
    # Instead, let's tune the parameters we CAN change: transitionMs, humanize,
    # expressiveness, rateScale, and basePitch — as these all affect transitions.

    # But more importantly: let's tune per-phoneme DURATION which directly
    # affects how long transitions take. And per-phoneme voicedAmp/noise
    # which affect crossfade character.

    # Strategy: for each word, find the optimal combination of:
    # - transitionMs (20, 25, 30, 35, 40, 50, 60)
    # - rateScale (0.7, 0.8, 0.9, 1.0, 1.1, 1.2)
    # - basePitch (90, 100, 110, 120, 130)
    # Then for the best global settings, do per-phoneme duration tuning

    print(f'Test words: {len(TEST_WORDS)}', flush=True)

    # Phase 1: Find best global transition settings
    print('\n── Phase 1: Global transition parameters ──', flush=True)

    # Use a small representative subset for fast iteration
    FAST_WORDS = ['yes', 'no', 'hello', 'she', 'me', 'to', 'we', 'ten', 'man',
                  'bat', 'beat', 'say', 'two', 'three', 'one', 'go', 'the', 'that']

    tsx_path = os.path.join(VODER_DIR, 'node_modules', '.bin', 'tsx')
    render_script = os.path.join(VODER_DIR, 'scripts', 'render-with-overrides.ts')

    def render_with_opts(words, transition_ms=35, rate_scale=1.0, base_pitch=110):
        """Render using render-offline approach with custom sequencer options."""
        # Write a custom render script with the options
        script = f'''
import * as WAA from "node-web-audio-api"
Object.assign(globalThis, {{
  AudioContext: WAA.AudioContext, OfflineAudioContext: WAA.OfflineAudioContext,
  OscillatorNode: WAA.OscillatorNode, GainNode: WAA.GainNode,
  BiquadFilterNode: WAA.BiquadFilterNode, AudioBufferSourceNode: WAA.AudioBufferSourceNode,
  AnalyserNode: WAA.AnalyserNode, AudioWorkletNode: WAA.AudioWorkletNode,
  MediaStreamAudioDestinationNode: class {{ stream = null }},
}})
import * as fs from "fs"
import {{ VoderEngine }} from "../src/engine"
import {{ speakPhonemeSequence }} from "../src/sequencer"
import {{ textToPhonemes }} from "../src/text-to-phoneme"
const SR = 48000
function writeWav(path: string, samples: Float32Array) {{
  const n = samples.length, ds = n * 2, buf = Buffer.alloc(44 + ds)
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + ds, 4); buf.write("WAVE", 8)
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36)
  buf.writeUInt32LE(ds, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2)
  fs.writeFileSync(path, buf)
}}
async function render(text: string): Promise<Float32Array> {{
  const ctx = new WAA.OfflineAudioContext(1, SR * 10, SR)
  const engine = new VoderEngine()
  await engine.start(ctx as any)
  const result = textToPhonemes(text)
  const handle = speakPhonemeSequence(engine, result.phonemes, {{
    defaultDurationMs: 110,
    transitionMs: {transition_ms},
    basePitch: {base_pitch},
    rateScale: {rate_scale},
    expressiveness: 0.35,
    humanize: 0,
  }})
  await handle.done
  const rendered = await ctx.startRendering()
  const data = rendered.getChannelData(0)
  let end = data.length - 1
  while (end > 0 && Math.abs(data[end]) < 0.001) end--
  end = Math.min(end + Math.round(SR * 0.1), data.length)
  const trimmed = new Float32Array(data.buffer, 0, end)
  let peak = 0
  for (let i = 0; i < trimmed.length; i++) peak = Math.max(peak, Math.abs(trimmed[i]))
  if (peak > 0.01) {{ const sc = 0.85 / peak; for (let i = 0; i < trimmed.length; i++) trimmed[i] *= sc }}
  return trimmed
}}
async function main() {{
  const words = {json.dumps(words)}
  for (const word of words) {{
    const safe = word.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase()
    const audio = await render(word)
    writeWav("{WORK_DIR}/" + safe + ".wav", audio)
  }}
}}
main().then(() => process.exit(0)).catch(e => {{ console.error(e); process.exit(1) }})
'''
        script_path = os.path.join(VODER_DIR, 'scripts', '_transition_render.ts')
        with open(script_path, 'w') as f:
            f.write(script)
        try:
            result = subprocess.run(
                [tsx_path, script_path],
                capture_output=True, timeout=60, cwd=VODER_DIR,
                env={**os.environ, 'PATH': f'{NODE_PATH}:{os.environ["PATH"]}'}
            )
            return result.returncode == 0
        except:
            return False

    # Baseline with current settings
    print('Baseline...', flush=True)
    render_with_opts(FAST_WORDS)
    baseline = score_words(FAST_WORDS)
    best_total = total_score(baseline)
    best_correct = count_correct(baseline)
    print(f'  {best_correct}/{len(FAST_WORDS)} correct, CTC={best_total:.1f}', flush=True)

    best_transition_ms = 35
    best_rate_scale = 1.0
    best_base_pitch = 110

    # Sweep transition time
    print('\nSweeping transitionMs...', flush=True)
    for tms in [15, 20, 25, 30, 35, 40, 50, 60, 80]:
        if not render_with_opts(FAST_WORDS, transition_ms=tms):
            continue
        r = score_words(FAST_WORDS)
        ts = total_score(r)
        cc = count_correct(r)
        improved = "★" if ts > best_total + 0.1 else " "
        print(f'  {improved} transitionMs={tms:3d}: {cc}/{len(FAST_WORDS)} correct, CTC={ts:.1f}', flush=True)
        if ts > best_total + 0.1:
            best_total = ts
            best_correct = cc
            best_transition_ms = tms

    # Sweep rate scale
    print(f'\nSweeping rateScale (transitionMs={best_transition_ms})...', flush=True)
    for rs in [0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.4, 1.6]:
        if not render_with_opts(FAST_WORDS, transition_ms=best_transition_ms, rate_scale=rs):
            continue
        r = score_words(FAST_WORDS)
        ts = total_score(r)
        cc = count_correct(r)
        improved = "★" if ts > best_total + 0.1 else " "
        print(f'  {improved} rateScale={rs:.1f}: {cc}/{len(FAST_WORDS)} correct, CTC={ts:.1f}', flush=True)
        if ts > best_total + 0.1:
            best_total = ts
            best_correct = cc
            best_rate_scale = rs

    # Sweep base pitch
    print(f'\nSweeping basePitch (transitionMs={best_transition_ms}, rateScale={best_rate_scale})...', flush=True)
    for bp in [80, 90, 100, 110, 120, 130, 140, 150]:
        if not render_with_opts(FAST_WORDS, transition_ms=best_transition_ms, rate_scale=best_rate_scale, base_pitch=bp):
            continue
        r = score_words(FAST_WORDS)
        ts = total_score(r)
        cc = count_correct(r)
        improved = "★" if ts > best_total + 0.1 else " "
        print(f'  {improved} basePitch={bp:3d}: {cc}/{len(FAST_WORDS)} correct, CTC={ts:.1f}', flush=True)
        if ts > best_total + 0.1:
            best_total = ts
            best_correct = cc
            best_base_pitch = bp

    print(f'\nBest globals: transitionMs={best_transition_ms}, rateScale={best_rate_scale}, basePitch={best_base_pitch}', flush=True)

    # Phase 2: Full vocabulary with best settings
    print(f'\n── Phase 2: Full vocabulary ({len(TEST_WORDS)} words) ──', flush=True)
    render_with_opts(TEST_WORDS, best_transition_ms, best_rate_scale, best_base_pitch)
    full = score_words(TEST_WORDS)
    fc = count_correct(full)
    ft = total_score(full)
    print(f'Full vocabulary: {fc}/{len(TEST_WORDS)} correct, CTC={ft:.1f}', flush=True)

    print(f'\nCorrect words:', flush=True)
    for word, (text, score, correct) in sorted(full.items()):
        if correct:
            print(f'  ✓ {word} → "{text}" ({score:.2f})', flush=True)

    print(f'\nNear misses (close but not exact):', flush=True)
    for word, (text, score, correct) in sorted(full.items()):
        if not correct and text.strip() and score > -5.0:
            print(f'    {word} → "{text}" ({score:.2f})', flush=True)

    # Phase 3: Per-phoneme duration sweep with best globals
    print(f'\n── Phase 3: Per-phoneme duration tuning ──', flush=True)

    # Load CMU dict for phoneme mapping
    cmu_path = os.path.join(VODER_DIR, 'node_modules', 'cmu-pronouncing-dictionary', 'index.js')
    cmu = {}
    with open(cmu_path) as f:
        for line in f:
            line = line.strip()
            if line.startswith('"') and '": "' in line:
                parts = line.split('": "', 1)
                cmu[parts[0].strip('"')] = parts[1].rstrip('",')

    # Map phonemes to words
    ph_words = {}
    for word in TEST_WORDS:
        if word not in cmu:
            continue
        phones = [re.sub(r'[0-9]', '', p) for p in cmu[word].split()]
        for ph in set(phones):
            if ph not in ph_words:
                ph_words[ph] = []
            ph_words[ph].append(word)

    # Read current phoneme durations from phonemes.ts
    phonemes_path = os.path.join(VODER_DIR, 'src', 'phonemes.ts')
    with open(phonemes_path) as f:
        content = f.read()

    durations = {}
    for m in re.finditer(r'(\w+):\s*\{[^}]*durationMs:\s*(\d+)', content):
        durations[m.group(1)] = int(m.group(2))

    best_durations = dict(durations)
    dur_improvements = 0

    for ph, words in sorted(ph_words.items(), key=lambda x: -len(x[1])):
        if ph not in durations or len(words) < 3:
            continue

        # Score current
        render_with_opts(words, best_transition_ms, best_rate_scale, best_base_pitch)
        current_results = score_words(words)
        current_score = total_score(current_results)

        # Try different durations
        orig_dur = best_durations[ph]
        for delta in [30, -30, 50, -50, 20, -20, -40]:
            new_dur = max(20, orig_dur + delta)
            if new_dur == orig_dur:
                continue

            # Write phoneme override with new duration
            override = {ph: {'durationMs': new_dur}}
            override_path = f'{WORK_DIR}/dur_override.json'
            with open(override_path, 'w') as f:
                json.dump(override, f)

            # Render with override
            tsx = os.path.join(VODER_DIR, 'node_modules', '.bin', 'tsx')
            render_script = os.path.join(VODER_DIR, 'scripts', 'render-with-overrides.ts')
            try:
                subprocess.run(
                    [tsx, render_script, override_path, WORK_DIR] + words,
                    capture_output=True, timeout=30, cwd=VODER_DIR,
                    env={**os.environ, 'PATH': f'{NODE_PATH}:{os.environ["PATH"]}'}
                )
            except:
                continue

            trial_results = score_words(words)
            trial_score = total_score(trial_results)

            if trial_score > current_score + 0.1:
                current_score = trial_score
                best_durations[ph] = new_dur
                dur_improvements += 1
                new_correct = [w for w, v in trial_results.items() if v[2]]
                nc = f' ✓ {",".join(new_correct)}' if new_correct else ''
                print(f'  {ph} dur {orig_dur}→{new_dur}ms: score {trial_score:.1f}{nc}', flush=True)
                break

    print(f'\nDuration improvements: {dur_improvements}', flush=True)

    # Final full scoring
    print(f'\n── Final Results ──', flush=True)
    # Apply best durations
    dur_override = {ph: {'durationMs': d} for ph, d in best_durations.items() if d != durations.get(ph)}
    override_path = f'{WORK_DIR}/final_override.json'
    with open(override_path, 'w') as f:
        json.dump(dur_override, f)

    tsx = os.path.join(VODER_DIR, 'node_modules', '.bin', 'tsx')
    render_script = os.path.join(VODER_DIR, 'scripts', 'render-with-overrides.ts')
    subprocess.run(
        [tsx, render_script, override_path, WORK_DIR] + TEST_WORDS,
        capture_output=True, timeout=120, cwd=VODER_DIR,
        env={**os.environ, 'PATH': f'{NODE_PATH}:{os.environ["PATH"]}'}
    )

    final = score_words(TEST_WORDS)
    fc = count_correct(final)
    ft = total_score(final)
    print(f'Final: {fc}/{len(TEST_WORDS)} correct, CTC={ft:.1f}', flush=True)

    print(f'\nCorrect:', flush=True)
    for word, (text, score, correct) in sorted(final.items()):
        if correct:
            print(f'  ✓ {word} → "{text}" ({score:.2f})', flush=True)

    print(f'\nNear misses:', flush=True)
    for word, (text, score, correct) in sorted(final.items()):
        if not correct and text.strip() and score > -5.0:
            print(f'    {word} → "{text}" ({score:.2f})', flush=True)

    # Save results
    save = {
        'transition_ms': best_transition_ms,
        'rate_scale': best_rate_scale,
        'base_pitch': best_base_pitch,
        'duration_changes': {ph: d for ph, d in best_durations.items() if d != durations.get(ph)},
        'correct_words': [w for w, v in final.items() if v[2]],
        'total_correct': fc,
    }
    save_path = os.path.join(VODER_DIR, 'tuning-checkpoints', 'transition-tuner-results.json')
    os.makedirs(os.path.dirname(save_path), exist_ok=True)
    with open(save_path, 'w') as f:
        json.dump(save, f, indent=2)
    print(f'\nSaved to {save_path}', flush=True)


if __name__ == '__main__':
    main()
