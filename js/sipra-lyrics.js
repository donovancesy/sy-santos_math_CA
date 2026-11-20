/* Sipra lyrics: synced lyrics that follow the song, highlighting the current
 * line and (estimated) word. Shared by the website and the extension.
 *
 *   SipraLyrics.mount(container, { getTrack })
 *   getTrack() → { title, artist, album, duration, position, playing } or null
 *
 * Lyrics come from LRCLIB (lrclib.net), a free, open lyrics database. They are
 * off until the listener switches them on; then Sipra sends LRCLIB the song's
 * name, artist and length (nothing else). LRCLIB times each line; the word
 * inside the line is estimated from where it sits in the line.
 */
(function (global) {
  "use strict";
  const API = "https://lrclib.net/api";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const cache = new Map();

  function parseLRC(text) {
    const lines = [];
    for (const raw of String(text || "").split(/\r?\n/)) {
      const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
      if (!stamps.length) continue;
      const body = raw.replace(/\[[^\]]*\]/g, "").trim();
      // Enhanced LRC: "<00:12.34> word <00:12.80> word" gives each word its own time.
      const wordTimes = [];
      const tagged = [...body.matchAll(/<(\d+):(\d+(?:\.\d+)?)>\s*([^<]*)/g)];
      if (tagged.length) {
        for (const w of tagged) {
          const t = Number(w[1]) * 60 + Number(w[2]);
          for (const word of w[3].trim().split(/\s+/).filter(Boolean)) wordTimes.push(t);
        }
      }
      const words = body.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
      for (const m of stamps) lines.push({ t: Number(m[1]) * 60 + Number(m[2]), text: words, words: wordTimes.length ? wordTimes : null });
    }
    return lines.sort((a, b) => a.t - b.t);
  }

  // "Song - Remastered 2011", "Song (feat. X)" → "Song", for a looser search.
  const simplify = (s) => String(s || "").replace(/\s*[-–]\s*(remaster|live|mono|stereo|single|radio|edit|version|\d{4}).*$/i, "").replace(/\s*[([].*?(feat|with|remaster|live|version|edit).*?[)\]]/gi, "").trim();

  async function lookup(track) {
    const key = `${track.title}|${track.artist}`.toLowerCase();
    if (cache.has(key)) return cache.get(key);
    const pick = (list) => {
      if (!Array.isArray(list) || !list.length) return null;
      const scored = list.map((x) => ({ x, d: track.duration ? Math.abs((x.duration || 0) - track.duration) : 0 }))
        .filter((c) => !track.duration || c.d < 8).sort((a, b) => (Boolean(b.x.syncedLyrics) - Boolean(a.x.syncedLyrics)) || a.d - b.d);
      return scored.length ? scored[0].x : null;
    };
    let hit = null;
    try {
      if (track.duration) {
        const p = new URLSearchParams({ track_name: track.title, artist_name: track.artist || "", album_name: track.album || "", duration: String(Math.round(track.duration)) });
        const res = await fetch(`${API}/get?${p}`);
        if (res.ok) hit = await res.json();
      }
      if (!hit || (!hit.syncedLyrics && !hit.instrumental)) {
        const p = new URLSearchParams({ track_name: simplify(track.title), artist_name: (track.artist || "").split(/,|&| feat\.? /i)[0].trim() });
        const res = await fetch(`${API}/search?${p}`);
        if (res.ok) hit = pick(await res.json()) || hit;
      }
      if (!hit) {
        const res = await fetch(`${API}/search?${new URLSearchParams({ q: `${simplify(track.title)} ${track.artist || ""}` })}`);
        if (res.ok) hit = pick(await res.json());
      }
    } catch (e) {
      return { error: true };
    }
    const out = !hit ? { none: true }
      : hit.instrumental ? { instrumental: true }
      : hit.syncedLyrics ? { lines: parseLRC(hit.syncedLyrics) }
      : hit.plainLyrics ? { plain: hit.plainLyrics } : { none: true };
    cache.set(key, out);
    return out;
  }

  function mount(root, options = {}) {
    let on = false;
    try { on = localStorage.getItem("sipra-lyrics") === "on"; } catch (e) {}
    root.classList.add("ly");
    root.innerHTML = `
      <div class="ly-head">
        <span class="ly-title">Lyrics</span>
        <span class="ly-sync" hidden title="Lyrics early or late? Nudge them (saved for this song)">
          <button type="button" data-ly="-1" aria-label="Lyrics half a second earlier">−</button>
          <span class="ly-offset">0.0 s</span>
          <button type="button" data-ly="1" aria-label="Lyrics half a second later">+</button>
        </span>
        <button type="button" class="ly-toggle" role="switch" aria-checked="false">Off</button>
      </div>
      <div class="ly-body" aria-live="off"></div>
      <p class="ly-note"></p>`;
    const body = root.querySelector(".ly-body"), note = root.querySelector(".ly-note"), toggle = root.querySelector(".ly-toggle");
    let trackKey = "", data = null, lineEls = [], activeLine = -1, activeWord = -1, stick = true, loading = false;
    // Timing nudge, in seconds, saved per song: + shows the words later, − earlier.
    const syncEl = root.querySelector(".ly-sync"), offsetEl = root.querySelector(".ly-offset");
    const OFFSETS = "sipra-lyrics-offset";
    const readOffsets = () => { try { return JSON.parse(localStorage.getItem(OFFSETS) || "{}"); } catch (e) { return {}; } };
    let offset = 0;
    function showOffset() { offsetEl.textContent = `${offset > 0 ? "+" : ""}${offset.toFixed(1)} s`; }
    root.querySelectorAll("[data-ly]").forEach((b) => b.addEventListener("click", () => {
      offset = Math.round((offset + Number(b.dataset.ly) * 0.5) * 10) / 10;
      offset = Math.max(-10, Math.min(10, offset));
      const all = readOffsets();
      if (offset) all[trackKey] = offset; else delete all[trackKey];
      try { localStorage.setItem(OFFSETS, JSON.stringify(all)); } catch (e) {}
      showOffset(); activeLine = -2;
    }));

    // Only the listener's own scrolling (wheel, touch, scrollbar drag) pauses
    // follow-along for a few seconds; Sipra's own scrolling doesn't.
    const pauseFollow = () => { stick = false; clearTimeout(body._t); body._t = setTimeout(() => { stick = true; centerLine(activeLine); }, 4000); };
    ["wheel", "touchstart", "pointerdown", "keydown"].forEach((ev) => body.addEventListener(ev, pauseFollow, { passive: true }));
    // Scroll only inside the lyrics box, keeping the current line in its middle
    // (measured against the box itself, never the page).
    function centerLine(i) {
      const line = lineEls[i];
      if (!line || !stick) return;
      const box = body.getBoundingClientRect(), r = line.getBoundingClientRect();
      const target = body.scrollTop + (r.top - box.top) - (body.clientHeight - r.height) / 2;
      // Glide when you're watching; jump when the tab is in the background.
      body.scrollTo({ top: Math.max(0, target), behavior: document.hidden ? "auto" : "smooth" });
    }

    function setNote(text) { note.textContent = text; }
    function renderToggle() {
      toggle.setAttribute("aria-checked", String(on));
      toggle.textContent = on ? "On" : "Off";
      root.classList.toggle("ly-off", !on);
    }
    toggle.addEventListener("click", () => {
      on = !on;
      try { localStorage.setItem("sipra-lyrics", on ? "on" : "off"); } catch (e) {}
      trackKey = ""; data = null;
      renderToggle(); tick();
    });

    function renderLines() {
      activeLine = -1; activeWord = -1;
      if (!data) { body.innerHTML = ""; lineEls = []; return; }
      if (data.lines) {
        body.innerHTML = data.lines.map((l, i) => `<p class="ly-line" data-i="${i}">${l.text ? l.text.split(/\s+/).map((w) => `<span>${esc(w)}</span>`).join(" ") : "♪"}</p>`).join("");
        lineEls = [...body.querySelectorAll(".ly-line")];
      } else if (data.plain) {
        body.innerHTML = data.plain.split(/\r?\n/).map((l) => `<p class="ly-line ly-plain">${esc(l) || "&nbsp;"}</p>`).join("");
        lineEls = [];
      } else { body.innerHTML = ""; lineEls = []; }
    }

    async function load(track) {
      loading = true;
      data = null; renderLines();
      setNote("Looking up lyrics…");
      const got = await lookup(track);
      if (`${track.title}|${track.artist}` !== trackKey) return; // song changed meanwhile
      loading = false;
      data = got;
      renderLines();
      if (got.error) setNote("Couldn't reach the lyrics service. Check your connection.");
      else if (got.instrumental) setNote("Instrumental: no lyrics.");
      else if (got.none) setNote("No lyrics found for this song.");
      else if (got.plain) setNote("These lyrics aren't timed, so they can't follow the song. Lyrics: LRCLIB.");
      else setNote(got.lines.some((l) => l.words)
        ? "Lyrics: LRCLIB, timed word by word · early or late? use − / +"
        : "Lyrics: LRCLIB · lines are timed, the highlighted word is estimated · early or late? use − / +");
      syncEl.hidden = !got.lines;
    }

    function tick() {
      if (!on) { body.innerHTML = ""; lineEls = []; setNote("Turn on to follow the words as the song plays. Sipra looks them up on LRCLIB by song name and artist."); return; }
      const t = options.getTrack ? options.getTrack() : null;
      if (!t || !t.title) {
        trackKey = ""; data = null; renderLines();
        setNote(options.noTrackHint || "Lyrics need the song's name: play something on Spotify.");
        return;
      }
      const key = `${t.title}|${t.artist}`;
      if (key !== trackKey) {
        trackKey = key; syncEl.hidden = true;
        offset = Number(readOffsets()[key]) || 0; showOffset();
        load(t); return;
      }
      if (loading || !data || !data.lines || !lineEls.length || !Number.isFinite(t.position)) return;
      // A + nudge means the lyrics run late, so they're shown as of a moment earlier.
      const pos = t.position - offset, L = data.lines;
      let i = -1;
      for (let k = 0; k < L.length; k += 1) { if (L[k].t <= pos + 0.15) i = k; else break; }
      if (i !== activeLine) {
        if (lineEls[activeLine]) lineEls[activeLine].classList.remove("now");
        if (lineEls[activeLine]) [...lineEls[activeLine].children].forEach((w) => w.classList.remove("now", "past"));
        activeLine = i; activeWord = -1;
        if (lineEls[i]) {
          lineEls[i].classList.add("now");
          // After the line restyles (it grows a little), center it.
          setTimeout(() => centerLine(i), 0);
        }
        lineEls.forEach((el, k) => el.classList.toggle("past", k < i));
      }
      // Word: spread the line's time over its words by length.
      if (i >= 0 && lineEls[i]) {
        const words = [...lineEls[i].children];
        if (words.length && L[i].words && L[i].words.length === words.length) {
          // Word-by-word times from the lyrics themselves.
          let w = 0;
          for (let k = 0; k < words.length; k += 1) if (L[i].words[k] <= pos + 0.05) w = k;
          if (w !== activeWord) {
            words.forEach((el, k) => { el.classList.toggle("now", k === w); el.classList.toggle("past", k < w); });
            activeWord = w;
          }
        } else if (words.length) {
          const start = L[i].t, end = i + 1 < L.length ? Math.min(L[i + 1].t, start + 8) : start + 5;
          const frac = Math.max(0, Math.min(0.999, (pos - start) / Math.max(0.5, (end - start) * 0.92)));
          const lens = words.map((w) => w.textContent.length + 1), total = lens.reduce((a, b) => a + b, 0);
          let acc = 0, w = 0;
          for (; w < words.length; w += 1) { acc += lens[w]; if (acc / total > frac) break; }
          w = Math.min(w, words.length - 1);
          if (w !== activeWord) {
            words.forEach((el, k) => { el.classList.toggle("now", k === w); el.classList.toggle("past", k < w); });
            activeWord = w;
          }
        }
      }
    }
    renderToggle();
    // First look after the host page has finished setting up (its getTrack may
    // read state that's declared later in the same script).
    setTimeout(tick, 0);
    const timer = setInterval(tick, 100);
    return { refresh: tick, stop() { clearInterval(timer); } };
  }

  global.SipraLyrics = { mount, parseLRC };
})(typeof window !== "undefined" ? window : globalThis);
