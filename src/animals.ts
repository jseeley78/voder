/**
 * Animal sounds for the Voder — custom frame sequences that bypass
 * the phoneme pipeline and drive the engine directly.
 *
 * The original 1939 Voder demonstrations included animal sounds
 * to showcase the instrument's versatility.
 */

import type { VoderEngine, VoderFrame } from './engine'

interface AnimalKeyframe {
  /** Time offset in seconds from start */
  time: number
  frame: VoderFrame
  /** Transition shape */
  shape?: 'snap' | 'expo' | 'smooth' | 'slow'
  /** Transition time in ms */
  transitionMs?: number
}

interface AnimalSound {
  name: string
  label: string
  keyframes: AnimalKeyframe[]
}

// ── Silence frame ──
const SILENCE: VoderFrame = {
  voiced: false, noise: 0, pitchHz: 110,
  bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
}

// ── Cow: "Mooooo" ──
// Low fundamental (~100Hz), strong low formants, nasal quality
// M onset → long OO vowel with slow pitch fall
const COW: AnimalSound = {
  name: 'cow',
  label: '🐄 Moo',
  keyframes: [
    // M nasal onset
    { time: 0.00, frame: { voiced: true, noise: 0, voicedAmp: 0.5, pitchHz: 115,
      bands: [0.50, 0.70, 0.15, 0.05, 0.02, 0.02, 0.02, 0.01, 0, 0] }, transitionMs: 20, shape: 'snap' },
    // Open into OO vowel, pitch rises slightly
    { time: 0.15, frame: { voiced: true, noise: 0, voicedAmp: 0.9, pitchHz: 125,
      bands: [0.35, 1.00, 0.70, 0.20, 0.15, 0.03, 0.03, 0.02, 0, 0] }, transitionMs: 80, shape: 'smooth' },
    // Sustain — long held vowel with slow pitch fall
    { time: 0.50, frame: { voiced: true, noise: 0, voicedAmp: 1.0, pitchHz: 120,
      bands: [0.40, 1.00, 0.65, 0.18, 0.12, 0.03, 0.03, 0.02, 0, 0] }, transitionMs: 100, shape: 'smooth' },
    // Gentle pitch descent
    { time: 1.00, frame: { voiced: true, noise: 0, voicedAmp: 0.9, pitchHz: 105,
      bands: [0.45, 1.00, 0.60, 0.15, 0.10, 0.02, 0.02, 0.02, 0, 0] }, transitionMs: 100, shape: 'smooth' },
    // Fade out
    { time: 1.40, frame: { voiced: true, noise: 0, voicedAmp: 0.4, pitchHz: 95,
      bands: [0.30, 0.80, 0.40, 0.10, 0.08, 0.02, 0.01, 0.01, 0, 0] }, transitionMs: 80, shape: 'smooth' },
    // Silence
    { time: 1.60, frame: SILENCE, transitionMs: 40, shape: 'smooth' },
  ],
}

// ── Pig: "Oink oink" ──
// Nasal, mid-high pitch, sharp attacks, two repetitions
const OINK_FRAME: VoderFrame = {
  voiced: true, noise: 0.15, voicedAmp: 0.8, pitchHz: 220,
  bands: [0.20, 0.60, 0.90, 0.40, 0.70, 0.30, 0.15, 0.10, 0.05, 0.02],
}
const OINK_NASAL: VoderFrame = {
  voiced: true, noise: 0.05, voicedAmp: 0.6, pitchHz: 250,
  bands: [0.50, 0.80, 0.20, 0.05, 0.03, 0.03, 0.02, 0.02, 0, 0],
}
const OINK_END: VoderFrame = {
  voiced: false, noise: 0.4, voicedAmp: 0, pitchHz: 200,
  bands: [0.05, 0.10, 0.20, 0.10, 0.15, 0.30, 0.20, 0.10, 0.05, 0.02],
}

