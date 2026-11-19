/* Sipra Math map page (math.html): lessons overlay, the last song you listened
   to on the Live page, and audio-driven motion for the Signal lab deck.
   The labs themselves run in app.js. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const NOTE = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The Live page saves its latest numbers, so lessons use your song.
  const readLive = () => { try { return JSON.parse(localStorage.getItem("sipra-web-now") || "null"); } catch (e) { return null; } };

  // Opened from the extension: math.html#song&bpm=…&tonic=…&mode=…&meter=…&title=…
  // (in the #fragment, so it never reaches the server).
  if (location.hash.startsWith("#song&")) {
    const p = new URLSearchParams(location.hash.slice(6));
    const bpm = Number(p.get("bpm")), tonic = Number(p.get("tonic"));
    if (Number.isFinite(bpm) && bpm > 0 && Number.isInteger(tonic) && tonic >= 0 && tonic < 12) {
      const prev = readLive() || {};
      const snap = { ...prev, at: Date.now(), bpm, key: { tonicPc: tonic, mode: p.get("mode") === "minor" ? "minor" : "major" }, meter: p.get("meter") || null,
        song: p.get("title") ? { title: p.get("title").slice(0, 200) } : null };
      try { localStorage.setItem("sipra-web-now", JSON.stringify(snap)); } catch (e) {}
    }
    history.replaceState(null, "", location.pathname + location.search);
  }

  /* ---------- opened over the Live page ----------
     The Live page shows this page in a layer so listening isn't interrupted.
     Links back to the Live page just close that layer. */
  const embedded = (() => { try { return window.parent !== window && window.parent.location.origin === location.origin; } catch (e) { return false; } })();
  if (embedded) {
    document.documentElement.classList.add("in-layer");
    document.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("a[href]");
      if (!a) return;
      const href = a.getAttribute("href");
      if (!/^index\.html(#.*)?$/.test(href)) return;
      e.preventDefault();
      window.parent.postMessage({ sipra: "close-map", hash: href.replace(/^index\.html/, "") }, location.origin);
    });
  }

  /* ---------- last song ---------- */
  const last = $("mmLastSong");
  function showLast() {
    const s = readLive();
    if (!last || !s || !s.bpm) return;
    const bits = [];
    if (s.song && s.song.title) bits.push(`<b>${s.song.title.replace(/[<>&]/g, "")}</b>`);
    bits.push(`${Math.round(s.bpm)} BPM`);
    if (s.key) bits.push(`${NOTE[s.key.tonicPc]} ${s.key.mode}`);
    if (s.meter) bits.push(s.meter);
    last.innerHTML = `Lessons use your last song: ${bits.join(" · ")}`;
    last.hidden = false;
  }
  showLast();
  window.addEventListener("storage", (e) => { if (e.key === "sipra-web-now") showLast(); });

  /* ---------- lessons overlay ---------- */
  const overlay = $("learnOverlay"), learnRoot = $("learnRoot"), learnClose = $("learnClose");
  let view = null;
  function openLearn(topic) {
    if (!window.SipraLearn || !overlay) return;
    overlay.hidden = false;
    document.body.classList.add("learn-open");
    if (!view) view = window.SipraLearn.mount(learnRoot, { getLive: readLive, topic });
    else { view.refresh(); if (topic) view.goTo(topic); else $("learnScroll").scrollTop = 0; }
    learnClose.focus();
  }
  function closeLearn() { overlay.hidden = true; document.body.classList.remove("learn-open"); }
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-learn]");
    if (!b) return;
    e.preventDefault();
    openLearn(b.dataset.learn);
  });
  if (learnClose) learnClose.addEventListener("click", closeLearn);
  if (overlay) overlay.addEventListener("click", (e) => { if (e.target === overlay) closeLearn(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && overlay && !overlay.hidden) closeLearn(); });
  // Open a lesson straight from a link like math.html#learn-tempo.
  if (/^#learn-/.test(location.hash)) setTimeout(() => openLearn(location.hash.slice(7)), 300);

  /* ---------- Signal lab motion (song / demo playback) ---------- */
  const glyph = document.querySelector(".track-glyph"), vu = $("deckVu"), playBtn = $("playBtn"), metricBpm = $("metricBpm");
  const EDGES = [40, 120, 400, 1200, 3500, 12000];
  function bump(node, cls) {
    if (!node || reduceMotion) return;
    node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls);
    clearTimeout(node._t); node._t = setTimeout(() => node.classList.remove(cls), 120);
  }
  function setBars(container, levels) {
    if (!container) return;
    [...container.children].forEach((bar, i) => { bar.style.transform = levels ? `scaleY(${(0.12 + 0.88 * levels[i]).toFixed(3)})` : ""; });
  }
  let beat = -1, freq = null, time = null;
  function frame() {
    const app = window.MBMApp;
    if (!document.hidden && app) {
      if (!(app.isPlaying && app.analyser)) {
        if (beat !== -1) { beat = -1; setBars(glyph, null); if (vu) [...vu.children].forEach((s) => s.classList.remove("on", "hot")); }
      } else {
        const an = app.analyser, binHz = app.ctx.sampleRate / an.fftSize;
        if (!freq || freq.length !== an.frequencyBinCount) { freq = new Float32Array(an.frequencyBinCount); time = new Float32Array(an.fftSize); }
        an.getFloatFrequencyData(freq);
        an.getFloatTimeDomainData(time);
        const levels = [];
        for (let b = 0; b < 5; b += 1) {
          const i0 = Math.max(1, Math.floor(EDGES[b] / binHz)), i1 = Math.min(freq.length - 1, Math.ceil(EDGES[b + 1] / binHz));
          let sum = 0;
          for (let i = i0; i <= i1; i += 1) sum += freq[i];
          levels.push(clamp((sum / (i1 - i0 + 1) + 95) / 70, 0, 1));
        }
        setBars(glyph, levels);
        let e = 0;
        for (let i = 0; i < time.length; i += 1) e += time[i] * time[i];
        const lvl = clamp((20 * Math.log10(Math.sqrt(e / time.length) + 1e-9) + 54) / 54, 0, 1);
        if (vu) {
          const segs = [...vu.children], lit = Math.round(lvl * segs.length);
          segs.forEach((s, i) => { s.classList.toggle("on", i < lit && i < segs.length - 1); s.classList.toggle("hot", i < lit && i === segs.length - 1); });
        }
        const k = Math.floor((app.time * app.bpm) / 60);
        if (k !== beat) { if (beat !== -1) { bump(playBtn, "beat"); bump(metricBpm, "bump"); } beat = k; }
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
