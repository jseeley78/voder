/**
 * Automated iterative phoneme tuner.
 *
 * Gradient-descent-style optimization: for each phoneme, try small
 * perturbations to each band gain, keep changes that reduce distance
 * to the Samantha reference, revert changes that increase it.
 *
 * Runs hundreds of iterations per phoneme — the digital equivalent
 * of the year of practice a Voder operator needed.
 */

import * as fs from 'fs'
import { BAND_CENTERS, BAND_WIDTHS, BAND_COMPENSATION, PHONEMES, type PhonemeConfig } from '../src/phonemes'

// ─── WAV + FFT (same as other scripts) ───

interface WavData { sampleRate: number; samples: Float32Array }

function readWav(path: string): WavData {
  const buf = fs.readFileSync(path)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let offset = 12, sampleRate = 44100, bitsPerSample = 16, numChannels = 1, dataStart = 0, dataSize = 0
  while (offset < buf.length - 8) {
    const id = String.fromCharCode(buf[offset], buf[offset+1], buf[offset+2], buf[offset+3])
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') { numChannels = view.getUint16(offset+10,true); sampleRate = view.getUint32(offset+12,true); bitsPerSample = view.getUint16(offset+22,true) }
    else if (id === 'data') { dataStart = offset+8; dataSize = size }
    offset += 8+size; if (size%2!==0) offset++
  }
  const n = dataSize/(bitsPerSample/8)/numChannels
  const samples = new Float32Array(n)
  for (let i=0;i<n;i++) { const bo=dataStart+i*numChannels*(bitsPerSample/8); samples[i]=bitsPerSample===16?view.getInt16(bo,true)/32768:(buf[bo]-128)/128 }
  return { sampleRate, samples }
}

function fft(real: Float64Array, imag: Float64Array): void {
  const n=real.length
  for(let i=1,j=0;i<n;i++){let b=n>>1;while(j&b){j^=b;b>>=1}j^=b;if(i<j){[real[i],real[j]]=[real[j],real[i]];[imag[i],imag[j]]=[imag[j],imag[i]]}}
  for(let len=2;len<=n;len*=2){const h=len/2,a=-2*Math.PI/len,wR=Math.cos(a),wI=Math.sin(a);for(let i=0;i<n;i+=len){let cR=1,cI=0;for(let j=0;j<h;j++){const tR=cR*real[i+j+h]-cI*imag[i+j+h],tI=cR*imag[i+j+h]+cI*real[i+j+h];real[i+j+h]=real[i+j]-tR;imag[i+j+h]=imag[i+j]-tI;real[i+j]+=tR;imag[i+j]+=tI;const nR=cR*wR-cI*wI;cI=cR*wI+cI*wR;cR=nR}}}
}

const BAND_EDGES = [0, 225, 450, 700, 1000, 1400, 2000, 2700, 3800, 5400, 7500]

function analyzeWav(wav: WavData): number[] {
  const {sampleRate, samples}=wav; const fftSize=4096
  const start=Math.floor(samples.length*0.15), end=Math.floor(samples.length*0.85), hop=fftSize/2
  const nf=Math.max(1,Math.floor((end-start)/hop)-1); const avg=new Float64Array(fftSize/2)
  for(let f=0;f<nf;f++){const o=start+f*hop;const r=new Float64Array(fftSize),im=new Float64Array(fftSize);for(let i=0;i<fftSize;i++)r[i]=(samples[o+i]||0)*0.5*(1-Math.cos(2*Math.PI*i/(fftSize-1)));fft(r,im);for(let i=0;i<fftSize/2;i++)avg[i]+=Math.sqrt(r[i]*r[i]+im[i]*im[i])/nf}
  const bHz=sampleRate/fftSize
  return BAND_CENTERS.map((_,i)=>{const lo=Math.floor(BAND_EDGES[i]/bHz),hi=Math.ceil(BAND_EDGES[i+1]/bHz);let s=0,c=0;for(let b=lo;b<hi&&b<avg.length;b++){s+=avg[b];c++}return c>0?s/c:0})
}

function normalize(b: number[]): number[] { const m=Math.max(...b,0.001); return b.map(v=>v/m) }

function distance(a: number[], b: number[]): number {
  let s = 0; for (let i = 0; i < 10; i++) s += (a[i]-b[i])**2; return Math.sqrt(s)
}

function compensatedNorm(bands: number[]): number[] {
  const raw = bands.map((g,i) => g * BAND_COMPENSATION[i])
  const max = Math.max(...raw, 0.001)
  return raw.map(g => g/max)
}

// ─── Load references ───

