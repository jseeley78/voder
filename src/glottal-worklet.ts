/**
 * AudioWorklet processor that generates a glottal pulse train
 * modeled on the Voder's relaxation oscillator.
 *
 * The real oscillator used a gas triode that charged a capacitor
 * quickly (~0.3ms) then discharged slowly (~0.8ms), producing an
 * asymmetric pulse. The key difference from a PeriodicWave:
 *   - Pulse width is relatively fixed (~1.1ms), so at lower pitches
 *     the duty cycle is smaller → brighter spectrum
 *   - Slight cycle-to-cycle jitter in pulse width adds organic character
 *
 * Exported as a string for Blob URL registration (avoids Vite
 * bundling issues with worklet files).
 */

export const GLOTTAL_WORKLET_CODE = /* js */ `
class GlottalPulseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency', defaultValue: 110, automationRate: 'a-rate' },
    ];
  }

  constructor() {
    super();
    this.phase = 0;
    // Pulse shape parameters (in seconds)
    // Charge time ~0.3ms, discharge ~0.8ms → total pulse ~1.1ms
    this.chargeTime = 0.0003;
    this.dischargeTime = 0.0008;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0][0];
    if (!output) return true;

    const freqParam = parameters.frequency;
    const sr = sampleRate;

    for (let i = 0; i < output.length; i++) {
      const freq = freqParam.length > 1 ? freqParam[i] : freqParam[0];
      const period = 1.0 / Math.max(freq, 20);

      // Advance phase
      this.phase += 1.0 / sr;

      // Wrap phase — add tiny jitter to period for organic instability
      if (this.phase >= period) {
        this.phase -= period;
        // Cycle-to-cycle jitter: ±2% of pulse timing
        this.chargeTime = 0.0003 * (1.0 + (Math.random() - 0.5) * 0.04);
        this.dischargeTime = 0.0008 * (1.0 + (Math.random() - 0.5) * 0.04);
      }

      const t = this.phase;
      let sample = 0;

      if (t < this.chargeTime) {
        // Fast charge phase: exponential rise
        // e^(t/tau) normalized, tau = chargeTime/4 for steep rise
        const tau = this.chargeTime * 0.25;
        sample = 1.0 - Math.exp(-t / tau);
      } else if (t < this.chargeTime + this.dischargeTime) {
        // Slow discharge phase: exponential decay
        const dt = t - this.chargeTime;
        const tau = this.dischargeTime * 0.35;
        sample = Math.exp(-dt / tau);
      } else {
        // Rest of period: near-zero (slight DC offset like real circuit)
        sample = 0.02;
      }

      // Center around zero (remove DC)
      output[i] = (sample - 0.3) * 0.8;
    }

    return true;
  }
}

registerProcessor('glottal-pulse', GlottalPulseProcessor);
`