const PIG: AnimalSound = {
  name: 'pig',
  label: '🐷 Oink',
  keyframes: [
    // First oink
    { time: 0.00, frame: { ...OINK_FRAME, pitchHz: 200 }, transitionMs: 10, shape: 'snap' },
    { time: 0.05, frame: { ...OINK_FRAME, pitchHz: 260 }, transitionMs: 40, shape: 'smooth' },
    { time: 0.12, frame: OINK_NASAL, transitionMs: 30, shape: 'smooth' },
    { time: 0.20, frame: OINK_END, transitionMs: 20, shape: 'snap' },
    { time: 0.28, frame: SILENCE, transitionMs: 20, shape: 'snap' },
    // Second oink (slightly higher)
    { time: 0.40, frame: { ...OINK_FRAME, pitchHz: 210 }, transitionMs: 10, shape: 'snap' },
    { time: 0.45, frame: { ...OINK_FRAME, pitchHz: 270 }, transitionMs: 40, shape: 'smooth' },
    { time: 0.52, frame: { ...OINK_NASAL, pitchHz: 260 }, transitionMs: 30, shape: 'smooth' },
    { time: 0.60, frame: OINK_END, transitionMs: 20, shape: 'snap' },
    { time: 0.68, frame: SILENCE, transitionMs: 30, shape: 'smooth' },
  ],
}

// ── Dog: "Woof woof" ──
// Sharp bark: low pitch burst, brief vowel, abrupt stop
const DOG: AnimalSound = {
  name: 'dog',
  label: '🐕 Woof',
  keyframes: [
    // First woof — W onset
    { time: 0.00, frame: { voiced: true, noise: 0.1, voicedAmp: 0.3, pitchHz: 150,
      bands: [0.30, 0.70, 0.50, 0.10, 0.05, 0.02, 0.02, 0.01, 0, 0] }, transitionMs: 10, shape: 'snap' },
    // OO vowel burst
    { time: 0.04, frame: { voiced: true, noise: 0.05, voicedAmp: 1.0, pitchHz: 170,
      bands: [0.35, 1.00, 0.80, 0.25, 0.20, 0.05, 0.04, 0.03, 0.01, 0] }, transitionMs: 20, shape: 'snap' },
    // F offset (breathy)
    { time: 0.14, frame: { voiced: false, noise: 0.6, voicedAmp: 0, pitchHz: 150,
      bands: [0.05, 0.10, 0.20, 0.30, 0.20, 0.15, 0.10, 0.05, 0.03, 0.01] }, transitionMs: 15, shape: 'snap' },
    { time: 0.22, frame: SILENCE, transitionMs: 20, shape: 'snap' },
    // Second woof (slightly lower)
    { time: 0.35, frame: { voiced: true, noise: 0.1, voicedAmp: 0.3, pitchHz: 140,
      bands: [0.30, 0.70, 0.50, 0.10, 0.05, 0.02, 0.02, 0.01, 0, 0] }, transitionMs: 10, shape: 'snap' },
    { time: 0.39, frame: { voiced: true, noise: 0.05, voicedAmp: 1.0, pitchHz: 160,
      bands: [0.35, 1.00, 0.80, 0.25, 0.20, 0.05, 0.04, 0.03, 0.01, 0] }, transitionMs: 20, shape: 'snap' },
    { time: 0.49, frame: { voiced: false, noise: 0.6, voicedAmp: 0, pitchHz: 140,
      bands: [0.05, 0.10, 0.20, 0.30, 0.20, 0.15, 0.10, 0.05, 0.03, 0.01] }, transitionMs: 15, shape: 'snap' },
    { time: 0.57, frame: SILENCE, transitionMs: 30, shape: 'smooth' },
  ],
}

// ── Cat: "Meow" ──
// M nasal → rising EE → falling AW glide
const CAT: AnimalSound = {
  name: 'cat',
  label: '🐱 Meow',
  keyframes: [
    // M nasal
    { time: 0.00, frame: { voiced: true, noise: 0, voicedAmp: 0.5, pitchHz: 300,
      bands: [0.50, 0.80, 0.15, 0.05, 0.02, 0.02, 0.02, 0.01, 0, 0] }, transitionMs: 15, shape: 'snap' },
    // EE vowel — pitch rises
    { time: 0.10, frame: { voiced: true, noise: 0, voicedAmp: 0.9, pitchHz: 400,
      bands: [0.30, 1.00, 0.20, 0.03, 0.02, 0.05, 0.30, 0.20, 0.05, 0.01] }, transitionMs: 50, shape: 'smooth' },
    // Peak
    { time: 0.25, frame: { voiced: true, noise: 0, voicedAmp: 1.0, pitchHz: 450,
      bands: [0.25, 0.90, 0.35, 0.05, 0.03, 0.08, 0.35, 0.25, 0.06, 0.02] }, transitionMs: 60, shape: 'smooth' },
    // Glide down to AW — pitch falls
    { time: 0.45, frame: { voiced: true, noise: 0, voicedAmp: 0.8, pitchHz: 350,
      bands: [0.30, 0.50, 0.80, 0.60, 0.30, 0.10, 0.05, 0.03, 0.02, 0] }, transitionMs: 80, shape: 'smooth' },
    // Fade
    { time: 0.65, frame: { voiced: true, noise: 0, voicedAmp: 0.3, pitchHz: 280,
      bands: [0.20, 0.35, 0.50, 0.30, 0.15, 0.05, 0.03, 0.02, 0, 0] }, transitionMs: 60, shape: 'smooth' },
    { time: 0.80, frame: SILENCE, transitionMs: 40, shape: 'smooth' },
  ],
}

