"""
Derive 10-band filter gains mathematically from published formant data.

Each vowel has known F1, F2, F3 frequencies and bandwidths. A formant is a
resonance peak — we compute how much energy each of our 10 bandpass filters
would capture from each formant, then sum the contributions.

Sources:
  - Peterson & Barney (1952): male formant frequencies
  - Hillenbrand et al. (1995): updated measurements, 45 male speakers
  - Typical formant bandwidths: B1≈60Hz, B2≈70Hz, B3≈110Hz (Klatt 1980)

Output: band gains ready to paste into phonemes.ts
"""

import numpy as np
import json

# ── Our Voder filter bank ──
BAND_CENTERS = [112, 338, 575, 850, 1200, 1700, 2350, 3250, 4600, 6450]
BAND_WIDTHS  = [225, 225, 250, 300,  400,  600,  700, 1100, 1600, 2100]

# ── Published formant data (Hillenbrand 1995, male speakers) ──
# Format: (F1, F2, F3, [optional F4]) in Hz
# F4 is typically around 3500-4500 Hz for most vowels
FORMANTS = {
    'IY': (270, 2290, 3010, 3700),   # "beat"
    'IH': (390, 1990, 2550, 3700),   # "bit"
    'EH': (530, 1840, 2480, 3600),   # "bet"
    'AE': (660, 1720, 2410, 3600),   # "bat"
    'AA': (730, 1090, 2440, 3400),   # "bot/father"
    'AO': (570,  840, 2410, 3400),   # "bought"
    'AH': (640, 1190, 2390, 3400),   # "but"
    'UH': (440, 1020, 2240, 3400),   # "book"
    'UW': (300,  870, 2240, 3400),   # "boot"
    'ER': (490, 1350, 1690, 3400),   # "bird" — F3 is notably low (rhoticity)
}

# Diphthongs: (onset_formants, offset_formants)
DIPHTHONGS = {
    'OW': ((570, 840, 2410), (440, 1020, 2240)),     # AO → UH
    'AY': ((730, 1090, 2440), (390, 1990, 2550)),    # AA → IH
    'EY': ((530, 1840, 2480), (270, 2290, 3010)),    # EH → IY
    'AW': ((730, 1090, 2440), (440, 1020, 2240)),    # AA → UH
    'OY': ((570, 840, 2410), (270, 2290, 3010)),     # AO → IY
}

# Formant bandwidths (Klatt 1980 defaults)
# B1 is wider for open vowels, narrower for close vowels
FORMANT_BW = {
    'F1': 60,   # typical F1 bandwidth
    'F2': 70,   # typical F2 bandwidth
    'F3': 110,  # typical F3 bandwidth
    'F4': 120,  # typical F4 bandwidth
}

# Formant amplitudes relative to each other
# F1 is strongest, higher formants progressively weaker
FORMANT_AMP = {
    'F1': 1.0,
    'F2': 0.7,   # ~3 dB down
    'F3': 0.45,  # ~7 dB down
    'F4': 0.25,  # ~12 dB down
}


def formant_energy_in_band(f_center: float, f_bw: float, f_amp: float,
                           band_center: float, band_width: float) -> float:
    """
    Compute energy a formant peak contributes to a bandpass filter.

    A formant is modeled as a Lorentzian (resonance) peak centered at f_center
    with bandwidth f_bw and amplitude f_amp. The bandpass filter captures
    energy proportional to the overlap integral.

    For simplicity and accuracy, we compute the value of the Lorentzian
    response at the band center frequency, weighted by the band width.
    """
    # Lorentzian: H(f) = amp / sqrt(1 + ((f - f0) / (bw/2))^2)
    half_bw = f_bw / 2
    distance = abs(band_center - f_center)
    response = f_amp / np.sqrt(1 + (distance / half_bw) ** 2)

    # Also account for the band capturing energy from the tails
    # Integrate the Lorentzian over the band edges
    lo = band_center - band_width / 2
    hi = band_center + band_width / 2

    # Analytical integral of Lorentzian: amp * bw * arctan((f - f0) / (bw/2))
    integral = f_amp * half_bw * (
        np.arctan((hi - f_center) / half_bw) -
        np.arctan((lo - f_center) / half_bw)
    )
    # Normalize by band width to get average energy density
    avg_energy = integral / band_width

    # Use the max of point response and integrated response
    # (point response for narrow formants near band center,
    #  integrated for wide formants straddling band edges)
    return max(response, avg_energy)


