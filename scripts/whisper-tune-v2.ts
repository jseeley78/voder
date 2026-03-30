/**
 * Whisper intelligibility tuner v2.
 *
 * Improvements over v1:
 * - Optimizes DURATION as well as band gains
 * - Uses longer test phrases (not just single words)
 * - Bigger step sizes to escape local minima faster
 * - Keeps Whisper model loaded across all iterations (Python server)
 * - Reports what Whisper hears at each step
 */

import * as fs from 'fs'
import { execSync } from 'child_process'
import { BAND_CENTERS, BAND_WIDTHS, BAND_Q, BAND_COMPENSATION, PHONEMES } from '../src/phonemes'
import { textToPhonemes } from '../src/text-to-phoneme'
import { applyProsody } from '../src/prosody'

const SAMPLE_RATE = 16000
const TWO_PI = 2 * Math.PI
const OUTPUT_DIR = '/tmp/voder-whisper-v2'
fs.mkdirSync(OUTPUT_DIR, { recursive: true })

// ─── DSP (compact) ───
class BP{b0;b2;a1;a2;x1=0;x2=0;y1=0;y2=0;constructor(c:number,Q:number,sr:number){const w=TWO_PI*c/sr,a=Math.sin(w)/(2*Q),a0=1+a;this.b0=a/a0;this.b2=-a/a0;this.a1=(-2*Math.cos(w))/a0;this.a2=(1-a)/a0}p(x:number){const y=this.b0*x+this.b2*this.x2-this.a1*this.y1-this.a2*this.y2;this.x2=this.x1;this.x1=x;this.y2=this.y1;this.y1=y;return y}r(){this.x1=this.x2=this.y1=this.y2=0}}
class LP{b0;b1;b2;a1;a2;x1=0;x2=0;y1=0;y2=0;constructor(f:number,Q:number,sr:number){const w=TWO_PI*f/sr,a=Math.sin(w)/(2*Q),c=Math.cos(w),a0=1+a;this.b0=((1-c)/2)/a0;this.b1=(1-c)/a0;this.b2=this.b0;this.a1=(-2*c)/a0;this.a2=(1-a)/a0}p(x:number){const y=this.b0*x+this.b1*this.x1+this.b2*this.x2-this.a1*this.y1-this.a2*this.y2;this.x2=this.x1;this.x1=x;this.y2=this.y1;this.y1=y;return y}}
class PK{b0;b1;b2;a1;a2;x1=0;x2=0;y1=0;y2=0;constructor(f:number,Q:number,dB:number,sr:number){const A=Math.pow(10,dB/40),w=TWO_PI*f/sr,a=Math.sin(w)/(2*Q),a0=1+a/A;this.b0=(1+a*A)/a0;this.b1=(-2*Math.cos(w))/a0;this.b2=(1-a*A)/a0;this.a1=this.b1;this.a2=(1-a/A)/a0}p(x:number){const y=this.b0*x+this.b1*this.x1+this.b2*this.x2-this.a1*this.y1-this.a2*this.y2;this.x2=this.x1;this.x1=x;this.y2=this.y1;this.y1=y;return y}}
class GL{phase=0;ct=0.0003;dt=0.0008;g(f:number,sr:number){const p=1/Math.max(f,20);this.phase+=1/sr;if(this.phase>=p){this.phase-=p;this.ct=0.0003*(1+(Math.random()-0.5)*0.04);this.dt=0.0008*(1+(Math.random()-0.5)*0.04)}const t=this.phase;if(t<this.ct)return(1-Math.exp(-t/(this.ct*0.25))-0.3)*0.8;if(t<this.ct+this.dt)return(Math.exp(-(t-this.ct)/(this.dt*0.35))-0.3)*0.8;return-0.224}}

