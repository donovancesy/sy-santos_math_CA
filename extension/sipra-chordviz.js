/* Sipra chord visualizer: the current chord on a piano or a guitar.
 * Shared by the website (Live) and the extension's side panel.
 *
 *   const viz = SipraChordViz.mount(container)
 *   viz.show({ root, quality, tones: [0, 4, 7], name, bass })  // or null
 *
 * Guitar shapes: open chords where a common one exists, otherwise the E-shape
 * (root on the 6th string) or A-shape (root on the 5th) barre chord, whichever
 * sits lower on the neck.
 */
(function (global) {
  "use strict";
  const NOTE = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const OPEN_STRINGS = [4, 9, 2, 7, 11, 4]; // E A D G B E (low → high), as pitch classes
  const X = null; // muted string

  // Movable shapes, frets relative to the barre (low E string → high e).
  const E_SHAPE = {
    maj: [0, 2, 2, 1, 0, 0], min: [0, 2, 2, 0, 0, 0], "7": [0, 2, 0, 1, 0, 0], m7: [0, 2, 0, 0, 0, 0],
    maj7: [0, 2, 1, 1, 0, 0], sus4: [0, 2, 2, 2, 0, 0], sus2: [0, 2, 4, 4, 0, 0], dim: [0, 1, 2, 0, X, X], aug: [0, 3, 2, 1, 1, 0]
  };
  const A_SHAPE = {
    maj: [X, 0, 2, 2, 2, 0], min: [X, 0, 2, 2, 1, 0], "7": [X, 0, 2, 0, 2, 0], m7: [X, 0, 2, 0, 1, 0],
    maj7: [X, 0, 2, 1, 2, 0], sus4: [X, 0, 2, 2, 3, 0], sus2: [X, 0, 2, 2, 0, 0], dim: [X, 0, 1, 2, 1, X], aug: [X, 0, 3, 2, 2, 1]
  };
  // Common open chords (absolute frets), keyed "root:quality".
  const OPEN = {
    "0:maj": [X, 3, 2, 0, 1, 0], "0:7": [X, 3, 2, 3, 1, 0], "0:maj7": [X, 3, 2, 0, 0, 0],
    "7:maj": [3, 2, 0, 0, 0, 3], "7:7": [3, 2, 0, 0, 0, 1],
    "2:maj": [X, X, 0, 2, 3, 2], "2:min": [X, X, 0, 2, 3, 1], "2:7": [X, X, 0, 2, 1, 2], "2:m7": [X, X, 0, 2, 1, 1],
    "2:maj7": [X, X, 0, 2, 2, 2], "2:sus4": [X, X, 0, 2, 3, 3], "2:sus2": [X, X, 0, 2, 3, 0],
    "11:7": [X, 2, 1, 2, 0, 2]
  };

  function guitarShape(root, quality) {
    const q = E_SHAPE[quality] ? quality : "maj";
    if (OPEN[`${root}:${q}`]) return { frets: OPEN[`${root}:${q}`], base: 1 };
    const eFret = (root - 4 + 12) % 12, aFret = (root - 9 + 12) % 12;
    const useA = aFret < eFret;
    const shape = useA ? A_SHAPE[q] : E_SHAPE[q], f = useA ? aFret : eFret;
    const frets = shape.map((v) => (v === X ? X : v + f));
    const played = frets.filter((v) => v !== X && v > 0);
    const base = played.length && Math.max(...played) > 5 ? Math.min(...played) : 1;
    return { frets, base, barre: f > 0 ? f : 0 };
  }

  // Which pitch classes a shape plays (used by the tests to check every shape).
  function shapeNotes(frets) {
    return frets.map((v, s) => (v === X ? null : (OPEN_STRINGS[s] + v) % 12)).filter((v) => v !== null);
  }

  function pianoSVG(chord) {
    // Two octaves from C. The chord is voiced upward from its root; the bass
    // note (for slash chords) is marked in the lower octave.
    const W = 14, whites = 14, BW = 9, H = 64, BH = 40;
    const whitePcs = [0, 2, 4, 5, 7, 9, 11], blackAfter = { 0: 1, 2: 3, 5: 6, 7: 8, 9: 10 };
    const on = new Map(); // key index (0–23) → "root" | "tone" | "bass"
    if (chord) {
      const start = chord.root;
      chord.tones.forEach((iv, i) => on.set(start + iv, i === 0 ? "root" : "tone"));
      if (chord.bass !== null && chord.bass !== undefined && chord.bass !== chord.root) {
        const b = chord.bass < chord.root ? chord.bass : chord.bass; // lower octave
        on.set(b, "bass");
      }
    }
    let svg = `<svg viewBox="0 0 ${W * whites} ${H}" class="cv-piano" role="img" aria-label="${chord ? chord.name + " on a piano" : "Piano"}">`;
    let x = 0;
    const blacks = [];
    for (let o = 0; o < 2; o += 1) {
      for (const pc of whitePcs) {
        const k = o * 12 + pc, st = on.get(k);
        svg += `<rect x="${x + 0.5}" y="0.5" width="${W - 1}" height="${H - 1}" rx="2" class="cv-w${st ? " cv-" + st : ""}"/>`;
        if (st) svg += `<text x="${x + W / 2}" y="${H - 6}" class="cv-lbl">${NOTE[pc].replace("♯", "")}</text>`;
        if (blackAfter[pc] !== undefined) blacks.push({ x: x + W - BW / 2, k: o * 12 + blackAfter[pc], pc: blackAfter[pc] });
        x += W;
      }
    }
    for (const b of blacks) {
      const st = on.get(b.k);
      svg += `<rect x="${b.x}" y="0.5" width="${BW}" height="${BH}" rx="1.5" class="cv-b${st ? " cv-" + st : ""}"/>`;
    }
    return svg + "</svg>";
  }

  function guitarSVG(chord) {
    const strings = 6, frets = 5, SW = 16, FH = 18, left = 18, top = 20;
    const w = left + SW * (strings - 1) + 16, h = top + FH * frets + 16;
    let svg = `<svg viewBox="0 0 ${w} ${h}" class="cv-guitar" role="img" aria-label="${chord ? chord.name + " on a guitar" : "Guitar"}">`;
    const shape = chord ? guitarShape(chord.root, chord.quality) : null;
    const base = shape ? shape.base : 1;
    // nut or fret number
    if (base === 1) svg += `<rect x="${left - 1}" y="${top - 3}" width="${SW * (strings - 1) + 2}" height="4" rx="1" class="cv-nut"/>`;
    else svg += `<text x="${left - 7}" y="${top + FH * 0.66}" class="cv-fretno">${base}</text>`;
    for (let f = 0; f <= frets; f += 1) svg += `<line x1="${left}" y1="${top + f * FH}" x2="${left + SW * (strings - 1)}" y2="${top + f * FH}" class="cv-fret"/>`;
    for (let s = 0; s < strings; s += 1) svg += `<line x1="${left + s * SW}" y1="${top}" x2="${left + s * SW}" y2="${top + FH * frets}" class="cv-string"/>`;
    if (shape) {
      // Barre across the strings it covers.
      if (shape.barre && shape.barre >= base) {
        const covered = shape.frets.map((v, s) => (v === shape.barre ? s : -1)).filter((s) => s >= 0);
        if (covered.length >= 2) {
          const y = top + (shape.barre - base + 0.5) * FH;
          svg += `<line x1="${left + covered[0] * SW}" y1="${y}" x2="${left + covered[covered.length - 1] * SW}" y2="${y}" class="cv-barre"/>`;
        }
      }
      shape.frets.forEach((v, s) => {
        const cx = left + s * SW;
        const pc = v === X ? null : (OPEN_STRINGS[s] + v) % 12;
        if (v === X) svg += `<text x="${cx}" y="${top - 8}" class="cv-mute">×</text>`;
        else if (v === 0) svg += `<circle cx="${cx}" cy="${top - 10}" r="4" class="cv-open${pc === chord.root ? " cv-root" : ""}"/>`;
        else svg += `<circle cx="${cx}" cy="${top + (v - base + 0.5) * FH}" r="6" class="cv-dot${pc === chord.root ? " cv-root" : ""}"/>`;
        if (pc !== null) svg += `<text x="${cx}" y="${top + FH * frets + 12}" class="cv-lbl">${NOTE[pc].replace("♯", "♯")}</text>`;
      });
    }
    return svg + "</svg>";
  }

  function mount(root, options = {}) {
    let mode = "piano";
    try { mode = localStorage.getItem("sipra-viz") === "guitar" ? "guitar" : "piano"; } catch (e) {}
    root.classList.add("cv");
    root.innerHTML = `
      <div class="cv-top">
        <p class="cv-pinned" hidden><span></span><button type="button" class="cv-live">Back to live</button></p>
        <div class="cv-tabs" role="tablist" aria-label="Show chords on">
          <button type="button" role="tab" data-cv="piano">Piano</button>
          <button type="button" role="tab" data-cv="guitar">Guitar</button>
        </div>
      </div>
      <div class="cv-stage" aria-live="off"></div>`;
    const stage = root.querySelector(".cv-stage"), pinnedEl = root.querySelector(".cv-pinned");
    // `current` follows the song; `pinned` is a past chord the listener tapped.
    let current = null, pinned = null, sig = "";
    function paint() {
      root.querySelectorAll("[data-cv]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.cv === mode)));
      const shown = pinned || current;
      pinnedEl.hidden = !pinned;
      root.classList.toggle("cv-is-pinned", Boolean(pinned));
      if (pinned) pinnedEl.querySelector("span").textContent = `${pinned.name}${pinned.label ? " · " + pinned.label : ""}`;
      const s = mode + (pinned ? "P" : "") + (shown ? `${shown.root}|${shown.quality}|${shown.bass}` : "none");
      if (s === sig) return;
      sig = s;
      stage.innerHTML = mode === "guitar" ? guitarSVG(shown) : pianoSVG(shown);
    }
    root.querySelectorAll("[data-cv]").forEach((b) => b.addEventListener("click", () => {
      mode = b.dataset.cv;
      try { localStorage.setItem("sipra-viz", mode); } catch (e) {}
      paint();
    }));
    root.querySelector(".cv-live").addEventListener("click", () => { pinned = null; paint(); if (options.onUnpin) options.onUnpin(); });
    paint();
    return {
      show(chord) { current = chord && Number.isInteger(chord.root) ? chord : null; paint(); },
      /** Show a past chord (from the chart or the recent row) until "Back to live". */
      pin(chord, label) { pinned = chord && Number.isInteger(chord.root) ? { ...chord, label } : null; paint(); },
      unpin() { pinned = null; paint(); },
      get pinned() { return pinned; }
    };
  }

  global.SipraChordViz = { mount, guitarShape, shapeNotes, E_SHAPE, A_SHAPE, OPEN };
})(typeof window !== "undefined" ? window : globalThis);
