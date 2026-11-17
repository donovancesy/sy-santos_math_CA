// Sipra: runs inside the Spotify Web Player page itself (MAIN world).
// Reads the same "now playing" info the browser uses for media keys and the
// lock screen (Media Session), plus exact time from Spotify's audio element.
// Read-only: it never changes playback.
(() => {
  if (window.__sipraMain) return;
  window.__sipraMain = true;

  const players = new Set();
  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    players.add(this);
    return origPlay.apply(this, args);
  };

  function activePlayer() {
    let best = null;
    for (const el of players) {
      if (!el.isConnected && el.paused && el.currentTime === 0) continue;
      if (!best || (!el.paused && best.paused)) best = el;
    }
    document.querySelectorAll("video, audio").forEach((el) => {
      if (!best || (!el.paused && best.paused)) best = el;
    });
    return best;
  }

  function snapshot() {
    const ms = navigator.mediaSession;
    const md = ms && ms.metadata;
    let art = "";
    if (md && md.artwork && md.artwork.length) {
      const sorted = [...md.artwork].sort((a, b) => parseInt(b.sizes || "0", 10) - parseInt(a.sizes || "0", 10));
      art = sorted[0].src || "";
    }
    const el = activePlayer();
    const finite = (v) => (Number.isFinite(v) ? v : null);
    return {
      title: md ? md.title || "" : "",
      artist: md ? md.artist || "" : "",
      album: md ? md.album || "" : "",
      art,
      sessionState: ms ? ms.playbackState || "" : "",
      mediaTime: el ? finite(el.currentTime) : null,
      mediaDuration: el ? finite(el.duration) : null,
      mediaPaused: el ? el.paused : null
    };
  }

  setInterval(() => {
    window.postMessage({ __sipra: "np", data: snapshot() }, "*"); // same window only
  }, 500);
})();
