# Sipra: the math behind music

Sipra listens to the song playing on Spotify (desktop app or web player) and shows its math live: tempo, key, chords, a bar-by-bar chord chart, meter, spectrum and statistics. Every number has a **Learn** button with a full lesson worked out with your song.

## Two pages

- **`index.html`: Live.** Everything is about the song that's playing: listen to Spotify, the current chord, the chord chart, tempo, key, meter, spectrum, then **The math in this song** (periodicity, equal temperament, ratios in chords, bars & remainders, Fourier analysis, statistics), each worked out with your song's numbers. **Stats** keeps the songs you listened to (in this browser).
- **`math.html`: Math map.** The concepts behind every number (periodicity, geometric sequences, ratios, Fourier, LCM & modular arithmetic, logarithms, statistics, optimization), each linked to a lesson and a lab: the **Signal lab** (add an MP3/WAV/M4A or use the demo, tap a tempo, FFT and beat views), the **Pitch lab** (keyboard and the `f = 440 · 2^(n/12)` graph) and the **Rhythm lab** (polyrhythms and LCM). Lessons there use the last song you listened to.

Both pages share `js/app.js`; each runs only the parts whose elements it has (`<body data-page="live">` / `data-page="math"`).

## Chord chart

While a song plays, Sipra writes out its chords **bar by bar** (`| Am | F | C | G |`), finds the **loop** that repeats (vi – IV – I – V), and notes whether the tempo is steady, the song's tuning (A4 = 440 Hz or not), any key change, and how many chord changes per minute. Tap **I–V** to switch to Roman numerals, or **Copy** to paste the chart as text. Bars with two chords show both (`Dm7 G`).

Once a bar is a few seconds old it's **frozen**: written into the chart for good, so earlier chords can't all flip to one chord later. Only the newest bars are still being worked out.

## Live listening (Spotify)

The **Live** section listens to music that's playing on your computer and works out its tempo, key, meter and loudest note as it goes.

- **Listen to Spotify:** pick your Spotify tab (or your whole screen) in the share window and switch on **Share tab audio** / **Share system audio**.
  - Spotify in the browser: share the Spotify **tab**.
  - Spotify desktop app on Windows or ChromeOS: share **Entire screen** with system audio on.
  - Spotify desktop app on a Mac (Chrome 141 or newer, recent macOS): share the **Spotify window** with audio on. On older Macs, use **Mic**.
- **Mic:** listens through your microphone, so it works with any speaker, including your phone.

### Song name, cover and exact time (optional)

Tap **Link Spotify account** in the Live section and follow the steps there. Sipra then reads what's playing from *any* Spotify app (desktop, phone, web) and resets its analysis exactly when the song changes. This needs:
- a free Spotify developer app (developer.spotify.com/dashboard) with this site's address as its Redirect URI,
- your Spotify account added under User Management,
- Spotify Premium (Spotify's rule for personal developer apps; up to 5 people).

Spotify only accepts `https://` addresses, or `http://127.0.0.1` for testing on your computer (not `localhost`).

Live listening needs the site to be opened from its own address, such as GitHub Pages or `http://localhost`. It can't hear audio inside a preview frame like a claude.ai link.

## Run it on GitHub Pages

1. Push these files to a GitHub repository.
2. Go to **Settings → Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`, then click **Save**.
3. Open the address GitHub shows, for example `https://<your-name>.github.io/<repo>/`.

## Run it on your computer

On Windows, double-click **`Start Sipra.cmd`** (needs [Node.js](https://nodejs.org)). It opens Sipra at http://127.0.0.1:8080; keep the black window open while you use it.

Or in this folder run `node serve.js` (or `python3 -m http.server 8000`) and open the address it prints. Opening `index.html` straight from the folder won't work for Live listening: browsers block audio sharing on `file://` pages.

All audio processing happens in your browser. Nothing is uploaded.

## Chrome / Opera extension

The `extension/` folder is the Sipra browser extension. It sits beside Spotify Web Player and shows the same live math. Its **Math map** button opens `math.html` on GitHub Pages, with the current song's tempo and key passed in the link's `#` part (which never leaves your browser). To install it, open `chrome://extensions` or `opera://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `extension` folder. Full steps are in [extension/README.md](extension/README.md).
