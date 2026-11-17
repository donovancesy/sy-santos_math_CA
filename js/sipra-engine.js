/* Sipra engine: follows a song continuously, chunk by chunk.
 *
 * Rhythm (sipra-rhythm.js): log-mel onset strength → autocorrelation tempo with
 * an octave check → dynamic-programming beat tracking → meter 2–7 + downbeat.
 * Harmony (here): a chromagram every ~43 ms (12 pitch-class strengths).
 *   Key    : whole-song chroma correlated with Temperley key profiles.
 *   Chords : median-filtered recent chroma matched against chord templates,
 *            with a small bonus for chords in the key and a 2-step confirmation.
 *
 * Depends on analysis.js (SipraAnalysis) and sipra-rhythm.js. Browser or Node.
 */
(function (global) {
  "use strict";
  const A = global.SipraAnalysis;
  const { NOTE_NAMES, MAJOR_PROFILE, MINOR_PROFILE, getFFTPlan, fftWithPlan, percentile,
    detectTempoFromEnvelope, detectTimeSignatureFromEnvelope, clamp } = A;

  const ONSET_N = 1024, ONSET_HOP = 512;
  const CHROMA_N = 8192, CHROMA_HOP = 2048;
  const RING = 1 << 15;
  const MAX_ONSET_SECONDS = 90;
  const TEMPO_WINDOW_SECONDS = 40;

  // Chord shapes in semitones above the root, with how much each tone matters.
  const QUALITIES = [
    { id: "maj", suffix: "", tones: [[0, 1], [4, 1], [7, 0.8]], label: "major" },
    { id: "min", suffix: "m", tones: [[0, 1], [3, 1], [7, 0.8]], label: "minor" },
    { id: "dim", suffix: "dim", tones: [[0, 1], [3, 1], [6, 0.9]], label: "diminished", penalty: 0.05 },
    { id: "sus4", suffix: "sus4", tones: [[0, 1], [5, 1], [7, 0.8]], label: "suspended 4th", penalty: 0.06 },
    { id: "7", suffix: "7", tones: [[0, 1], [4, 0.9], [7, 0.7], [10, 0.8]], label: "dominant 7th", penalty: 0.03 },
    { id: "maj7", suffix: "maj7", tones: [[0, 1], [4, 0.9], [7, 0.7], [11, 0.8]], label: "major 7th", penalty: 0.075 },
    { id: "m7", suffix: "m7", tones: [[0, 1], [3, 0.9], [7, 0.7], [10, 0.8]], label: "minor 7th", penalty: 0.03 }
  ];
  const TEMPLATES = [];
  for (let root = 0; root < 12; root += 1) {
    for (const q of QUALITIES) {
      const v = new Float64Array(12);
      for (const [iv, w] of q.tones) v[(root + iv) % 12] = w;
      let norm = 0;
      for (let i = 0; i < 12; i += 1) norm += v[i] * v[i];
      norm = Math.sqrt(norm);
      for (let i = 0; i < 12; i += 1) v[i] /= norm;
      TEMPLATES.push({ root, q, v });
    }
  }

  const MAJOR_DEGREES = { 0: "I", 2: "II", 4: "III", 5: "IV", 7: "V", 9: "VI", 11: "VII" };
  const MINOR_DEGREES = { 0: "I", 2: "II", 3: "♭III", 5: "IV", 7: "V", 8: "♭VI", 10: "♭VII" };
  const FLAT_NAMES = { 1: "♭II", 3: "♭III", 6: "♭V", 8: "♭VI", 10: "♭VII" };

  function diatonicSet(key) {
    const steps = key.mode === "minor" ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
    return new Set(steps.map((s) => (key.tonicPc + s) % 12));
  }

  function romanNumeral(chord, key) {
    if (!chord || !key) return "";
    const deg = (chord.root - key.tonicPc + 12) % 12;
    const table = key.mode === "minor" ? MINOR_DEGREES : MAJOR_DEGREES;
    let base = table[deg] || FLAT_NAMES[deg] || "♯IV";
    const minorish = chord.q.id === "min" || chord.q.id === "m7" || chord.q.id === "dim";
    if (minorish) base = base.replace(/[IV]+/, (m) => m.toLowerCase());
    if (chord.q.id === "dim") base += "°";
    if (chord.q.id === "7" || chord.q.id === "m7") base += "7";
    if (chord.q.id === "maj7") base += "maj7";
    if (chord.q.id === "sus4") base += "sus4";
    return base;
  }

  function correlate(a, b) {
    let ma = 0, mb = 0;
    for (let i = 0; i < 12; i += 1) { ma += a[i]; mb += b[i]; }
    ma /= 12; mb /= 12;
    let n = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i += 1) {
      const x = a[i] - ma, y = b[i] - mb;
      n += x * y; da += x * x; db += y * y;
    }
    return n / (Math.sqrt(da * db) + 1e-12);
  }

  function normalizeEnvelope(source) {
    const center = percentile(source, 0.48);
    const high = Math.max(percentile(source, 0.96), center + 1e-9);
    const out = new Float32Array(source.length);
    let max = 0;
    for (let i = 0; i < source.length; i += 1) {
      out[i] = Math.max(0, source[i] - center * 0.88) / (high - center + 1e-9);
      if (out[i] > max) max = out[i];
    }
    if (max > 0) for (let i = 0; i < out.length; i += 1) out[i] /= max;
    const sm = new Float32Array(out.length);
    for (let i = 0; i < out.length; i += 1) {
      sm[i] = out[i] * 0.72 + (out[i - 1] || 0) * 0.14 + (out[i + 1] || 0) * 0.14;
    }
    return sm;
  }

  class SipraEngine {
    constructor(sampleRate) {
      this.sr = sampleRate;
      this.ring = new Float32Array(RING);
      this.chromaPlan = getFFTPlan(CHROMA_N);
      this.chromaWin = SipraEngine.hann(CHROMA_N);
      this.chromaRe = new Float64Array(CHROMA_N); this.chromaIm = new Float64Array(CHROMA_N);
      this.fps = sampleRate / ONSET_HOP;
      this.chromaFps = sampleRate / CHROMA_HOP;
      // Pitch-class lookup per chroma bin (with a weight that fades between semitones).
      const binHz = sampleRate / CHROMA_N;
      this.pcBin = new Int8Array(CHROMA_N / 2).fill(-1);
      this.pcWeight = new Float32Array(CHROMA_N / 2);
      this.isBass = new Uint8Array(CHROMA_N / 2);
      for (let b = 1; b < CHROMA_N / 2; b += 1) {
        const f = b * binHz;
        if (f < 55 || f > 4200) continue;
        const midi = 69 + 12 * Math.log2(f / 440);
        const near = Math.round(midi);
        const dev = Math.abs(midi - near);
        this.pcBin[b] = ((near % 12) + 12) % 12;
        this.pcWeight[b] = Math.pow(Math.cos(Math.PI * dev), 2) * (f < 100 ? 0.5 : f > 2000 ? 0.6 : 1);
        this.isBass[b] = f <= 220 ? 1 : 0;
      }
      this.rhythm = new global.SipraRhythm(sampleRate);
      this.reset();
    }

    static hann(n) {
      const w = new Float32Array(n);
      for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      return w;
    }

    reset() {
      this.total = 0;
      this.nextOnset = 0;
      this.nextChroma = 0;
      this.prevMag = new Float32Array(ONSET_N / 2);
      this.flux = []; this.lowFlux = []; this.fluxStart = 0;
      this.songChroma = new Float64Array(12);
      this.songBass = new Float64Array(12);
      this.recent = [];           // recent chroma frames for chord detection
      this.recentBass = [];
      this.tempoVotes = [];
      this.meterVotes = new Map();
      this.result = null;
      this.chord = null; this.pendingChord = null; this.pendingCount = 0;
      this.chordHistory = [];
      this.lastChordEval = 0;
      this.energy = 0;
      if (this.rhythm) this.rhythm.reset();
    }

    get seconds() { return this.total / this.sr; }

    push(chunk) {
      const ring = this.ring;
      for (let i = 0; i < chunk.length; i += 1) ring[(this.total + i) & (RING - 1)] = chunk[i];
      this.total += chunk.length;
      this.rhythm.push(chunk);
      while (this.nextChroma + CHROMA_N <= this.total) {
        this.chromaFrame(this.nextChroma);
        this.nextChroma += CHROMA_HOP;
      }
    }

    chromaFrame(start) {
      const re = this.chromaRe, im = this.chromaIm, w = this.chromaWin, ring = this.ring;
      let energy = 0;
      for (let i = 0; i < CHROMA_N; i += 1) {
        const v = ring[(start + i) & (RING - 1)];
        energy += v * v;
        re[i] = v * w[i]; im[i] = 0;
      }
      const rms = Math.sqrt(energy / CHROMA_N);
      this.energy = this.energy * 0.8 + rms * 0.2;
      const chroma = new Float64Array(12), bass = new Float64Array(12);
      if (rms > 0.002) {
        fftWithPlan(re, im, this.chromaPlan);
        const half = CHROMA_N / 2;
        const mag = new Float32Array(half);
        for (let b = 1; b < half; b += 1) mag[b] = Math.hypot(re[b], im[b]);
        // Only spectral peaks count: tonal partials, not broadband drum noise.
        for (let b = 2; b < half - 1; b += 1) {
          const pc = this.pcBin[b];
          if (pc < 0) continue;
          const m = mag[b];
          if (m <= mag[b - 1] || m < mag[b + 1]) continue;
          const v = Math.log1p(m * 20) * this.pcWeight[b];
          chroma[pc] += v;
          if (this.isBass[b]) bass[pc] += v;
        }
        let total = 0;
        for (let i = 0; i < 12; i += 1) total += chroma[i];
        if (total > 0) {
          const weight = clamp(rms * 20, 0.1, 1);
          for (let i = 0; i < 12; i += 1) {
            chroma[i] /= total;
            this.songChroma[i] += chroma[i] * weight;
            this.songBass[i] += bass[i] / total * weight;
          }
        }
      }
      if (rms > 0.002) this.rhythm.addChroma((start + CHROMA_N / 2) / this.sr, chroma);
      this.recent.push(chroma);
      this.recentBass.push(bass);
      const keep = Math.round(0.8 * this.chromaFps);
      if (this.recent.length > keep) { this.recent.shift(); this.recentBass.shift(); }
      // Re-evaluate the chord about 4 times a second.
      const t = start / this.sr;
      if (t - this.lastChordEval >= 0.25) {
        this.lastChordEval = t;
        this.evaluateChord(t, rms);
      }
    }

    key() {
      const c = new Float64Array(12);
      let bassTotal = 0;
      for (let i = 0; i < 12; i += 1) bassTotal += this.songBass[i];
      for (let i = 0; i < 12; i += 1) c[i] = this.songChroma[i] + (bassTotal ? (this.songBass[i] / bassTotal) * 0.2 * this.songChroma.reduce((a, b) => a + b, 0) : 0);
      const scores = [];
      for (let t = 0; t < 12; t += 1) {
        const maj = new Float64Array(12), min = new Float64Array(12);
        for (let i = 0; i < 12; i += 1) { maj[i] = MAJOR_PROFILE[(i - t + 12) % 12]; min[i] = MINOR_PROFILE[(i - t + 12) % 12]; }
        scores.push({ tonicPc: t, mode: "major", score: correlate(c, maj) });
        scores.push({ tonicPc: t, mode: "minor", score: correlate(c, min) });
      }
      scores.sort((a, b) => b.score - a.score);
      const best = scores[0], second = scores[1];
      const confidence = clamp(0.15 + Math.max(0, best.score) * 0.6 + Math.max(0, best.score - second.score) * 2.2, 0.05, 0.97);
      return { tonicPc: best.tonicPc, mode: best.mode, confidence, scores: scores.slice(0, 4) };
    }

    evaluateChord(t, rms) {
      const frames = this.recent;
      if (frames.length < 4 || rms < 0.004) {
        this.commitChord(null, t);
        return;
      }
      // Median over the last ~0.8 s per pitch class removes short drum hits.
      const chroma = new Float64Array(12), bass = new Float64Array(12);
      const tmp = new Float64Array(frames.length);
      for (let pc = 0; pc < 12; pc += 1) {
        for (let f = 0; f < frames.length; f += 1) tmp[f] = frames[f][pc];
        const sorted = Array.from(tmp).sort((a, b) => a - b);
        chroma[pc] = (sorted[sorted.length >> 1] + sorted[Math.floor(sorted.length * 0.75)]) / 2;
        let bs = 0;
        for (let f = 0; f < frames.length; f += 1) bs += this.recentBass[f][pc];
        bass[pc] = bs;
      }
      let norm = 0;
      for (let i = 0; i < 12; i += 1) norm += chroma[i] * chroma[i];
      norm = Math.sqrt(norm);
      if (norm < 1e-9) { this.commitChord(null, t); return; }
      for (let i = 0; i < 12; i += 1) chroma[i] /= norm;
      let bassPc = -1, bassMax = 0, bassSum = 0;
      for (let i = 0; i < 12; i += 1) { bassSum += bass[i]; if (bass[i] > bassMax) { bassMax = bass[i]; bassPc = i; } }
      const bassClear = bassSum > 0 && bassMax / bassSum > 0.22;

      const key = this.result && this.result.key && this.result.key.confidence > 0.35 ? this.result.key : null;
      const diatonic = key ? diatonicSet(key) : null;
      let best = null, second = null;
      for (const tpl of TEMPLATES) {
        let s = 0;
        for (let i = 0; i < 12; i += 1) s += chroma[i] * tpl.v[i];
        s -= tpl.q.penalty || 0;
        if (bassClear && bassPc === tpl.root) s += 0.06;
        if (diatonic) {
          const tones = tpl.q.tones.map(([iv]) => (tpl.root + iv) % 12);
          if (tones.every((p) => diatonic.has(p))) s += 0.035;
        }
        if (!best || s > best.score) { second = best; best = { ...tpl, score: s }; }
        else if (!second || s > second.score) second = { ...tpl, score: s };
      }
      if (best.score < 0.62) { this.commitChord(null, t); return; }
      const confidence = clamp((best.score - 0.62) * 2.2 + (best.score - second.score) * 3, 0.05, 0.98);
      const bassNote = bassClear && bassPc !== best.root && best.q.tones.some(([iv]) => (best.root + iv) % 12 === bassPc) ? bassPc : null;
      this.commitChord({ root: best.root, q: best.q, bass: bassNote, confidence }, t);
    }

    commitChord(candidate, t) {
      const same = (a, b) => (!a && !b) || (a && b && a.root === b.root && a.q.id === b.q.id);
      if (same(candidate, this.chord)) {
        this.pendingChord = null; this.pendingCount = 0;
        if (candidate && this.chord) { this.chord.confidence = candidate.confidence; this.chord.bass = candidate.bass; }
        if (this.chordHistory.length) this.chordHistory[this.chordHistory.length - 1].end = t;
        return;
      }
      if (same(candidate, this.pendingChord)) this.pendingCount += 1;
      else { this.pendingChord = candidate; this.pendingCount = 1; }
      const needed = candidate ? 2 : 4; // a chord must hold ~0.5 s; silence ~1 s
      if (this.pendingCount >= needed) {
        this.chord = candidate;
        this.pendingChord = null; this.pendingCount = 0;
        if (candidate) {
          this.chordHistory.push({ root: candidate.root, q: candidate.q, start: t, end: t });
          if (this.chordHistory.length > 64) this.chordHistory.shift();
        }
      }
    }

    // Heavier estimates: call every 2-4 s.
    update() {
      const r = this.rhythm.estimate();
      if (!r.ready) { this.result = { ready: false, seconds: this.seconds }; return this.result; }
      const key = this.key();
      this.result = {
        ...r,
        beatAnchor: r.lastBeatTime,
        key,
        chroma: this.songChroma.slice()
      };
      return this.result;
    }

    // Light state: safe to call every frame.
    chordInfo() {
      const key = this.result && this.result.key;
      const describe = (c) => c ? {
        name: NOTE_NAMES[c.root] + c.q.suffix + (c.bass !== null && c.bass !== undefined ? "/" + NOTE_NAMES[c.bass] : ""),
        root: c.root, quality: c.q.id, qualityLabel: c.q.label,
        tones: c.q.tones.map(([iv]) => iv),
        notes: c.q.tones.map(([iv]) => NOTE_NAMES[(c.root + iv) % 12]),
        roman: romanNumeral(c, key), confidence: c.confidence
      } : null;
      return {
        current: describe(this.chord),
        history: this.chordHistory.slice(-8).map((h) => ({ ...describe({ ...h, bass: null, confidence: 1 }), start: h.start, end: h.end })),
        recentChroma: this.recent.length ? this.recent[this.recent.length - 1] : null
      };
    }
  }

  SipraEngine.NOTE_NAMES = NOTE_NAMES;
  SipraEngine.QUALITIES = QUALITIES;
  global.SipraEngine = SipraEngine;
})(typeof window !== "undefined" ? window : globalThis);
