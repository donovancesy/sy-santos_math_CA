/* Sipra side panel.
   1. Song info comes from the Spotify tab (content.js: Media Session + audio element).
   2. Audio comes from capturing that tab (or the browser's share-a-tab window).
   3. SipraEngine follows the whole song: tempo, key, meter, chords.
   4. Every frame draws the spectrum, waveform, level, loudest note and beat pulse.
   5. Live values are saved for the Learn page, so its examples use your song. */
(() => {
  "use strict";

  const NOTE_NAMES = window.SipraEngine.NOTE_NAMES;
  const SPOTIFY = "https://open.spotify.com/";
  const UPDATE_MS = 1000;
  const RATIOS = { maj: "4 : 5 : 6", min: "10 : 12 : 15", dim: "≈ 5 : 6 : 7", sus4: "6 : 8 : 9", "7": "≈ 4 : 5 : 6 : 7", maj7: "8 : 10 : 12 : 15", m7: "10 : 12 : 15 : 18", sus2: "8 : 9 : 12", aug: "16 : 20 : 25" };

  const $ = (id) => document.getElementById(id);
  // Bar-by-bar chord chart (sipra-chart.js).
  const chartView = window.SipraChart && $("chartCard") ? window.SipraChart.mount($("chartCard")) : null;
  // The chord on a piano or guitar (sipra-chordviz.js).
  const chordViz = window.SipraChordViz && $("chordViz") ? window.SipraChordViz.mount($("chordViz")) : null;
  // Synced lyrics (sipra-lyrics.js), following the Spotify tab's song and time.
  if (window.SipraLyrics && $("lyricsCard")) {
    window.SipraLyrics.mount($("lyricsCard"), {
      getTrack: () => {
        const np = state.np;
        if (!np || !np.title) return null;
        return { title: np.title, artist: np.artist, album: np.album, duration: np.duration, position: currentPosition(), playing: np.playing };
      },
      noTrackHint: "Lyrics follow the song once something is playing in the Spotify tab."
    });
  }
  // Tempo fix: ½× or 2× when Sipra counts eighth notes or half notes,
  // remembered per song.
  const FIX_KEY = "sipra-tempo-fix";
  const readFixes = () => { try { return JSON.parse(localStorage.getItem(FIX_KEY) || "{}"); } catch (e) { return {}; } };
  function songKey() { return state.np && state.np.title ? state.np.title + " — " + (state.np.artist || "") : null; }
  function restoreFix() {
    const k = songKey(), s = k ? readFixes()[k] : null;
    if (state.engine && s && state.engine.tempoScale !== s) state.engine.setTempoScale(s);
  }
  document.addEventListener("click", (event) => {
    const b = event.target.closest && event.target.closest("[data-tempo-fix]");
    if (!b || !state.engine) return;
    const want = Number(b.dataset.tempoFix), s = state.engine.tempoScale === want ? 1 : want;
    state.engine.setTempoScale(s);
    const k = songKey();
    if (k) {
      const fixes = readFixes();
      if (s === 1) delete fixes[k]; else fixes[k] = s;
      try { localStorage.setItem(FIX_KEY, JSON.stringify(fixes)); } catch (e) {}
    }
    state.result = null; state.chordKey = "";
    if (chartView) chartView.clear();
    renderResult();
  });
  const el = {
    art: $("art"), artImg: $("artImg"), artEq: $("artEq"), title: $("npTitle"), artist: $("npArtist"), status: $("status"),
    progress: $("progressFill"), pos: $("posText"), dur: $("durText"), level: $("levelFill"), levelPeak: $("levelPeak"),
    connect: $("connectBtn"), connectLabel: $("connectLabel"), openSpotify: $("openSpotifyBtn"), hint: $("hint"),
    chordName: $("chordName"), chordRoman: $("chordRoman"), chordNotes: $("chordNotes"), chordMath: $("chordMath"), chordLine: $("chordLine"),
    bpm: $("bpmVal"), bpmMath: $("bpmMath"), bpmAlt: $("bpmAlt"), bpmConf: $("bpmConf"),
    key: $("keyVal"), keyMath: $("keyMath"), keyConf: $("keyConf"),
    meter: $("meterVal"), meterFeel: $("meterFeel"), pulse: $("pulse"), beatNow: $("beatNow"), beatTotal: $("beatTotal"),
    spectrum: $("spectrum"), scope: $("scope"), peak: $("peakText"),
    sMean: $("sMean"), sMedian: $("sMedian"), sMode: $("sMode"), sStd: $("sStd"),
    tracks: $("tracks"), empty: $("emptyTracks"), clear: $("clearBtn"), theme: $("themeToggle"),
    brand: document.querySelector(".brand-mark")
  };

  const state = {
    np: null, trackId: null,
    cap: null, engine: null, streamOffset: null,
    result: null, chordKey: "", lastChordName: "",
    session: [], colors: null, peakLevel: 0, lastBeat: -1, lastNoteAt: 0, note: null, silentFor: 0
  };

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmtTime = (s) => (!Number.isFinite(s) || s < 0 ? "0:00" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`);
  function setHint(html) { el.hint.hidden = !html; el.hint.innerHTML = html || ""; }
  function setStatus(label, kind) { el.status.textContent = label; el.status.dataset.state = kind; }
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    state.colors = { accent: cs.getPropertyValue("--accent").trim(), faint: cs.getPropertyValue("--line-strong").trim(), text: cs.getPropertyValue("--text").trim() };
  }
  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  function bump(node) {
    if (!node || reduceMotion) return;
    node.classList.remove("bump"); void node.offsetWidth; node.classList.add("bump");
    clearTimeout(node._t); node._t = setTimeout(() => node.classList.remove("bump"), 120);
  }

  /* ---------- theme + lessons ---------- */
  el.theme.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("sipra-theme", next); } catch (e) {}
    readColors();
  });
  // Math map: the concept map and labs on the Sipra website. The song's numbers
  // go in the #fragment, which stays in the browser (never sent to the server).
  const MATH_MAP_URL = "https://donovancesy.github.io/sy-santos_math_CA/math.html";
  document.addEventListener("click", (event) => {
    const btn = event.target.closest && event.target.closest("[data-open-map]");
    if (!btn) return;
    const r = state.result && state.result.ready ? state.result : null;
    let url = MATH_MAP_URL;
    if (r) {
      const k = r.keyNow || r.key;
      const p = new URLSearchParams({ bpm: String(r.bpm), tonic: String(k.tonicPc), mode: k.mode, meter: r.meterReady ? r.meter : "" });
      if (state.np && state.np.title) p.set("title", state.np.title);
      url += "#song&" + p.toString();
    }
    chrome.tabs.create({ url });
  });
  document.addEventListener("click", (event) => {
    const btn = event.target.closest && event.target.closest("[data-learn]");
    if (!btn) return;
    const topic = btn.dataset.learn;
    publishLive();
    chrome.tabs.create({ url: chrome.runtime.getURL(`learn.html${topic ? "#" + topic : ""}`) });
  });

  /* ---------- Spotify tab + song info ---------- */
  async function findSpotifyTab() {
    const wanted = Number(new URLSearchParams(location.search).get("tab"));
    if (wanted) {
      try { const t = await chrome.tabs.get(wanted); if (t.url && t.url.startsWith(SPOTIFY)) return t; } catch (e) {}
    }
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (active && active.url && active.url.startsWith(SPOTIFY)) return active;
    const { lastSpotifyTab } = await chrome.storage.session.get("lastSpotifyTab").catch(() => ({}));
    if (lastSpotifyTab) {
      try { const t = await chrome.tabs.get(lastSpotifyTab); if (t.url && t.url.startsWith(SPOTIFY)) return t; } catch (e) {}
    }
    const all = await chrome.tabs.query({ url: SPOTIFY + "*" });
    return all.find((t) => t.audible) || all[0] || null;
  }

  async function askNowPlaying(tab) {
    try {
      const info = await chrome.tabs.sendMessage(tab.id, { type: "sipra-get-now-playing" });
      if (info) onNowPlaying(info, tab.id);
    } catch (e) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content-main.js"], world: "MAIN" });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      } catch (err) {}
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || msg.type !== "sipra-now-playing") return;
    const tabId = sender.tab ? sender.tab.id : null;
    if (state.cap && tabId !== state.cap.tabId) return;
    onNowPlaying(msg, tabId);
  });

  function onNowPlaying(info, tabId) {
    info.receivedAt = Date.now();
    info.tabId = tabId;
    const id = info.title ? `${info.title}|${info.artist}` : null;
    if (id && id !== state.trackId) {
      if (state.trackId) finishTrack();
      state.trackId = id;
      resetAnalysis();
      state.joinedAt = Number.isFinite(info.position) ? info.position : null;
      restoreFix();
    } else if (id && id === state.trackId && Number.isFinite(info.position) && Number.isFinite(state.lastPos) && state.lastPos > 12 && info.position < 4) {
      // Played again from the start: the chart starts over too.
      finishTrack();
      resetAnalysis();
      state.joinedAt = 0;
    }
    if (Number.isFinite(info.position)) state.lastPos = info.position;
    state.np = info;
    if (state.engine) state.engine.autoSplit = !info.title;
    el.title.textContent = info.title || "Nothing playing";
    el.artist.textContent = info.title ? [info.artist, info.album].filter(Boolean).join(" · ") : "Play something on Spotify";
    if (info.art && el.artImg.getAttribute("src") !== info.art) { el.artImg.src = info.art; el.artImg.hidden = false; }
    else if (!info.art) el.artImg.hidden = true;
    el.openSpotify.hidden = true;
    if (!state.cap) setStatus(info.playing ? "Ready" : "Paused", "off");
    else if (state.result && state.result.ready) setStatus(info.playing ? "Live" : "Paused", info.playing ? "live" : "off");
  }

  function currentPosition() {
    const np = state.np;
    if (!np || !Number.isFinite(np.position)) return null;
    const drift = np.playing ? (Date.now() - np.receivedAt) / 1000 : 0;
    return Number.isFinite(np.duration) ? clamp(np.position + drift, 0, np.duration) : np.position + drift;
  }

  /* ---------- audio capture ---------- */
  async function getTabStream(tab, allowPicker) {
    const { pendingStream } = await chrome.storage.session.get("pendingStream").catch(() => ({}));
    if (pendingStream) chrome.storage.session.remove("pendingStream").catch(() => {});
    const ids = [];
    if (pendingStream && pendingStream.id && pendingStream.tabId === tab.id && Date.now() - pendingStream.at < 15000) ids.push(pendingStream.id);
    let lastError = pendingStream && pendingStream.error ? pendingStream.error : "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let id = ids[attempt];
      if (!id && attempt === ids.length) {
        try { id = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id }); }
        catch (e) { lastError = (e && e.message) || String(e); }
      }
      if (!id) continue;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: id } }, video: false });
        return { stream, mutesTab: true };
      } catch (e) { lastError = (e && e.message) || String(e); }
    }
    if (!allowPicker) return { error: lastError };
    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) return { error: lastError || "Sharing isn't available." };
    setStatus("Pick tab", "off");
    setHint("Pick the <b>Spotify</b> tab in the share window and switch on <b>Share tab audio</b>.");
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        preferCurrentTab: false, selfBrowserSurface: "exclude", systemAudio: "include"
      });
      if (!stream.getAudioTracks().length) { stream.getTracks().forEach((t) => t.stop()); return { error: "no-audio" }; }
      stream.getVideoTracks().forEach((t) => { t.enabled = false; });
      return { stream, mutesTab: false };
    } catch (e) {
      return { error: "cancelled" };
    }
  }

  async function connect({ auto = false } = {}) {
    setHint("");
    const tab = await findSpotifyTab();
    if (!tab) {
      setStatus("No Spotify", "warn");
      el.openSpotify.hidden = false;
      setHint("Open <b>Spotify Web Player</b>, play a song, then tap Connect.");
      return;
    }
    const got = await getTabStream(tab, !auto);
    if (!got.stream) {
      if (auto) return;
      setStatus("Not connected", "warn");
      if (got.error === "no-audio") setHint("No sound was shared. Tap Connect again and switch on <b>Share tab audio</b>.");
      else if (got.error === "cancelled") setHint("Sharing was cancelled. Tap <b>Connect</b> to try again.");
      else setHint(`The browser blocked the audio. Reload the Spotify tab and try again.<br><small>${String(got.error).replace(/[<>&]/g, "")}</small>`);
      return;
    }
    try {
      const stream = got.stream;
      const ctx = new AudioContext({ latencyHint: "interactive" });
      await ctx.audioWorklet.addModule("capture-worklet.js");
      const source = ctx.createMediaStreamSource(stream);
      if (got.mutesTab) source.connect(ctx.destination); // tab capture mutes the tab: play it back here
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 8192;
      analyser.smoothingTimeConstant = 0.55;
      source.connect(analyser);
      const tap = new AudioWorkletNode(ctx, "sipra-tap", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      const silent = ctx.createGain();
      silent.gain.value = 0;
      source.connect(tap);
      tap.connect(silent).connect(ctx.destination);

      // The Spotify tab tells us when the song changes, so only split on our own
      // (gap + different tempo/key) when its song info is missing.
      state.engine = new window.SipraListener(ctx.sampleRate, { autoSplit: !(state.np && state.np.title) });
      state.streamOffset = null;
      state.epoch = state.engine.epoch;
      restoreFix(); // a tempo fix saved for this song applies right away
      state.joinedAt = Number.isFinite(currentPosition()) ? currentPosition() : state.joinedAt;
      tap.port.onmessage = (event) => {
        const engine = state.engine;
        if (!engine) return;
        const used = engine.push(event.data);
        // Re-sync the beat clock whenever the analysis clock jumps (gap, reset, new song).
        if (engine.epoch !== state.epoch) { state.epoch = engine.epoch; state.streamOffset = null; }
        if (!used) return;
        // Map engine time (seconds of music heard) to the audio clock.
        const offset = ctx.currentTime - engine.seconds;
        state.streamOffset = state.streamOffset === null ? offset : Math.min(state.streamOffset + 0.002, offset);
      };

      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      if (ctx.state !== "running") {
        setHint("Tap anywhere in this panel to hear Spotify.");
        document.addEventListener("pointerdown", () => ctx.resume().then(() => setHint("")).catch(() => {}), { once: true });
      }
      state.cap = { stream, ctx, analyser, tap, source, tabId: tab.id, freq: new Float32Array(analyser.frequencyBinCount), time: new Float32Array(analyser.fftSize) };
      stream.getAudioTracks()[0].addEventListener("ended", disconnect);
      el.connect.dataset.connected = "true";
      el.connectLabel.textContent = "Disconnect";
      setStatus("Listening", "off");
      if (ctx.state === "running") setHint("");
      askNowPlaying(tab);
    } catch (e) {
      got.stream.getTracks().forEach((t) => t.stop());
      setStatus("Error", "warn");
      setHint("The browser blocked the audio. Reload the Spotify tab and try again.");
    }
  }

  function disconnect() {
    finishTrack();
    const cap = state.cap;
    state.cap = null;
    state.engine = null;
    if (cap) { cap.stream.getTracks().forEach((t) => t.stop()); cap.ctx.close().catch(() => {}); }
    el.connect.dataset.connected = "false";
    el.connectLabel.textContent = "Connect";
    setStatus("Off", "off");
    setHint("");
  }
  el.connect.addEventListener("click", () => (state.cap ? disconnect() : connect()));
  el.openSpotify.addEventListener("click", () => chrome.tabs.create({ url: SPOTIFY }));

  function resetAnalysis() {
    if (state.engine) state.engine.reset();
    state.result = null;
    state.chordKey = "";
    state.lastBeat = -1;
    state.silentFor = 0;
    renderResult();
    renderChord(null);
    if (chartView) chartView.clear();
  }

  /* ---------- heavy estimates every 2.5 s ---------- */
  setInterval(() => {
    const engine = state.engine;
    if (!engine || !state.cap) return;
    if (state.np && !state.np.playing) return;
    if (engine.inGap) {
      state.silentFor = engine.silentSeconds;
      if (state.silentFor >= 8) {
        setStatus("No sound", "warn");
        setHint("No audio is reaching Sipra. Check Spotify isn't muted, then Disconnect and Connect again.");
      }
      return;
    }
    if (state.silentFor >= 8) setHint("");
    state.silentFor = 0;
    const r = engine.update();
    if (!r.ready) { setStatus(`Listening ${Math.floor(r.seconds)}s`, "off"); return; }
    state.result = r;
    renderResult();
    if (chartView) chartView.update(r, { title: state.np && state.np.title, artist: state.np && state.np.artist, joinedAt: state.joinedAt });
    setStatus("Live", "live");
    publishLive();
  }, UPDATE_MS);

  function renderResult() {
    const r = state.result;
    if (!r || !r.ready) {
      el.bpm.textContent = "—"; el.bpmMath.textContent = "T = 60 / BPM"; el.bpmAlt.textContent = "";
      el.key.textContent = "—"; el.keyMath.innerHTML = "f = 440 · 2<sup>n/12</sup>";
      el.meter.textContent = "—"; el.bpmConf.style.width = "0%"; el.keyConf.style.width = "0%";
      el.beatNow.textContent = "—"; el.beatTotal.textContent = "/ —";
      return;
    }
    const scale = r.tempoScale || 1;
    document.querySelectorAll("[data-tempo-fix]").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.tempoFix) === scale)));
    el.bpm.textContent = r.bpm % 1 ? r.bpm.toFixed(1) : String(r.bpm);
    el.bpmMath.textContent = `${r.compound ? "♩. " : ""}T = 60/${Math.round(r.bpm)} = ${(60 / r.bpm).toFixed(3)}s`;
    el.bpmAlt.textContent = scale !== 1 ? `heard ${Math.round(r.autoBpm)} → ${scale === 0.5 ? "½" : "2"}×` : "sounds off? fix it:";
    el.bpmConf.style.width = `${Math.round(r.bpmConfidence * 100)}%`;
    // After a key change, show the key we're in now.
    const k = r.keyNow || r.key;
    const name = NOTE_NAMES[k.tonicPc];
    const n = k.tonicPc - 9;
    el.key.textContent = `${name} ${k.mode}`;
    el.keyMath.innerHTML = (r.keyNow ? `was ${NOTE_NAMES[r.key.tonicPc]} ${r.key.mode} · ` : "") + `440·2<sup>${n}/12</sup> = ${(440 * Math.pow(2, n / 12)).toFixed(1)} Hz`;
    el.keyConf.style.width = `${Math.round(k.confidence * 100)}%`;
    el.meter.textContent = r.meterReady ? r.meter : "…";
    el.meterFeel.textContent = !r.meterReady ? "" : r.compound ? `♩. = ${Math.round(r.bpm)} · ♪ = ${Math.round(r.pulseBpm)}`
      : r.feel === "swing" ? "swing feel" : `${r.beatsPerBar} beats per bar`;
    if (r.meterReady && r.meterAlt) el.meterFeel.textContent += ` · or ${r.meterAlt}`;
    const beats = r.beatsPerBar || 4;
    [...el.pulse.children].forEach((d, i) => { d.hidden = i >= beats; d.classList.toggle("down", i === 0); });
  }

  /* ---------- chords (checked every frame, change ~4×/s) ---------- */
  function renderChord(info) {
    const c = info && info.current;
    const keyStr = c ? `${c.name}|${c.roman}|${info.history.length}` : "none";
    if (keyStr === state.chordKey) return;
    state.chordKey = keyStr;
    if (chordViz) chordViz.show(c ? { root: c.root, quality: c.quality, tones: c.tones, name: c.name } : null);
    if (!c) {
      el.chordName.textContent = "—";
      el.chordRoman.textContent = "—";
      el.chordNotes.textContent = "listening…";
      el.chordMath.textContent = "root + {0, 4, 7} semitones";
    } else {
      if (c.name !== state.lastChordName) {
        state.lastChordName = c.name;
        if (!reduceMotion) { el.chordName.classList.add("changed"); setTimeout(() => el.chordName.classList.remove("changed"), 350); }
      }
      el.chordName.textContent = c.name;
      el.chordRoman.textContent = c.roman || "—";
      el.chordNotes.textContent = c.notes.join(" · ");
      const freqs = c.tones.map((iv) => 440 * Math.pow(2, (c.root + iv - 9) / 12));
      el.chordMath.textContent = `${NOTE_NAMES[c.root]} + {${c.tones.join(", ")}} semitones → ${freqs.map((f) => f.toFixed(0)).join(" : ")} Hz ≈ ${RATIOS[c.quality] || ""}`;
    }
    el.chordLine.innerHTML = "";
    const hist = info ? info.history.slice(-6) : [];
    hist.forEach((h, i) => {
      const li = document.createElement("li");
      if (i === hist.length - 1 && c && h.name === c.name.split("/")[0]) li.className = "now";
      li.textContent = h.name;
      const span = document.createElement("span");
      span.textContent = h.roman || "";
      li.append(span);
      el.chordLine.append(li);
    });
  }

  /* ---------- session ---------- */
  function finishTrack() {
    const r = state.result, np = state.np;
    if (!np || !np.title || !r || !r.ready) return;
    const chords = state.engine ? state.engine.chordInfo().history : [];
    const counts = new Map();
    chords.forEach((h) => counts.set(h.name, (counts.get(h.name) || 0) + (h.end - h.start)));
    // The chart's loop (the progression) if there is one; else the most-heard chords.
    const loop = r.chart && r.chart.loop;
    const topChords = loop ? loop.names.slice(0, 8) : [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n]) => n);
    const entry = { title: np.title, artist: np.artist, art: np.art, bpm: r.bpm, key: { tonicPc: r.key.tonicPc, mode: r.key.mode }, meter: r.meter, chords: topChords, duration: np.duration, at: Date.now() };
    const last = state.session[0];
    if (last && last.title === entry.title && last.artist === entry.artist) state.session[0] = entry;
    else state.session.unshift(entry);
    state.session = state.session.slice(0, 50);
    chrome.storage.local.set({ "sipra-session": state.session }).catch(() => {});
    renderSession();
  }

  function renderSession() {
    const list = state.session;
    el.empty.hidden = list.length > 0;
    el.tracks.innerHTML = "";
    for (const t of list) {
      const li = document.createElement("li");
      const img = t.art ? document.createElement("img") : document.createElement("span");
      if (t.art) { img.src = t.art; img.alt = ""; } else img.className = "ph";
      const text = document.createElement("div"); text.className = "t";
      const b = document.createElement("b"); b.textContent = t.title;
      const s = document.createElement("span"); s.textContent = t.chords && t.chords.length ? t.chords.join(" · ") : (t.artist || "");
      text.append(b, s);
      const nums = document.createElement("div"); nums.className = "n";
      const strong = document.createElement("strong"); strong.textContent = `${Math.round(t.bpm)} BPM`;
      const keyText = t.key ? `${NOTE_NAMES[t.key.tonicPc]}${t.key.mode === "minor" ? "m" : ""}` : "";
      nums.append(strong, document.createTextNode(`${keyText} · ${t.meter || "4/4"}`));
      li.append(img, text, nums);
      el.tracks.append(li);
    }
    const bpms = list.map((t) => t.bpm).filter(Number.isFinite);
    if (!bpms.length) { [el.sMean, el.sMedian, el.sMode, el.sStd].forEach((x) => (x.textContent = "—")); return; }
    const sorted = [...bpms].sort((a, b) => a - b);
    const mean = bpms.reduce((s, v) => s + v, 0) / bpms.length;
    const mid = sorted.length >> 1;
    const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    const counts = new Map();
    sorted.forEach((v) => counts.set(Math.round(v), (counts.get(Math.round(v)) || 0) + 1));
    let mode = null, modeCount = 0;
    counts.forEach((c, v) => { if (c > modeCount) { mode = v; modeCount = c; } });
    const sd = Math.sqrt(bpms.reduce((s, v) => s + (v - mean) * (v - mean), 0) / bpms.length);
    el.sMean.textContent = mean.toFixed(1);
    el.sMedian.textContent = median.toFixed(1);
    el.sMode.textContent = modeCount > 1 ? String(mode) : "—";
    el.sStd.textContent = sd.toFixed(1);
  }
  el.clear.addEventListener("click", () => {
    state.session = [];
    chrome.storage.local.set({ "sipra-session": [] }).catch(() => {});
    renderSession();
    publishLive();
  });

  /* ---------- share live values with the Learn page ---------- */
  function publishLive() {
    const r = state.result && state.result.ready ? state.result : null;
    const chord = state.engine ? state.engine.chordInfo() : null;
    const payload = {
      at: Date.now(),
      song: state.np && state.np.title ? { title: state.np.title, artist: state.np.artist, duration: state.np.duration } : null,
      bpm: r ? r.bpm : null,
      meter: r && r.meterReady ? r.meter : null,
      feel: r && r.meterReady ? r.feel : null,
      meterAlt: r && r.meterReady ? r.meterAlt : null,
      key: r ? { tonicPc: r.key.tonicPc, mode: r.key.mode } : null,
      chord: chord && chord.current ? { name: chord.current.name, root: chord.current.root, quality: chord.current.quality, tones: chord.current.tones, roman: chord.current.roman } : null,
      chroma: r ? Array.from(r.chroma) : null,
      note: state.note,
      levelDb: state.levelDb ?? null,
      peakHz: state.peakHz ?? null,
      sampleRate: state.cap ? state.cap.ctx.sampleRate : null,
      sessionBpms: state.session.map((t) => t.bpm)
    };
    try { localStorage.setItem("sipra-now", JSON.stringify(payload)); } catch (e) {}
  }

  /* ---------- per-frame drawing ---------- */
  const BAR_COUNT = 56, F_MIN = 30, F_MAX = 16000;
  const peakHold = new Float32Array(BAR_COUNT);
  const BAND_EDGES = [40, 120, 400, 1200, 3500, 12000];

  function fit(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function drawSpectrum() {
    const { ctx, w, h } = fit(el.spectrum);
    const cap = state.cap;
    const gap = 2, barW = (w - gap * (BAR_COUNT - 1)) / BAR_COUNT;
    let peakFreq = null, peakDb = -Infinity;
    if (!cap) {
      ctx.fillStyle = state.colors.faint;
      for (let b = 0; b < BAR_COUNT; b += 1) ctx.fillRect(b * (barW + gap), h - 2, barW, 2);
      el.peak.textContent = "peak — Hz";
      return;
    }
    cap.analyser.getFloatFrequencyData(cap.freq);
    const binHz = cap.ctx.sampleRate / cap.analyser.fftSize;
    for (let b = 0; b < BAR_COUNT; b += 1) {
      const f0 = F_MIN * Math.pow(F_MAX / F_MIN, b / BAR_COUNT), f1 = F_MIN * Math.pow(F_MAX / F_MIN, (b + 1) / BAR_COUNT);
      const i0 = Math.max(1, Math.floor(f0 / binHz)), i1 = Math.max(i0, Math.ceil(f1 / binHz));
      let m = -Infinity;
      for (let i = i0; i <= i1 && i < cap.freq.length; i += 1) {
        if (cap.freq[i] > m) m = cap.freq[i];
        if (cap.freq[i] > peakDb) { peakDb = cap.freq[i]; peakFreq = i * binHz; }
      }
      const v = clamp((m + 100) / 75, 0, 1);
      peakHold[b] = Math.max(v, peakHold[b] - 0.012);
      const bh = Math.max(2, v * (h - 6));
      ctx.fillStyle = state.colors.accent;
      ctx.fillRect(b * (barW + gap), h - bh, barW, bh);
      ctx.globalAlpha = 0.35; ctx.fillStyle = state.colors.text;
      ctx.fillRect(b * (barW + gap), h - Math.max(2, peakHold[b] * (h - 6)) - 2, barW, 2);
      ctx.globalAlpha = 1;
    }
    state.peakHz = peakFreq && peakDb > -90 ? peakFreq : null;
    el.peak.textContent = state.peakHz ? `peak ${Math.round(peakFreq)} Hz` : "peak — Hz";
  }

  function drawScope() {
    const { ctx, w, h } = fit(el.scope);
    ctx.strokeStyle = state.colors.faint; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    const cap = state.cap;
    if (!cap) return;
    const data = cap.time;
    let start = 0;
    for (let i = 1; i < data.length / 2; i += 1) if (data[i - 1] < 0 && data[i] >= 0) { start = i; break; }
    const span = Math.min(2048, data.length - start);
    let peak = 0.02;
    for (let i = 0; i < span; i += 1) peak = Math.max(peak, Math.abs(data[start + i]));
    ctx.strokeStyle = state.colors.accent; ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < span; i += 1) {
      const x = (i / (span - 1)) * w, y = h / 2 - (data[start + i] / peak) * (h * 0.42);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.stroke();
  }

  function updateMotion() {
    const cap = state.cap;
    el.art.classList.toggle("is-live", Boolean(cap) && (!state.np || state.np.playing));
    if (!cap) { el.level.style.width = "0%"; el.levelPeak.style.left = "0%"; return; }
    cap.analyser.getFloatTimeDomainData(cap.time);
    const binHz = cap.ctx.sampleRate / cap.analyser.fftSize;
    [...el.artEq.children].forEach((bar, b) => {
      const i0 = Math.max(1, Math.floor(BAND_EDGES[b] / binHz)), i1 = Math.min(cap.freq.length - 1, Math.ceil(BAND_EDGES[b + 1] / binHz));
      let sum = 0;
      for (let i = i0; i <= i1; i += 1) sum += cap.freq[i];
      bar.style.transform = `scaleY(${(0.12 + 0.88 * clamp((sum / (i1 - i0 + 1) + 95) / 70, 0, 1)).toFixed(3)})`;
    });
    let e = 0;
    for (let i = 0; i < cap.time.length; i += 1) e += cap.time[i] * cap.time[i];
    const db = 20 * Math.log10(Math.sqrt(e / cap.time.length) + 1e-9);
    state.levelDb = Math.round(db * 10) / 10;
    const lvl = clamp((db + 54) / 54, 0, 1);
    state.peakLevel = Math.max(lvl, state.peakLevel - 0.006);
    el.level.style.width = `${(lvl * 100).toFixed(1)}%`;
    el.levelPeak.style.left = `${(state.peakLevel * 100).toFixed(1)}%`;
  }

  function updateBeats() {
    const r = state.result, cap = state.cap;
    if (cap && r && r.ready && state.streamOffset !== null && (!state.np || state.np.playing) && !(state.engine && state.engine.inGap)) {
      // Beat k after the last tracked beat lands at lastBeatTime + k·T (engine clock).
      const T = r.beatPeriod, B = r.beatsPerBar || 4;
      const latency = (cap.ctx.outputLatency || 0) + (cap.ctx.baseLatency || 0);
      const t = cap.ctx.currentTime - latency - (r.lastBeatTime + state.streamOffset);
      const k = Math.floor(t / T);
      const pos = (((r.lastBeatPos || 0) + k) % B + B) % B;
      const lit = (t / T) - k < 0.28;
      [...el.pulse.children].forEach((d, i) => d.classList.toggle("on", lit && i === pos));
      if (k !== state.lastBeat) { state.lastBeat = k; bump(el.bpm.parentElement); if (pos === 0) bump(el.brand); }
    } else {
      [...el.pulse.children].forEach((d) => d.classList.remove("on"));
    }
    const pos = currentPosition();
    if (r && r.ready && pos !== null) {
      el.beatNow.textContent = String(Math.floor((pos * r.bpm) / 60) + 1);
      el.beatTotal.textContent = Number.isFinite(state.np.duration) ? `/ ${Math.round((state.np.duration * r.bpm) / 60)}` : "/ —";
    }
  }

  function updateProgress() {
    const np = state.np, pos = currentPosition();
    if (!np || pos === null) return;
    el.pos.textContent = fmtTime(pos);
    el.dur.textContent = fmtTime(np.duration);
    el.progress.style.width = Number.isFinite(np.duration) && np.duration > 0 ? `${(pos / np.duration) * 100}%` : "0%";
  }

  function frame(now) {
    if (!state.colors) readColors();
    drawSpectrum();
    updateMotion();
    drawScope();
    updateBeats();
    updateProgress();
    if (state.engine) renderChord(state.engine.chordInfo());
    requestAnimationFrame(frame);
  }

  async function init() {
    readColors();
    const stored = await chrome.storage.local.get("sipra-session").catch(() => ({}));
    state.session = Array.isArray(stored["sipra-session"]) ? stored["sipra-session"] : [];
    renderSession();
    renderResult();
    renderChord(null);
    const tab = await findSpotifyTab().catch(() => null);
    if (tab) {
      askNowPlaying(tab);
      const { pendingStream } = await chrome.storage.session.get("pendingStream").catch(() => ({}));
      if (pendingStream && pendingStream.id && pendingStream.tabId === tab.id) connect({ auto: true });
    } else {
      el.openSpotify.hidden = false;
      setHint("Open <b>Spotify Web Player</b>, play a song, then tap Connect.");
    }
    requestAnimationFrame(frame);
  }
  window.addEventListener("pagehide", finishTrack);
  init();
})();