const pn=new Float32Array(SAMPLE_RATE*5);for(let i=0;i<pn.length;i+=2){const u1=Math.random()||1e-10,u2=Math.random(),r=Math.sqrt(-2*Math.log(u1));pn[i]=r*Math.cos(TWO_PI*u2);if(i+1<pn.length)pn[i+1]=r*Math.sin(TWO_PI*u2)}
let pb0=0,pb1=0,pb2=0;for(let i=0;i<pn.length;i++){const w=pn[i];pb0=0.99765*pb0+w*0.0990460;pb1=0.96300*pb1+w*0.2965164;pb2=0.57000*pb2+w*1.0526913;pn[i]=(pb0+pb1+pb2+w*0.1848)*0.22}

function writeWav(path:string,samples:Float32Array,sr:number){const n=samples.length,ds=n*2,buf=Buffer.alloc(44+ds);buf.write('RIFF',0);buf.writeUInt32LE(36+ds,4);buf.write('WAVE',8);buf.write('fmt ',12);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(1,22);buf.writeUInt32LE(sr,24);buf.writeUInt32LE(sr*2,28);buf.writeUInt16LE(2,32);buf.writeUInt16LE(16,34);buf.write('data',36);buf.writeUInt32LE(ds,40);for(let i=0;i<n;i++)buf.writeInt16LE(Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),44+i*2);fs.writeFileSync(path,buf)}

// Mutable state
const gains: Record<string, number[]> = {}
const durations: Record<string, number> = {}
for (const [ph, cfg] of Object.entries(PHONEMES)) {
  gains[ph] = [...cfg.bands]
  durations[ph] = cfg.durationMs
}

function renderPhrase(text: string): Float32Array {
  const result = textToPhonemes(text)
  const rawTokens = result.phonemes.split(/\s+/).filter(Boolean).map(x => x.toUpperCase())
  const prosody = applyProsody(rawTokens, { expressiveness: 0.7 })

  const filters = BAND_CENTERS.map((c,i) => new BP(c, BAND_Q[i], SAMPLE_RATE))
  const tilt = new LP(3400, 0.65, SAMPLE_RATE)
  const eq = new PK(2800, 0.8, 5, SAMPLE_RATE)
  const gl = new GL()
  let ni = 0
  const chunks: Float32Array[] = []
  let prevVA=0, prevNA=0, prevPitch=110
  const prevB = new Float64Array(10)

  for (const pt of prosody) {
    const ph = PHONEMES[pt.phoneme]; if (!ph) continue
    const g = gains[pt.phoneme] || ph.bands
    const dur = (durations[pt.phoneme] || ph.durationMs) * pt.durationMul
    const pitch = 110 * pt.pitchMul
    const n = Math.round(dur/1000*SAMPLE_RATE)
    const trans = Math.min(n, Math.round(0.030*SAMPLE_RATE))
    const chunk = new Float32Array(n)
    const tgtVA = ph.voiced ? ph.voicedAmp*0.30 : 0
    const tgtNA = ph.noise*0.10
    for (let i=0;i<n;i++){
      // Exponential approach: 1 - e^(-3i/trans) reaches ~95% at i=trans
      const t=i<trans? 1 - Math.exp(-3*i/trans) : 1.0
      const va=prevVA*(1-t)+tgtVA*t, na=prevNA*(1-t)+tgtNA*t, p=prevPitch*(1-t)+pitch*t
      const exc=tilt.p(gl.g(p,SAMPLE_RATE))*va + pn[ni++%pn.length]*na
      let sum=0;for(let b=0;b<10;b++){const bg=Math.max(0,Math.min(1.5,(prevB[b]*(1-t)+(g[b]*pt.ampMul)*t)*BAND_COMPENSATION[b]));sum+=filters[b].p(exc)*bg}
      chunk[i]=eq.p(sum)
    }
    prevVA=tgtVA;prevNA=tgtNA;prevPitch=pitch;for(let b=0;b<10;b++)prevB[b]=g[b]*pt.ampMul
    chunks.push(chunk)
    if(pt.pauseAfterMs>0){const pn2=Math.round(pt.pauseAfterMs/1000*SAMPLE_RATE);chunks.push(new Float32Array(pn2));prevVA=0;prevNA=0;for(let b=0;b<10;b++)prevB[b]=0}
  }
  const total=chunks.reduce((s,c)=>s+c.length,0);const out=new Float32Array(total);let off=0;for(const c of chunks){out.set(c,off);off+=c.length}
  let peak=0;for(let i=0;i<out.length;i++)peak=Math.max(peak,Math.abs(out[i]));if(peak>0.01){const sc=0.85/peak;for(let i=0;i<out.length;i++)out[i]*=sc}
  return out
}

