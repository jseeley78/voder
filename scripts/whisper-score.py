"""Score WAV files using Whisper. Reads wav_dir and words from args, writes JSON to output file."""
import ssl; ssl._create_default_https_context = ssl._create_unverified_context
import whisper, numpy as np, struct, os, json, sys

wav_dir = sys.argv[1]
words = sys.argv[2].split(',')
output_file = sys.argv[3]

model = whisper.load_model('tiny')

results = {}
for word in words:
    path = os.path.join(wav_dir, word + '.wav')
    if not os.path.exists(path):
        results[word] = {'text': '???', 'logprob': -2.0}
        continue
    with open(path, 'rb') as f:
        f.read(44)
        data = f.read()
    samples = np.array(struct.unpack(f'<{len(data)//2}h', data), dtype=np.float32) / 32768.0
    audio = whisper.pad_or_trim(samples.astype(np.float32))
    mel = whisper.log_mel_spectrogram(audio, n_mels=model.dims.n_mels).to(model.device)
    result = whisper.decode(model, mel, whisper.DecodingOptions(language='en', fp16=False))
    text = result.text.strip().lower().rstrip('.,!?')
    results[word] = {'text': text, 'logprob': float(result.avg_logprob)}

with open(output_file, 'w') as f:
    json.dump(results, f)