// ── Rooster: "Cock-a-doodle-doo" ──
// High pitched, dramatic pitch sweeps
const ROOSTER: AnimalSound = {
  name: 'rooster',
  label: '🐓 Crow',
  keyframes: [
    // "Cock" — sharp attack
    { time: 0.00, frame: { voiced: true, noise: 0.1, voicedAmp: 0.8, pitchHz: 250,
      bands: [0.20, 0.50, 0.90, 0.60, 0.30, 0.15, 0.10, 0.05, 0.02, 0] }, transitionMs: 10, shape: 'snap' },
    { time: 0.08, frame: SILENCE, transitionMs: 10, shape: 'snap' },
    // "a" — brief
    { time: 0.12, frame: { voiced: true, noise: 0, voicedAmp: 0.6, pitchHz: 280,
      bands: [0.15, 0.40, 0.80, 0.50, 0.20, 0.15, 0.10, 0.05, 0.02, 0] }, transitionMs: 15, shape: 'snap' },
    // "doodle" — rising pitch sweep
    { time: 0.20, frame: { voiced: true, noise: 0, voicedAmp: 1.0, pitchHz: 350,
      bands: [0.30, 0.90, 0.60, 0.20, 0.15, 0.03, 0.03, 0.02, 0, 0] }, transitionMs: 30, shape: 'smooth' },
    { time: 0.40, frame: { voiced: true, noise: 0, voicedAmp: 1.0, pitchHz: 500,
      bands: [0.25, 1.00, 0.50, 0.15, 0.10, 0.03, 0.03, 0.02, 0, 0] }, transitionMs: 60, shape: 'smooth' },
    // "doo" — peak then fall
    { time: 0.60, frame: { voiced: true, noise: 0, voicedAmp: 1.0, pitchHz: 520,
      bands: [0.30, 1.00, 0.70, 0.20, 0.15, 0.03, 0.03, 0.02, 0, 0] }, transitionMs: 50, shape: 'smooth' },
    { time: 0.90, frame: { voiced: true, noise: 0, voicedAmp: 0.7, pitchHz: 400,
      bands: [0.35, 0.90, 0.60, 0.15, 0.10, 0.03, 0.03, 0.02, 0, 0] }, transitionMs: 80, shape: 'smooth' },
    { time: 1.10, frame: { voiced: true, noise: 0, voicedAmp: 0.3, pitchHz: 300,
      bands: [0.25, 0.60, 0.40, 0.10, 0.08, 0.02, 0.02, 0.01, 0, 0] }, transitionMs: 60, shape: 'smooth' },
    { time: 1.25, frame: SILENCE, transitionMs: 40, shape: 'smooth' },
  ],
}

export const ANIMAL_SOUNDS: AnimalSound[] = [COW, PIG, DOG, CAT, ROOSTER]

/**
 * Play an animal sound through the Voder engine.
 * Temporarily zeroes the detune offset so the animal's own pitch values
 * are used as-is (the pitch slider normally shifts all frequencies via detune).
 * Returns total duration in seconds.
 */
export function playAnimalSound(engine: VoderEngine, sound: AnimalSound): number {
  const now = engine.ctx!.currentTime

  // Zero detune so animal pitchHz values are absolute
  const savedCents = engine.zeroDetune()

  for (const kf of sound.keyframes) {
    engine.applyFrame(kf.frame, kf.transitionMs ?? 35, kf.shape ?? 'smooth', now + kf.time)
  }
  const lastKf = sound.keyframes[sound.keyframes.length - 1]
  const totalDuration = lastKf.time + (lastKf.transitionMs ?? 35) / 1000

  // Restore detune after sound completes
  setTimeout(() => engine.restoreDetune(savedCents), totalDuration * 1000)

  return totalDuration
}