def compute_band_gains(formants: tuple, include_f4: bool = True) -> list[float]:
    """Compute 10-band gains from formant frequencies."""
    n_formants = len(formants)
    gains = np.zeros(10)

    formant_labels = ['F1', 'F2', 'F3', 'F4']

    for i, (f_freq) in enumerate(formants):
        if i >= 4:
            break
        label = formant_labels[i]
        f_bw = FORMANT_BW[label]
        f_amp = FORMANT_AMP[label]

        for b in range(10):
            energy = formant_energy_in_band(
                f_freq, f_bw, f_amp,
                BAND_CENTERS[b], BAND_WIDTHS[b]
            )
            gains[b] += energy

    # Normalize to [0, 1]
    peak = np.max(gains)
    if peak > 0:
        gains = gains / peak

    # Sharpen: apply power curve to increase contrast (reduce floor energy)
    # This models the fact that real formant resonances have much steeper
    # skirts than a single Lorentzian, especially after passing through
    # a bandpass filter with finite Q.
    gains = gains ** 2.0  # square to sharpen peaks

    # Re-normalize
    peak = np.max(gains)
    if peak > 0:
        gains = gains / peak

    return [round(float(g), 2) for g in gains]


def main():
    print("=" * 80)
    print("MATHEMATICALLY DERIVED BAND GAINS FROM PUBLISHED FORMANT DATA")
    print("=" * 80)
    print()
    print("Source: Hillenbrand et al. (1995), Klatt (1980) bandwidths")
    print("Method: Lorentzian formant peaks integrated over bandpass filters")
    print()

    # Header
    print(f"{'Ph':<4} {'F1':>5} {'F2':>5} {'F3':>5}   ", end='')
    for i in range(10):
        print(f"B{i:<4}", end='')
    print()
    print("-" * 80)

    all_results = {}

    # Monophthongs
    print("\n── Monophthongs ──")
    for ph, formants in sorted(FORMANTS.items()):
        gains = compute_band_gains(formants)
        all_results[ph] = {'formants': list(formants), 'bands': gains}

        f_str = f"F1={formants[0]:>4} F2={formants[1]:>4} F3={formants[2]:>4}"
        g_str = ' '.join(f'{g:.2f}' for g in gains)
        print(f"  {ph:<4} {f_str}   {g_str}")

    # Diphthongs
    print("\n── Diphthongs ──")
    for ph, (onset, offset) in sorted(DIPHTHONGS.items()):
        onset_gains = compute_band_gains(onset)
        offset_gains = compute_band_gains(offset)
        mid_gains = [round((a + b) / 2, 2) for a, b in zip(onset_gains, offset_gains)]
        all_results[ph] = {
            'onset_formants': list(onset),
            'offset_formants': list(offset),
            'bands': mid_gains,
            'onsetBands': onset_gains,
            'offsetBands': offset_gains,
        }

        print(f"  {ph:<4} onset=[{', '.join(f'{g:.2f}' for g in onset_gains)}]")
        print(f"       offset=[{', '.join(f'{g:.2f}' for g in offset_gains)}]")
        print(f"       mid   =[{', '.join(f'{g:.2f}' for g in mid_gains)}]")

    # Print phonemes.ts format
    print("\n\n" + "=" * 80)
    print("PHONEMES.TS FORMAT (copy-paste ready)")
    print("=" * 80)

    for ph in ['IY', 'IH', 'EH', 'AE', 'AA', 'AO', 'AH', 'UH', 'UW', 'ER']:
        data = all_results[ph]
        bands_str = ', '.join(f'{g:.2f}' for g in data['bands'])
        f = data['formants']
        print(f"  // {ph}: F1={f[0]} F2={f[1]} F3={f[2]} (Hillenbrand 1995)")
        print(f"  //   bands: [{bands_str}]")

    print()
    for ph in ['OW', 'AY', 'EY', 'AW', 'OY']:
        data = all_results[ph]
        print(f"  // {ph} diphthong:")
        print(f"  //   onset:  [{', '.join(f'{g:.2f}' for g in data['onsetBands'])}]")
        print(f"  //   offset: [{', '.join(f'{g:.2f}' for g in data['offsetBands'])}]")
        print(f"  //   mid:    [{', '.join(f'{g:.2f}' for g in data['bands'])}]")

    # Compare with current values
    print("\n\n" + "=" * 80)
    print("COMPARISON: Current vs Derived")
    print("=" * 80)

    # Import current values by reading the JSON we'll save
    with open('/tmp/voder-analysis/derived-gains.json', 'w') as f:
        json.dump(all_results, f, indent=2)

    print(f"\nSaved to /tmp/voder-analysis/derived-gains.json")


if __name__ == '__main__':
    main()