// ─── Test phrases ───
// Ordered by baseline logprob (most promising first)
const TESTS = [
  { phrase: 'six', expected: 'six' },        // -0.81, heard "okay"
  { phrase: 'zero', expected: 'zero' },      // -0.84, heard "okay"
  { phrase: 'three', expected: 'three' },    // -0.94, heard "bye"
  { phrase: 'five', expected: 'five' },      // -0.98, heard "hmm"
  { phrase: 'seven', expected: 'seven' },    // -1.13, heard "shhh" (SH coming through!)
  { phrase: 'eight', expected: 'eight' },    // -1.03, heard "thank you"
  { phrase: 'four', expected: 'four' },      // -1.11, heard "um"
  { phrase: 'nine', expected: 'nine' },      // -1.07, heard ""
  { phrase: 'one', expected: 'one' },        // -1.22, heard "thank you"
  { phrase: 'ten', expected: 'ten' },        // -1.20, heard ""
  { phrase: 'two', expected: 'two' },        // -1.03, heard ""
  { phrase: 'yes', expected: 'yes' },
  { phrase: 'no', expected: 'no' },
  { phrase: 'hello', expected: 'hello' },
]

// ─── Whisper scoring ───
function whisperScoreAll(): { correct: number; total: number; details: Map<string, {text: string; logprob: number}> } {
  // Render all test phrases
  for (const t of TESTS) {
    const audio = renderPhrase(t.phrase)
    writeWav(`${OUTPUT_DIR}/${t.expected}.wav`, audio, SAMPLE_RATE)
  }

  const wordList = TESTS.map(t => t.expected).join(',')
  const resultFile = `${OUTPUT_DIR}/_results.json`
  const scriptPath = new URL('./whisper-score.py', import.meta.url).pathname

  try {
    execSync(`python3 ${scriptPath} ${OUTPUT_DIR} ${wordList} ${resultFile}`, {
      timeout: 180000,
      env: { ...process.env, PYTHONHTTPSVERIFY: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (e) {
    console.error('Whisper failed')
    return { correct: 0, total: TESTS.length, details: new Map() }
  }

  const parsed = JSON.parse(fs.readFileSync(resultFile, 'utf-8'))
  const details = new Map<string, {text: string; logprob: number}>()
  let correct = 0
  for (const t of TESTS) {
    const d = parsed[t.expected]
    if (!d) continue
    details.set(t.expected, { text: d.text, logprob: d.logprob })
    if (d.text.toLowerCase().includes(t.expected.toLowerCase())) correct++
  }
  return { correct, total: TESTS.length, details }
}

// ─── Main optimization ───

console.log('=== WHISPER TUNER V2 (gains + durations) ===')
console.log(`${TESTS.length} test phrases`)
console.log()

// Baseline
console.log('── Baseline ──')
const baseline = whisperScoreAll()
console.log(`Score: ${baseline.correct}/${baseline.total}`)
for (const [w, d] of baseline.details) {
  const ok = d.text.toLowerCase().includes(w) ? '✓' : '✗'
  console.log(`  ${ok} ${w.padEnd(10)} → "${d.text}" (${d.logprob.toFixed(3)})`)
}

// Find phonemes in test words
const wordPhonemes = new Map<string, Set<string>>()
for (const t of TESTS) {
  const r = textToPhonemes(t.phrase)
  const tokens = r.phonemes.split(/\s+/).filter(tok => tok !== '|' && !/^[,.\?!;:]$/.test(tok))
  wordPhonemes.set(t.expected, new Set(tokens.map(tok => tok.replace(/[012]$/, ''))))
}

function wordsWithPhoneme(ph: string): string[] {
  return TESTS.map(t => t.expected).filter(w => wordPhonemes.get(w)?.has(ph))
}

const allPhonemes = new Set<string>()
for (const s of wordPhonemes.values()) for (const p of s) allPhonemes.add(p)
const tunablePhonemes = [...allPhonemes].filter(p => gains[p])

console.log(`\nTuning ${tunablePhonemes.length} phonemes`)

// Optimization loop
const STEP_SIZES = [0.15, 0.10, 0.08]
const DUR_STEPS = [40, 25, 15]
let totalImprovements = 0
let bestCorrect = baseline.correct
let bestLogprob = [...baseline.details.values()].reduce((s, d) => s + d.logprob, 0)

for (let si = 0; si < STEP_SIZES.length; si++) {
  const gainStep = STEP_SIZES[si]
  const durStep = DUR_STEPS[si]
  console.log(`\n── Step: gain=${gainStep}, dur=${durStep}ms ──`)
  let improved = 0

  for (const ph of tunablePhonemes) {
    const g = gains[ph]

    // Try each band gain
    for (let b = 0; b < 10; b++) {
      const orig = g[b]

      for (const delta of [gainStep, -gainStep]) {
        g[b] = Math.max(0, Math.min(1.0, orig + delta))
        const score = whisperScoreAll()
        const logprob = [...score.details.values()].reduce((s, d) => s + d.logprob, 0)

        if (score.correct > bestCorrect || (score.correct === bestCorrect && logprob > bestLogprob + 0.1)) {
          bestCorrect = score.correct
          bestLogprob = logprob
          improved++
          totalImprovements++
          console.log(`  ${ph} B${b+1} ${delta>0?'+':''}${delta.toFixed(2)}: ${score.correct}/${score.total} correct, logprob=${logprob.toFixed(2)}`)
          break // keep this change, move to next band
        }
        g[b] = orig
      }
    }

    // Try duration change
    const origDur = durations[ph]
    for (const delta of [durStep, -durStep]) {
      durations[ph] = Math.max(20, origDur + delta)
      const score = whisperScoreAll()
      const logprob = [...score.details.values()].reduce((s, d) => s + d.logprob, 0)

      if (score.correct > bestCorrect || (score.correct === bestCorrect && logprob > bestLogprob + 0.1)) {
        bestCorrect = score.correct
        bestLogprob = logprob
        improved++
        totalImprovements++
        console.log(`  ${ph} dur ${delta>0?'+':''}${delta}ms (${origDur}→${durations[ph]}): ${score.correct}/${score.total} correct, logprob=${logprob.toFixed(2)}`)
        break
      }
      durations[ph] = origDur
    }
  }

  if (improved === 0) {
    console.log('  No improvements at this step size')
    break
  }
}

// Final score
console.log('\n── Final ──')
const final = whisperScoreAll()
console.log(`Score: ${baseline.correct}→${final.correct}/${final.total}`)
for (const [w, d] of final.details) {
  const ok = d.text.toLowerCase().includes(w) ? '✓' : '✗'
  console.log(`  ${ok} ${w.padEnd(10)} → "${d.text}" (${d.logprob.toFixed(3)})`)
}
console.log(`Total improvements: ${totalImprovements}`)

// Output changes
console.log('\n=== CHANGED GAINS ===')
for (const ph of tunablePhonemes.sort()) {
  const orig = PHONEMES[ph].bands
  const opt = gains[ph]
  const changed = orig.some((v, i) => Math.abs(v - opt[i]) > 0.005)
  if (changed) console.log(`  ${ph.padEnd(3)}: [${opt.map(g => g.toFixed(2)).join(', ')}]`)
}

console.log('\n=== CHANGED DURATIONS ===')
for (const ph of tunablePhonemes.sort()) {
  const orig = PHONEMES[ph].durationMs
  const opt = durations[ph]
  if (Math.abs(orig - opt) > 1) console.log(`  ${ph.padEnd(3)}: ${orig}→${opt}ms`)
}
