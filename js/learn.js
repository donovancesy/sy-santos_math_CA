/* Sipra lessons — short, and about the song that's playing.
   SipraLearn.mount(root, { getLive, topic }) renders all lessons into `root`.
   Each lesson: what's happening now → idea → math → your song, step by step →
   try it (pre-filled from the song) → why → a check question built from the song. */
(function (global) {
  "use strict";

  const NOTE = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const Q = {
    maj: { label: "major", sym: "", tones: [0, 4, 7], ratio: "4 : 5 : 6" },
    min: { label: "minor", sym: "m", tones: [0, 3, 7], ratio: "10 : 12 : 15" },
    dim: { label: "diminished", sym: "dim", tones: [0, 3, 6], ratio: "≈ 5 : 6 : 7" },
    sus4: { label: "sus4", sym: "sus4", tones: [0, 5, 7], ratio: "6 : 8 : 9" },
    "7": { label: "dominant 7th", sym: "7", tones: [0, 4, 7, 10], ratio: "≈ 4 : 5 : 6 : 7" },
    maj7: { label: "major 7th", sym: "maj7", tones: [0, 4, 7, 11], ratio: "8 : 10 : 12 : 15" },
    m7: { label: "minor 7th", sym: "m7", tones: [0, 3, 7, 10], ratio: "10 : 12 : 15 : 18" }
  };
  const STEPS = { major: [2, 2, 1, 2, 2, 2, 1], minor: [2, 1, 2, 2, 1, 2, 2] };

  const hz = (n) => 440 * Math.pow(2, n / 12);                 // n = semitones from A4
  const nOf = (pc, oct = 4) => (oct - 4) * 12 + pc - 9;
  const f = (v, d = 2) => (Number.isFinite(v) ? Number(v).toFixed(d) : "—");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const scale = (pc, mode) => { const out = [pc]; let c = pc; for (let i = 0; i < 6; i += 1) { c = (c + STEPS[mode === "minor" ? "minor" : "major"][i]) % 12; out.push(c); } return out; };
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

  function liveValues(raw) {
    const r = raw || {};
    const fresh = Boolean(r.at && Date.now() - r.at < 60000);
    const has = (k) => fresh && r[k] !== null && r[k] !== undefined;
    const meter = has("meter") ? r.meter : "4/4";
    const [mn, md] = String(meter).split("/").map(Number);
    const feel = has("feel") ? r.feel : "straight";
    const meterAlt = has("meterAlt") ? r.meterAlt : null;
    const compound = feel === "compound" || (md === 8 && mn % 3 === 0 && mn >= 6);
    const L = {
      isLive: fresh && has("bpm"),
      song: fresh ? r.song : null,
      bpm: has("bpm") ? r.bpm : 120,
      meter, meterN: mn || 4, feel, compound, meterAlt,
      beats: compound ? (mn || 6) / 3 : (mn || 4),        // counted beats per bar (♩. in compound meters)
      key: has("key") ? r.key : { tonicPc: 9, mode: "minor" },
      chord: has("chord") ? r.chord : { name: "Am", root: 9, quality: "min", tones: [0, 3, 7], roman: "i" },
      chroma: has("chroma") ? r.chroma : null,
      note: has("note") ? r.note : { f: 440, n: 0, cents: 0, name: "A", octave: 4 },
      peakHz: has("peakHz") ? r.peakHz : 110,
      levelDb: has("levelDb") && Number.isFinite(r.levelDb) ? r.levelDb : -18,
      sr: (fresh && r.sampleRate) || 48000,
      duration: fresh && r.song && r.song.duration ? r.song.duration : 210,
      bpms: r.sessionBpms && r.sessionBpms.length >= 2 ? r.sessionBpms : [92, 120, 128, 100, 128]
    };
    L.has = { bpm: has("bpm"), key: has("key"), chord: has("chord"), note: has("note"), level: has("levelDb"), peak: has("peakHz"), session: Boolean(r.sessionBpms && r.sessionBpms.length >= 2), duration: Boolean(fresh && r.song && r.song.duration) };
    return L;
  }
  const tag = (on) => (on ? '<span class="tag live">This song</span>' : '<span class="tag">Example</span>');

  /* ------------------------------------------------------------------ */
  const LESSONS = [
    {
      id: "tempo", title: "Tempo",
      now: (L) => `${tag(L.has.bpm)} <b>${f(L.bpm, 1)} BPM</b>${L.compound ? " (♩., the big beat)" : ""} → a beat every <b>${f(60000 / L.bpm, 0)} ms</b>.`,
      idea: "Tempo is beats per minute. Flip it and you get the time between beats.",
      formulas: [["T = 60 / BPM", "seconds per beat"], ["eighth = T/2 · sixteenth = T/4 · dotted = ×1.5", ""], ["N = D · BPM / 60", "beats in a song D seconds long"]],
      steps: (L) => {
        const T = 60 / L.bpm;
        return [
          `T = 60 / ${f(L.bpm, 1)} = <b>${f(T, 3)} s</b>`,
          `eighth = ${f(T * 500, 0)} ms · sixteenth = ${f(T * 250, 0)} ms`,
          `${mmss(L.duration)} = ${Math.round(L.duration)} s → N = ${Math.round(L.duration)} × ${f(L.bpm, 1)} / 60 ≈ <b>${f((L.duration * L.bpm) / 60, 0)} beats</b>`,
          `same pulse at half / double speed: ${f(L.bpm / 2, 1)} / ${f(L.bpm * 2, 1)} BPM`
        ];
      },
      calc: {
        html: (L) => `<label>BPM <input type="number" data-in="b" value="${f(L.bpm, 1)}" min="20" max="300" step="any"></label>`,
        out: "beat <b data-out=T></b> · eighth <b data-out=e></b> · dotted eighth <b data-out=d></b>",
        run: (v) => { const T = 60 / v.b; return { T: `${f(T * 1000, 1)} ms`, e: `${f(T * 500, 1)} ms`, d: `${f(T * 750, 1)} ms` }; }
      },
      why: ["DJs match BPM to mix", "delay effects = 60000 / BPM", "run cadence"],
      quiz: (L) => ({ q: `At ${f(L.bpm, 1)} BPM, how long is one beat in ms? (1 decimal)`, a: 60000 / L.bpm, tol: 0.15, sol: `60000 / ${f(L.bpm, 1)} = ${f(60000 / L.bpm, 1)} ms` })
    },

    {
      id: "meter", title: "Meter & bars",
      now: (L) => {
        const bar = f((L.beats * 60) / L.bpm, 2);
        if (L.compound) return `${tag(L.has.bpm)} <b>${esc(L.meter)}</b>: ${L.meterN} eighths per bar in ${L.beats} groups of 3 → a bar every <b>${bar} s</b>.`;
        const extra = L.beats === 5 || L.beats === 7 ? " Odd meter, like <i>Take Five</i> (5) or <i>Money</i> (7)."
          : L.beats === 2 ? " Two beats per bar, like a march or <i>The Entertainer</i>." : "";
        const alt = L.meterAlt ? ` Could also be written <b>${esc(L.meterAlt)}</b>: same beat, ${L.meterAlt === "2/4" ? "half" : "twice"} the bar length.` : "";
        return `${tag(L.has.bpm)} <b>${esc(L.meter)}</b>: ${L.beats} beats per bar → a bar every <b>${bar} s</b>.${extra}${L.feel === "swing" ? " <b>Swing</b>: eighths split long–short, about 2 : 1." : ""}${alt}`;
      },
      idea: "Beats group into bars; beat 1 (the downbeat) is strongest. Top number = notes per bar, bottom = note value (4 = quarter, 8 = eighth). In 6/8, 9/8, 12/8 each beat splits in 3.",
      formulas: [["bar = beats × T", ""], ["bars ≈ N / beats per bar", ""], ["LCM(a, b) = a·b / GCD(a, b)", "when two patterns line up again"]],
      steps: (L) => {
        const T = 60 / L.bpm, bar = L.beats * T, N = (L.duration * L.bpm) / 60, l = (L.beats * 4) / gcd(L.beats, 4);
        if (L.compound) return [
          `♩. = ${f(L.bpm, 1)} BPM → T = 60 / ${f(L.bpm, 1)} = ${f(T, 3)} s`,
          `eighth = T / 3 = <b>${f((T / 3) * 1000, 0)} ms</b> (${f(L.bpm * 3, 0)} per minute)`,
          `bar = ${L.meterN} × ${f((T / 3) * 1000, 0)} ms = <b>${f(bar, 3)} s</b>`,
          `count: ${Array.from({ length: L.beats }, (_, i) => `<b>${i + 1}</b> &amp; a`).join(" ")}`
        ];
        return [
          `bar = ${L.beats} × ${f(T, 3)} = <b>${f(bar, 3)} s</b>`,
          `${f(N, 0)} beats ÷ ${L.beats} ≈ <b>${f(N / L.beats, 0)} bars</b>`,
          L.beats === 4 ? "count: 1 2 3 4 | 1 2 3 4" : `count: ${Array.from({ length: L.beats }, (_, i) => i + 1).join(" ")} | 1 … · vs 4/4 it realigns every LCM(${L.beats}, 4) = ${l} beats`
        ];
      },
      calc: {
        html: (L) => `<label>a <input type="number" data-in="a" value="${L.beats}" min="1" max="16" step="1"></label><label>b <input type="number" data-in="b" value="4" min="1" max="16" step="1"></label>`,
        out: "realign every <b data-out=l></b> beats · GCD <b data-out=g></b>",
        run: (v) => { const a = Math.max(1, Math.round(v.a)), b = Math.max(1, Math.round(v.b)), g = gcd(a, b); return { l: (a * b) / g, g }; }
      },
      why: ["know when the chorus hits", "2 = march, 3 = waltz, 4 = pop, 6/8 = sway", "odd meters feel off-balance"],
      quiz: (L) => ({ q: `How long is one bar of this song? (seconds, 2 decimals)`, a: (L.beats * 60) / L.bpm, tol: 0.01, sol: `${L.beats} × 60 / ${f(L.bpm, 1)} = ${f((L.beats * 60) / L.bpm, 2)} s` })
    },

    {
      id: "chords", title: "Chords",
      now: (L) => { const q = Q[L.chord.quality] || Q.maj; return `${tag(L.has.chord)} <b>${esc(L.chord.name)}</b>${L.chord.roman ? ` (${esc(L.chord.roman)})` : ""} = ${q.tones.map((t) => NOTE[(L.chord.root + t) % 12]).join(" · ")}`; },
      idea: "A chord is a root plus fixed gaps. Major = 0, 4, 7 semitones. Minor = 0, 3, 7. Names wrap after B (mod 12).",
      formulas: [["notes = (root + gaps) mod 12", ""], ["major ≈ 4 : 5 : 6 · minor ≈ 10 : 12 : 15", "frequency ratios"], ["match = (c · t) / (|c| |t|)", "how Sipra compares what it hears (c) with a chord shape (t)"]],
      steps: (L) => {
        const c = L.chord, q = Q[c.quality] || Q.maj, pcs = q.tones.map((t) => (c.root + t) % 12);
        const fr = q.tones.map((t) => hz(nOf(c.root) + t));
        const out = [
          `${NOTE[c.root]} = ${c.root} → ${c.root} + {${q.tones.join(", ")}} mod 12 = {${pcs.join(", ")}} = <b>${pcs.map((p) => NOTE[p]).join(" ")}</b>`,
          `${fr.map((x) => f(x, 0)).join(" : ")} Hz ÷ ${f(fr[0], 0)} = ${fr.map((x) => f(x / fr[0], 2)).join(" : ")} ≈ <b>${q.ratio}</b>`
        ];
        if (L.chroma) {
          const max = Math.max(...L.chroma) || 1;
          out.push(`what Sipra hears (chord notes in green):<div class="chroma">${L.chroma.map((v, i) => `<span class="${pcs.includes(i) ? "in" : ""}" style="--h:${Math.round((v / max) * 100)}%"><i></i>${NOTE[i]}</span>`).join("")}</div>`);
        }
        return out;
      },
      calc: {
        html: (L) => `<label>Root <select data-in="r">${NOTE.map((n, i) => `<option value="${i}"${i === L.chord.root ? " selected" : ""}>${n}</option>`).join("")}</select></label><label>Type <select data-in="q">${Object.entries(Q).map(([k, v]) => `<option value="${k}"${k === L.chord.quality ? " selected" : ""}>${v.label}</option>`).join("")}</select></label>`,
        out: "<b data-out=n></b> · <b data-out=r2></b>",
        run: (v) => { const q = Q[v.q] || Q.maj, r = Number(v.r) || 0; return { n: q.tones.map((t) => NOTE[(r + t) % 12]).join(" "), r2: q.ratio }; }
      },
      why: ["play along by ear", "most hits loop 4 chords", "transpose = add the same number"],
      quiz: (L) => {
        const c = L.chord, q = Q[c.quality] || Q.maj, notes = q.tones.slice(0, 3).map((t) => NOTE[(c.root + t) % 12]);
        return { q: `${NOTE[c.root]} = ${c.root}. Name the 3 notes of ${NOTE[c.root]}${q.tones[1] === 3 ? "m" : ""} (gaps 0, ${q.tones[1]}, ${q.tones[2]}).`, text: [notes.join(" ")], sol: `${c.root} + {0, ${q.tones[1]}, ${q.tones[2]}} mod 12 → ${notes.join(" ")}` };
      }
    },

    {
      id: "keys", title: "Key & scale",
      now: (L) => `${tag(L.has.key)} <b>${NOTE[L.key.tonicPc]} ${L.key.mode}</b> → ${scale(L.key.tonicPc, L.key.mode).map((p) => NOTE[p]).join(" ")}`,
      idea: "A key is a home note plus 7 notes chosen by a step pattern. Major steps: 2 2 1 2 2 2 1.",
      formulas: [["next = (note + step) mod 12", ""], ["relative minor = tonic − 3", "same 7 notes"], ["circle of fifths: +7 mod 12", "neighbouring keys"]],
      steps: (L) => {
        const k = L.key, sc = scale(k.tonicPc, k.mode), st = STEPS[k.mode === "minor" ? "minor" : "major"];
        const rel = k.mode === "minor" ? `${NOTE[(k.tonicPc + 3) % 12]} major` : `${NOTE[(k.tonicPc + 9) % 12]} minor`;
        return [
          `${NOTE[k.tonicPc]} + ${st.slice(0, 6).join(", ")} → <b>${sc.map((p) => NOTE[p]).join(" ")}</b>`,
          `relative ${k.mode === "minor" ? "major" : "minor"}: <b>${rel}</b>`,
          `neighbours: ${NOTE[(k.tonicPc + 5) % 12]} and ${NOTE[(k.tonicPc + 7) % 12]} ${k.mode}`,
          `home note ${NOTE[k.tonicPc]}4 = 440·2<sup>${nOf(k.tonicPc)}/12</sup> = ${f(hz(nOf(k.tonicPc)), 1)} Hz`
        ];
      },
      calc: {
        html: (L) => `<label>Tonic <select data-in="t">${NOTE.map((n, i) => `<option value="${i}"${i === L.key.tonicPc ? " selected" : ""}>${n}</option>`).join("")}</select></label><label>Mode <select data-in="m"><option value="major"${L.key.mode === "major" ? " selected" : ""}>major</option><option value="minor"${L.key.mode === "minor" ? " selected" : ""}>minor</option></select></label>`,
        out: "<b data-out=s></b>",
        run: (v) => ({ s: scale(Number(v.t) || 0, v.m).map((p) => NOTE[p]).join(" ") })
      },
      why: ["move a song to fit your voice", "DJs mix nearby keys", "solo with the 7 safe notes"],
      quiz: (L) => {
        const k = L.key, ans = k.mode === "minor" ? `${NOTE[(k.tonicPc + 3) % 12]} major` : `${NOTE[(k.tonicPc + 9) % 12]} minor`;
        return { q: `What is the relative ${k.mode === "minor" ? "major" : "minor"} of ${NOTE[k.tonicPc]} ${k.mode}?`, text: [ans, ans.split(" ")[0] + (k.mode === "minor" ? "" : "m"), ans.split(" ")[0]], sol: `${k.tonicPc} ${k.mode === "minor" ? "+ 3" : "− 3"} mod 12 → ${ans}` };
      }
    },

    {
      id: "pitch", title: "Pitch",
      now: (L) => `${tag(L.has.note)} Loudest note: <b>${esc(L.note.name)}${L.note.octave}</b> at <b>${f(L.note.f, 1)} Hz</b>${Number.isFinite(L.note.cents) ? ` (${L.note.cents >= 0 ? "+" : ""}${L.note.cents}¢)` : ""}.`,
      idea: "Each semitone multiplies frequency by 2^(1/12). Twelve of them double it: one octave.",
      formulas: [["f = 440 · 2<sup>n/12</sup>", "n = semitones from A4"], ["n = 12 · log<sub>2</sub>(f / 440)", ""], ["cents = 1200 · log<sub>2</sub>(f<sub>2</sub> / f<sub>1</sub>)", "100 cents = 1 semitone"]],
      steps: (L) => {
        const ex = 12 * Math.log2(L.note.f / 440), n = Math.round(ex);
        return [
          `n = 12·log₂(${f(L.note.f, 1)} / 440) = ${f(ex, 2)} → <b>${n}</b>`,
          `exact pitch: 440·2<sup>${n}/12</sup> = <b>${f(hz(n), 2)} Hz</b>`,
          `difference: ${Math.round((ex - n) * 100)} cents`
        ];
      },
      calc: {
        html: (L) => `<label>n <input type="range" data-in="n" min="-36" max="36" step="1" value="${Math.round(12 * Math.log2(L.note.f / 440))}"></label>`,
        out: "<b data-out=nm></b> = <b data-out=hz></b>",
        run: (v) => { const n = Math.round(v.n), m = 69 + n; return { nm: `${NOTE[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1} (n = ${n})`, hz: `${f(hz(n), 2)} Hz` }; }
      },
      why: ["tuners & auto-tune", "transposing", "fret spacing"],
      quiz: (L) => { const n = Math.round(12 * Math.log2(L.note.f / 440)); return { q: `${esc(L.note.name)}${L.note.octave} is n = ${n}. Its exact frequency? (Hz, 2 decimals)`, a: hz(n), tol: 0.02, sol: `440 × 2^(${n}/12) = ${f(hz(n), 2)} Hz` }; }
    },

    {
      id: "intervals", title: "Intervals & ratios",
      now: (L) => { const fr = hz(nOf(L.chord.root)); return `${tag(L.has.chord)} In <b>${esc(L.chord.name)}</b>: ${NOTE[L.chord.root]} → ${NOTE[(L.chord.root + 7) % 12]} = 7 semitones = ×${f(Math.pow(2, 7 / 12), 4)} ≈ 3 : 2.`; },
      idea: "Notes blend when their frequencies form simple ratios. Equal tuning gets close, not exact.",
      formulas: [["ratio = 2<sup>k/12</sup>", "k semitones apart"], ["wobble rate = |f<sub>1</sub> − f<sub>2</sub>|", "beats per second when slightly out of tune"]],
      table: `<table><tr><th>Interval</th><th>k</th><th>Pure</th><th>Equal</th></tr><tr><td>octave</td><td>12</td><td>2 : 1</td><td>2.000</td></tr><tr><td>fifth</td><td>7</td><td>3 : 2</td><td>1.498</td></tr><tr><td>fourth</td><td>5</td><td>4 : 3</td><td>1.335</td></tr><tr><td>major 3rd</td><td>4</td><td>5 : 4</td><td>1.260</td></tr><tr><td>minor 3rd</td><td>3</td><td>6 : 5</td><td>1.189</td></tr></table>`,
      steps: (L) => {
        const r = hz(nOf(L.chord.root));
        return [
          `root ${NOTE[L.chord.root]}4 = ${f(r, 1)} Hz`,
          `equal fifth: ${f(r, 1)} × 1.4983 = ${f(r * Math.pow(2, 7 / 12), 2)} Hz · pure: × 1.5 = ${f(r * 1.5, 2)} Hz`,
          `wobble: ${f(Math.abs(r * 1.5 - r * Math.pow(2, 7 / 12)), 2)} per second, too slow to notice`
        ];
      },
      calc: {
        html: (L) => `<label>k <input type="number" data-in="k" value="7" min="0" max="24" step="1"></label><label>low note <input type="number" data-in="lo" value="${f(hz(nOf(L.chord.root)), 1)}" step="any"> Hz</label>`,
        out: "high note <b data-out=hi></b> · ratio <b data-out=r></b>",
        run: (v) => ({ hi: `${f(v.lo * Math.pow(2, v.k / 12), 2)} Hz`, r: f(Math.pow(2, v.k / 12), 4) })
      },
      why: ["why harmony sounds smooth", "tuning by ear"],
      quiz: (L) => { const r = hz(nOf(L.chord.root)); return { q: `Root ≈ ${f(r, 1)} Hz. A fifth above (×2^(7/12))? (Hz, 1 decimal)`, a: r * Math.pow(2, 7 / 12), tol: 0.15, sol: `${f(r, 1)} × 1.4983 = ${f(r * Math.pow(2, 7 / 12), 1)} Hz` }; }
    },

    {
      id: "spectrum", title: "Spectrum",
      now: (L) => `${tag(L.has.peak)} Most energy right now near <b>${f(L.peakHz, 0)} Hz</b>.`,
      idea: "Every sound is a sum of sine waves. The FFT measures how much of each.",
      formulas: [["harmonic k = k · f", "overtones of a note"], ["Δf = f<sub>s</sub> / N", "FFT bin spacing"], ["f<sub>max</sub> = f<sub>s</sub> / 2", "highest frequency a sample rate holds"]],
      steps: (L) => [
        `harmonics of ${esc(L.note.name)}${L.note.octave}: ${[1, 2, 3, 4].map((k) => f(L.note.f * k, 0)).join(", ")} Hz…`,
        `Sipra's chord FFT: ${L.sr} / 8192 = <b>${f(L.sr / 8192, 2)} Hz</b> per bin`,
        `limit: ${L.sr} / 2 = ${L.sr / 2} Hz (hearing stops near 20000)`
      ],
      calc: {
        html: (L) => `<label>f<sub>s</sub> <input type="number" data-in="fs" value="${L.sr}" step="1"></label><label>N <select data-in="N"><option>1024</option><option>2048</option><option>4096</option><option selected>8192</option></select></label>`,
        out: "Δf <b data-out=df></b> · window <b data-out=w></b>",
        run: (v) => ({ df: `${f(v.fs / v.N, 2)} Hz`, w: `${f((v.N / v.fs) * 1000, 0)} ms` })
      },
      why: ["EQ while mixing", "MP3/Ogg compression", "song & instrument ID"],
      quiz: (L) => ({ q: `Sample rate ${L.sr} Hz. Highest frequency it can hold? (Hz)`, a: L.sr / 2, tol: 1, sol: `${L.sr} / 2 = ${L.sr / 2} Hz` })
    },

    {
      id: "loudness", title: "Loudness",
      now: (L) => `${tag(L.has.level)} Level now <b>${f(L.levelDb, 1)} dBFS</b> = ${f(Math.pow(10, L.levelDb / 20), 3)} of full scale.`,
      idea: "Decibels are logarithms of ratios. +6 dB ≈ double the amplitude; ~+10 dB sounds twice as loud.",
      formulas: [["L = 20 · log<sub>10</sub>(A / A<sub>0</sub>)", ""], ["A / A<sub>0</sub> = 10<sup>L/20</sup>", ""], ["safe hours ≈ 8 / 2<sup>(L − 85)/3</sup>", "L in dB SPL"]],
      steps: (L) => [
        `10<sup>${f(L.levelDb, 1)}/20</sup> = <b>${f(Math.pow(10, L.levelDb / 20), 3)}</b>`,
        `headroom to 0 dBFS: ${f(-L.levelDb, 1)} dB`,
        "85 dB → 8 h safe · 94 dB → 1 h · 100 dB → 15 min"
      ],
      calc: {
        html: () => `<label>dB SPL <input type="number" data-in="L" value="94" min="70" max="130" step="1"></label>`,
        out: "safe ≈ <b data-out=s></b> a day",
        run: (v) => { const h = 8 / Math.pow(2, (v.L - 85) / 3); return { s: h >= 1 ? `${f(h, 1)} h` : `${f(h * 60, 0)} min` }; }
      },
      why: ["protect your hearing", "avoid clipping", "loudness normalising"],
      quiz: (L) => ({ q: `Level is ${f(L.levelDb, 1)} dBFS. Amplitude as a fraction of full scale? (3 decimals)`, a: Math.pow(10, L.levelDb / 20), tol: 0.002, sol: `10^(${f(L.levelDb, 1)}/20) = ${f(Math.pow(10, L.levelDb / 20), 3)}` })
    },

    {
      id: "sound", title: "Sound waves",
      now: (L) => `${tag(L.has.note)} ${f(L.note.f, 1)} Hz → the air moves back and forth ${Math.round(L.note.f)} times a second.`,
      idea: "Sound is vibrating air. Frequency = cycles per second; period = seconds per cycle.",
      formulas: [["f = 1 / T", ""], ["λ = v / f", "v ≈ 343 m/s in air"]],
      steps: (L) => [`T = 1 / ${f(L.note.f, 1)} = <b>${f(1000 / L.note.f, 3)} ms</b>`, `λ = 343 / ${f(L.note.f, 1)} = <b>${f(343 / L.note.f, 2)} m</b>`],
      calc: {
        html: (L) => `<label>f <input type="number" data-in="f" value="${f(L.note.f, 1)}" step="any"> Hz</label>`,
        out: "T <b data-out=T></b> · λ <b data-out=l></b>",
        run: (v) => ({ T: `${f(1000 / v.f, 3)} ms`, l: `${f(343 / v.f, 3)} m` })
      },
      why: ["why bass needs big speakers", "room acoustics"],
      quiz: (L) => ({ q: `Wavelength of ${f(L.note.f, 1)} Hz in air? (m, 2 decimals)`, a: 343 / L.note.f, tol: 0.01, sol: `343 / ${f(L.note.f, 1)} = ${f(343 / L.note.f, 2)} m` })
    },

    {
      id: "stats", title: "Your songs in numbers",
      now: (L) => { const x = L.bpms, m = x.reduce((a, b) => a + b, 0) / x.length; return `${tag(L.has.session)} ${x.length} songs · mean <b>${f(m, 1)} BPM</b>.`; },
      idea: "A few numbers describe a whole playlist: centre (mean, median, mode) and spread (range, σ).",
      formulas: [["x̄ = Σx / n", ""], ["σ = √( Σ(x − x̄)² / n )", "typical distance from the mean"]],
      steps: (L) => {
        const x = L.bpms.map(Number), n = x.length, m = x.reduce((a, b) => a + b, 0) / n, s = [...x].sort((a, b) => a - b);
        const med = n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2, sd = Math.sqrt(x.reduce((a, v) => a + (v - m) ** 2, 0) / n);
        return [`x̄ = (${x.map((v) => f(v, 0)).join(" + ")}) / ${n} = <b>${f(m, 1)}</b>`, `median ${f(med, 1)} · range ${f(s[n - 1] - s[0], 0)}`, `σ = <b>${f(sd, 1)}</b>`];
      },
      calc: {
        html: (L) => `<label>BPMs <input type="text" class="wide" data-in="list" value="${L.bpms.map((v) => f(v, 0)).join(", ")}"></label>`,
        out: "x̄ <b data-out=m></b> · median <b data-out=md></b> · σ <b data-out=s></b>",
        run: (v) => {
          const x = String(v.list).split(/[\s,;]+/).map(Number).filter(Number.isFinite);
          if (!x.length) return { m: "—", md: "—", s: "—" };
          const n = x.length, m = x.reduce((a, b) => a + b, 0) / n, s = [...x].sort((a, b) => a - b);
          return { m: f(m, 2), md: f(n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2, 2), s: f(Math.sqrt(x.reduce((a, q) => a + (q - m) ** 2, 0) / n), 2) };
        }
      },
      why: ["steady-energy playlists", "compare artists"],
      quiz: (L) => { const x = L.bpms.map(Number), m = x.reduce((a, b) => a + b, 0) / x.length; return { q: `Mean of ${x.map((v) => f(v, 0)).join(", ")}? (1 decimal)`, a: m, tol: 0.06, sol: `${f(x.reduce((a, b) => a + b, 0), 1)} / ${x.length} = ${f(m, 1)}` }; }
    }
  ];

  /* ------------------------------------------------------------------ */
  function shell(lesson, i) {
    return `<section class="lesson" id="${lesson.id}" aria-labelledby="h-${lesson.id}">
      <header class="lesson-head"><span class="num">${String(i + 1).padStart(2, "0")}</span><h2 id="h-${lesson.id}">${lesson.title}</h2></header>
      <p class="now-line" data-now-line="${lesson.id}"></p>
      <p class="idea">${lesson.idea}</p>
      <ul class="formulas">${lesson.formulas.map(([fm, d]) => `<li><code>${fm}</code>${d ? `<span>${d}</span>` : ""}</li>`).join("")}</ul>
      ${lesson.table || ""}
      <div class="block"><h3>This song, step by step</h3><ol class="steps" data-steps="${lesson.id}"></ol></div>
      <div class="block calc" data-calc="${lesson.id}"><h3>Try it</h3><div class="calc-in"></div><p class="calc-out">${lesson.calc.out}</p></div>
      <p class="why"><b>Why:</b> ${lesson.why.join(" · ")}</p>
      <div class="block practice" data-practice="${lesson.id}"><h3>Check</h3><p class="q"></p>
        <div class="answer-row"><input type="text" aria-label="Your answer" placeholder="Answer"><button type="button" class="check">Check</button><button type="button" class="reveal">Show</button></div>
        <p class="feedback" aria-live="polite"></p></div>
    </section>`;
  }

  function mount(root, opts = {}) {
    const getLive = opts.getLive || (() => null);
    root.classList.add("sipra-learn");
    root.innerHTML = `
      <div class="learn-top">
        <div class="now-strip" data-now></div>
        <nav class="toc" aria-label="Lessons">${LESSONS.map((l, i) => `<a href="#${l.id}" data-goto="${l.id}"><span>${String(i + 1).padStart(2, "0")}</span>${l.title}</a>`).join("")}</nav>
      </div>
      <div class="lessons">${LESSONS.map(shell).join("")}</div>`;

    const quizzes = {};
    function fillCalc(lesson, L) {
      const box = root.querySelector(`[data-calc="${lesson.id}"]`);
      box.querySelector(".calc-in").innerHTML = lesson.calc.html(L);
      const inputs = [...box.querySelectorAll("[data-in]")];
      const run = () => {
        const v = {};
        inputs.forEach((inp) => { const num = Number(inp.value); v[inp.dataset.in] = inp.type === "text" ? inp.value : Number.isFinite(num) && inp.value !== "" ? num : inp.value; });
        let out = {};
        try { out = lesson.calc.run(v); } catch (e) {}
        Object.entries(out).forEach(([k, val]) => { const o = box.querySelector(`[data-out="${k}"]`); if (o) o.innerHTML = String(val); });
      };
      inputs.forEach((inp) => inp.addEventListener("input", run));
      run();
    }
    function setQuiz(lesson, L, force) {
      const box = root.querySelector(`[data-practice="${lesson.id}"]`);
      const input = box.querySelector("input");
      if (!force && input.value.trim()) return; // don't swap the question while someone is answering
      const qz = lesson.quiz(L);
      quizzes[lesson.id] = qz;
      box.querySelector(".q").innerHTML = qz.q;
      box.querySelector(".feedback").textContent = "";
      box.querySelector(".feedback").className = "feedback";
    }
    LESSONS.forEach((lesson) => {
      const box = root.querySelector(`[data-practice="${lesson.id}"]`);
      const input = box.querySelector("input"), fb = box.querySelector(".feedback");
      const norm = (s) => String(s).toLowerCase().replace(/[♯#]/g, "#").replace(/[\s,–-]+/g, " ").trim();
      box.querySelector(".check").addEventListener("click", () => {
        const qz = quizzes[lesson.id];
        const raw = input.value.trim();
        let ok;
        if (qz.text) ok = qz.text.some((t) => norm(t) === norm(raw));
        else { const n = parseFloat(raw.replace(/,/g, "")); ok = Number.isFinite(n) && Math.abs(n - qz.a) <= qz.tol; }
        fb.className = `feedback ${ok ? "ok" : "no"}`;
        fb.textContent = ok ? "Correct." : "Not yet.";
      });
      box.querySelector(".reveal").addEventListener("click", () => { fb.className = "feedback sol"; fb.textContent = quizzes[lesson.id].sol; });
    });
    root.querySelectorAll("[data-goto]").forEach((a) => a.addEventListener("click", (e) => {
      e.preventDefault();
      const t = root.querySelector(`#${a.dataset.goto}`);
      if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
      root.querySelectorAll("[data-goto]").forEach((x) => x.classList.toggle("on", x === a));
    }));

    let lastSig = "", lastSong = null, first = true;
    function refresh() {
      const L = liveValues(getLive());
      const sig = JSON.stringify([L.bpm, L.meter, L.key, L.chord && L.chord.name, L.note && Math.round(L.note.f), Math.round(L.levelDb), Math.round(L.peakHz), L.bpms, L.isLive]);
      if (sig === lastSig) return;
      lastSig = sig;
      const songId = L.song ? `${L.song.title}|${L.song.artist}` : (L.isLive ? "live" : "example");
      const songChanged = songId !== lastSong;
      lastSong = songId;
      root.querySelector("[data-now]").innerHTML = L.isLive
        ? `<span class="tag live">Live</span><b>${esc(L.song ? L.song.title : "Live audio")}</b>${L.song && L.song.artist ? ` · ${esc(L.song.artist)}` : ""}<span class="vals">${f(L.bpm, 1)} BPM · ${esc(L.meter)} · ${NOTE[L.key.tonicPc]} ${L.key.mode} · ${esc(L.chord.name)}</span>`
        : `<span class="tag">Example values</span>Play a song with Sipra listening and every lesson switches to it.`;
      LESSONS.forEach((l) => {
        try { root.querySelector(`[data-now-line="${l.id}"]`).innerHTML = l.now(L); } catch (e) {}
        try { root.querySelector(`[data-steps="${l.id}"]`).innerHTML = l.steps(L).map((s) => `<li>${s}</li>`).join(""); } catch (e) {}
        if (first || songChanged) { fillCalc(l, L); setQuiz(l, L, true); }
      });
      first = false;
    }
    refresh();
    const timer = setInterval(refresh, 1500);
    if (opts.topic) { const t = root.querySelector(`#${opts.topic}`); if (t) setTimeout(() => t.scrollIntoView({ block: "start" }), 30); }
    return {
      refresh,
      goTo(topic) { const t = root.querySelector(`#${topic}`); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); },
      destroy() { clearInterval(timer); }
    };
  }

  global.SipraLearn = { mount, LESSONS, liveValues };
})(typeof window !== "undefined" ? window : globalThis);
