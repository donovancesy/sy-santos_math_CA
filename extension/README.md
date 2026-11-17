# Sipra: Chrome / Opera extension

Sipra sits next to **Spotify Web Player** and shows the math of the song that's playing, live:

- **Chord:** the chord right now (e.g. Am), its role in the key (vi), its notes and frequency ratio, plus the last few chords
- **Tempo:** BPM and beat length `T = 60 / BPM`
- **Key:** home note and mode, with `f = 440 · 2^(n/12)`
- **Meter:** 3/4 or 4/4, with dots that light on each beat
- **Beats:** beat number through the song, `N = D · BPM / 60`
- **Spectrum and waveform**, the **loudest note** with its tuning in cents, and a **level meter**
- **Session:** every song you played, with mean, median, mode and standard deviation of tempo

Every card has a **Learn** button that opens a full lesson: the idea, the formulas, the math worked out with *your* song, a calculator, why it matters, and a practice question.

All audio is analysed on your computer. Nothing is uploaded, and no Spotify login is needed.

## Install

1. Unzip `sipra-extension.zip` (right-click → **Extract All**). You'll get a `sipra-extension` folder with `manifest.json` directly inside.
2. Open `chrome://extensions` (Chrome), `opera://extensions` (Opera / Opera GX) or `edge://extensions` (Edge).
3. Turn on **Developer mode**.
4. Remove the old "The Math Behind Music" extension if you have it.
5. Click **Load unpacked** and pick the `sipra-extension` folder.
6. Pin Sipra to your toolbar.

## Use

1. Open **https://open.spotify.com** and play a song. If the tab was already open before you installed Sipra, reload it once.
2. On the Spotify tab, click the **Sipra** icon (or press **Alt+Shift+S**).
   - Chrome / Edge / Brave: opens in the side panel.
   - Opera / Opera GX: opens as a small window beside the browser.
3. It connects automatically. If it doesn't, click **Connect**. If the browser asks, pick the Spotify tab and switch on **Share tab audio**.
4. Tempo appears after about 5 seconds and meter shortly after; tricky songs (odd meters, swing) can take 10–15 seconds to lock in. Chords update about 4 times a second.

## How it works

- **Song info** comes from the browser's own "now playing" data (the same info your media keys and lock screen use) and the exact time from Spotify's audio player. The on-screen text is only a backup.
- **Tempo:** onset strength across 40 frequency bands every 11 ms, autocorrelation with a check for half/double speed (40–240 BPM), then a dynamic-programming beat tracker (the method used by librosa). The BPM shown is the slope of the tracked beats, so it follows tempo drift.
- **Meter:** 2/4, 3/4, 4/4, 5/4, 7/4, plus compound 6/8, 9/8 and 12/8 (beats split in three) and swing feel. It looks at where chords change, where the kick and bass land, whether there's a snare backbeat, and how hits are spread inside each beat. 2/4 and 4/4 can sound identical, so when the evidence fits both, Sipra shows the other reading too.
- **Key:** the whole song's chroma (strength of each of the 12 notes) correlated with key profiles.
- **Chords:** recent chroma compared with chord templates (major, minor, dim, sus4, 7, maj7, m7), with drum hits filtered out.

These are estimates, like a DJ app's. Very busy mixes, songs without a clear beat, or unusual chords can confuse them.

## Limits

- The extension only works with Spotify **in the browser**. For the Spotify **desktop app**, use the Sipra website's Live section (share the Spotify window or your screen with audio).
