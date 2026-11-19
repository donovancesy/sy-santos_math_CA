/* Sipra engine: follows a song continuously, chunk by chunk.
 *
 * Rhythm (sipra-rhythm.js): log-mel onset strength → autocorrelation tempo with
 * an octave check → dynamic-programming beat tracking → meter 2–7 + downbeat.
 * Harmony (here): a chromagram every ~43 ms (12 pitch-class strengths).
 *   Tuning : spectral peaks' offset from the nearest semitone (circular mean),
 *            so songs not tuned to A4 = 440 Hz still land on the right notes.
 *   Key    : whole-song chroma correlated with Temperley key profiles, plus the
 *            last 30 s on their own to spot a key change.
 *   Chords : median-filtered recent chroma matched against chord templates,
 *            with a small bonus for chords in the key and a 2-step confirmation.
 *   Chart  : beat-synchronous chroma + Viterbi smoothing → chords per bar, and
 *            the repeating loop (progression).
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
    { id: "m7", suffix: "m7", tones: [[0, 1], [3, 0.9], [7, 0.7], [10, 0.8]], label: "minor 7th", penalty: 0.03 },
    { id: "sus2", suffix: "sus2", tones: [[0, 1], [2, 1], [7, 0.8]], label: "suspended 2nd", penalty: 0.07 },
    { id: "aug", suffix: "+", tones: [[0, 1], [4, 1], [8, 0.9]], label: "augmented", penalty: 0.08 }
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
    if (chord.q.id === "sus2") base += "sus2";
    if (chord.q.id === "aug") base += "+";
    return base;
  }

  function keyFromChroma(chroma, bassChroma) {
    const c = new Float64Array(12);
    let bassTotal = 0, total = 0;
    for (let i = 0; i < 12; i += 1) { bassTotal += bassChroma ? bassChroma[i] : 0; total += chroma[i]; }
    for (let i = 0; i < 12; i += 1) c[i] = chroma[i] + (bassTotal ? (bassChroma[i] / bassTotal) * 0.2 * total : 0);
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
    return { tonicPc: best.tonicPc, mode: best.mode, confidence, scores: scores.slice(0, 4), all: scores };
  }

  // Close calls between neighbouring keys (G vs D major) are settled by the
  // chords: the key whose scale holds the most chord time wins.
  function refineKey(key, bars) {
    if (!key || !key.all || !bars || !bars.length) return key;
    const chords = bars.flatMap((b) => b.chords);
    const total = chords.reduce((s, c) => s + c.beats, 0);
    if (total < 16) return key;
    const best = key.all[0].score;
    const cands = key.all.filter((k) => k.score > best - 0.12).map((k) => {
      const set = diatonicSet(k);
      let fit = 0;
      for (const c of chords) {
        const q = QUALITIES.find((x) => x.id === c.quality);
        if (q && q.tones.every(([iv]) => set.has((c.root + iv) % 12))) fit += c.beats;
      }
      return { ...k, fit: fit / total, total: k.score + 0.35 * (fit / total) };
    }).sort((a, b) => b.total - a.total);
    const top = cands[0];
    if (top.tonicPc === key.tonicPc && top.mode === key.mode) return { ...key, chordFit: top.fit };
    const margin = cands.length > 1 ? top.total - cands[1].total : 0.2;
    return { tonicPc: top.tonicPc, mode: top.mode, confidence: clamp(0.35 + top.score * 0.4 + margin * 2, 0.05, 0.95), scores: cands.slice(0, 4), all: key.all, chordFit: top.fit };
  }

  const chordName = (root, q, bass) => NOTE_NAMES[root] + q.suffix + (bass !== null && bass !== undefined ? "/" + NOTE_NAMES[bass] : "");

  /* Chart text for copying: header + bars, four to a line. */
  function chartText(chart, meta = {}) {
    if (!chart || !chart.bars.length) return "";
    const lines = [];
    const head = [meta.title, meta.artist].filter(Boolean).join(" — ");
    if (head) lines.push(head);
    const facts = [meta.bpm ? `${Math.round(meta.bpm)} BPM` : "", meta.key || "", chart.meter || "", meta.tuning || ""].filter(Boolean);
    if (facts.length) lines.push(facts.join(" · "));
    if (chart.loop) lines.push(`Loop (${chart.loop.bars} bar${chart.loop.bars > 1 ? "s" : ""}): ${chart.loop.names.join(" → ")}${chart.loop.romans.some(Boolean) ? "   (" + chart.loop.romans.join(" – ") + ")" : ""}`);
    lines.push("");
    const cell = (bar) => (bar.chords.length ? bar.chords.map((c) => c.name).join(" ") : "N.C.");
    const width = Math.max(4, ...chart.bars.map((b) => cell(b).length));
    for (let i = 0; i < chart.bars.length; i += 4) {
      const row = chart.bars.slice(i, i + 4);
      const label = String(row[0].number).padStart(3, " ");
      lines.push(`${label} | ${row.map((b) => cell(b).padEnd(width, " ")).join(" | ")} |`);
    }
    return lines.join("\n");
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
      this.pcBin = new Int8Array(CHROMA_N / 2).fill(-1);
      this.pcWeight = new Float32Array(CHROMA_N / 2);
      this.isBass = new Uint8Array(CHROMA_N / 2);
      this.buildPitchMap(0);
      this.rhythm = new global.SipraRhythm(sampleRate);
      this.reset();
    }

    // Pitch-class lookup per chroma bin (with a weight that fades between semitones).
    // `cents` shifts the grid for songs not tuned to A4 = 440 Hz.
    buildPitchMap(cents) {
      const binHz = this.sr / CHROMA_N;
      this.mapCents = cents;
      this.pcBin.fill(-1);
      for (let b = 1; b < CHROMA_N / 2; b += 1) {
        const f = b * binHz;
        if (f < 55 || f > 4200) continue;
        const midi = 69 + 12 * Math.log2(f / 440) - cents / 100;
        const near = Math.round(midi);
        const dev = Math.abs(midi - near);
        this.pcBin[b] = ((near % 12) + 12) % 12;
        this.pcWeight[b] = Math.pow(Math.cos(Math.PI * dev), 2) * (f < 100 ? 0.5 : f > 2000 ? 0.6 : 1);
        // Bass notes: 55–260 Hz (low peaks are placed between bins in chromaFrame).
        this.isBass[b] = f <= 260 ? 1 : 0;
      }
    }

    // Tuning: the average offset of spectral peaks from the nearest semitone,
    // as a circular mean (−50…+50 cents), once it is clear enough.
    updateTuning() {
      const t = this.tune;
      if (t.w <= 0) return;
      const R = Math.hypot(t.re, t.im) / t.w;
      const cents = (Math.atan2(t.im, t.re) / (2 * Math.PI)) * 100;
      this.tuning = { cents: Math.round(cents), clarity: R, a4: 440 * Math.pow(2, cents / 1200) };
      if (R > 0.3 && Math.abs(cents - this.mapCents) >= 6) this.buildPitchMap(Math.round(cents));
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
      // Transcription: every chroma frame of the song, the beat grid, tempo log.
      this.frames = [];
      this.grid = [];
      this.tempoLog = [];
      this.chart = null;
      this.tune = { re: 0, im: 0, w: 0, frames: 0 };
      this.tuning = null;
      if (this.mapCents) this.buildPitchMap(0);
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
        const binHz = this.sr / CHROMA_N, tune = this.tune;
        let maxMag = 0;
        for (let b = 2; b < half - 1; b += 1) if (mag[b] > maxMag) maxMag = mag[b];
        for (let b = 2; b < half - 1; b += 1) {
          let pc = this.pcBin[b];
          if (pc < 0) continue;
          const m = mag[b];
          if (m <= mag[b - 1] || m < mag[b + 1]) continue;
          let weight = this.pcWeight[b];
          if (b * binHz < 300) {
            // Low notes are closer together than one bin: place the peak between
            // bins (parabolic fit) before naming its note.
            const a = Math.log(mag[b - 1] + 1e-12), c = Math.log(mag[b + 1] + 1e-12), y = Math.log(m + 1e-12);
            const p = clamp(0.5 * (a - c) / (a - 2 * y + c || 1), -0.5, 0.5);
            const midi = 69 + 12 * Math.log2(((b + p) * binHz) / 440) - this.mapCents / 100;
            const near = Math.round(midi);
            pc = ((near % 12) + 12) % 12;
            weight = Math.pow(Math.cos(Math.PI * (midi - near)), 2) * (b * binHz < 100 ? 0.5 : 1);
          }
          const v = Math.log1p(m * 20) * weight;
          chroma[pc] += v;
          if (this.isBass[b]) bass[pc] += v;
          // Tuning evidence: strong peaks between 100 Hz and 2 kHz, located to a
          // fraction of a bin, measured against A4 = 440 Hz.
          if (m > maxMag * 0.1 && b * binHz > 100 && b * binHz < 2000) {
            const a = Math.log(mag[b - 1] + 1e-12), c = Math.log(mag[b + 1] + 1e-12), y = Math.log(m + 1e-12);
            const p = 0.5 * (a - c) / (a - 2 * y + c || 1);
            const midi = 69 + 12 * Math.log2(((b + clamp(p, -0.5, 0.5)) * binHz) / 440);
            const dev = midi - Math.round(midi);
            const w = Math.log1p(m * 20);
            tune.re += w * Math.cos(2 * Math.PI * dev); tune.im += w * Math.sin(2 * Math.PI * dev); tune.w += w;
          }
        }
        tune.frames += 1;
        if (tune.frames === 60 || tune.frames % 240 === 0) this.updateTuning();
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
      // Keep the whole song (up to ~10 min) for the beat-by-beat chord chart.
      this.frames.push({ t: (start + CHROMA_N / 2) / this.sr, c: Float32Array.from(chroma), b: Float32Array.from(bass), e: rms });
      if (this.frames.length > 13000) this.frames.splice(0, 1000);
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

    key() { return keyFromChroma(this.songChroma, this.songBass); }

    // Key of just the last ~30 s, to spot a key change (modulation).
    recentKey(seconds = 30) {
      const fr = this.frames;
      if (!fr.length) return null;
      const from = fr[fr.length - 1].t - seconds;
      const c = new Float64Array(12), b = new Float64Array(12);
      let n = 0;
      for (let i = fr.length - 1; i >= 0 && fr[i].t >= from; i -= 1) {
        const w = clamp(fr[i].e * 20, 0.1, 1);
        for (let k = 0; k < 12; k += 1) { c[k] += fr[i].c[k] * w; b[k] += fr[i].b[k] * w; }
        n += 1;
      }
      return n > 100 ? keyFromChroma(c, b) : null;
    }

    // Merge the tracker's latest beats into the song-long beat grid. The newest
    // stretch is re-tracked every update, so it replaces what we had there.
    mergeBeats(beats, period) {
      if (!beats || !beats.length) return;
      const cut = beats[0] - period * 0.5;
      while (this.grid.length && this.grid[this.grid.length - 1] >= cut) this.grid.pop();
      for (const t of beats) this.grid.push(t);
      if (this.grid.length > 2400) this.grid.splice(0, this.grid.length - 2400);
    }

    /* Chord chart, beat by beat:
     *  1. average the chroma over each beat (and the bass notes under it),
     *  2. score every chord shape on every beat (plus "no chord"),
     *  3. Viterbi: the best path of chords through the song, where changing
     *     chord costs a little, and costs more away from the start of a bar,
     *  4. group the beats into bars, and look for the loop that repeats.
     */
    transcribe(r, key) {
      const grid = this.grid, fr = this.frames;
      const n = grid.length;
      if (n < 6 || !fr.length) return null;
      const T = r.beatPeriod || (grid[n - 1] - grid[0]) / (n - 1);
      const lastPos = r.lastBeatPos || 0;
      const diatonic = key && key.confidence > 0.3 ? diatonicSet(key) : null;
      const S = TEMPLATES.length, NC = S; // last state = no chord
      const inKey = TEMPLATES.map((tpl) => diatonic && tpl.q.tones.every(([iv]) => diatonic.has((tpl.root + iv) % 12)));

      // 1–2. Per-beat chroma and emission scores.
      const emit = new Float32Array(n * (S + 1));
      const beatBass = new Int8Array(n).fill(-1);
      const beatBassShare = new Float32Array(n);
      let f = 0;
      while (f < fr.length && fr[f].t < grid[0]) f += 1;
      for (let i = 0; i < n; i += 1) {
        const a = grid[i], b = i + 1 < n ? grid[i + 1] : grid[i] + T;
        const c = new Float64Array(12), bs = new Float64Array(12);
        let cnt = 0, energy = 0;
        while (f < fr.length && fr[f].t < a) f += 1;
        for (let j = f; j < fr.length && fr[j].t < b; j += 1) {
          for (let k = 0; k < 12; k += 1) { c[k] += fr[j].c[k]; bs[k] += fr[j].b[k]; }
          energy += fr[j].e; cnt += 1;
        }
        const row = i * (S + 1);
        let norm = 0;
        for (let k = 0; k < 12; k += 1) norm += c[k] * c[k];
        norm = Math.sqrt(norm);
        if (!cnt || norm < 1e-9 || energy / cnt < 0.003) { emit[row + NC] = 1; continue; }
        for (let k = 0; k < 12; k += 1) c[k] /= norm;
        let bp = -1, bm = 0, bsum = 0;
        for (let k = 0; k < 12; k += 1) { bsum += bs[k]; if (bs[k] > bm) { bm = bs[k]; bp = k; } }
        const bassClear = bsum > 0 && bm / bsum > 0.22;
        if (bassClear) { beatBass[i] = bp; beatBassShare[i] = bm / bsum; }
        for (let s = 0; s < S; s += 1) {
          const tpl = TEMPLATES[s];
          let sc = 0;
          for (let k = 0; k < 12; k += 1) sc += c[k] * tpl.v[k];
          sc -= tpl.q.penalty || 0;
          // The bass is the best clue to the harmony under a loud melody:
          // reward a chord for the bass sitting on its root (or another of its
          // notes), and mark it down when the clear bass note isn't in it.
          if (bsum > 0) {
            const rootShare = bs[tpl.root] / bsum;
            sc += 0.22 * rootShare;
            if (bassClear && bp !== tpl.root) sc += tpl.q.tones.some(([iv]) => (tpl.root + iv) % 12 === bp) ? 0.02 : -0.08 * (bm / bsum);
          }
          if (inKey[s]) sc += 0.035;
          emit[row + s] = sc;
        }
        emit[row + NC] = 0.6;
      }

      // 3. Viterbi with a change cost, tried for each possible downbeat (and for
      //    3 vs 4 beats per bar). Chords tend to change on beat 1, so the bar
      //    grid that lets the changes line up with bar lines scores best.
      const back = new Int16Array(n * (S + 1));
      const viterbi = (B, shift) => {
        const pos = new Int8Array(n);
        for (let i = 0; i < n; i += 1) pos[i] = (((lastPos + shift - (n - 1 - i)) % B) + B) % B;
        let dp = new Float32Array(S + 1), next = new Float32Array(S + 1);
        for (let s = 0; s <= S; s += 1) dp[s] = emit[s];
        for (let i = 1; i < n; i += 1) {
          let best = 0;
          for (let s = 1; s <= S; s += 1) if (dp[s] > dp[best]) best = s;
          const p = pos[i];
          // Cheap on beat 1 (a 2-beat chord can still show), dearer mid-bar.
          const cost = 0.11 + (p === 0 ? 0 : (B % 2 === 0 && p === B / 2) ? 0.07 : 0.17);
          const row = i * (S + 1);
          for (let s = 0; s <= S; s += 1) {
            const stay = dp[s], jump = dp[best] - cost;
            if (stay >= jump) { next[s] = stay + emit[row + s]; back[row + s] = s; }
            else { next[s] = jump + emit[row + s]; back[row + s] = best; }
          }
          const tmp = dp; dp = next; next = tmp;
        }
        let state = 0;
        for (let s = 1; s <= S; s += 1) if (dp[s] > dp[state]) state = s;
        const score = dp[state];
        const labels = new Int16Array(n);
        for (let i = n - 1; i >= 0; i -= 1) { labels[i] = state; state = back[i * (S + 1) + state]; }
        let changes = 0, onDown = 0;
        for (let i = 1; i < n; i += 1) if (labels[i] !== labels[i - 1]) { changes += 1; if (pos[i] === 0) onDown += 1; }
        return { B, shift, pos, labels, score, changes, downFrac: changes ? onDown / changes : 0 };
      };
      const B0 = r.beatsPerBar || 4;
      const base = viterbi(B0, 0);
      let pick = base;
      // Same bar length, different downbeat: needs a clear win to move.
      for (let sh = 1; sh < B0; sh += 1) {
        const v = viterbi(B0, sh);
        if (v.score > pick.score + 0.15 + (pick === base ? 0.1 : 0)) pick = v;
      }
      // 3 vs 4 beats per bar, from where the chords change (simple meters only).
      if (!r.compound && (B0 === 3 || B0 === 4) && base.changes >= 6) {
        const alt = B0 === 3 ? 4 : 3;
        let bestAlt = null;
        for (let sh = 0; sh < alt; sh += 1) { const v = viterbi(alt, sh); if (!bestAlt || v.score > bestAlt.score) bestAlt = v; }
        // Wins on score, or because nearly every change lands on its beat 1
        // while under the current bar length many don't.
        const clearer = bestAlt.downFrac >= 0.85 && pick.downFrac <= 0.6 && bestAlt.score > pick.score - 0.2;
        if (clearer || bestAlt.score > pick.score + Math.max(0.6, 0.06 * base.changes)) pick = bestAlt;
      }
      const { B, pos, labels } = pick;

      // 4. Bars. Beats before the first downbeat make a pickup bar.
      const bars = [];
      let bar = null;
      for (let i = 0; i < n; i += 1) {
        if (!bar || pos[i] === 0) {
          bar = { start: grid[i], beats: [], pickup: !bars.length && pos[i] !== 0 };
          bars.push(bar);
        }
        bar.beats.push(i);
      }
      // We usually start listening mid-song: a first bar that's at least half
      // there counts as bar 1 rather than a pickup.
      if (bars.length && bars[0].pickup && bars[0].beats.length >= Math.ceil(B / 2)) bars[0].pickup = false;
      const describe = (s, from, to) => {
        if (s === NC) return null;
        const tpl = TEMPLATES[s];
        // Inversion: a chord tone (not the root) that is clearly lowest for most of the span.
        const votes = new Map();
        for (let i = from; i <= to; i += 1) if (beatBass[i] >= 0) votes.set(beatBass[i], (votes.get(beatBass[i]) || 0) + beatBassShare[i]);
        let bassPc = null, top = 0;
        for (const [pc, v] of votes) if (v > top) { top = v; bassPc = pc; }
        const tones = tpl.q.tones.map(([iv]) => (tpl.root + iv) % 12);
        const slash = bassPc !== null && bassPc !== tpl.root && tones.includes(bassPc) && top > 0.35 * (to - from + 1) ? bassPc : null;
        return {
          name: chordName(tpl.root, tpl.q, slash), root: tpl.root, quality: tpl.q.id,
          roman: romanNumeral({ root: tpl.root, q: tpl.q }, key), beats: to - from + 1, state: s
        };
      };
      let number = 0;
      const out = bars.map((b) => {
        if (!b.pickup) number += 1;
        const chords = [];
        let from = b.beats[0];
        for (let k = 1; k <= b.beats.length; k += 1) {
          const i = b.beats[k], prev = b.beats[k - 1];
          if (k === b.beats.length || labels[i] !== labels[prev]) {
            const c = describe(labels[prev], from, prev);
            if (c) chords.push(c);
            from = i;
          }
        }
        return { number: b.pickup ? 0 : number, start: b.start, pickup: b.pickup, complete: b.beats.length === B, chords };
      }).filter((b) => !b.pickup || b.chords.length);

      // Changes per minute, and the repeating loop.
      let changes = 0;
      for (let i = 1; i < n; i += 1) if (labels[i] !== labels[i - 1]) changes += 1;
      const minutes = (grid[n - 1] - grid[0]) / 60;
      const meterLabel = B === B0 ? (r.meterReady ? r.meter : null) : global.SipraRhythm.METER_LABEL[B];
      return {
        meter: meterLabel, beatsPerBar: B, meterFromChords: B !== B0,
        // Where bar 1 falls, as the position of the newest beat in its bar.
        lastBeatPos: pos[n - 1], downbeatMoved: pick !== base,
        bars: out, loop: this.findLoop(out),
        changesPerMinute: minutes > 0.2 ? Math.round(changes / minutes) : null,
        currentBar: out.length ? out[out.length - 1].number : 0
      };
    }

    // The shortest run of bars (1–8) that repeats over the last 24 complete bars.
    findLoop(bars) {
      const seq = bars.filter((b) => b.complete && !b.pickup).slice(-24).map((b) => b.chords.map((c) => c.name).join(" ") || "N.C.");
      if (seq.length < 4) return null;
      const ratioAt = (p) => {
        if (seq.length < 2 * p) return 0;
        let match = 0, total = 0;
        for (let i = p; i < seq.length; i += 1) { total += 1; if (seq[i] === seq[i - p]) match += 1; }
        return total ? match / total : 0;
      };
      for (let p of [1, 2, 3, 4, 6, 8]) {
        let ratio = ratioAt(p);
        if (!ratio && seq.length < 2 * p) break;
        if (ratio >= 0.75) {
          // A longer loop that repeats exactly beats a shorter one with exceptions
          // (Am F C G Am F C E7 is one 8-bar loop, not 4 bars with a wrong note).
          while (p <= 4 && ratioAt(2 * p) >= Math.max(0.9, ratio + 0.15)) { p *= 2; ratio = ratioAt(p); }
          const match = ratio, total = 1;
          const recent = bars.filter((b) => b.complete && !b.pickup).slice(-24);
          // Start the loop on a bar that lines up with bar 1 of the song (bar ≡ 1 mod p).
          let startIdx = recent.length - p;
          for (let j = recent.length - p; j >= 0; j -= 1) if ((recent[j].number - 1) % p === 0) { startIdx = j; break; }
          const loopBars = recent.slice(startIdx, startIdx + p);
          if (loopBars.every((b) => !b.chords.length)) return null;
          const chords = loopBars.flatMap((b) => b.chords);
          return { bars: p, names: chords.map((c) => c.name), romans: chords.map((c) => c.roman), strength: match / total };
        }
      }
      return null;
    }

    // Tempo over the song: steady, speeding up, or slowing down.
    tempoStats() {
      const log = this.tempoLog;
      if (log.length < 6) return null;
      const xs = log.map((p) => p.t), ys = log.map((p) => p.bpm);
      const n = log.length, xm = xs.reduce((a, b) => a + b, 0) / n, ym = ys.reduce((a, b) => a + b, 0) / n;
      let num = 0, den = 0, ss = 0;
      for (let i = 0; i < n; i += 1) { num += (xs[i] - xm) * (ys[i] - ym); den += (xs[i] - xm) ** 2; ss += (ys[i] - ym) ** 2; }
      const perMinute = den > 0 ? (num / den) * 60 : 0;
      const sd = Math.sqrt(ss / n);
      const span = (xs[n - 1] - xs[0]) / 60;
      const drift = perMinute * span; // BPM gained or lost over what we heard
      const trend = Math.abs(drift) >= 3 && Math.abs(perMinute) >= 1.5 ? (perMinute > 0 ? "speeding up" : "slowing down") : sd < 1.5 ? "steady" : "loose";
      return { mean: ym, sd, perMinute, min: Math.min(...ys), max: Math.max(...ys), trend };
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
      let key = this.key();
      this.mergeBeats(r.beats, r.beatPeriod);
      // Tempo log, skipping octave flips while the tracker settles.
      const prevBpm = this.tempoLog.length ? this.tempoLog[this.tempoLog.length - 1].bpm : null;
      if (!prevBpm || Math.abs(r.bpm / prevBpm - 1) < 0.15) this.tempoLog.push({ t: this.seconds, bpm: r.bpm });
      else this.tempoLog = [{ t: this.seconds, bpm: r.bpm }];
      if (this.tempoLog.length > 400) this.tempoLog.shift();
      // Chart first with the note-strength key, then let the chords settle the
      // key (whole song, and the last 30 s for a key change), then re-chart.
      let chart = this.transcribe(r, key);
      key = refineKey(key, chart && chart.bars);
      let keyNow = null;
      if (this.seconds > 45 && chart) {
        const now = this.seconds;
        const recentBars = chart.bars.filter((b) => b.start >= now - 30);
        const local = refineKey(this.recentKey(30), recentBars);
        if (local && local.confidence > 0.45 && (local.tonicPc !== key.tonicPc || local.mode !== key.mode)) {
          // Ignore the relative major/minor: same notes, not a key change.
          const relative = local.mode !== key.mode && (key.mode === "major" ? (key.tonicPc + 9) % 12 : (key.tonicPc + 3) % 12) === local.tonicPc;
          if (!relative) keyNow = local;
        }
      }
      this.chart = this.transcribe(r, keyNow || key);
      // The chord changes can correct the tracker's downbeat (and 3 vs 4 per bar).
      const barFix = {};
      if (this.chart && (this.chart.downbeatMoved || this.chart.meterFromChords)) {
        barFix.lastBeatPos = this.chart.lastBeatPos;
        barFix.beatsPerBar = this.chart.beatsPerBar;
        if (this.chart.meterFromChords && r.meterReady) barFix.meter = this.chart.meter;
      }
      this.result = {
        ...r,
        ...barFix,
        beatAnchor: r.lastBeatTime,
        key, keyNow,
        chroma: this.songChroma.slice(),
        chart: this.chart,
        tuning: this.tuning && this.tuning.clarity > 0.3 ? this.tuning : null,
        tempo: this.tempoStats()
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

  /* SipraListener: wraps SipraEngine for live listening.
   *  - Level: boosts quiet input (mic, low volume) for analysis only, up to ×40.
   *  - Gaps: silence (pauses, the space between songs) is left out of the
   *    analysis, so it doesn't blur the tempo or key.
   *  - New songs: after a gap, a second engine starts fresh beside the first.
   *    Once it has ~12 s of music it is compared with the first: a different
   *    tempo or key means a new song (it takes over, keeping those 12 s); the
   *    same tempo and key means a pause (it is dropped).
   *  - epoch: goes up whenever the analysis clock jumps (reset, gap, new song),
   *    so the page knows to re-sync its beat clock.
   * Same reading API as SipraEngine: update(), chordInfo(), seconds, result.
   */
  const TARGET_LEVEL = 0.08, MAX_GAIN = 40;
  const GAP_SECONDS = 0.6, MIN_SONG_SECONDS = 15, PROBE_SECONDS = 12, PROBE_GIVE_UP = 30;

  class SipraListener {
    constructor(sampleRate, options = {}) {
      this.sr = sampleRate;
      this.autoSplit = options.autoSplit !== false;
      this.onSongChange = options.onSongChange || null;
      this.main = new SipraEngine(sampleRate);
      this.probe = null;
      this.epoch = 0;
      this.songs = 1;
      this.level = 0;          // raw input level (RMS), smoothed
      this.musicLevel = 0;     // typical level while music plays
      this.quietFor = 0;       // seconds of continuous quiet
      this.inGap = false;
      this.gain = 1;
      this.lastChange = null;  // { at, reason }
    }

    get seconds() { return this.main.seconds; }
    get result() { return this.main.result; }
    get energy() { return this.inGap ? 0 : this.main.energy; }
    get probing() { return Boolean(this.probe); }
    /** Seconds of near-silence on the input (for "nothing is playing" hints). */
    get silentSeconds() { return this.quietFor; }
    /** True when the input is quiet even at full boost (mic too far away). */
    get tooQuiet() { return !this.inGap && this.musicLevel > 0 && this.musicLevel * MAX_GAIN < TARGET_LEVEL * 0.5; }

    reset() {
      this.main.reset();
      this.probe = null;
      this.quietFor = 0;
      this.inGap = false;
      this.epoch += 1;
    }

    /** Start counting a new song now (the "New song" button, or a metadata change). */
    newSong(reason = "manual") {
      const previous = this.main.result && this.main.result.ready ? this.summary(this.main) : null;
      this.reset();
      this.songs += 1;
      this.lastChange = { at: Date.now(), reason };
      if (previous && this.onSongChange) this.onSongChange(previous, reason);
    }

    push(chunk) {
      let e = 0;
      for (let i = 0; i < chunk.length; i += 1) e += chunk[i] * chunk[i];
      const rms = Math.sqrt(e / chunk.length);
      const dt = chunk.length / this.sr;
      this.level = this.level * 0.7 + rms * 0.3;
      // Quiet = far below this song's usual level (or below the noise floor).
      const floor = Math.max(0.00025, this.musicLevel * 0.02);
      const quiet = rms < floor;
      this.quietFor = quiet ? this.quietFor + dt : 0;
      if (!quiet) {
        // Slow-moving music level: rises fast, falls slowly.
        const k = rms > this.musicLevel ? 0.08 : 0.01;
        this.musicLevel = this.musicLevel ? this.musicLevel + (rms - this.musicLevel) * k : rms;
      }
      if (this.quietFor >= GAP_SECONDS) {
        if (!this.inGap) { this.inGap = true; this.gapStartedAt = this.main.seconds; }
        return false;
      }
      if (this.inGap && !quiet) {
        // Music is back after a gap.
        this.inGap = false;
        this.epoch += 1;
        if (this.autoSplit && !this.probe && this.main.seconds >= MIN_SONG_SECONDS) {
          // Remember the song as it was before the gap, in case this turns out to be a new one.
          const before = this.main.update();
          this.beforeGap = before && before.ready ? this.summary(this.main) : null;
          this.probe = new SipraEngine(this.sr);
        }
      }
      // Short dips (stops, breaks) stay in, so the beat grid keeps its timing.
      // Boost quiet input towards a steady analysis level (never turn it down).
      const want = this.musicLevel > 0 ? clamp(TARGET_LEVEL / this.musicLevel, 1, MAX_GAIN) : 1;
      this.gain += (want - this.gain) * 0.05;
      let input = chunk;
      if (this.gain > 1.02) {
        input = new Float32Array(chunk.length);
        for (let i = 0; i < chunk.length; i += 1) input[i] = clamp(chunk[i] * this.gain, -1, 1);
      }
      this.main.push(input);
      if (this.probe) this.probe.push(input);
      return true;
    }

    summary(engine) {
      const r = engine.result;
      const info = engine.chordInfo();
      const time = new Map();
      for (const h of info.history) time.set(h.name, (time.get(h.name) || 0) + (h.end - h.start));
      const loop = r.chart && r.chart.loop;
      return {
        bpm: r.bpm, key: { tonicPc: r.key.tonicPc, mode: r.key.mode, confidence: r.key.confidence },
        meter: r.meterReady ? r.meter : "4/4", seconds: engine.seconds,
        chords: loop ? loop.names.slice(0, 8) : [...time.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n]) => n),
        chart: r.chart || null
      };
    }

    // Same song after a pause, or a new one?
    sameSong(a, b, ea, eb) {
      const ratio = b.bpm / a.bpm;
      const tempoSame = [1, 2, 0.5].some((k) => Math.abs(ratio / k - 1) < 0.04);
      const tonal = correlate(ea.songChroma, eb.songChroma);
      const keySame = a.key.tonicPc === b.key.tonicPc && a.key.mode === b.key.mode;
      const relative = (a.key.mode !== b.key.mode) && ((a.key.mode === "major" ? (a.key.tonicPc + 9) : (a.key.tonicPc + 3)) % 12 === b.key.tonicPc);
      if (tonal < 0.55) return false;                 // clearly different notes
      if (!tempoSame && tonal < 0.9) return false;    // different groove and not the same harmony
      return keySame || relative || tonal > 0.85;
    }

    update() {
      const r = this.main.update();
      if (this.probe) {
        const p = this.probe.update();
        if (p.ready && this.probe.seconds >= PROBE_SECONDS && r.ready) {
          if (this.sameSong(r, p, this.main, this.probe)) {
            this.probe = null;
          } else {
            const previous = this.beforeGap || this.summary(this.main);
            this.main = this.probe;
            this.probe = null;
            this.songs += 1;
            this.epoch += 1;
            this.lastChange = { at: Date.now(), reason: "auto" };
            if (this.onSongChange) this.onSongChange(previous, "auto");
            return this.main.result;
          }
        } else if (this.probe.seconds > PROBE_GIVE_UP) {
          this.probe = null;
        }
      }
      return r;
    }

    chordInfo() { return this.main.chordInfo(); }
  }

  SipraEngine.NOTE_NAMES = NOTE_NAMES;
  SipraEngine.QUALITIES = QUALITIES;
  SipraEngine.Listener = SipraListener;
  SipraEngine.chartText = chartText;
  SipraEngine.romanNumeral = romanNumeral;
  global.SipraEngine = SipraEngine;
  global.SipraListener = SipraListener;
})(typeof window !== "undefined" ? window : globalThis);