const VOWEL_DIR = '/tmp/voder-ref-mac/vowels'
const VOWEL_MAP: Record<string, string> = {
  AA:'aa.wav', AE:'ae.wav', AH:'ah.wav', AO:'ao.wav', EH:'eh.wav',
  ER:'er.wav', IH:'ih.wav', IY:'iy.wav', OW:'ow.wav', UH:'uh.wav', UW:'uw.wav',
}

const refs = new Map<string, number[]>()
for (const [ph, file] of Object.entries(VOWEL_MAP)) {
  const p = `${VOWEL_DIR}/${file}`
  if (fs.existsSync(p)) {
    refs.set(ph, normalize(analyzeWav(readWav(p))))
  }
}

console.log(`Loaded ${refs.size} reference spectra`)
console.log()

// ─── Optimization ───

const MAX_ITERATIONS = 500
const STEP_SIZES = [0.08, 0.05, 0.03, 0.02, 0.01]  // anneal from large to small steps
const PHONEMES_TO_TUNE = [...refs.keys()]

// Clone current gains
const currentGains: Record<string, number[]> = {}
for (const ph of PHONEMES_TO_TUNE) {
  currentGains[ph] = [...PHONEMES[ph].bands]
}

// Track progress
let totalImproved = 0
let totalAttempts = 0

for (const stepSize of STEP_SIZES) {
  console.log(`── Step size: ${stepSize} ──`)

  for (let iter = 0; iter < MAX_ITERATIONS / STEP_SIZES.length; iter++) {
    let improved = 0

    for (const ph of PHONEMES_TO_TUNE) {
      const ref = refs.get(ph)!
      const bands = currentGains[ph]
      const curDist = distance(compensatedNorm(bands), ref)

      // Try perturbing each band
      for (let b = 0; b < 10; b++) {
        const original = bands[b]

        // Try increase
        bands[b] = Math.min(1.0, original + stepSize)
        let newDist = distance(compensatedNorm(bands), ref)
        if (newDist < curDist - 0.001) {
          improved++
          totalImproved++
          continue // keep the change
        }

        // Try decrease
        bands[b] = Math.max(0, original - stepSize)
        newDist = distance(compensatedNorm(bands), ref)
        if (newDist < curDist - 0.001) {
          improved++
          totalImproved++
          continue
        }

        // Neither helped — revert
        bands[b] = original
        totalAttempts++
      }
    }

    if (improved === 0) break // converged at this step size
  }

  // Report progress at this step size
  for (const ph of PHONEMES_TO_TUNE) {
    const ref = refs.get(ph)!
    const d = distance(compensatedNorm(currentGains[ph]), ref)
    process.stdout.write(`  ${ph}=${d.toFixed(3)}  `)
  }
  console.log()
}

// ─── Final report ───

console.log()
console.log('=== FINAL RESULTS ===')
console.log(`Total improvements: ${totalImproved}, attempts: ${totalAttempts}`)
console.log()

// Compare before vs after
for (const ph of PHONEMES_TO_TUNE) {
  const ref = refs.get(ph)!
  const beforeDist = distance(compensatedNorm(PHONEMES[ph].bands), ref)
  const afterDist = distance(compensatedNorm(currentGains[ph]), ref)
  const delta = beforeDist - afterDist
  const pct = ((delta / beforeDist) * 100).toFixed(0)
  const flag = afterDist < 0.15 ? '★' : afterDist < 0.25 ? '✓' : afterDist < 0.4 ? '~' : '✗'
  console.log(`  ${flag} ${ph.padEnd(3)}: ${beforeDist.toFixed(3)} → ${afterDist.toFixed(3)}  (${delta > 0 ? '-' : '+'}${Math.abs(delta).toFixed(3)}, ${delta > 0 ? pct+'% better' : 'worse'})`)
}

// Output the optimized gains for copy-paste
console.log()
console.log('=== OPTIMIZED GAINS (copy into phonemes.ts) ===')
for (const ph of PHONEMES_TO_TUNE) {
  console.log(`  ${ph}: [${currentGains[ph].map(g => g.toFixed(2)).join(', ')}]`)
}

// Also compute average distance
const avgBefore = PHONEMES_TO_TUNE.reduce((s, ph) => s + distance(compensatedNorm(PHONEMES[ph].bands), refs.get(ph)!), 0) / PHONEMES_TO_TUNE.length
const avgAfter = PHONEMES_TO_TUNE.reduce((s, ph) => s + distance(compensatedNorm(currentGains[ph]), refs.get(ph)!), 0) / PHONEMES_TO_TUNE.length
console.log()
console.log(`Average distance: ${avgBefore.toFixed(3)} → ${avgAfter.toFixed(3)} (${((1 - avgAfter/avgBefore) * 100).toFixed(0)}% improvement)`)
