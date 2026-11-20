# Sipra: Chrome / Opera extension

Sipra sits next to **Spotify Web Player** and shows the math of the song that's playing, live:

- **Chord:** the chord right now (e.g. Am), its role in the key (vi), its notes and frequency ratio, the last few chords, and the chord drawn on a **piano** or **guitar** (open chords and barre shapes); tap a past chord in the chart or the recent row to see it drawn. It always matches the chart: both come from the same transcription
- **Chart:** the whole song's chords bar by bar (`| Am | F | C | G |`), the loop that repeats (vi – IV – I – V), names or Roman numerals, and a **Copy** button for the text chart. If you start listening partway through, it says where it joined; play the song again from the top and the chart starts over
- **Lyrics:** switch on to follow the words as the song plays, with the current line and word highlighted. They come from [LRCLIB](https://lrclib.net), which Sipra sends only the song's name, artist and length. Early or late? Nudge them with **− / +**
- **Tempo:** BPM and beat length `T = 60 / BPM`, plus whether it's steady or speeding up / slowing down. If it's double or half what you hear (jazz ballads often fool it), tap **½×** or **2×**, or tap **Tap** along with the beat (4+ taps) to set it yourself; Sipra remembers that for the song, and **Auto** goes back
- **Key:** home note and mode, with `f = 440 · 2^(n/12)`; shows a key change mid-song, and the song's tuning if it isn't A4 = 440 Hz
- **Meter:** 3/4 or 4/4, with dots that light on each beat
- **Beats:** beat number through the song, `N = D · BPM / 60`
- **Spectrum and waveform**, and a **level meter**
- **Session:** every song you played, with mean, median, mode and standard deviation of tempo
- **Math map:** the button at the top (and the card at the bottom) opens the Sipra website's Math map: the concepts behind every number, with labs (add a song, keyboard, tap tempo, polyrhythms, any time signature, famous grooves)

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
- **Chords:** recent chroma compared with chord templates (major, minor, dim, aug, sus2, sus4, 7, maj7, m7), with drum hits filtered out. The bass note weighs in, so a loud melody doesn't pull the chord off.
- **Chart:** bars a few seconds old are frozen, so the past never changes. The chroma is averaged over each tracked beat, every chord is scored on every beat, and a Viterbi search finds the most likely chord path through the song (changing chord costs a little, more so away from beat 1). Trying each possible downbeat, the one where the chords change on bar lines wins, which also fixes the beat dots and can tell 3/4 from 4/4. The loop is the shortest run of bars (1–8) that repeats.
- **Tuning:** spectral peaks' average offset from the nearest semitone (a circular mean), so a song tuned to A4 = 446 Hz still lands on the right notes.
- **Key change:** the last 30 s get their own key estimate; the chords then settle close calls (G vs D major: is there a C or a C♯?).

- **Listening:** pauses and the silence between songs are left out of the analysis, so they don't blur tempo or key, and the beat dots re-sync right after. Quiet input is boosted for analysis (up to ×40). When there's no song info, a gap followed by a different tempo or key counts as a new song.

These are estimates, like a DJ app's. Very busy mixes, songs without a clear beat, or unusual chords can confuse them.

## Limits

- The extension only works with Spotify **in the browser**. For the Spotify **desktop app**, use the Sipra website's Live section (share the Spotify window or your screen with audio).
