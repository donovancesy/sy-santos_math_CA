/* Sipra rhythm: tempo, beats, meter and downbeat, following a song live.
 *
 *  1. Onset strength: log-mel spectral flux (40 bands, 30 Hz–8 kHz) every ~11 ms,
 *     plus a low-band version (kick + bass) for accents.
 *  2. Tempo: autocorrelation of the onset strength over the last ~22 s, with
 *     harmonic support (A(τ) + ½A(2τ)) and a log-normal prior around 120 BPM.
 *     Range 40–240 BPM. Octave flips need repeated evidence before they show.
 *  3. Beats: dynamic-programming beat tracker (Ellis 2007, as in librosa):
 *     the best chain of beats that lands on onsets and keeps a steady spacing.
 *     The tempo shown is the slope of the tracked beats, so it follows drift.
 *  4. Meter (2–7 beats per bar) + downbeat: per-beat accents, chord changes
 *     and pattern repetition; the bar length whose phase stands out wins.
 */
(function (global) {
  "use strict";
  const A = global.SipraAnalysis;
  const { getFFTPlan, fftWithPlan } = A;

  const N = 2048, HOP = 512, RING = 1 << 15;
  const MAX_SECONDS = 60, TEMPO_SECONDS = 22;
  const METER_LABEL = { 2: "2/4", 3: "3/4", 4: "4/4", 5: "5/4", 6: "6/8", 7: "7/4" };
  const METER_PRIOR = { 2: 0, 3: 0.03, 4: 0.12, 5: 0, 6: -0.06, 7: -0.04 };

  function hann(n) { const w = new Float32Array(n); for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); return w; }
  const hz2mel = (f) => 2595 * Math.log10(1 + f / 700);
  const mel2hz = (m) => 700 * (Math.pow(10, m / 2595) - 1);
  const mean = (a) => { let s = 0; for (let i = 0; i < a.length; i += 1) s += a[i]; return a.length ? s / a.length : 0; };
  function std(a, m = mean(a)) { let s = 0; for (let i = 0; i < a.length; i += 1) s += (a[i] - m) * (a[i] - m); return Math.sqrt(s / Math.max(1, a.length)); }
  function zscore(a) { const m = mean(a), s = std(a, m) || 1; return a.map((v) => (v - m) / s); }
  function cos(a, b) { let n = 0, x = 0, y = 0; for (let i = 0; i < a.length; i += 1) { n += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return n / (Math.sqrt(x * y) + 1e-12); }

  // Remove slow trends and normalise so loud and quiet songs behave the same.
  function prepare(x) {
    const n = x.length, out = new Float32Array(n), W = 8;
    let acc = 0;
    const pre = new Float64Array(n + 1);
    for (let i = 0; i < n; i += 1) { acc += x[i]; pre[i + 1] = acc; }
    for (let i = 0; i < n; i += 1) {
      const a = Math.max(0, i - W), b = Math.min(n, i + W + 1);
      out[i] = Math.max(0, x[i] - (pre[b] - pre[a]) / (b - a));
    }
    const s = std(out) || 1;
    for (let i = 0; i < n; i += 1) out[i] /= s;
    return out;
  }

  class SipraRhythm {
    constructor(sampleRate) {
      this.sr = sampleRate;
      this.fps = sampleRate / HOP;
      this.win = hann(N);
      this.plan = getFFTPlan(N);
      this.re = new Float64Array(N); this.im = new Float64Array(N);
      this.ring = new Float32Array(RING);
      // Mel filterbank (40 triangles).
      const bands = 40, fmin = 30, fmax = Math.min(8000, sampleRate / 2 - 100);
      const mels = [];
      for (let i = 0; i < bands + 2; i += 1) mels.push(mel2hz(hz2mel(fmin) + ((hz2mel(fmax) - hz2mel(fmin)) * i) / (bands + 1)));
      const binHz = sampleRate / N;
      this.filters = [];
      this.lowBands = [];
      this.highBands = [];
      for (let b = 0; b < bands; b += 1) {
        const lo = mels[b], mid = mels[b + 1], hi = mels[b + 2];
        const taps = [];
        for (let k = Math.max(1, Math.floor(lo / binHz)); k <= Math.min(N / 2 - 1, Math.ceil(hi / binHz)); k += 1) {
          const f = k * binHz;
          const w = f < mid ? (f - lo) / (mid - lo) : (hi - f) / (hi - mid);
          if (w > 0) taps.push([k, w]);
        }
        if (!taps.length) taps.push([Math.max(1, Math.round(mid / binHz)), 1]);
        this.filters.push(taps);
        if (mid < 160) this.lowBands.push(b);
        if (mid > 2500) this.highBands.push(b);
      }
      this.reset();
    }

    reset() {
      this.total = 0; this.next = 0; this.frameCount = 0;
      this.prev = null;
      this.odf = []; this.low = []; this.high = []; this.start = 0;   // start = global index of odf[0]
      this.chroma = [];                               // [{t, v}]
      this.period = null; this.pending = null; this.pendingCount = 0;
      this.meterVotes = new Map();
      this.meterUpdates = 0;
      this.oomLock = false;
      this.twoFourAmbiguous = false;
      this.ambVotes = 0;
      this.feelVotes = new Map();
      this.last = null;
    }

    frameTime(g) { return (g * HOP + N / 2) / this.sr; }

    push(chunk) {
      for (let i = 0; i < chunk.length; i += 1) this.ring[(this.total + i) & (RING - 1)] = chunk[i];
      this.total += chunk.length;
      while (this.next + N <= this.total) { this.frame(this.next); this.next += HOP; }
    }

    frame(startSample) {
      const { re, im, win, ring } = this;
      for (let i = 0; i < N; i += 1) { re[i] = ring[(startSample + i) & (RING - 1)] * win[i]; im[i] = 0; }
      fftWithPlan(re, im, this.plan);
      const bands = this.filters.length, lm = new Float32Array(bands);
      for (let b = 0; b < bands; b += 1) {
        let e = 0;
        for (const [k, w] of this.filters[b]) e += w * (re[k] * re[k] + im[k] * im[k]);
        lm[b] = 10 * Math.log10(e + 1e-10);
      }
      let flux = 0, low = 0, high = 0;
      if (this.prev) {
        for (let b = 0; b < bands; b += 1) flux += Math.max(0, lm[b] - this.prev[b]);
        for (const b of this.lowBands) low += Math.max(0, lm[b] - this.prev[b]);
        for (const b of this.highBands) high += Math.max(0, lm[b] - this.prev[b]);
        flux /= bands; low /= Math.max(1, this.lowBands.length); high /= Math.max(1, this.highBands.length);
      }
      this.prev = lm;
      this.odf.push(flux); this.low.push(low); this.high.push(high);
      this.frameCount += 1;
      const max = Math.round(MAX_SECONDS * this.fps);
      if (this.odf.length > max + 400) {
        const cut = this.odf.length - max;
        this.odf.splice(0, cut); this.low.splice(0, cut); this.high.splice(0, cut); this.start += cut;
      }
    }

    addChroma(t, v) {
      this.chroma.push({ t, v });
      while (this.chroma.length && this.chroma[0].t < t - MAX_SECONDS) this.chroma.shift();
    }

    /* ---------- tempo from autocorrelation ---------- */
    tempoPeriod(o) {
      const fps = this.fps, n = o.length;
      const tMin = Math.floor((fps * 60) / 240), tMax = Math.ceil((fps * 60) / 40);
      const maxLag = Math.min(n - 2, tMax * 2 + 2);
      const m = mean(o);
      const x = new Float32Array(n);
      for (let i = 0; i < n; i += 1) x[i] = o[i] - m;
      const ac = new Float64Array(maxLag + 1);
      for (let lag = 0; lag <= maxLag; lag += 1) {
        let s = 0;
        for (let i = 0; i + lag < n; i += 1) s += x[i] * x[i + lag];
        ac[lag] = s / (n - lag);
      }
      const a0 = ac[0] || 1;
      for (let i = 0; i <= maxLag; i += 1) ac[i] /= a0;
      const at = (l) => { if (l > maxLag) return 0; const i = Math.floor(l), f = l - i; return ac[i] * (1 - f) + (ac[i + 1] || 0) * f; };
      const score = new Float64Array(tMax + 2);
      let best = -1, bestS = -Infinity;
      for (let lag = tMin; lag <= Math.min(tMax, maxLag); lag += 1) {
        const bpm = (fps * 60) / lag;
        const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 1.0, 2));
        const s = Math.max(0, at(lag) + 0.5 * at(2 * lag)) * prior;
        score[lag] = s;
        if (s > bestS) { bestS = s; best = lag; }
      }
      if (best < 0) return null;
      // Parabolic refinement for sub-frame precision.
      const y0 = score[best - 1] || 0, y1 = score[best], y2 = score[best + 1] || 0;
      const d = (y0 - y2) / (2 * (y0 - 2 * y1 + y2) || 1);
      const lag = best + Math.max(-0.5, Math.min(0.5, d));
      // Confidence: how much the peak stands out.
      let sum = 0, cnt = 0;
      for (let l = tMin; l <= Math.min(tMax, maxLag); l += 1) { sum += score[l]; cnt += 1; }
      const conf = Math.max(0.05, Math.min(0.98, (bestS - sum / cnt) / (bestS + 1e-9)));
      return { period: lag, confidence: conf };
    }

    /* ---------- dynamic-programming beat tracker ---------- */
    trackBeats(o, period, tightness = 100) {
      const n = o.length;
      const p = period;
      // Local score: onset strength smoothed by a narrow Gaussian.
      const half = Math.max(1, Math.round(p)), sigma = Math.max(0.5, p / 32);
      const kern = []; for (let k = -half; k <= half; k += 1) kern.push(Math.exp(-0.5 * (k / sigma) * (k / sigma)));
      const local = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        let s = 0;
        for (let k = -half; k <= half; k += 1) { const j = i + k; if (j >= 0 && j < n) s += o[j] * kern[k + half]; }
        local[i] = s;
      }
      const lo = Math.max(1, Math.round(p / 2)), hi = Math.round(p * 2);
      const tx = new Float64Array(hi + 1);
      for (let d = lo; d <= hi; d += 1) tx[d] = -tightness * Math.pow(Math.log(d / p), 2);
      const cum = new Float64Array(n), back = new Int32Array(n).fill(-1);
      const thresh = 0.01 * Math.max(...local);
      let started = false;
      for (let i = 0; i < n; i += 1) {
        let best = -Infinity, arg = -1;
        for (let d = lo; d <= hi && i - d >= 0; d += 1) {
          const v = cum[i - d] + tx[d];
          if (v > best) { best = v; arg = i - d; }
        }
        cum[i] = local[i] + (arg >= 0 && started ? best : 0);
        back[i] = started ? arg : -1;
        if (!started && local[i] > thresh) started = true;
      }
      // Last beat: the latest local maximum of the cumulative score that is strong enough.
      const maxima = [];
      for (let i = 1; i < n - 1; i += 1) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) maxima.push(i);
      if (!maxima.length) return [];
      const med = maxima.map((i) => cum[i]).sort((a, b) => a - b)[maxima.length >> 1];
      let tail = maxima[maxima.length - 1];
      for (let k = maxima.length - 1; k >= 0; k -= 1) if (cum[maxima[k]] >= 0.5 * med) { tail = maxima[k]; break; }
      const beats = [];
      for (let i = tail; i >= 0; i = back[i]) { beats.push(i); if (back[i] < 0) break; }
      beats.reverse();
      // Trim weak beats at the edges.
      const rms = Math.sqrt(mean(beats.map((b) => local[b] * local[b])));
      while (beats.length > 2 && local[beats[0]] < 0.5 * rms) beats.shift();
      while (beats.length > 2 && local[beats[beats.length - 1]] < 0.5 * rms) beats.pop();
      return beats;
    }

    /* ---------- meter + downbeat from beat-level features ---------- */
    meterFrom(beats, o, low, bpm, high) {
      const M = beats.length;
      if (M < 12) return null;
      const near = (arr, b) => { let m = 0; for (let k = -2; k <= 2; k += 1) { const v = arr[b + k]; if (v > m) m = v; } return m; };
      const acc = beats.map((b) => near(o, b));
      const lowA = beats.map((b) => near(low, b));
      const t = beats.map((b) => this.frameTime(this.winStart + b));
      // Beat-synchronous chroma.
      const chroma = [];
      let ci = 0;
      for (let i = 0; i < M; i += 1) {
        const a = t[i], b = i + 1 < M ? t[i + 1] : t[i] + (t[i] - t[i - 1]);
        const v = new Float64Array(12);
        let cnt = 0;
        while (ci < this.chroma.length && this.chroma[ci].t < a) ci += 1;
        for (let j = ci; j < this.chroma.length && this.chroma[j].t < b; j += 1) { const c = this.chroma[j].v; for (let k = 0; k < 12; k += 1) v[k] += c[k]; cnt += 1; }
        chroma.push(cnt ? v : (chroma[i - 1] || v));
      }
      const hc = chroma.map((c, i) => (i ? 1 - cos(c, chroma[i - 1]) : 0));
      hc[0] = mean(hc.slice(1));
      const hz = zscore(hc), lz = zscore(lowA), az = zscore(acc);
      const s = hz.map((v, i) => v + 0.7 * lz[i] + 0.4 * az[i]);
      // Feature vector per beat for pattern repetition.
      const F = chroma.map((c, i) => {
        const tot = c.reduce((x, y) => x + y, 0) || 1;
        return [...Array.from(c, (v) => v / tot * 3), az[i] * 0.5, lz[i] * 0.5];
      });
      const rep = (L) => { let sum = 0, cnt = 0; for (let i = 0; i + L < M; i += 1) { sum += cos(F[i], F[i + L]); cnt += 1; } return cnt ? sum / cnt : 0; };
      const R = {}; for (let L = 1; L <= 8; L += 1) R[L] = rep(L);
      const Rmean = mean(Object.values(R));
      const sMean = mean(s), sStd = std(s) || 1;
      const acfS = (L) => { let sum = 0, cnt = 0; for (let i = 0; i + L < M; i += 1) { sum += (s[i] - sMean) * (s[i + L] - sMean); cnt += 1; } return cnt ? sum / cnt / (sStd * sStd) : 0; };
      const scores = {};
      for (let m = 2; m <= 7; m += 1) {
        if (M < 3 * m) continue;
        if (m === 6) continue; // 6/8 is found through the triplet feel instead
        let bestC = -Infinity, bestPhase = 0;
        for (let ph = 0; ph < m; ph += 1) {
          let on = 0, onN = 0, off = 0, offN = 0;
          for (let i = 0; i < M; i += 1) { if (i % m === ph) { on += s[i]; onN += 1; } else { off += s[i]; offN += 1; } }
          const c = on / onN - off / offN;
          if (c > bestC) { bestC = c; bestPhase = ph; }
        }
        scores[m] = { score: 0.35 * bestC + 0.8 * acfS(m) + 2.5 * (R[m] - Rmean) + METER_PRIOR[m], phase: bestPhase, contrast: bestC };
      }
      // 2 vs 4: does beat 3 differ from beat 1? (half-bar asymmetry), vs the strength of the 2-beat pattern.
      this.debugTwoFour = null;
      if (scores[4] && scores[2]) {
        const ph = scores[4].phase, at = (q) => mean(s.filter((_, i) => i % 4 === q));
        const sd = std(s) || 1;
        // Chord-change asymmetry: do chords change on "beat 1" more than on "beat 3"?
        const hAt = (q) => mean(hz.filter((_, i) => i % 4 === q));
        let hp = 0; for (let q = 1; q < 4; q += 1) if (hAt(q) > hAt(hp)) hp = q;
        const hAsym = hAt(hp) - hAt((hp + 2) % 4);
        const hiA = beats.map((b) => near(high, b));
        const ph2 = scores[2].phase;
        const hiOn = mean(hiA.filter((_, i) => i % 2 === ph2)), hiOff = mean(hiA.filter((_, i) => i % 2 !== ph2));
        const backbeat = hiOff / (hiOn + 0.05);
        // Half-time drums: snare/clap noise sitting halfway between the tracked beats.
        const hiMid = mean(beats.slice(0, -1).map((b, i) => near(high, Math.round((b + beats[i + 1]) / 2))));
        const midSnare = hiMid / (mean(hiA) + 0.05);
        this.debugTwoFour = { midSnare, backbeat, asym: (at(ph) - at((ph + 2) % 4)) / sd, c2: scores[2].contrast / sd, s2: scores[2].score, s4: scores[4].score, hAsym };
      }
      const ms = Object.keys(scores).map(Number);
      if (!ms.length) return null;
      // Even family (2 or 4 beats) vs odd (3, 5, 7): an odd meter must clearly win,
      // otherwise 2/4 and 4/4 split the vote and a weak 3 or 5 slips through.
      const even = [2, 4].filter((m) => scores[m]);
      const odd = [3, 5, 7].filter((m) => scores[m]);
      const evenBest = even.length ? even.reduce((a, b) => (scores[b].score > scores[a].score ? b : a)) : null;
      const oddBest = odd.length ? odd.reduce((a, b) => (scores[b].score > scores[a].score ? b : a)) : null;
      let best = evenBest;
      if (oddBest !== null && (evenBest === null || scores[oddBest].score > scores[evenBest].score + 0.8)) best = oddBest;
      const twoFour = this.debugTwoFour || null;
      const sorted = ms.map((m) => scores[m].score).sort((a, b) => b - a);
      const margin = sorted.length > 1 ? sorted[0] - sorted[1] : 0.3;
      return { beatsPerBar: best, phase: scores[best].phase, margin, scores, twoFour };
    }

    // Where do hits fall inside each beat: at ½ (straight), or at ⅓ and ⅔ (triplets)?
    subdivision(beats, o) {
      const near = (b) => { const i = Math.round(b); let m = 0; for (let k = -1; k <= 1; k += 1) { const v = o[i + k]; if (v > m) m = v; } return m; };
      const rec = beats.slice(-40);
      let h = 0, t1 = 0, t2 = 0, q = 0, on = 0, n = 0, both = 0;
      for (let i = 0; i + 1 < rec.length; i += 1) {
        const a = rec[i], p = rec[i + 1] - rec[i];
        const vh = near(a + p / 2), v1 = near(a + p / 3), v2 = near(a + (2 * p) / 3);
        h += vh; t1 += v1; t2 += v2; q += (near(a + p / 4) + near(a + (3 * p) / 4)) / 2; on += near(a); n += 1;
        if (v1 > vh && v2 > vh) both += 1;
      }
      if (!n) return null;
      return { half: h / n, third1: t1 / n, third2: t2 / n, quarter: q / n, on: on / n, bothShare: both / n };
    }

    oomPah(beats, low, high, bpm) {
      if (bpm < 140 || beats.length < 12) return null;
      const near = (arr, b) => { let m = 0; for (let k = -2; k <= 2; k += 1) { const v = arr[Math.round(b) + k]; if (v > m) m = v; } return m; };
      const rec = beats.slice(-32);
      const lo = rec.map((b) => near(low, b)), hi = rec.map((b) => near(high, b));
      const lEven = mean(lo.filter((_, i) => i % 2 === 0)), lOdd = mean(lo.filter((_, i) => i % 2 === 1));
      const hEven = mean(hi.filter((_, i) => i % 2 === 0)), hOdd = mean(hi.filter((_, i) => i % 2 === 1));
      const bassBeat = lEven >= lOdd ? "even" : "odd";
      const lowAlt = Math.min(lEven, lOdd) / (Math.max(lEven, lOdd) + 1e-9);          // small = bass on alternate beats
      const snareOther = bassBeat === "even" ? hOdd / (hEven + 0.05) : hEven / (hOdd + 0.05); // big = snare between
      return { lowAlt, snareOther, halve: lowAlt < 0.4 && snareOther < 1.3 && bpm / 2 >= 50 };
    }

    fixPhase(beats, low, period) {
      if (beats.length < 8) return beats;
      const near = (b) => { let m = 0; for (let k = -2; k <= 2; k += 1) { const v = low[Math.round(b) + k]; if (v > m) m = v; } return m; };
      const rec = beats.slice(-32);
      const on = mean(rec.map(near)), off = mean(rec.map((b) => near(b + period / 2)));
      this.debugPhase = { on, off };
      if (off > 1.5 * on && off > 0.3) {
        const half = Math.round(period / 2);
        return beats.map((b) => b + half).filter((b) => b < low.length);
      }
      return beats;
    }

    // How strong are hits halfway between beats, and on alternate beats?
    octaveEvidence(o, beats) {
      const near = (b) => { let m = 0; for (let k = -2; k <= 2; k += 1) { const v = o[Math.round(b) + k]; if (v > m) m = v; } return m; };
      const rec = beats.slice(-40);
      if (rec.length < 6) return null;
      const on = rec.map(near), mid = [];
      for (let i = 0; i + 1 < rec.length; i += 1) mid.push(near((rec[i] + rec[i + 1]) / 2));
      const even = on.filter((_, i) => i % 2 === 0), odd = on.filter((_, i) => i % 2 === 1);
      const me = mean(even), mo = mean(odd);
      return { up: mean(mid) / (mean(on) || 1), down: Math.min(me, mo) / (Math.max(me, mo) || 1) };
    }

    estimate() {
      const fps = this.fps;
      const len = this.odf.length;
      const seconds = this.total / this.sr;
      if (len < fps * 4.5) return { ready: false, seconds };
      this.winStart = this.start;
      const o = prepare(this.odf);
      const low = prepare(this.low);
      const tn = Math.min(len, Math.round(TEMPO_SECONDS * fps));
      const mix = new Float32Array(tn);
      for (let i = 0; i < tn; i += 1) mix[i] = o[len - tn + i] + 0.5 * low[len - tn + i];
      const tp = this.tempoPeriod(mix);
      if (!tp) return { ready: false, seconds };

      // Octave check: if hits halfway between the tracked beats are as strong as
      // the beats themselves, the real beat is twice as fast (waltzes, swing jazz).
      let cand = tp.period;
      const probe = this.octaveEvidence(o, this.trackBeats(o, cand));
      this.debugOctave = probe;
      let doubled = false;
      // Swung ride cymbals and brushes (jazz ballads) also hit halfway between beats,
      // so doubling into a fast tempo (over 150) needs stronger evidence.
      const needUp = (bpmIfDoubled) => (bpmIfDoubled > 150 ? 1.05 : 0.8);
      if (!this.oomLock && probe && probe.up >= needUp((fps * 60) / (cand / 2)) && (fps * 60) / (cand / 2) <= 200) { cand /= 2; doubled = true; }

      // Hysteresis: small changes blend in; octave/large jumps must repeat first.
      if (this.period === null) this.period = cand;
      else {
        const r = cand / this.period;
        if (Math.abs(r - 1) < 0.06) { this.period = 0.6 * this.period + 0.4 * cand; this.pending = null; this.pendingCount = 0; }
        else {
          if (this.pending && Math.abs(cand / this.pending - 1) < 0.06) this.pendingCount += 1;
          else { this.pending = cand; this.pendingCount = 1; }
          const related = [2, 0.5, 1.5, 2 / 3, 3, 1 / 3].some((k) => Math.abs(r / k - 1) < 0.06);
          const slower = r > 1.4; // a longer beat period = dropping to a slower octave
          const needed = doubled ? 1 : slower && related ? 4 : related ? 3 : 2;
          if (this.pendingCount >= needed) { this.period = this.pending; this.pending = null; this.pendingCount = 0; }
        }
      }

      let beats = this.trackBeats(o, this.period);
      // Oom-pah check: at a fast pulse, bass on every other beat with a chord (not a
      // snare) in between means we're counting the eighth notes of a slower 2/4.
      const oom = this.oomPah(beats, low, prepare(this.high), (fps * 60) / this.period);
      this.debugOom = oom;
      if (oom && oom.halve) {
        this.period *= 2; this.pending = null; this.pendingCount = 0;
        this.oomLock = true; // the off-beat "pah" chords must not double it back
        beats = this.trackBeats(o, this.period);
      }
      // Same check on the tempo we're showing, so it can't get stuck at half speed.
      const held = this.octaveEvidence(o, beats);
      if (!this.oomLock && held && held.up >= needUp((fps * 60) / (this.period / 2)) && (fps * 60) / (this.period / 2) <= 200) {
        this.period /= 2;
        this.pending = null; this.pendingCount = 0;
        beats = this.trackBeats(o, this.period);
      }
      // Phase check: bass and kick land on the beat in nearly all music. If the low
      // end is clearly stronger halfway between our beats (oom-pah, ska, marches),
      // we've locked onto the off-beat, so shift by half a beat.
      beats = this.fixPhase(beats, low, this.period);
      let period = this.period;
      // Tempo from the slope of the recent tracked beats (follows drift precisely).
      const recent = beats.filter((b) => b >= len - Math.round(24 * fps));
      if (recent.length >= 8) {
        const k = recent.length, xs = recent.map((_, i) => i), xm = (k - 1) / 2, ym = mean(recent);
        let num = 0, den = 0;
        for (let i = 0; i < k; i += 1) { num += (xs[i] - xm) * (recent[i] - ym); den += (xs[i] - xm) * (xs[i] - xm); }
        const slope = num / den;
        if (Math.abs(slope / this.period - 1) < 0.06) { period = slope; this.period = 0.5 * this.period + 0.5 * slope; }
      }
      const bpm = Math.round(((fps * 60) / period) * 10) / 10;

      // Meter (needs ~3 bars); votes decay so it can change if the song does.
      const meter = this.meterFrom(beats, o, low, bpm, prepare(this.high));
      const sub = this.subdivision(beats, o);
      this.debugSub = sub;
      // Feel: triplets inside every beat (compound), long-short (swing), or straight.
      let feel = "straight";
      if (sub) {
        const h = Math.max(sub.half, 0.05);
        if (sub.third1 > 1.5 * h && sub.third2 > 1.5 * h && Math.min(sub.third1, sub.third2) > 0.6) feel = "compound";
        else if (sub.third2 > 1.5 * h && sub.third2 > 0.6 && sub.third1 < 0.5 * sub.third2) feel = "swing";
      }
      this.feelVotes = this.feelVotes || new Map();
      for (const [k, v] of this.feelVotes) this.feelVotes.set(k, v * 0.85);
      if (sub) this.feelVotes.set(feel, (this.feelVotes.get(feel) || 0) + 1);
      let feelNow = "straight", fTop = 0;
      for (const [k, v] of this.feelVotes) if (v > fTop) { fTop = v; feelNow = k; }

      for (const [k, v] of this.meterVotes) this.meterVotes.set(k, v * 0.85);
      if (meter) {
        let m = meter.beatsPerBar;
        // 2 vs 4 beats per bar: 2/4 when the 2-beat accent is clear and chords change
        // as often on "beat 3" as on "beat 1"; otherwise the usual 4/4.
        if ((m === 2 || m === 4) && meter.twoFour) {
          const t = meter.twoFour;
          // 2/4 and 4/4 can sound identical (The Entertainer is printed both ways), so
          // remember when the evidence fits both and offer the other reading too.
          const amb = t.c2 > 0.5 && t.midSnare < 2 && t.hAsym < 2.0 && t.backbeat < 1.5; // no snare/clap backbeat
          this.ambVotes = (this.ambVotes || 0) * 0.85 + (amb ? 1 : 0);
          this.twoFourAmbiguous = this.ambVotes > 0.8;
          // midSnare guards half-time drum grooves (drum & bass, trap), which also accent every 2 beats.
          m = t.hAsym < 1.1 && t.c2 > 0.6 && t.midSnare < 2 ? 2 : 4;
        }
        this.meterUpdates = (this.meterUpdates || 0) + 1;
        this.meterVotes.set(m, (this.meterVotes.get(m) || 0) + 0.5 + Math.min(1, meter.margin * 2));
      }
      let beatsPerBar = 4, top = 0, total = 0;
      for (const [k, v] of this.meterVotes) { total += v; if (v > top) { top = v; beatsPerBar = k; } }
      const meterReady = total > 0 && this.meterUpdates >= 2; // show a meter only after two agreeing looks
      const compound = feelNow === "compound" && beatsPerBar >= 2 && beatsPerBar <= 4;
      const label = compound ? `${beatsPerBar * 3}/8` : METER_LABEL[beatsPerBar];
      const meterAlt = !compound && this.twoFourAmbiguous && (beatsPerBar === 4 || beatsPerBar === 2) ? (beatsPerBar === 4 ? "2/4" : "4/4") : null;

      const lastIdx = beats.length - 1;
      const beatTimes = beats.map((b) => this.frameTime(this.winStart + b));
      let lastBeatPos = 0;
      if (meter && meter.beatsPerBar === beatsPerBar) lastBeatPos = ((lastIdx - meter.phase) % beatsPerBar + beatsPerBar) % beatsPerBar;
      else if (this.last && this.last.beatsPerBar === beatsPerBar && this.last.lastBeatTime) {
        const k = Math.round((beatTimes[lastIdx] - this.last.lastBeatTime) / (period / fps));
        lastBeatPos = ((this.last.lastBeatPos + k) % beatsPerBar + beatsPerBar) % beatsPerBar;
      }
      this.last = {
        ready: true, seconds, bpm, bpmConfidence: tp.confidence,
        beatPeriod: period / fps, beats: beatTimes.slice(-64),
        lastBeatTime: beatTimes[lastIdx], lastBeatPos,
        beatsPerBar, meter: meterReady ? label : "4/4",
        meterConfidence: meterReady ? top / total : 0, meterReady,
        feel: feelNow, compound, meterAlt: meterReady ? meterAlt : null,
        pulseBpm: compound ? Math.round(bpm * 3 * 10) / 10 : bpm   // eighth-note rate in compound meters
      };
      return this.last;
    }
  }

  SipraRhythm.METER_LABEL = METER_LABEL;
  global.SipraRhythm = SipraRhythm;
})(typeof window !== "undefined" ? window : globalThis);
