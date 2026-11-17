/* Sipra (website): live listening, chords, lessons, Spotify account link,
   and audio-driven motion for the Signal deck.
   Audio: getDisplayMedia (a Spotify tab, the desktop app's window, or the whole
   screen with system audio) or the microphone. Analysis: SipraEngine. */
(() => {
  "use strict";
  const Engine = window.SipraEngine;
  if (!Engine) return;
  const NOTE = Engine.NOTE_NAMES;
  const RATIOS = { maj: "4 : 5 : 6", min: "10 : 12 : 15", dim: "≈ 5 : 6 : 7", sus4: "6 : 8 : 9", "7": "≈ 4 : 5 : 6 : 7", maj7: "8 : 10 : 12 : 15", m7: "10 : 12 : 15 : 18" };
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmt = (s) => (!Number.isFinite(s) || s < 0 ? "0:00" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`);
  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const el = {
    tabBtn: $("liveTabBtn"), micBtn: $("liveMicBtn"), stopBtn: $("liveStopBtn"),
    eq: $("liveEq"), status: $("liveStatus"), clock: $("liveClock"), hint: $("liveHint"),
    level: $("liveLevel"), peak: $("livePeak"), db: $("liveDb"),
    np: $("liveNp"), art: $("liveArt"), artEq: $("liveArtEq"), title: $("liveTitle"), artist: $("liveArtist"),
    progress: $("liveProgress"), pos: $("livePos"), dur: $("liveDur"), device: $("liveDevice"),
    chord: $("liveChord"), roman: $("liveRoman"), chordNotes: $("liveChordNotes"), chordMath: $("liveChordMath"), chordLine: $("liveChordLine"),
    bpm: $("liveBpm"), bpmMath: $("liveBpmMath"), bpmConf: $("liveBpmConf"),
    key: $("liveKey"), keyMath: $("liveKeyMath"), keyConf: $("liveKeyConf"),
    meter: $("liveMeter"), feel: $("liveFeel"), pulse: $("livePulse"), beats: $("liveBeats"),
    note: $("liveNote"), oct: $("liveOct"), noteMath: $("liveNoteMath"),
    spectrum: $("liveSpectrum"), scope: $("liveScope"), peakHz: $("livePeakHz"),
    save: $("liveSaveBtn"),
    linkBtn: $("spotifyLinkBtn"), linkLabel: $("spotifyLinkLabel"), linkOpen: $("spotifyLinkOpen"), panel: $("spotifyPanel"),
    clientId: $("spotifyClientId"), connectSpotify: $("spotifyConnect"), redirect: $("redirectUri"), copyRedirect: $("copyRedirect"), linkError: $("spotifyError"),
    overlay: $("learnOverlay"), learnRoot: $("learnRoot"), learnClose: $("learnClose"),
    glyph: document.querySelector(".track-glyph"), vu: $("deckVu"), playBtn: $("playBtn"), metricBpm: $("metricBpm")
  };
  if (!el.tabBtn) return;

  let colors = null;
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    colors = { accent: cs.getPropertyValue("--accent").trim() || "#1DB954", text: cs.getPropertyValue("--text").trim() || "#191414", line: cs.getPropertyValue("--line-strong").trim() || "rgba(0,0,0,.18)" };
  }
  new MutationObserver(readColors).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  readColors();

  function bump(node, cls = "bump") {
    if (!node || reduceMotion) return;
    node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls);
    clearTimeout(node._t); node._t = setTimeout(() => node.classList.remove(cls), 120);
  }
  const BAND_EDGES = [40, 120, 400, 1200, 3500, 12000];
  function bandLevels(freqDb, binHz) {
    const out = [];
    for (let b = 0; b < 5; b += 1) {
      const i0 = Math.max(1, Math.floor(BAND_EDGES[b] / binHz)), i1 = Math.min(freqDb.length - 1, Math.ceil(BAND_EDGES[b + 1] / binHz));
      let sum = 0;
      for (let i = i0; i <= i1; i += 1) sum += freqDb[i];
      out.push(clamp((sum / (i1 - i0 + 1) + 95) / 70, 0, 1));
    }
    return out;
  }
  const rmsOf = (d) => { let e = 0; for (let i = 0; i < d.length; i += 1) e += d[i] * d[i]; return Math.sqrt(e / d.length); };
  function setBars(container, levels) {
    if (!container) return;
    [...container.children].forEach((bar, i) => { bar.style.transform = levels ? `scaleY(${(0.12 + 0.88 * levels[i]).toFixed(3)})` : ""; });
  }

  /* ---------- live state ---------- */
  const live = {
    stream: null, ctx: null, analyser: null, freq: null, time: null, engine: null, offset: null,
    startedAt: 0, result: null, chordSig: "", lastChord: "", lastBeat: -1, lastNoteAt: 0, note: null,
    levelDb: null, peakLevel: 0, silent: 0, takes: 0, trackId: null
  };
  function setStatus(t, k) { el.status.textContent = t; el.status.dataset.state = k; }
  function setHint(h) { el.hint.innerHTML = h; }
  const inFrame = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();
  const BLOCKED = "This preview can't hear audio. Open Sipra from <strong>your own address</strong> (GitHub Pages or your computer), or use the <strong>Sipra extension</strong>.";
  function captureAllowed(kind) {
    const policy = document.permissionsPolicy || document.featurePolicy;
    if (!policy || typeof policy.allowsFeature !== "function") return true;
    try { return policy.allowsFeature(kind === "tab" ? "display-capture" : "microphone"); } catch (e) { return true; }
  }

  async function start(kind) {
    if (live.stream) stop();
    if (!captureAllowed(kind)) { setStatus("Blocked", "warn"); setHint(BLOCKED); return; }
    let stream;
    try {
      if (kind === "tab") {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) throw new Error("unsupported");
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
          systemAudio: "include",   // Windows/ChromeOS (and macOS on newer Chrome): whole-screen audio
          windowAudio: "window",    // Chrome 141+: sharing the Spotify desktop window shares its sound
          selfBrowserSurface: "exclude",
          surfaceSwitching: "include"
        });
        if (!stream.getAudioTracks().length) {
          stream.getTracks().forEach((t) => t.stop());
          setStatus("No audio", "warn");
          setHint("No sound was shared. Try again and switch on <strong>Share audio</strong> in the share window.");
          return;
        }
        stream.getVideoTracks().forEach((t) => { t.enabled = false; });
      } else {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error("unsupported");
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      }
    } catch (error) {
      setStatus("Blocked", "warn");
      setHint(inFrame || /policy|unsupported/i.test(String(error && error.message)) ? BLOCKED : "Sharing was cancelled. Tap <strong>Listen to Spotify</strong> to try again.");
      return;
    }
    const ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.55;
    source.connect(analyser); // not sent to the speakers: Spotify already plays them
    const engine = new Engine(ctx.sampleRate);
    const onChunk = (chunk) => {
      engine.push(chunk);
      const off = ctx.currentTime - engine.seconds;
      live.offset = live.offset === null ? off : Math.min(live.offset + 0.002, off);
    };
    const mute = ctx.createGain();
    mute.gain.value = 0;
    try {
      await ctx.audioWorklet.addModule("js/capture-worklet.js");
      const tap = new AudioWorkletNode(ctx, "sipra-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      source.connect(tap); tap.connect(mute).connect(ctx.destination);
      tap.port.onmessage = (e) => onChunk(e.data);
    } catch (e) {
      const proc = ctx.createScriptProcessor(4096, 2, 1);
      source.connect(proc); proc.connect(mute).connect(ctx.destination);
      proc.onaudioprocess = (ev) => {
        const ib = ev.inputBuffer, L = ib.getChannelData(0), R = ib.numberOfChannels > 1 ? ib.getChannelData(1) : L;
        const m = new Float32Array(L.length);
        for (let i = 0; i < L.length; i += 1) m[i] = (L[i] + R[i]) * 0.5;
        onChunk(m);
      };
    }
    Object.assign(live, {
      stream, ctx, analyser, engine, offset: null,
      freq: new Float32Array(analyser.frequencyBinCount), time: new Float32Array(analyser.fftSize),
      startedAt: performance.now(), result: null, chordSig: "", lastBeat: -1, silent: 0, peakLevel: 0
    });
    stream.getAudioTracks()[0].addEventListener("ended", stop);
    el.tabBtn.hidden = true; el.micBtn.hidden = true; el.stopBtn.hidden = false; el.save.disabled = true;
    setStatus("Listening", "off");
    setHint(kind === "tab" ? "Listening. Numbers appear after ~6 s and get steadier as the song plays." : "Listening through the mic. Keep it near the speaker.");
    renderResult(); renderChord(null);
  }

  function stop() {
    if (!live.stream) return;
    live.stream.getTracks().forEach((t) => t.stop());
    if (live.ctx) live.ctx.close().catch(() => {});
    Object.assign(live, { stream: null, ctx: null, analyser: null, engine: null });
    el.tabBtn.hidden = false; el.micBtn.hidden = false; el.stopBtn.hidden = true;
    setStatus("Off", "off");
    setHint(live.result && live.result.ready ? "Stopped. Tap <strong>Add to Stats</strong> to keep this song's numbers." : "Share Spotify with <strong>audio on</strong>, or use the mic.");
    setBars(el.eq, null); setBars(el.artEq, null);
    el.level.style.width = "0%"; el.peak.style.left = "0%";
    [...el.pulse.children].forEach((d) => d.classList.remove("on"));
  }
  el.tabBtn.addEventListener("click", () => start("tab"));
  el.micBtn.addEventListener("click", () => start("mic"));
  el.stopBtn.addEventListener("click", stop);

  el.save.addEventListener("click", () => {
    const r = live.result;
    if (!r || !r.ready || !window.MBMApp) return;
    live.takes += 1;
    const t = window.SipraSpotify && window.SipraSpotify.state.track;
    window.MBMApp.addTrack({
      name: t ? t.title : `Live ${live.takes}`,
      duration: t && t.duration ? Math.round(t.duration) : Math.max(1, Math.round((performance.now() - live.startedAt) / 1000)),
      bpm: r.bpm, key: { tonicPc: r.key.tonicPc, mode: r.key.mode, confidence: r.key.confidence }, timeSignature: r.meter
    });
    el.save.disabled = true;
    setHint('Added to <a href="#session">Stats</a>.');
  });

  /* ---------- engine updates ---------- */
  setInterval(() => {
    const engine = live.engine;
    if (!engine) return;
    const sp = window.SipraSpotify && window.SipraSpotify.state.track;
    if (sp && !sp.playing) return;
    if (engine.energy < 0.0006) {
      live.silent += 1.5;
      if (live.silent >= 8) { setStatus("No sound", "warn"); setHint("Nothing is playing. Press play in Spotify. If it is playing, share again with <strong>audio on</strong>."); }
      return;
    }
    live.silent = 0;
    const r = engine.update();
    if (!r.ready) { setStatus(`Listening ${Math.floor(r.seconds)}s`, "off"); return; }
    if (!live.result || !live.result.ready) setHint("Every number shows its math underneath. Tap <strong>Learn</strong> on any of them for the full lesson.");
    live.result = r;
    renderResult();
    setStatus("Live", "live");
    el.save.disabled = false;
  }, 1500);

  function renderResult() {
    const r = live.result;
    if (!r || !r.ready) {
      el.bpm.textContent = "—"; el.bpmMath.textContent = "Waiting for a beat…"; el.key.textContent = "—";
      el.keyMath.textContent = "Listening for the home note…"; el.meter.textContent = "—";
      el.bpmConf.style.width = "0%"; el.keyConf.style.width = "0%"; el.beats.textContent = "beat — / —";
      return;
    }
    const T = 60 / r.bpm;
    el.bpm.textContent = r.bpm % 1 ? r.bpm.toFixed(1) : String(r.bpm);
    el.bpmMath.textContent = `${r.compound ? "♩. " : ""}T = 60/${Math.round(r.bpm)} = ${T.toFixed(3)} s${r.bpm >= 140 ? ` · or half-time ${(r.bpm / 2).toFixed(0)}` : r.bpm < 80 ? ` · or double-time ${(r.bpm * 2).toFixed(0)}` : ""}`;
    el.bpmConf.style.width = `${Math.round(r.bpmConfidence * 100)}%`;
    const name = NOTE[r.key.tonicPc], n = r.key.tonicPc - 9;
    el.key.textContent = `${name} ${r.key.mode}`;
    el.keyMath.innerHTML = `home note ${name}4: 440·2<sup>${n}/12</sup> = ${(440 * Math.pow(2, n / 12)).toFixed(1)} Hz`;
    el.keyConf.style.width = `${Math.round(r.key.confidence * 100)}%`;
    el.meter.textContent = r.meterReady ? r.meter : "…";
    el.feel.textContent = !r.meterReady ? "" : r.compound ? `${r.meter}: ${r.beatsPerBar} big beats × 3 eighths · ♩. = ${Math.round(r.bpm)}, ♪ = ${Math.round(r.pulseBpm)}`
      : r.feel === "swing" ? "swing feel: long–short eighths ≈ 2 : 1" : `${r.beatsPerBar} beats per bar`;
    if (r.meterReady && r.meterAlt) el.feel.textContent += ` · could also be written ${r.meterAlt}`;
    const beats = r.beatsPerBar || 4;
    [...el.pulse.children].forEach((d, i) => { d.hidden = i >= beats; d.classList.toggle("down", i === 0); });
  }

  function renderChord(info) {
    const c = info && info.current;
    const sig = c ? `${c.name}|${c.roman}|${info.history.length}` : "none";
    if (sig === live.chordSig) return;
    live.chordSig = sig;
    if (!c) {
      el.chord.textContent = "—"; el.roman.textContent = "—"; el.chordNotes.textContent = "listening…";
      el.chordMath.textContent = "root + {0, 4, 7} semitones";
    } else {
      if (c.name !== live.lastChord) {
        live.lastChord = c.name;
        if (!reduceMotion) { el.chord.classList.add("changed"); setTimeout(() => el.chord.classList.remove("changed"), 350); }
      }
      el.chord.textContent = c.name;
      el.roman.textContent = c.roman || "—";
      el.chordNotes.textContent = c.notes.join(" · ");
      const freqs = c.tones.map((iv) => 440 * Math.pow(2, (c.root + iv - 9) / 12));
      el.chordMath.textContent = `${NOTE[c.root]} + {${c.tones.join(", ")}} semitones → ${freqs.map((f) => f.toFixed(0)).join(" : ")} Hz ≈ ${RATIOS[c.quality] || ""}`;
    }
    el.chordLine.innerHTML = "";
    const hist = info ? info.history.slice(-8) : [];
    hist.forEach((h, i) => {
      const li = document.createElement("li");
      if (i === hist.length - 1 && c && h.name === c.name.split("/")[0]) li.className = "now";
      li.textContent = h.name;
      const sp = document.createElement("span"); sp.textContent = h.roman || "";
      li.append(sp);
      el.chordLine.append(li);
    });
  }

  /* ---------- Spotify account link ---------- */
  const SP = window.SipraSpotify;
  if (SP) {
    el.redirect.textContent = SP.redirectUri();
    el.clientId.value = SP.clientId();
    const togglePanel = (show) => { el.panel.hidden = show === undefined ? !el.panel.hidden : !show; if (!el.panel.hidden) el.panel.scrollIntoView({ block: "nearest", behavior: "smooth" }); };
    el.linkBtn.addEventListener("click", () => (SP.state.linked ? SP.unlink() : togglePanel()));
    el.linkOpen.addEventListener("click", () => togglePanel(true));
    el.copyRedirect.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(SP.redirectUri()); el.copyRedirect.textContent = "Copied"; } catch (e) { el.copyRedirect.textContent = "Select it and copy"; }
      setTimeout(() => (el.copyRedirect.textContent = "Copy"), 1600);
    });
    el.connectSpotify.addEventListener("click", async () => {
      el.linkError.textContent = "";
      if (inFrame) { el.linkError.textContent = "Linking works when Sipra is opened from its own address (GitHub Pages or http://127.0.0.1), not inside a preview."; return; }
      try { await SP.link(el.clientId.value); } catch (e) { el.linkError.textContent = e.message; }
    });
    SP.onChange((s) => {
      el.linkLabel.textContent = s.linked ? "Unlink Spotify" : "Link Spotify account";
      if (s.error) { el.linkError.textContent = s.error; if (!s.linked) el.panel.hidden = false; }
      if (s.linked) el.panel.hidden = true;
      const t = s.track;
      el.np.hidden = !s.linked;
      if (!s.linked) return;
      if (!t) {
        el.title.textContent = "Nothing playing on Spotify";
        el.artist.textContent = "Press play in any Spotify app";
        el.art.hidden = true;
        return;
      }
      el.title.textContent = t.title;
      el.artist.textContent = [t.artist, t.album].filter(Boolean).join(" · ");
      if (t.art && el.art.getAttribute("src") !== t.art) { el.art.src = t.art; el.art.hidden = false; }
      el.device.textContent = t.device ? `on ${t.device}` : "";
      if (t.id !== live.trackId) {
        if (live.trackId && live.engine) { live.engine.reset(); live.result = null; live.chordSig = ""; renderResult(); renderChord(null); }
        live.trackId = t.id;
      }
    });
    SP.init();
  }
  function spotifyPosition() {
    const t = SP && SP.state.track;
    if (!t) return null;
    const p = t.position + (t.playing ? (Date.now() - t.at) / 1000 : 0);
    return { pos: clamp(p, 0, t.duration || p), dur: t.duration, playing: t.playing };
  }

  /* ---------- lessons overlay ---------- */
  let learnView = null;
  function liveSnapshot() {
    const r = live.result && live.result.ready ? live.result : null;
    const info = live.engine ? live.engine.chordInfo() : null;
    const t = SP && SP.state.track;
    return {
      at: Date.now(),
      song: t ? { title: t.title, artist: t.artist, duration: t.duration } : null,
      bpm: r ? r.bpm : null, meter: r && r.meterReady ? r.meter : null, feel: r && r.meterReady ? r.feel : null, meterAlt: r && r.meterReady ? r.meterAlt : null,
      key: r ? { tonicPc: r.key.tonicPc, mode: r.key.mode } : null,
      chord: info && info.current ? { name: info.current.name, root: info.current.root, quality: info.current.quality, tones: info.current.tones, roman: info.current.roman } : null,
      chroma: r ? Array.from(r.chroma) : null,
      note: live.note, levelDb: live.levelDb, peakHz: live.peakHz ?? null, sampleRate: live.ctx ? live.ctx.sampleRate : null,
      sessionBpms: window.MBMApp && window.MBMApp.sessionBpms ? window.MBMApp.sessionBpms() : null
    };
  }
  function openLearn(topic) {
    if (!window.SipraLearn) return;
    el.overlay.hidden = false;
    document.body.classList.add("learn-open");
    if (!learnView) learnView = window.SipraLearn.mount(el.learnRoot, { getLive: liveSnapshot, topic });
    else { learnView.refresh(); if (topic) learnView.goTo(topic); else $("learnScroll").scrollTop = 0; }
    el.learnClose.focus();
  }
  function closeLearn() { el.overlay.hidden = true; document.body.classList.remove("learn-open"); }
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-learn]");
    if (!b) return;
    e.preventDefault();
    openLearn(b.dataset.learn);
  });
  el.learnClose.addEventListener("click", closeLearn);
  el.overlay.addEventListener("click", (e) => { if (e.target === el.overlay) closeLearn(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el.overlay.hidden) closeLearn(); });

  /* ---------- drawing ---------- */
  function fit(canvas) {
    const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }
  const BARS = 64, hold = new Float32Array(BARS);
  function drawLiveSpectrum() {
    const { ctx, w, h } = fit(el.spectrum);
    const gap = 2, bw = (w - gap * (BARS - 1)) / BARS;
    if (!live.analyser) {
      ctx.fillStyle = colors.line;
      for (let b = 0; b < BARS; b += 1) ctx.fillRect(b * (bw + gap), h - 2, bw, 2);
      el.peakHz.textContent = "peak — Hz";
      return;
    }
    const binHz = live.ctx.sampleRate / live.analyser.fftSize;
    let peakF = 0, peakDb = -Infinity;
    for (let b = 0; b < BARS; b += 1) {
      const f0 = 30 * Math.pow(16000 / 30, b / BARS), f1 = 30 * Math.pow(16000 / 30, (b + 1) / BARS);
      const i0 = Math.max(1, Math.floor(f0 / binHz)), i1 = Math.max(i0, Math.ceil(f1 / binHz));
      let m = -Infinity;
      for (let i = i0; i <= i1 && i < live.freq.length; i += 1) {
        if (live.freq[i] > m) m = live.freq[i];
        if (live.freq[i] > peakDb) { peakDb = live.freq[i]; peakF = i * binHz; }
      }
      const v = clamp((m + 100) / 75, 0, 1);
      hold[b] = Math.max(v, hold[b] - 0.012);
      const bh = Math.max(2, v * (h - 30));
      ctx.fillStyle = colors.accent;
      ctx.fillRect(b * (bw + gap), h - bh, bw, bh);
      ctx.globalAlpha = 0.4; ctx.fillStyle = colors.text;
      ctx.fillRect(b * (bw + gap), h - Math.max(2, hold[b] * (h - 30)) - 2, bw, 2);
      ctx.globalAlpha = 1;
    }
    live.peakHz = peakDb > -90 ? peakF : null;
    el.peakHz.textContent = live.peakHz ? `peak ${Math.round(peakF)} Hz` : "peak — Hz";
  }
  function drawScope() {
    const { ctx, w, h } = fit(el.scope);
    ctx.strokeStyle = colors.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    if (!live.analyser) return;
    const d = live.time;
    let s = 0;
    for (let i = 1; i < d.length / 2; i += 1) if (d[i - 1] < 0 && d[i] >= 0) { s = i; break; }
    const span = Math.min(2048, d.length - s);
    let pk = 0.02;
    for (let i = 0; i < span; i += 1) pk = Math.max(pk, Math.abs(d[s + i]));
    ctx.strokeStyle = colors.accent; ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < span; i += 1) { const x = (i / (span - 1)) * w, y = h / 2 - (d[s + i] / pk) * (h * 0.4); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
    ctx.stroke();
  }
  function updateNote(now) {
    if (now - live.lastNoteAt < 150) return;
    live.lastNoteAt = now;
    const f = live.freq, binHz = live.ctx.sampleRate / live.analyser.fftSize;
    const lo = Math.floor(70 / binHz), hi = Math.ceil(1200 / binHz);
    let best = -1, bestDb = -Infinity;
    for (let i = lo; i <= hi; i += 1) if (f[i] > bestDb) { bestDb = f[i]; best = i; }
    if (best < 1 || bestDb < -62) { live.note = null; el.note.textContent = "—"; el.oct.textContent = ""; el.noteMath.textContent = "—"; return; }
    const a = f[best - 1], b = f[best], c = f[best + 1];
    const hz = (best + clamp((a - c) / (2 * (a - 2 * b + c) || 1), -0.5, 0.5)) * binHz;
    const exact = 12 * Math.log2(hz / 440), n = Math.round(exact), cents = Math.round((exact - n) * 100), midi = 69 + n;
    live.note = { f: hz, n, cents, name: NOTE[((midi % 12) + 12) % 12], octave: Math.floor(midi / 12) - 1 };
    el.note.textContent = live.note.name;
    el.oct.textContent = String(live.note.octave);
    el.noteMath.innerHTML = `${hz.toFixed(1)} Hz → n = ${n} (${cents >= 0 ? "+" : ""}${cents}¢) → 440·2<sup>${n}/12</sup> = ${(440 * Math.pow(2, n / 12)).toFixed(1)} Hz`;
  }
  function updateBeat() {
    const r = live.result;
    if (!r || !r.ready || live.offset === null) return;
    const sp = spotifyPosition();
    if (sp && !sp.playing) { [...el.pulse.children].forEach((d) => d.classList.remove("on")); return; }
    // Beat k after the last tracked beat lands at lastBeatTime + k·T (engine clock).
    const T = r.beatPeriod, B = r.beatsPerBar || 4;
    const latency = (live.ctx.outputLatency || 0) + (live.ctx.baseLatency || 0);
    const t = live.ctx.currentTime - latency - (r.lastBeatTime + live.offset);
    const k = Math.floor(t / T), pos = (((r.lastBeatPos || 0) + k) % B + B) % B, lit = t / T - k < 0.28;
    [...el.pulse.children].forEach((d, i) => d.classList.toggle("on", lit && i === pos));
    if (k !== live.lastBeat) { live.lastBeat = k; bump(el.bpm.parentElement); }
    if (sp && sp.dur) el.beats.textContent = `beat ${Math.floor((sp.pos * r.bpm) / 60) + 1} / ${Math.round((sp.dur * r.bpm) / 60)}  (N = D·BPM/60)`;
    else el.beats.textContent = `beat ${pos + 1} of ${B}`;
  }
  function updateSpotifyCard() {
    const sp = spotifyPosition();
    el.np.classList.toggle("is-live", Boolean(live.analyser) && (!sp || sp.playing));
    if (!sp) return;
    el.pos.textContent = fmt(sp.pos);
    el.dur.textContent = fmt(sp.dur);
    el.progress.style.width = sp.dur ? `${(sp.pos / sp.dur) * 100}%` : "0%";
  }

  /* ---------- Signal deck motion (file / demo playback) ---------- */
  let deckBeat = -1, deckFreq = null, deckTime = null;
  function updateDeck() {
    const app = window.MBMApp;
    if (!(app && app.isPlaying && app.analyser)) {
      if (deckBeat !== -1) { deckBeat = -1; setBars(el.glyph, null); if (el.vu) [...el.vu.children].forEach((s) => s.classList.remove("on", "hot")); }
      return;
    }
    const an = app.analyser;
    if (!deckFreq || deckFreq.length !== an.frequencyBinCount) { deckFreq = new Float32Array(an.frequencyBinCount); deckTime = new Float32Array(an.fftSize); }
    an.getFloatFrequencyData(deckFreq);
    an.getFloatTimeDomainData(deckTime);
    setBars(el.glyph, bandLevels(deckFreq, app.ctx.sampleRate / an.fftSize));
    const lvl = clamp((20 * Math.log10(rmsOf(deckTime) + 1e-9) + 54) / 54, 0, 1);
    if (el.vu) {
      const segs = [...el.vu.children], lit = Math.round(lvl * segs.length);
      segs.forEach((s, i) => { s.classList.toggle("on", i < lit && i < segs.length - 1); s.classList.toggle("hot", i < lit && i === segs.length - 1); });
    }
    const k = Math.floor((app.time * app.bpm) / 60);
    if (k !== deckBeat) { if (deckBeat !== -1) { bump(el.playBtn, "beat"); bump(el.metricBpm); } deckBeat = k; }
  }

  function frame(now) {
    if (!document.hidden) {
      if (live.analyser) {
        live.analyser.getFloatFrequencyData(live.freq);
        live.analyser.getFloatTimeDomainData(live.time);
        const bands = bandLevels(live.freq, live.ctx.sampleRate / live.analyser.fftSize);
        setBars(el.eq, bands); setBars(el.artEq, bands);
        const db = 20 * Math.log10(rmsOf(live.time) + 1e-9);
        live.levelDb = Math.round(db * 10) / 10;
        const lvl = clamp((db + 54) / 54, 0, 1);
        live.peakLevel = Math.max(lvl, live.peakLevel - 0.006);
        el.level.style.width = `${(lvl * 100).toFixed(1)}%`;
        el.peak.style.left = `${(live.peakLevel * 100).toFixed(1)}%`;
        el.db.textContent = `${db > -90 ? db.toFixed(1) : "—"} dBFS`;
        updateNote(now);
        updateBeat();
        if (live.engine) renderChord(live.engine.chordInfo());
        const secs = (performance.now() - live.startedAt) / 1000;
        el.clock.textContent = fmt(secs);
      }
      updateSpotifyCard();
      drawLiveSpectrum();
      drawScope();
      updateDeck();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
