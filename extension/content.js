// Sipra: bridge on open.spotify.com. Combines three sources, most reliable first:
//   1. Media Session metadata (title / artist / album / artwork) from content-main.js
//   2. Spotify's audio element (exact position, duration, paused)
//   3. The player's on-screen text (fallback if 1–2 are missing)
// and sends one clean "now playing" record to the Sipra panel twice a second.
(() => {
  const q = (sel, root = document) => root.querySelector(sel);
  const text = (el) => (el && el.textContent ? el.textContent.trim() : "");
  let main = null;
  let mainAt = 0;

  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data || event.data.__sipra !== "np") return;
    main = event.data.data;
    mainAt = Date.now();
  });

  function parseTime(value) {
    if (!value) return null;
    const parts = value.split(":").map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return null;
    return parts.reduce((total, n) => total * 60 + n, 0);
  }

  function fromPage() {
    const widget = q('[data-testid="now-playing-widget"]') || document;
    let title = text(q('[data-testid="context-item-info-title"]', widget)) || text(q('[data-testid="context-item-link"]', widget));
    let artist = text(q('[data-testid="context-item-info-artist"]', widget)) || text(q('[data-testid="context-item-info-subtitles"]', widget));
    if (!title && document.title.includes(" • ")) {
      const [t, a] = document.title.split(" • ");
      title = t.trim();
      artist = (a || "").replace(/\s*[|-]\s*Spotify.*$/i, "").trim();
    }
    const img = q('img[data-testid="cover-art-image"]', widget) || q('[data-testid="now-playing-widget"] img');
    const playBtn = q('[data-testid="control-button-playpause"]');
    const label = playBtn ? (playBtn.getAttribute("aria-label") || "").toLowerCase() : "";
    const range = q('[data-testid="playback-progressbar"] input[type="range"]');
    let position = parseTime(text(q('[data-testid="playback-position"]')));
    let duration = parseTime(text(q('[data-testid="playback-duration"]')));
    if (range && Number(range.max) > 0) {
      const max = Number(range.max), val = Number(range.value);
      const scale = max > 10000 ? 1000 : 1; // the slider is in ms on current builds
      position = val / scale;
      duration = max / scale;
    }
    return {
      title, artist, art: img ? img.currentSrc || img.src : "",
      position, duration,
      playing: label ? /pause|pausar|pausa|pausieren|一時停止|暂停|일시정지/.test(label) : null
    };
  }

  function read() {
    const page = fromPage();
    const fresh = main && Date.now() - mainAt < 2000 ? main : null;
    const title = (fresh && fresh.title) || page.title;
    const artist = (fresh && fresh.artist) || page.artist;
    const art = (fresh && fresh.art) || page.art;

    // Time: trust the audio element when its length agrees with the page's (±2 s);
    // otherwise use the page's progress bar.
    let position = page.position, duration = page.duration, source = "page";
    if (fresh && fresh.mediaDuration && fresh.mediaTime !== null) {
      if (!page.duration || Math.abs(fresh.mediaDuration - page.duration) < 2) {
        position = fresh.mediaTime;
        duration = fresh.mediaDuration;
        source = "media";
      }
    }
    let playing = page.playing;
    if (fresh) {
      if (fresh.sessionState === "playing") playing = true;
      else if (fresh.sessionState === "paused") playing = false;
      else if (fresh.mediaPaused !== null && playing === null) playing = !fresh.mediaPaused;
    }
    if (playing === null) playing = document.title.includes(" • ");

    return {
      type: "sipra-now-playing",
      title, artist, album: fresh ? fresh.album : "", art,
      position, duration, playing,
      infoSource: fresh && fresh.title ? "media-session" : "page",
      timeSource: source,
      at: Date.now()
    };
  }

  let timer = null;
  function send() {
    try {
      chrome.runtime.sendMessage(read()).catch(() => {});
    } catch (e) {
      clearInterval(timer); // extension reloaded: this old copy stops quietly
    }
  }
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg && msg.type === "sipra-get-now-playing") reply(read());
  });
  timer = setInterval(send, 500);
  send();
})();
