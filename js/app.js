// Theme-aware canvas colors: read "r, g, b" from CSS custom properties.
const __tcCache = {};
function tc(key, alpha) {
  let v = __tcCache[key];
  if (!v) {
    v = getComputedStyle(document.documentElement).getPropertyValue("--c-" + key).trim() || "0, 0, 0";
    __tcCache[key] = v;
  }
  return `rgba(${v}, ${alpha})`;
}
(function initThemeToggle() {
  const root = document.documentElement;
  const meta = () => document.querySelector('meta[name="theme-color"]');
  function apply(theme) {
    root.setAttribute("data-theme", theme);
    for (const k in __tcCache) delete __tcCache[k];
    const m = meta(); if (m) m.setAttribute("content", theme === "dark" ? "#121212" : "#F4F4F4");
    document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
      b.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
      b.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    });
    window.dispatchEvent(new Event("resize"));
  }
  document.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest("[data-theme-toggle]");
    if (!btn) return;
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    try { localStorage.setItem("sipra-theme", next); } catch (err) {}
    apply(next);
  });
  apply(root.getAttribute("data-theme") || "light");
})();

/* Sipra — application behavior. Front-end markup: index.html. Styles: css/styles.css. */

    (() => {
      "use strict";

      const $ = (selector, root = document) => root.querySelector(selector);
      const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
      const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
      const TAU = Math.PI * 2;
      const FFT_BARS = 80;
      const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
      const SAMPLE_TRACKS = [
        { id: "sample-1", name: "Velvet Static", duration: 204.0, bpm: 92, rootMidi: 62, kind: "sample", key: { tonicPc: 2, mode: "minor", confidence: 1 }, timeSignature: "4/4" },
        { id: "sample-2", name: "Glasshouse", duration: 242.0, bpm: 128, rootMidi: 57, kind: "sample", key: { tonicPc: 9, mode: "minor", confidence: 1 }, timeSignature: "4/4" },
        { id: "sample-3", name: "Low Orbit", duration: 191.0, bpm: 128, rootMidi: 54, kind: "sample", key: { tonicPc: 6, mode: "minor", confidence: 1 }, timeSignature: "4/4" },
        { id: "sample-4", name: "Afterimage", duration: 178.0, bpm: 100, rootMidi: 60, kind: "sample", key: { tonicPc: 0, mode: "major", confidence: 1 }, timeSignature: "3/4" },
        { id: "sample-5", name: "Metric Bloom", duration: 257.0, bpm: 75, rootMidi: 52, kind: "sample", key: { tonicPc: 4, mode: "minor", confidence: 1 }, timeSignature: "4/4" }
      ];
      const MAJOR_PROFILE = [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400];
      const MINOR_PROFILE = [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330];

      const state = {
        ctx: null,
        analyser: null,
        masterGain: null,
        freqData: null,
        buffer: null,
        source: null,
        demoBuffer: null,
        isPlaying: false,
        startedAt: 0,
        startOffset: 0,
        offset: 0,
        loop: false,
        volume: 0.8,
        bpm: 96,
        rootMidi: 69,
        track: null,
        tracks: SAMPLE_TRACKS.map((track) => ({ ...track })),
        view: "spectrum",
        peaks: null,
        staticSpectrum: null,
        staticPeak: null,
        spectrumPeaks: new Float32Array(FFT_BARS),
        seekPreview: null,
        seeking: false,
        waveHoverX: null,
        pitchN: 0,
        pitchHoverN: null,
        pitchTone: null,
        loading: false,
        analyzing: false,
        toastTimer: null,
        tapTimes: [],
        tapResetTimer: null,
        clearArmed: false,
        clearTimer: null,
        lastPeakText: "",
        lastPeakFreq: 0,
        frameAt: 0,
        uiAt: 0,
        drawerOpen: false,
        drawerReturnFocus: null,
        userInteracted: false,
        demoInitialized: false,
        ids: 0
      };

      const poly = {
        x: 3,
        y: 4,
        playing: false,
        anchor: 0,
        cycleDur: 2.5,
        nextCycle: 0,
        timer: null,
        lastStep: -1
      };

      const el = {};
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

      function uid() {
        state.ids += 1;
        return `track-${Date.now().toString(36)}-${state.ids}`;
      }

      function midiToFreq(midi) {
        return 440 * Math.pow(2, (midi - 69) / 12);
      }

      function freqForN(n) {
        return 440 * Math.pow(2, n / 12);
      }

      function noteFromMidi(midi) {
        const rounded = Math.round(midi);
        const pitchClass = ((rounded % 12) + 12) % 12;
        const octave = Math.floor(rounded / 12) - 1;
        return `${NOTE_NAMES[pitchClass]}${octave}`;
      }

      function notePartsFromMidi(midi) {
        const rounded = Math.round(midi);
        const pitchClass = ((rounded % 12) + 12) % 12;
        return { name: NOTE_NAMES[pitchClass], octave: Math.floor(rounded / 12) - 1, midi: rounded };
      }

      function nearestNote(freq) {
        if (!Number.isFinite(freq) || freq <= 0) return "—";
        return noteFromMidi(Math.round(69 + 12 * Math.log2(freq / 440)));
      }

      function noteToMidiNumber(n) {
        return 69 + Math.round(n);
      }

      function formatNumber(value, decimals = 0) {
        if (!Number.isFinite(value)) return "—";
        const fixed = value.toFixed(decimals);
        return decimals > 0 ? fixed.replace(/\.0+$/, "") : fixed;
      }

      function formatBpm(value) {
        return Number.isFinite(value) ? String(Math.round(value * 10) / 10) : "—";
      }

      function formatTime(seconds, tenths = false) {
        if (!Number.isFinite(seconds) || seconds < 0) return "—";
        if (tenths) {
          const rounded = Math.round(seconds * 10) / 10;
          const minutes = Math.floor(rounded / 60);
          const remainder = rounded - minutes * 60;
          return `${minutes}:${remainder.toFixed(1).padStart(4, "0")}`;
        }
        const whole = Math.floor(seconds + 0.00001);
        const minutes = Math.floor(whole / 60);
        const remainder = whole % 60;
        return `${minutes}:${String(remainder).padStart(2, "0")}`;
      }

      function escapeHTML(value) {
        return String(value)
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;");
      }

      function gcd(a, b) {
        let x = Math.abs(a);
        let y = Math.abs(b);
        while (y) {
          const next = x % y;
          x = y;
          y = next;
        }
        return x || 1;
      }

      function lcm(a, b) {
        return Math.abs(a * b) / gcd(a, b);
      }

      function pitchClass(midi) {
        return ((Math.round(midi) % 12) + 12) % 12;
      }

      function keyLabel(key) {
        if (!key || !Number.isFinite(key.tonicPc)) return "—";
        return `${NOTE_NAMES[pitchClass(key.tonicPc)]} ${key.mode === "minor" ? "minor" : "major"}`;
      }

      function keyRootMidi(key) {
        if (!key || !Number.isFinite(key.tonicPc)) return 69;
        return 60 + pitchClass(key.tonicPc);
      }

      function makeKey(tonicPc, mode = "major", confidence = 0) {
        return {
          tonicPc: pitchClass(tonicPc),
          mode: mode === "minor" ? "minor" : "major",
          confidence: clamp(Number(confidence) || 0, 0, 1)
        };
      }

      function showToast(message, type = "info") {
        if (!el.toast) return;
        clearTimeout(state.toastTimer);
        el.toast.textContent = message;
        el.toast.classList.toggle("error", type === "error");
        el.toast.hidden = false;
        state.toastTimer = window.setTimeout(() => {
          el.toast.hidden = true;
        }, type === "error" ? 4800 : 3000);
      }

      function setRangeFill(input) {
        if (!input) return;
        const min = Number(input.min) || 0;
        const max = Number(input.max) || 100;
        const value = Number(input.value) || 0;
        const percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
        input.style.setProperty("--fill", `${clamp(percent, 0, 100)}%`);
      }

      function paintAllRanges() {
        $$('input[type="range"]').forEach(setRangeFill);
      }

      function gainForVolume(value) {
        return Math.pow(clamp(value, 0, 1), 1.55) * 0.9;
      }

      function setStatusLive(isLive) {
        if (!el.vizStatus) return;
        el.vizStatus.classList.toggle("is-live", isLive);
      }

      function setView(view, { focus = false } = {}) {
        state.view = view === "waveform" ? "waveform" : "spectrum";
        $$(".viz-tab").forEach((tab) => {
          const selected = tab.dataset.view === state.view;
          tab.setAttribute("aria-selected", String(selected));
          tab.tabIndex = selected ? 0 : -1;
          if (selected && focus) tab.focus();
        });
        updateVizCopy();
        drawActiveVisualizer();
      }

      function updateVizCopy() {
        if (!el.vizModeLabel || !el.vizFooterText) return;
        const track = state.track;
        if (state.view === "spectrum") {
          el.vizModeLabel.textContent = state.isPlaying ? "Live spectrum" : "Spectrum preview";
          el.vizFooterText.textContent = state.isPlaying
            ? "Live · 20 Hz–20 kHz"
            : track
              ? "Press ▶ for live"
              : "Add a song";
          if (el.vizCanvas) {
            el.vizCanvas.setAttribute("aria-label", state.isPlaying
              ? "Live Fourier frequency spectrum of the playing track."
              : "Static spectrum preview of the current track. Press play for the live Fourier spectrum.");
          }
        } else {
          const beats = track ? Math.floor((track.duration * state.bpm) / 60) : 0;
          el.vizModeLabel.textContent = `Waveform · ${beats} beats · ${track?.timeSignature || "4/4"}`;
          el.vizFooterText.textContent = "Tap to seek";
          if (el.vizCanvas) {
            el.vizCanvas.setAttribute("aria-label", `Waveform of the current track with vertical beat markers at intervals of ${(60 / state.bpm).toFixed(3)} seconds. Click to seek.`);
          }
        }
        setStatusLive(state.isPlaying);
      }


      function ensureAudio() {
        if (!state.ctx) {
          const AudioCtor = window.AudioContext || window.webkitAudioContext;
          if (!AudioCtor) throw new Error("This browser does not support the Web Audio API.");
          state.ctx = new AudioCtor();
          state.analyser = state.ctx.createAnalyser();
          state.analyser.fftSize = 4096;
          state.analyser.smoothingTimeConstant = 0.82;
          state.analyser.minDecibels = -95;
          state.analyser.maxDecibels = -10;
          state.masterGain = state.ctx.createGain();
          state.masterGain.gain.value = gainForVolume(state.volume);
          state.analyser.connect(state.masterGain);
          state.masterGain.connect(state.ctx.destination);
          state.freqData = new Uint8Array(state.analyser.frequencyBinCount);
        }
        if (state.ctx.state === "suspended") {
          state.ctx.resume().catch(() => {});
        }
        return state.ctx;
      }

      function makeDemoBuffer() {
        const ctx = ensureAudio();
        const sampleRate = ctx.sampleRate;
        const bpm = 96;
        const bars = 8;
        const beatsPerBar = 4;
        const beatSeconds = 60 / bpm;
        const duration = bars * beatsPerBar * beatSeconds;
        const length = Math.ceil(duration * sampleRate);
        const buffer = ctx.createBuffer(1, length, sampleRate);
        const data = buffer.getChannelData(0);
        let seed = 0x2f6e2b1;

        const random = () => {
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          return ((seed >>> 0) / 4294967296) * 2 - 1;
        };

        function addTone(start, durationSec, frequency, amplitude, options = {}) {
          const attack = options.attack ?? 0.008;
          const decay = options.decay ?? 0.55;
          const harmonic = options.harmonic ?? 0;
          let startIndex = Math.max(0, Math.floor(start * sampleRate));
          const endIndex = Math.min(length, Math.ceil((start + durationSec) * sampleRate));
          if (endIndex <= startIndex || !Number.isFinite(frequency)) return;
          let phase = 0;
          const increment = (TAU * frequency) / sampleRate;
          for (let i = startIndex; i < endIndex; i += 1) {
            const t = (i - startIndex) / sampleRate;
            const envelope = Math.min(1, t / attack) * Math.exp(-t / decay);
            const value = Math.sin(phase) + harmonic * Math.sin(phase * 2.01);
            data[i] += value * amplitude * envelope;
            phase += increment;
          }
        }

        function addKick(start) {
          const startIndex = Math.max(0, Math.floor(start * sampleRate));
          const endIndex = Math.min(length, Math.ceil((start + 0.34) * sampleRate));
          let phase = 0;
          for (let i = startIndex; i < endIndex; i += 1) {
            const t = (i - startIndex) / sampleRate;
            const frequency = 43 + 105 * Math.exp(-t * 26);
            phase += (TAU * frequency) / sampleRate;
            data[i] += Math.sin(phase) * Math.exp(-t * 11.5) * 0.72;
          }
        }

        function addNoise(start, durationSec, amplitude, decay, highPass = false) {
          const startIndex = Math.max(0, Math.floor(start * sampleRate));
          const endIndex = Math.min(length, Math.ceil((start + durationSec) * sampleRate));
          let previous = 0;
          for (let i = startIndex; i < endIndex; i += 1) {
            const t = (i - startIndex) / sampleRate;
            const noise = random();
            const value = highPass ? noise - previous * 0.72 : noise;
            previous = noise;
            data[i] += value * amplitude * Math.exp(-t * decay);
          }
        }

        const chords = [
          { bass: 110.0, tones: [220.0, 261.63, 329.63] },
          { bass: 87.31, tones: [174.61, 220.0, 261.63] },
          { bass: 130.81, tones: [261.63, 329.63, 392.0] },
          { bass: 98.0, tones: [196.0, 246.94, 293.66] }
        ];
        const melody = [440, 523.25, 659.25, 587.33, 523.25, 783.99, 659.25, 587.33, 493.88, 523.25, 440, 392];

        for (let beat = 0; beat < bars * beatsPerBar; beat += 1) {
          const time = beat * beatSeconds;
          addKick(time);
          if (beat % 4 === 1 || beat % 4 === 3) {
            addNoise(time, 0.2, 0.27, 22);
            addTone(time, 0.15, 185, 0.1, { attack: 0.002, decay: 0.12, harmonic: 0.4 });
          }
          if (beat % 4 === 2.5) {
            addNoise(time, 0.12, 0.07, 30, true);
          }
        }

        for (let eighth = 0; eighth < bars * beatsPerBar * 2; eighth += 1) {
          const time = eighth * (beatSeconds / 2);
          addNoise(time, 0.06, eighth % 2 === 0 ? 0.055 : 0.032, 70, true);
        }

        for (let bar = 0; bar < bars; bar += 1) {
          const chord = chords[Math.floor(bar / 2) % chords.length];
          const barStart = bar * beatsPerBar * beatSeconds;
          [0, 1.5, 2.5].forEach((offsetBeat, index) => {
            addTone(barStart + offsetBeat * beatSeconds, 0.55, chord.bass * (index === 2 ? 2 : 1), 0.18, {
              attack: 0.008,
              decay: 0.3,
              harmonic: 0.32
            });
          });
          chord.tones.forEach((frequency, index) => {
            addTone(barStart, beatsPerBar * beatSeconds * 1.05, frequency, 0.026, {
              attack: 0.16,
              decay: 2.5,
              harmonic: 0.08
            });
            if (bar % 2 === 1) {
              addTone(barStart, beatsPerBar * beatSeconds, frequency * 2, 0.008, { attack: 0.25, decay: 2.3 });
            }
          });
          for (let beat = 0; beat < beatsPerBar; beat += 1) {
            const index = (bar * beatsPerBar + beat) % melody.length;
            if ((bar + beat) % 3 !== 1) {
              addTone(barStart + beat * beatSeconds, 0.33, melody[index], 0.044, {
                attack: 0.006,
                decay: 0.28,
                harmonic: 0.18
              });
            }
          }
        }

        let peak = 0;
        for (let i = 0; i < length; i += 1) peak = Math.max(peak, Math.abs(data[i]));
        const normalizer = peak > 0 ? 0.88 / peak : 1;
        const fadeSamples = Math.min(Math.floor(0.03 * sampleRate), Math.floor(length / 4));
        for (let i = 0; i < length; i += 1) {
          let gain = normalizer;
          if (i < fadeSamples) gain *= i / fadeSamples;
          if (i > length - fadeSamples) gain *= (length - i) / fadeSamples;
          data[i] *= gain;
        }
        return buffer;
      }

      function stopSource() {
        if (!state.source) return;
        const source = state.source;
        state.source = null;
        source.onended = null;
        try { source.stop(); } catch (error) {}
        try { source.disconnect(); } catch (error) {}
      }

      function haltPlayback() {
        stopSource();
        state.isPlaying = false;
        state.offset = 0;
        state.startedAt = 0;
        state.startOffset = 0;
        updateTransport();
      }

      function currentTime() {
        if (!state.buffer) return 0;
        const duration = state.buffer.duration;
        if (!state.isPlaying || !state.ctx) return clamp(state.offset, 0, duration);
        const elapsed = Math.max(0, state.ctx.currentTime - state.startedAt);
        let time = state.startOffset + elapsed;
        if (state.loop) {
          time %= duration;
        } else {
          time = Math.min(time, duration);
        }
        return time;
      }

      function startSource(offset) {
        const ctx = ensureAudio();
        const buffer = state.buffer;
        if (!buffer) return;
        const duration = buffer.duration;
        const startAt = clamp(offset, 0, Math.max(0, duration - 0.001));
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = state.loop;
        source.connect(state.analyser);
        source.start(ctx.currentTime, startAt);
        state.source = source;
        state.startedAt = ctx.currentTime;
        state.startOffset = startAt;
        state.offset = startAt;
        state.isPlaying = true;
        state.seekPreview = null;
        source.onended = () => {
          if (state.source !== source) return;
          state.source = null;
          state.isPlaying = false;
          state.offset = state.loop ? 0 : duration;
          updateTransport();
          updateVizCopy();
          drawActiveVisualizer();
        };
        updateTransport();
        updateVizCopy();
      }

      async function playPlayback() {
        if (!state.buffer) {
          showToast("Load an audio track first.", "error");
          return;
        }
        try {
          const ctx = ensureAudio();
          if (ctx.state === "suspended") await ctx.resume();
        } catch (error) {
          showToast("Audio playback could not start in this browser.", "error");
          return;
        }
        state.userInteracted = true;
        if (state.source) return;
        let offset = state.offset;
        if (offset >= state.buffer.duration - 0.02) offset = 0;
        startSource(offset);
      }

      function pausePlayback() {
        if (!state.isPlaying && !state.source) {
          updateTransport();
          return;
        }
        const time = currentTime();
        stopSource();
        state.isPlaying = false;
        state.offset = clamp(time, 0, state.buffer ? state.buffer.duration : 0);
        updateTransport();
        updateVizCopy();
        drawActiveVisualizer();
      }

      function togglePlayback() {
        if (state.isPlaying) pausePlayback();
        else playPlayback();
      }

      function seekTo(seconds) {
        if (!state.buffer) return;
        const target = clamp(seconds, 0, state.buffer.duration);
        const wasPlaying = state.isPlaying;
        if (state.source) stopSource();
        state.isPlaying = false;
        state.offset = target;
        state.seekPreview = null;
        if (wasPlaying && target < state.buffer.duration - 0.02) {
          startSource(target);
        } else {
          updateTransport();
          updateVizCopy();
          drawActiveVisualizer();
        }
      }

      function setLoop(next) {
        const time = currentTime();
        const wasPlaying = state.isPlaying;
        if (state.source) stopSource();
        state.isPlaying = false;
        state.loop = Boolean(next);
        state.offset = clamp(time, 0, state.buffer ? state.buffer.duration : 0);
        if (wasPlaying) startSource(state.offset);
        updateLoopButton();
        updateTransport();
      }

      function computeWavePeaks(buffer, count = 2400) {
        const channels = buffer.numberOfChannels;
        const channelData = [];
        for (let channel = 0; channel < channels; channel += 1) {
          channelData.push(buffer.getChannelData(channel));
        }
        const min = new Float32Array(count);
        const max = new Float32Array(count);
        const block = buffer.length / count;
        let global = 0;
        for (let i = 0; i < count; i += 1) {
          const start = Math.floor(i * block);
          const end = Math.min(buffer.length, Math.ceil((i + 1) * block));
          const step = Math.max(1, Math.floor((end - start) / 160));
          let low = 0;
          let high = 0;
          for (let sample = start; sample < end; sample += step) {
            let value = 0;
            for (let channel = 0; channel < channels; channel += 1) {
              value += channelData[channel][sample] || 0;
            }
            value /= channels;
            if (value < low) low = value;
            if (value > high) high = value;
          }
          min[i] = low;
          max[i] = high;
          global = Math.max(global, Math.abs(low), Math.abs(high));
        }
        if (global > 0) {
          for (let i = 0; i < count; i += 1) {
            min[i] /= global;
            max[i] /= global;
          }
        }
        return { min, max, count };
      }

      function fftInPlace(real, imag) {
        const n = real.length;
        for (let i = 1, j = 0; i < n; i += 1) {
          let bit = n >> 1;
          while (j & bit) {
            j ^= bit;
            bit >>= 1;
          }
          j ^= bit;
          if (i < j) {
            const tempReal = real[i];
            const tempImag = imag[i];
            real[i] = real[j];
            imag[i] = imag[j];
            real[j] = tempReal;
            imag[j] = tempImag;
          }
        }
        for (let size = 2; size <= n; size <<= 1) {
          const angle = (-TAU) / size;
          const half = size >> 1;
          for (let start = 0; start < n; start += size) {
            for (let k = 0; k < half; k += 1) {
              const theta = angle * k;
              const cos = Math.cos(theta);
              const sin = Math.sin(theta);
              const evenIndex = start + k;
              const oddIndex = evenIndex + half;
              const oddReal = real[oddIndex] * cos - imag[oddIndex] * sin;
              const oddImag = real[oddIndex] * sin + imag[oddIndex] * cos;
              real[oddIndex] = real[evenIndex] - oddReal;
              imag[oddIndex] = imag[evenIndex] - oddImag;
              real[evenIndex] += oddReal;
              imag[evenIndex] += oddImag;
            }
          }
        }
      }

      function computeStaticSpectrum(buffer) {
        const size = 2048;
        const sampleRate = buffer.sampleRate;
        const channels = buffer.numberOfChannels;
        const channelData = [];
        for (let channel = 0; channel < channels; channel += 1) {
          channelData.push(buffer.getChannelData(channel));
        }
        const limit = Math.max(0, buffer.length - size);
        let bestStart = 0;
        let bestEnergy = -1;
        for (let fraction = 0.08; fraction <= 0.86; fraction += 0.08) {
          const start = Math.floor(limit * fraction);
          let energy = 0;
          for (let i = 0; i < size; i += 7) {
            let value = 0;
            for (let channel = 0; channel < channels; channel += 1) value += channelData[channel][start + i] || 0;
            energy += Math.abs(value / channels);
          }
          if (energy > bestEnergy) {
            bestEnergy = energy;
            bestStart = start;
          }
        }
        const real = new Float64Array(size);
        const imag = new Float64Array(size);
        for (let i = 0; i < size; i += 1) {
          let value = 0;
          for (let channel = 0; channel < channels; channel += 1) value += channelData[channel][bestStart + i] || 0;
          value /= channels;
          const window = 0.5 - 0.5 * Math.cos((TAU * i) / (size - 1));
          real[i] = value * window;
        }
        fftInPlace(real, imag);
        const magnitudes = new Float64Array(FFT_BARS);
        const bandFrequencies = new Float64Array(FFT_BARS);
        const nyquist = sampleRate / 2;
        const highFrequency = Math.min(20000, nyquist);
        for (let bar = 0; bar < FFT_BARS; bar += 1) {
          const low = 20 * Math.pow(highFrequency / 20, bar / FFT_BARS);
          const high = 20 * Math.pow(highFrequency / 20, (bar + 1) / FFT_BARS);
          let binStart = Math.max(1, Math.floor((low * size) / sampleRate));
          let binEnd = Math.max(binStart, Math.ceil((high * size) / sampleRate));
          binEnd = Math.min(binEnd, size / 2 - 1);
          let magnitude = 0;
          for (let bin = binStart; bin <= binEnd; bin += 1) {
            magnitude = Math.max(magnitude, Math.hypot(real[bin], imag[bin]));
          }
          magnitudes[bar] = magnitude;
          bandFrequencies[bar] = Math.sqrt(low * high);
        }
        let maxMagnitude = 0;
        let peakIndex = 0;
        for (let bar = 0; bar < FFT_BARS; bar += 1) {
          if (magnitudes[bar] > maxMagnitude) {
            maxMagnitude = magnitudes[bar];
            peakIndex = bar;
          }
        }
        const values = new Float32Array(FFT_BARS);
        if (maxMagnitude > 0) {
          for (let bar = 0; bar < FFT_BARS; bar += 1) {
            const db = 20 * Math.log10(magnitudes[bar] / maxMagnitude + 1e-9);
            values[bar] = clamp((db + 54) / 54, 0, 1);
          }
        }
        return { values, peakFreq: bandFrequencies[peakIndex] || 0 };
      }

      function yieldToUI() {
        return new Promise((resolve) => window.setTimeout(resolve, 0));
      }

      function createMonoSegment(buffer, startSeconds, seconds) {
        const sampleRate = buffer.sampleRate;
        const start = clamp(Math.floor(startSeconds * sampleRate), 0, buffer.length);
        const length = Math.max(0, Math.min(Math.ceil(seconds * sampleRate), buffer.length - start));
        const mono = new Float32Array(length);
        if (buffer.numberOfChannels === 1) {
          mono.set(buffer.getChannelData(0).subarray(start, start + length));
          return mono;
        }
        const channels = [];
        for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
          channels.push(buffer.getChannelData(channel));
        }
        for (let i = 0; i < length; i += 1) {
          let value = 0;
          for (let channel = 0; channel < channels.length; channel += 1) {
            value += channels[channel][start + i] || 0;
          }
          mono[i] = value / channels.length;
        }
        return mono;
      }

      const fftPlanCache = new Map();

      function getFFTPlan(size) {
        if (fftPlanCache.has(size)) return fftPlanCache.get(size);
        const half = size >> 1;
        const cos = new Float64Array(half);
        const sin = new Float64Array(half);
        for (let i = 0; i < half; i += 1) {
          const angle = (-TAU * i) / size;
          cos[i] = Math.cos(angle);
          sin[i] = Math.sin(angle);
        }
        const reverse = new Uint32Array(size);
        const bits = Math.round(Math.log2(size));
        for (let i = 0; i < size; i += 1) {
          let value = i;
          let reversed = 0;
          for (let bit = 0; bit < bits; bit += 1) {
            reversed = (reversed << 1) | (value & 1);
            value >>= 1;
          }
          reverse[i] = reversed;
        }
        const plan = { size, cos, sin, reverse };
        fftPlanCache.set(size, plan);
        return plan;
      }

      function fftWithPlan(real, imag, plan) {
        const size = plan.size;
        const reverse = plan.reverse;
        for (let i = 0; i < size; i += 1) {
          const j = reverse[i];
          if (i < j) {
            const realValue = real[i];
            const imagValue = imag[i];
            real[i] = real[j];
            imag[i] = imag[j];
            real[j] = realValue;
            imag[j] = imagValue;
          }
        }
        for (let block = 2; block <= size; block <<= 1) {
          const half = block >> 1;
          const stride = size / block;
          for (let start = 0; start < size; start += block) {
            for (let k = 0; k < half; k += 1) {
              const tableIndex = k * stride;
              const cos = plan.cos[tableIndex];
              const sin = plan.sin[tableIndex];
              const oddIndex = start + k + half;
              const evenIndex = start + k;
              const oddReal = real[oddIndex] * cos - imag[oddIndex] * sin;
              const oddImag = real[oddIndex] * sin + imag[oddIndex] * cos;
              real[oddIndex] = real[evenIndex] - oddReal;
              imag[oddIndex] = imag[evenIndex] - oddImag;
              real[evenIndex] += oddReal;
              imag[evenIndex] += oddImag;
            }
          }
        }
      }

      function percentile(values, fraction) {
        if (!values.length) return 0;
        const sorted = Float64Array.from(values).sort();
        return sorted[clamp(Math.floor(fraction * (sorted.length - 1)), 0, sorted.length - 1)];
      }

      function sampleEnvelope(values, position) {
        if (!values.length || position <= 0) return values[0] || 0;
        if (position >= values.length - 1) return values[values.length - 1] || 0;
        const index = Math.floor(position);
        const fraction = position - index;
        return values[index] * (1 - fraction) + values[index + 1] * fraction;
      }

      function peakAround(values, position, radius = 0.55) {
        return Math.max(
          sampleEnvelope(values, position - radius),
          sampleEnvelope(values, position),
          sampleEnvelope(values, position + radius)
        );
      }

      async function computeOnsetEnvelopes(mono, sampleRate, onProgress) {
        const frameSize = 1024;
        const hop = 512;
        const frameCount = Math.max(0, Math.floor((mono.length - frameSize) / hop));
        const fps = sampleRate / hop;
        const flux = new Float32Array(frameCount);
        const lowFlux = new Float32Array(frameCount);
        if (frameCount < 8) return { flux, lowFlux, fps, frames: frameCount };

        const window = new Float32Array(frameSize);
        for (let i = 0; i < frameSize; i += 1) {
          window[i] = 0.5 - 0.5 * Math.cos((TAU * i) / (frameSize - 1));
        }
        const plan = getFFTPlan(frameSize);
        const real = new Float64Array(frameSize);
        const imag = new Float64Array(frameSize);
        const previous = new Float32Array(frameSize / 2);
        const sampleRateBin = sampleRate / frameSize;
        const maxBin = Math.min(frameSize / 2 - 1, Math.floor(8000 / sampleRateBin));

        for (let frame = 0; frame < frameCount; frame += 1) {
          const offset = frame * hop;
          for (let i = 0; i < frameSize; i += 1) {
            real[i] = mono[offset + i] * window[i];
            imag[i] = 0;
          }
          fftWithPlan(real, imag, plan);
          let frameFlux = 0;
          let frameLow = 0;
          for (let bin = 1; bin <= maxBin; bin += 1) {
            const frequency = bin * sampleRateBin;
            const magnitude = Math.hypot(real[bin], imag[bin]);
            const difference = magnitude - previous[bin];
            previous[bin] = magnitude;
            if (difference <= 0) continue;
            let weight = 1;
            if (frequency < 200) weight = 1.55;
            else if (frequency > 2000) weight = 0.38;
            frameFlux += difference * weight;
            if (frequency >= 30 && frequency <= 180) frameLow += difference * 2.1;
          }
          flux[frame] = frameFlux;
          lowFlux[frame] = frameLow;
          if (frame % 450 === 0) {
            if (onProgress) onProgress("Reading rhythmic onsets…");
            await yieldToUI();
          }
        }

        function normalize(source) {
          const center = percentile(source, 0.48);
          const high = Math.max(percentile(source, 0.96), center + 1e-9);
          const result = new Float32Array(source.length);
          let maximum = 0;
          for (let i = 0; i < source.length; i += 1) {
            result[i] = Math.max(0, source[i] - center * 0.88) / (high - center + 1e-9);
            maximum = Math.max(maximum, result[i]);
          }
          if (maximum > 0) {
            for (let i = 0; i < result.length; i += 1) result[i] /= maximum;
          }
          const smoothed = new Float32Array(result.length);
          for (let i = 0; i < result.length; i += 1) {
            const previous = result[Math.max(0, i - 1)] || 0;
            const next = result[Math.min(result.length - 1, i + 1)] || 0;
            smoothed[i] = result[i] * 0.72 + previous * 0.14 + next * 0.14;
          }
          return smoothed;
        }

        return {
          flux: normalize(flux),
          lowFlux: normalize(lowFlux),
          fps,
          frames: frameCount
        };
      }

      function detectTempoFromEnvelope(flux, lowFlux, fps) {
        if (flux.length < 12) {
          return { bpm: 120, confidence: 0.08, phase: 0 };
        }
        const combined = new Float32Array(flux.length);
        for (let i = 0; i < flux.length; i += 1) {
          combined[i] = flux[i] * 0.82 + lowFlux[i] * 0.18;
        }
        const scores = [];
        let best = { bpm: 120, score: -Infinity, phase: 0 };
        for (let bpm = 55; bpm <= 200.01; bpm += 0.5) {
          const period = (fps * 60) / bpm;
          if (period < 3 || period > flux.length / 3) continue;
          let bestPhase = 0;
          let bestPhaseScore = -Infinity;
          const phaseCount = 72;
          for (let phaseIndex = 0; phaseIndex < phaseCount; phaseIndex += 1) {
            const phase = (phaseIndex / phaseCount) * period;
            let onSum = 0;
            let onCount = 0;
            let offSum = 0;
            let offCount = 0;
            for (let position = phase; position < combined.length - 1; position += period) {
              onSum += peakAround(combined, position);
              onCount += 1;
            }
            for (let position = phase + period / 2; position < combined.length - 1; position += period) {
              offSum += peakAround(combined, position);
              offCount += 1;
            }
            if (onCount < 3) continue;
            const onAverage = onSum / onCount;
            const offAverage = offCount ? offSum / offCount : 0;
            const score = onAverage - offAverage * 0.28;
            if (score > bestPhaseScore) {
              bestPhaseScore = score;
              bestPhase = phase;
            }
          }
          if (!Number.isFinite(bestPhaseScore)) continue;
          const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.62, 2));
          const weighted = bestPhaseScore * (0.74 + 0.26 * prior);
          scores.push({ bpm, score: weighted });
          if (weighted > best.score) best = { bpm, score: weighted, phase: bestPhase };
        }
        if (!Number.isFinite(best.score) || best.score <= 0) {
          return { bpm: 120, confidence: 0.08, phase: 0 };
        }
        let second = { score: 0 };
        for (const candidate of scores) {
          if (Math.abs(candidate.bpm - best.bpm) <= 2.5) continue;
          if (candidate.score > second.score) second = candidate;
        }
        const margin = second.score > 0 ? 1 - second.score / best.score : 1;
        const confidence = clamp(0.23 + margin * 1.25 + Math.min(0.2, best.score * 0.4), 0.05, 0.97);
        let bpm = best.bpm;
        if (bpm < 78 && bpm * 2 <= 200) bpm *= 2;
        else if (bpm > 168 && bpm / 2 >= 55) bpm /= 2;
        return {
          bpm: Math.round(bpm * 10) / 10,
          confidence,
          phase: best.phase
        };
      }

      function detectTimeSignatureFromEnvelope(flux, lowFlux, fps, bpm, phaseFrames) {
        const period = (fps * 60) / bpm;
        if (!Number.isFinite(period) || period < 2) {
          return { timeSignature: "4/4", confidence: 0.12 };
        }
        const strengths = [];
        for (let position = phaseFrames; position < flux.length - 1; position += period) {
          const onset = peakAround(flux, position);
          const low = peakAround(lowFlux, position);
          strengths.push(onset * 0.72 + low * 0.28);
        }
        if (strengths.length < 9) {
          return { timeSignature: "4/4", confidence: 0.12 };
        }
        const average = strengths.reduce((sum, value) => sum + value, 0) / strengths.length;
        if (average <= 1e-5) return { timeSignature: "4/4", confidence: 0.1 };

        function correlationAtLag(lag) {
          if (strengths.length <= lag + 2) return 0;
          let sumA = 0;
          let sumB = 0;
          let count = 0;
          for (let i = 0; i + lag < strengths.length; i += 1) {
            sumA += strengths[i];
            sumB += strengths[i + lag];
            count += 1;
          }
          const meanA = sumA / count;
          const meanB = sumB / count;
          let numerator = 0;
          let denomA = 0;
          let denomB = 0;
          for (let i = 0; i + lag < strengths.length; i += 1) {
            const a = strengths[i] - meanA;
            const b = strengths[i + lag] - meanB;
            numerator += a * b;
            denomA += a * a;
            denomB += b * b;
          }
          return numerator / (Math.sqrt(denomA * denomB) + 1e-9);
        }

        function scoreMeter(meter) {
          let bestContrast = -Infinity;
          let bestPhase = 0;
          for (let phase = 0; phase < meter; phase += 1) {
            let down = 0;
            let downCount = 0;
            let other = 0;
            let otherCount = 0;
            strengths.forEach((value, index) => {
              if (index % meter === phase) {
                down += value;
                downCount += 1;
              } else {
                other += value;
                otherCount += 1;
              }
            });
            if (!downCount || !otherCount) continue;
            const contrast = (down / downCount - other / otherCount) / (average + 1e-9);
            if (contrast > bestContrast) {
              bestContrast = contrast;
              bestPhase = phase;
            }
          }
          const correlation = correlationAtLag(meter);
          return {
            phase: bestPhase,
            contrast: Number.isFinite(bestContrast) ? bestContrast : 0,
            correlation,
            score: Math.max(0, bestContrast) * 0.62 + Math.max(0, correlation) * 0.38
          };
        }

        const three = scoreMeter(3);
        const four = scoreMeter(4);
        const useThree = three.score > four.score + 0.055;
        const chosen = useThree ? three : four;
        const alternate = useThree ? four : three;
        const confidence = clamp(
          0.18 + Math.max(0, chosen.score) * 0.65 + Math.max(0, chosen.score - alternate.score) * 1.25,
          0.06,
          0.95
        );
        return {
          timeSignature: useThree ? "3/4" : "4/4",
          confidence,
          downbeat: chosen.phase
        };
      }

      async function detectKeyFromMono(mono, sampleRate, onProgress) {
        const frameSize = 4096;
        const hop = 4096;
        const frameCount = Math.max(0, Math.floor((mono.length - frameSize) / hop));
        if (frameCount < 3) {
          return { tonicPc: 0, mode: "major", confidence: 0.06 };
        }
        const window = new Float32Array(frameSize);
        for (let i = 0; i < frameSize; i += 1) {
          window[i] = 0.5 - 0.5 * Math.cos((TAU * i) / (frameSize - 1));
        }
        const plan = getFFTPlan(frameSize);
        const real = new Float64Array(frameSize);
        const imag = new Float64Array(frameSize);
        const chroma = new Float64Array(12);
        const bassChroma = new Float64Array(12);
        const binWidth = sampleRate / frameSize;
        const firstBin = Math.max(1, Math.floor(98 / binWidth));
        const lastBin = Math.min(frameSize / 2 - 1, Math.ceil(2800 / binWidth));
        let usedFrames = 0;

        for (let frame = 0; frame < frameCount; frame += 1) {
          const offset = frame * hop;
          let energy = 0;
          for (let i = 0; i < frameSize; i += 1) {
            const value = mono[offset + i];
            energy += value * value;
            real[i] = value * window[i];
            imag[i] = 0;
          }
          const rms = Math.sqrt(energy / frameSize);
          if (rms < 0.0015) continue;
          fftWithPlan(real, imag, plan);
          const frameChroma = new Float64Array(12);
          const frameBass = new Float64Array(12);
          for (let bin = firstBin; bin <= lastBin; bin += 1) {
            const frequency = bin * binWidth;
            const magnitude = Math.hypot(real[bin], imag[bin]);
            if (magnitude < 1e-6) continue;
            const midi = 69 + 12 * Math.log2(frequency / 440);
            const pc = ((Math.round(midi) % 12) + 12) % 12;
            let weight = 1;
            if (frequency < 160) weight = 0.45;
            else if (frequency > 1600) weight = 0.55;
            const centered = Math.pow(magnitude, 0.62) * weight;
            frameChroma[pc] += centered;
            if (frequency >= 98 && frequency <= 300) frameBass[pc] += centered;
          }
          const total = frameChroma.reduce((sum, value) => sum + value, 0);
          if (total <= 0) continue;
          const frameWeight = clamp(rms * 18, 0.08, 1);
          for (let pc = 0; pc < 12; pc += 1) {
            chroma[pc] += (frameChroma[pc] / total) * frameWeight;
            bassChroma[pc] += (frameBass[pc] / total) * frameWeight;
          }
          usedFrames += 1;
          if (frame % 180 === 0) {
            if (onProgress) onProgress("Detecting tonal center…");
            await yieldToUI();
          }
        }

        if (!usedFrames) {
          return { tonicPc: 0, mode: "major", confidence: 0.06 };
        }
        let bassTotal = 0;
        for (let pc = 0; pc < 12; pc += 1) bassTotal += bassChroma[pc];
        for (let pc = 0; pc < 12; pc += 1) {
          if (bassTotal > 0) chroma[pc] = chroma[pc] * 0.82 + (bassChroma[pc] / bassTotal) * 0.18;
        }
        const meanChroma = chroma.reduce((sum, value) => sum + value, 0) / 12;
        let variance = 0;
        for (let pc = 0; pc < 12; pc += 1) variance += Math.pow(chroma[pc] - meanChroma, 2);
        if (variance <= 1e-12) {
          return { tonicPc: 0, mode: "major", confidence: 0.06 };
        }

        function correlation(profile, tonic) {
          const expected = new Float64Array(12);
          for (let pc = 0; pc < 12; pc += 1) {
            expected[pc] = profile[(pc - tonic + 12) % 12];
          }
          const meanExpected = expected.reduce((sum, value) => sum + value, 0) / 12;
          let numerator = 0;
          let denomA = 0;
          let denomB = 0;
          for (let pc = 0; pc < 12; pc += 1) {
            const a = chroma[pc] - meanChroma;
            const b = expected[pc] - meanExpected;
            numerator += a * b;
            denomA += a * a;
            denomB += b * b;
          }
          return numerator / (Math.sqrt(denomA * denomB) + 1e-9);
        }

        const candidates = [];
        for (let tonic = 0; tonic < 12; tonic += 1) {
          candidates.push({ tonic, mode: "major", score: correlation(MAJOR_PROFILE, tonic) });
          candidates.push({ tonic, mode: "minor", score: correlation(MINOR_PROFILE, tonic) });
        }
        candidates.sort((a, b) => b.score - a.score);
        const best = candidates[0];
        const second = candidates[1] || { score: 0 };
        const confidence = clamp(
          0.14 + Math.max(0, best.score) * 0.68 + Math.max(0, best.score - second.score) * 1.15,
          0.05,
          0.96
        );
        return {
          tonicPc: best.tonic,
          mode: best.mode,
          confidence,
          correlation: best.score,
          analyzedFrames: usedFrames
        };
      }

      async function analyzeAudioBuffer(buffer, onProgress = () => {}) {
        if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration < 1.5) {
          return {
            bpm: 120,
            bpmConfidence: 0.08,
            key: makeKey(0, "major", 0.06),
            timeSignature: "4/4",
            meterConfidence: 0.08,
            analyzedSeconds: buffer ? buffer.duration : 0
          };
        }
        const startSeconds = buffer.duration > 30 ? Math.min(8, buffer.duration * 0.05) : 0;
        const seconds = Math.min(75, buffer.duration - startSeconds);
        onProgress("Preparing audio analysis…");
        await yieldToUI();
        const mono = createMonoSegment(buffer, startSeconds, seconds);
        const onset = await computeOnsetEnvelopes(mono, buffer.sampleRate, onProgress);
        onProgress("Scoring tempo candidates…");
        await yieldToUI();
        const tempo = detectTempoFromEnvelope(onset.flux, onset.lowFlux, onset.fps);
        const meter = detectTimeSignatureFromEnvelope(onset.flux, onset.lowFlux, onset.fps, tempo.bpm, tempo.phase);
        onProgress("Detecting key center…");
        await yieldToUI();
        const key = await detectKeyFromMono(mono, buffer.sampleRate, onProgress);
        onProgress("Analysis complete");
        return {
          bpm: tempo.bpm,
          bpmConfidence: tempo.confidence,
          key: makeKey(key.tonicPc, key.mode, key.confidence),
          timeSignature: meter.timeSignature,
          meterConfidence: meter.confidence,
          analyzedSeconds: seconds
        };
      }

      function applyBuffer(buffer, meta = {}) {
        haltPlayback();
        state.buffer = buffer;
        state.offset = 0;
        state.seekPreview = null;
        const kind = meta.kind || "upload";
        const bpm = clamp(Number(meta.bpm) || 120, 30, 300);
        const key = meta.key
          ? makeKey(meta.key.tonicPc, meta.key.mode, meta.key.confidence)
          : makeKey(pitchClass(meta.rootMidi ?? state.rootMidi), "major", 0);
        const rootMidi = clamp(Math.round(Number(meta.rootMidi ?? keyRootMidi(key))), 21, 108);
        const track = {
          id: meta.id || uid(),
          name: meta.name || "Untitled track",
          duration: buffer.duration,
          bpm,
          rootMidi,
          key,
          timeSignature: /^(2\/4|3\/4|4\/4|6\/8)$/.test(meta.timeSignature || "") ? meta.timeSignature : "4/4",
          kind,
          sourceLabel: meta.sourceLabel || (kind === "demo" ? "Generated in-browser" : "Local file"),
          formatLabel: meta.formatLabel || (kind === "demo" ? "MONO · demo" : "AUDIO"),
          analysis: {
            bpmConfidence: clamp(Number(meta.bpmConfidence) || 0, 0, 1),
            keyConfidence: key.confidence,
            meterConfidence: clamp(Number(meta.meterConfidence) || 0, 0, 1),
            source: meta.analysisSource || (kind === "demo" ? "demo" : "auto"),
            analyzedSeconds: Number(meta.analyzedSeconds) || 0
          },
          edited: Boolean(meta.edited)
        };
        state.track = track;
        state.bpm = track.bpm;
        state.rootMidi = track.rootMidi;
        state.peaks = computeWavePeaks(buffer);
        const spectrum = computeStaticSpectrum(buffer);
        state.staticSpectrum = spectrum.values;
        state.staticPeak = spectrum.peakFreq;
        state.spectrumPeaks.fill(0);
        if (meta.log) {
          state.tracks.push({ ...track });
        }
        syncCurrentTrackToSession();
        if (el.fileStatus && meta.status) el.fileStatus.textContent = meta.status;
        updateTrackUI();
        updateMetrics();
        updateTransport();
        updateBpmUI();
        updateAnalysisUI();
        renderStats();
        updatePolyUI();
        updateVizCopy();
        drawActiveVisualizer();
      }

      function setLoading(loading, message) {
        state.loading = loading;
        if (!el.dropzone) return;
        el.dropzone.classList.toggle("is-loading", loading);
        el.dropzone.setAttribute("aria-disabled", String(loading));
        if (message && el.fileStatus) el.fileStatus.textContent = message;
        updateAnalyzeButton();
      }

      function decodeAudio(ctx, arrayBuffer) {
        return new Promise((resolve, reject) => {
          let settled = false;
          const success = (decoded) => {
            if (settled) return;
            settled = true;
            resolve(decoded);
          };
          const failure = (error) => {
            if (settled) return;
            settled = true;
            reject(error || new Error("Unable to decode audio."));
          };
          try {
            const maybePromise = ctx.decodeAudioData(arrayBuffer, success, failure);
            if (maybePromise && typeof maybePromise.then === "function") {
              maybePromise.then(success).catch(failure);
            }
          } catch (error) {
            failure(error);
          }
        });
      }

      function isSupportedFile(file) {
        return /\.(mp3|wav|m4a)$/i.test(file.name || "") || /^audio\/(mpeg|wav|x-wav|mp4|x-m4a|m4a)$/i.test(file.type || "");
      }

      async function loadFile(file) {
        if (!file || state.loading) return;
        if (!isSupportedFile(file)) {
          showToast("Choose an MP3, WAV, or M4A audio file.", "error");
          return;
        }
        pausePlayback();
        setLoading(true, `Decoding ${file.name}…`);
        await new Promise((resolve) => window.setTimeout(resolve, 30));
        try {
          ensureAudio();
          const arrayBuffer = await file.arrayBuffer();
          const buffer = await decodeAudio(state.ctx, arrayBuffer);
          if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0) {
            throw new Error("Empty audio buffer.");
          }
          const extensionMatch = file.name.match(/\.([a-z0-9]+)$/i);
          const format = extensionMatch ? extensionMatch[1].toUpperCase() : "AUDIO";
          setLoading(true, "Analyzing…");
          await yieldToUI();
          const analysis = await analyzeAudioBuffer(buffer, (message) => {
            if (el.fileStatus) el.fileStatus.textContent = message;
          });
          const filenameTempo = file.name.match(/(\d{2,3})\s*bpm/i);
          const useFilenameTempo = Boolean(filenameTempo) && analysis.bpmConfidence < 0.22;
          const bpm = useFilenameTempo
            ? clamp(Number(filenameTempo[1]), 30, 300)
            : clamp(analysis.bpm, 30, 300);
          const key = analysis.key;
          const rootMidi = keyRootMidi(key);
          const meter = analysis.timeSignature;
          const resultLine = `${formatBpm(bpm)} BPM · ${keyLabel(key)} · ${meter}`;
          applyBuffer(buffer, {
            name: file.name.replace(/\.[^.]+$/, "").replaceAll("_", " "),
            bpm,
            rootMidi,
            key,
            timeSignature: meter,
            bpmConfidence: useFilenameTempo ? 0.9 : analysis.bpmConfidence,
            meterConfidence: analysis.meterConfidence,
            analysisSource: useFilenameTempo ? "filename" : "auto",
            analyzedSeconds: analysis.analyzedSeconds,
            kind: "upload",
            log: true,
            sourceLabel: `Local file · ${format}`,
            formatLabel: `${buffer.numberOfChannels === 1 ? "MONO" : "STEREO"} · ${(buffer.sampleRate / 1000).toFixed(1)} kHz`,
            status: `${format} decoded · ${resultLine}`
          });
          setLoading(false);
          showToast(useFilenameTempo
            ? `Loaded ${file.name}. Tempo came from the filename (${formatBpm(bpm)} BPM); key and meter were estimated from audio.`
            : `Auto analysis: ${resultLine}. Estimates can be corrected in the deck.`);
        } catch (error) {
          console.error(error);
          setLoading(false, "The file could not be decoded or analyzed.");
          showToast("That file could not be decoded. Try a WAV or MP3 version.", "error");
        } finally {
          if (el.fileInput) el.fileInput.value = "";
        }
      }

      async function loadDemoTrack({ announce = false } = {}) {
        if (state.loading) return;
        setLoading(true, "Synthesizing the demo groove…");
        await new Promise((resolve) => window.setTimeout(resolve, 30));
        try {
          if (!state.demoBuffer) state.demoBuffer = makeDemoBuffer();
          applyBuffer(state.demoBuffer, {
            id: "demo",
            name: "Procedural Etude in A",
            bpm: 96,
            rootMidi: 69,
            key: { tonicPc: 9, mode: "minor", confidence: 1 },
            timeSignature: "4/4",
            bpmConfidence: 1,
            meterConfidence: 1,
            analysisSource: "demo",
            analyzedSeconds: state.demoBuffer.duration,
            kind: "demo",
            log: false,
            sourceLabel: "Generated in-browser",
            formatLabel: "MONO · generated",
            status: "Demo synthesized locally at 96 BPM"
          });
          setLoading(false);
          if (announce) showToast("Demo reloaded. Press play, then try the spectrum and waveform.");
        } catch (error) {
          console.error(error);
          setLoading(false, "The demo could not be generated.");
          showToast("Audio could not start in this browser. Try another browser.", "error");
        }
      }


      async function analyzeCurrentTrack() {
        if (!state.buffer || state.loading || state.analyzing) return;
        state.analyzing = true;
        updateAnalysisUI();
        if (el.fileStatus) el.fileStatus.textContent = "Analyzing tempo, key, and meter…";
        try {
          const analysis = await analyzeAudioBuffer(state.buffer, (message) => {
            if (el.fileStatus) el.fileStatus.textContent = message;
          });
          if (!state.track) return;
          const track = state.track;
          const bpm = clamp(analysis.bpm, 30, 300);
          state.bpm = bpm;
          track.bpm = bpm;
          track.key = analysis.key;
          track.rootMidi = keyRootMidi(analysis.key);
          state.rootMidi = track.rootMidi;
          track.timeSignature = analysis.timeSignature;
          track.analysis = {
            bpmConfidence: analysis.bpmConfidence,
            keyConfidence: analysis.key.confidence,
            meterConfidence: analysis.meterConfidence,
            source: "auto",
            analyzedSeconds: analysis.analyzedSeconds
          };
          track.edited = false;
          syncCurrentTrackToSession();
          updateTrackUI();
          updateBpmUI();
          updateMetrics();
          updateTransport();
          updateAnalysisUI();
          updatePolyUI();
          renderStats();
          updateVizCopy();
          drawActiveVisualizer();
          if (poly.playing) restartPoly();
          const result = `${formatBpm(bpm)} BPM · ${keyLabel(track.key)} · ${track.timeSignature}`;
          if (el.fileStatus) el.fileStatus.textContent = `Re-analyzed · ${result}`;
          showToast(`Re-analysis: ${result}. Use the controls to correct any estimate.`);
        } catch (error) {
          console.error(error);
          if (el.fileStatus) el.fileStatus.textContent = "Analysis failed — the audio is still loaded.";
          showToast("Audio analysis could not finish. You can still set the values manually.", "error");
        } finally {
          state.analyzing = false;
          updateAnalysisUI();
        }
      }

      function cacheElements() {
        [
          "trackName", "trackBadge", "trackSource", "trackDurationLabel", "trackFormat",
          "playBtn", "seekBar", "currentTime", "totalTime", "loopBtn", "volume",
          "bpmInput", "bpmDown", "bpmUp", "tapBtn", "tapHint", "halfTempoBtn", "doubleTempoBtn", "rootSelect", "keyModeSelect", "meterSelect",
          "dropzone", "fileInput", "fileStatus", "loadDemo", "analysisStrip", "analysisLabel", "analysisSummary", "analysisConfidence", "analyzeBtn",
          "trackKey", "trackMeter",
          "metricDuration", "metricBeatInterval", "metricBeatFormula", "metricBeats", "metricBpm",
          "spectrumTab", "waveTab", "vizStatus", "vizModeLabel", "vizCanvas", "peakReadout", "vizFooterText",
          "noteName", "noteFreq", "noteSemitones", "noteRatio", "semitoneSlider", "semitoneOutput",
          "piano", "playToneBtn", "setRootBtn", "resetPitchBtn", "toneStatus", "pitchCanvas", "graphCurrent",
          "lcmValue", "lcmCaption", "polyCycleTime", "polyStepTime", "polyRows", "seqTitle",
          "seqStepReadout", "seqCaption", "polyPlayBtn", "polyPlayLabel", "polyTempoLabel",
          "tempoValues", "durationValues", "tempoRange", "durationRange", "sessionCount", "sessionNote",
          "sessionBody", "logCurrentBtn", "clearSessionBtn",
          "conceptDrawer", "drawerBackdrop", "closeConcepts", "toast"
        ].forEach((id) => {
          el[id] = document.getElementById(id);
        });
        el.vizTabs = $$(".viz-tab");
        el.ratioButtons = $$(".ratio-btn");
        el.conceptTriggers = $$("[data-open-concepts]");
        el.gotoConceptLinks = $$("[data-close-goto]");
      }

      function updateLoopButton() {
        if (!el.loopBtn) return;
        el.loopBtn.setAttribute("aria-pressed", String(state.loop));
        el.loopBtn.setAttribute("aria-label", state.loop ? "Disable looping" : "Loop audio");
      }

      function updateTransport() {
        if (!el.playBtn) return;
        const duration = state.buffer ? state.buffer.duration : 0;
        el.playBtn.classList.toggle("is-playing", state.isPlaying);
        el.playBtn.setAttribute("aria-label", state.isPlaying ? "Pause audio" : "Play audio");
        el.playBtn.disabled = !state.buffer;
        el.loopBtn.disabled = !state.buffer;
        document.body.classList.toggle("is-playing", state.isPlaying);
        setStatusLive(state.isPlaying);
        if (!state.seeking && state.seekPreview === null) {
          const time = currentTime();
          if (el.currentTime) el.currentTime.textContent = formatTime(time);
          if (el.seekBar) {
            el.seekBar.max = String(duration || 0);
            el.seekBar.value = String(Math.min(time, duration));
          }
        }
        if (el.totalTime) el.totalTime.textContent = formatTime(duration);
        if (el.seekBar) {
          el.seekBar.max = String(duration || 0);
          setRangeFill(el.seekBar);
        }
        updateLoopButton();
      }

      function updateTrackUI() {
        const track = state.track;
        if (!track) {
          if (el.trackName) el.trackName.textContent = "No track loaded";
          return;
        }
        if (el.trackName) {
          el.trackName.textContent = track.name;
          el.trackName.title = track.name;
        }
        if (el.trackBadge) {
          const demo = track.kind === "demo";
          el.trackBadge.textContent = demo ? "Demo" : "Upload";
          el.trackBadge.classList.toggle("demo", demo);
        }
        if (el.trackSource) el.trackSource.textContent = track.sourceLabel || "Audio";
        if (el.trackDurationLabel) el.trackDurationLabel.textContent = formatTime(track.duration, true);
        if (el.trackFormat) el.trackFormat.textContent = track.formatLabel || "AUDIO";
        if (el.trackKey) el.trackKey.textContent = keyLabel(track.key);
        if (el.trackMeter) el.trackMeter.textContent = track.timeSignature || "4/4";
        if (el.bpmInput) el.bpmInput.value = formatBpm(state.bpm);
        if (el.rootSelect) el.rootSelect.value = String(state.rootMidi);
        if (el.keyModeSelect && track.key) el.keyModeSelect.value = track.key.mode;
        if (el.meterSelect) el.meterSelect.value = track.timeSignature || "4/4";
      }

      function updateAnalyzeButton() {
        if (!el.analyzeBtn) return;
        const disabled = !state.buffer || state.loading || state.analyzing;
        el.analyzeBtn.disabled = disabled;
        el.analyzeBtn.classList.toggle("is-working", state.analyzing);
        el.analyzeBtn.textContent = state.analyzing ? "Analyzing…" : "Re-analyze";
      }

      function updateAnalysisUI() {
        if (!el.analysisSummary) return;
        updateAnalyzeButton();
        if (!el.analysisStrip) return;
        el.analysisStrip.classList.toggle("is-analyzing", state.analyzing);
        const track = state.track;
        if (state.analyzing) {
          if (el.analysisLabel) el.analysisLabel.textContent = "Analyzing";
          el.analysisSummary.textContent = "Analyzing…";
          if (el.analysisConfidence) {
            el.analysisConfidence.textContent = "Working";
            el.analysisConfidence.className = "analysis-confidence";
            el.analysisConfidence.title = "Audio analysis is running locally in the browser.";
          }
          return;
        }
        if (!track) {
          if (el.analysisLabel) el.analysisLabel.textContent = "Audio analysis";
          el.analysisSummary.textContent = "Add a song";
          if (el.analysisConfidence) {
            el.analysisConfidence.textContent = "—";
            el.analysisConfidence.className = "analysis-confidence";
            el.analysisConfidence.title = "";
          }
          return;
        }
        const demoReference = track.analysis?.source === "demo" && !track.edited;
        if (el.analysisLabel) {
          el.analysisLabel.textContent = demoReference
            ? "Demo reference"
            : track.edited
              ? "Edited values"
              : "Audio analysis";
        }
        el.analysisSummary.textContent = `${formatBpm(state.bpm)} BPM · ${keyLabel(track.key)} · ${track.timeSignature || "4/4"}`;
        if (!el.analysisConfidence) return;
        const analysis = track.analysis || {};
        const tempoConfidence = clamp(Number(analysis.bpmConfidence) || 0, 0, 1);
        const keyConfidence = clamp(Number(track.key?.confidence) || 0, 0, 1);
        const meterConfidence = clamp(Number(analysis.meterConfidence) || 0, 0, 1);
        const combined = tempoConfidence * 0.5 + keyConfidence * 0.35 + meterConfidence * 0.15;
        let label = "Estimated";
        let className = "analysis-confidence";
        if (demoReference) {
          label = "Known";
        } else if (track.edited) {
          label = "Edited";
          className = "analysis-confidence is-edited";
        } else if (combined < 0.36 || keyConfidence < 0.16 || tempoConfidence < 0.14) {
          label = "Low confidence";
          className = "analysis-confidence is-low";
        }
        el.analysisConfidence.textContent = label;
        el.analysisConfidence.className = className;
        el.analysisConfidence.title = "Estimated locally from the audio. Tempo, key, and meter can be corrected with the controls in the deck.";
      }

      function updateMetrics() {
        const duration = state.buffer ? state.buffer.duration : 0;
        const bpm = state.bpm;
        const beatInterval = 60 / bpm;
        const totalBeats = (duration * bpm) / 60;
        if (el.metricDuration) el.metricDuration.textContent = duration ? formatTime(duration) : "—";
        if (el.metricBeatInterval) el.metricBeatInterval.textContent = beatInterval.toFixed(3);
        if (el.metricBeatFormula) el.metricBeatFormula.textContent = `T = 60 / ${formatBpm(bpm)}`;
        if (el.metricBeats) el.metricBeats.textContent = duration ? totalBeats.toFixed(1) : "—";
        if (el.metricBpm) el.metricBpm.textContent = formatBpm(bpm);
        if (el.trackDurationLabel && state.track) el.trackDurationLabel.textContent = formatTime(duration, true);
        if (el.totalTime) el.totalTime.textContent = formatTime(duration);
        if (el.seekBar) el.seekBar.max = String(duration || 0);
      }

      function updateBpmUI() {
        if (el.bpmInput && document.activeElement !== el.bpmInput) {
          el.bpmInput.value = formatBpm(state.bpm);
        }
        if (el.metricBpm) el.metricBpm.textContent = formatBpm(state.bpm);
        if (el.metricBeatInterval) el.metricBeatInterval.textContent = (60 / state.bpm).toFixed(3);
        if (el.metricBeatFormula) el.metricBeatFormula.textContent = `T = 60 / ${formatBpm(state.bpm)}`;
        if (el.metricBeats && state.buffer) {
          el.metricBeats.textContent = ((state.buffer.duration * state.bpm) / 60).toFixed(1);
        }
        if (el.polyTempoLabel) el.polyTempoLabel.textContent = `Tempo-locked · ${formatBpm(state.bpm)} BPM`;
      }

      function fitCanvas(canvas) {
        const rect = canvas.getBoundingClientRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(rect.width));
        const height = Math.max(1, Math.round(rect.height));
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
          canvas.width = Math.round(width * dpr);
          canvas.height = Math.round(height * dpr);
        }
        const ctx = canvas.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { ctx, width, height, dpr };
      }

      function mixSignalColor(t) {
        const stops = [
          [30, 215, 96],
          [29, 185, 84],
          [30, 215, 96]
        ];
        const scaled = clamp(t, 0, 1) * (stops.length - 1);
        const index = Math.min(stops.length - 2, Math.floor(scaled));
        const local = scaled - index;
        const from = stops[index];
        const to = stops[index + 1];
        return [
          Math.round(from[0] + (to[0] - from[0]) * local),
          Math.round(from[1] + (to[1] - from[1]) * local),
          Math.round(from[2] + (to[2] - from[2]) * local)
        ];
      }

      function rgba(color, alpha) {
        return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${alpha})`;
      }

      function roundTopRect(ctx, x, y, width, height, radius) {
        const r = Math.min(radius, width / 2, height);
        ctx.beginPath();
        ctx.moveTo(x, y + height);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.lineTo(x + width - r, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + r);
        ctx.lineTo(x + width, y + height);
        ctx.closePath();
      }

      function updatePeakReadout(frequency) {
        if (!el.peakReadout) return;
        let text = "Peak —";
        if (state.buffer && frequency > 0) {
          text = `Peak ${Math.round(frequency)} Hz · ${nearestNote(frequency)}`;
        }
        if (text !== state.lastPeakText) {
          state.lastPeakText = text;
          el.peakReadout.textContent = text;
        }
      }

      function drawSpectrum() {
        if (!el.vizCanvas) return;
        const { ctx, width, height } = fitCanvas(el.vizCanvas);
        const compact = width < 520;
        const padLeft = compact ? 30 : 37;
        const padRight = compact ? 8 : 12;
        const padTop = compact ? 15 : 19;
        const padBottom = compact ? 22 : 27;
        const plotWidth = Math.max(10, width - padLeft - padRight);
        const plotHeight = Math.max(10, height - padTop - padBottom);
        const baseline = padTop + plotHeight;
        const sampleRate = state.ctx?.sampleRate || state.buffer?.sampleRate || 44100;
        const highFrequency = Math.min(20000, sampleRate / 2);

        ctx.clearRect(0, 0, width, height);
        const background = ctx.createLinearGradient(0, 0, 0, height);
        background.addColorStop(0, tc("paper", 1));
        background.addColorStop(0.6, tc("paper", 1));
        background.addColorStop(1, tc("paper", 1));
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);

        ctx.save();
        ctx.lineWidth = 1;
        ctx.strokeStyle = tc("ink", 0.07);
        ctx.fillStyle = tc("muted", 0.62);
        ctx.font = `${compact ? 8 : 9}px "Geist Mono", monospace`;
        ctx.textBaseline = "middle";
        ctx.textAlign = "right";
        const dbLabels = ["0", "−20", "−40", "−60", "−80"];
        for (let i = 0; i < dbLabels.length; i += 1) {
          const y = padTop + (plotHeight / (dbLabels.length - 1)) * i;
          ctx.beginPath();
          ctx.moveTo(padLeft, y + 0.5);
          ctx.lineTo(width - padRight, y + 0.5);
          ctx.stroke();
          ctx.fillText(dbLabels[i], padLeft - 7, y);
        }

        const frequencyTicks = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
        const logRange = Math.log(highFrequency / 20);
        const labelEvery = compact ? 2 : 1;
        ctx.textBaseline = "alphabetic";
        ctx.textAlign = "center";
        frequencyTicks.forEach((frequency, index) => {
          if (frequency > highFrequency) return;
          const x = padLeft + (Math.log(frequency / 20) / logRange) * plotWidth;
          ctx.strokeStyle = tc("ink", 0.052);
          ctx.beginPath();
          ctx.moveTo(x + 0.5, padTop);
          ctx.lineTo(x + 0.5, baseline);
          ctx.stroke();
          if (index % labelEvery === 0) {
            const label = frequency >= 1000 ? `${frequency / 1000}k` : String(frequency);
            ctx.fillStyle = tc("muted", 0.62);
            ctx.textAlign = index === 0 ? "left" : index === frequencyTicks.length - 1 ? "right" : "center";
            ctx.fillText(label, x, height - 7);
          }
        });

        const values = new Float32Array(FFT_BARS);
        const live = state.isPlaying && state.analyser;
        if (live) {
          state.analyser.getByteFrequencyData(state.freqData);
          const binCount = state.freqData.length;
          for (let bar = 0; bar < FFT_BARS; bar += 1) {
            const low = 20 * Math.pow(highFrequency / 20, bar / FFT_BARS);
            const high = 20 * Math.pow(highFrequency / 20, (bar + 1) / FFT_BARS);
            let start = Math.max(1, Math.floor((low * state.analyser.fftSize) / sampleRate));
            let end = Math.max(start, Math.ceil((high * state.analyser.fftSize) / sampleRate));
            end = Math.min(end, binCount - 1);
            let max = 0;
            for (let bin = start; bin <= end; bin += 1) max = Math.max(max, state.freqData[bin]);
            values[bar] = Math.pow(max / 255, 1.08);
          }
        } else if (state.staticSpectrum) {
          for (let bar = 0; bar < FFT_BARS; bar += 1) values[bar] = state.staticSpectrum[bar] || 0;
        } else {
          for (let bar = 0; bar < FFT_BARS; bar += 1) {
            values[bar] = 0.018 + 0.026 * (0.5 + 0.5 * Math.sin(bar * 0.31));
          }
        }

        const gap = Math.max(1, (plotWidth / FFT_BARS) * 0.24);
        const barWidth = Math.max(1, (plotWidth - gap * (FFT_BARS - 1)) / FFT_BARS);
        for (let bar = 0; bar < FFT_BARS; bar += 1) {
          const value = clamp(values[bar], 0, 1);
          const color = mixSignalColor(bar / (FFT_BARS - 1));
          const x = padLeft + bar * (barWidth + gap);
          const barHeight = Math.max(1.5, value * plotHeight * 0.94);
          const y = baseline - barHeight;
          const alpha = live ? 0.55 + value * 0.42 : 0.32 + value * 0.42;
          ctx.fillStyle = rgba(color, alpha);
          if (barHeight > 2.5) {
            roundTopRect(ctx, x, y, barWidth, barHeight, Math.min(3, barWidth / 2));
            ctx.fill();
          } else {
            ctx.fillRect(x, y, barWidth, barHeight);
          }

          const decay = live ? 0.012 : 0.2;
          state.spectrumPeaks[bar] = Math.max(value, state.spectrumPeaks[bar] - decay);
          if (state.spectrumPeaks[bar] > 0.055) {
            const py = baseline - state.spectrumPeaks[bar] * plotHeight * 0.94;
            ctx.fillStyle = rgba(color, 0.9);
            ctx.fillRect(x, Math.max(padTop, py), barWidth, 1.4);
          }
        }

        ctx.strokeStyle = tc("ink", 0.126);
        ctx.beginPath();
        ctx.moveTo(padLeft, baseline + 0.5);
        ctx.lineTo(width - padRight, baseline + 0.5);
        ctx.stroke();

        let peakFrequency = 0;
        if (live) {
          let peakValue = 0;
          let peakBin = 0;
          for (let bin = 2; bin < state.freqData.length; bin += 1) {
            if (state.freqData[bin] > peakValue) {
              peakValue = state.freqData[bin];
              peakBin = bin;
            }
          }
          if (peakValue > 4) peakFrequency = (peakBin * sampleRate) / state.analyser.fftSize;
        } else if (state.buffer && state.staticPeak) {
          peakFrequency = state.staticPeak;
        }
        updatePeakReadout(peakFrequency);

        if (!state.buffer) {
          ctx.fillStyle = tc("ink", 0.7);
          ctx.font = '11px "Figtree", sans-serif';
          ctx.textAlign = "center";
          ctx.fillText("Load a track to view its frequency spectrum", width / 2, height / 2);
        }
        ctx.restore();

        if (el.vizCanvas) {
          el.vizCanvas.style.cursor = "default";
        }
      }

      function waveformLayout(width, height) {
        const compact = width < 520;
        return {
          padLeft: compact ? 8 : 12,
          padRight: compact ? 8 : 12,
          padTop: compact ? 14 : 18,
          padBottom: compact ? 23 : 27,
          width,
          height
        };
      }

      function drawWaveformShape(ctx, peaks, x0, centerY, width, amplitude) {
        if (!peaks) return;
        const columns = Math.max(1, Math.round(width));
        ctx.beginPath();
        for (let px = 0; px <= columns; px += 1) {
          const index = Math.min(peaks.count - 1, Math.floor((px / columns) * peaks.count));
          const y = centerY - peaks.max[index] * amplitude;
          if (px === 0) ctx.moveTo(x0, y);
          else ctx.lineTo(x0 + px, y);
        }
        for (let px = columns; px >= 0; px -= 1) {
          const index = Math.min(peaks.count - 1, Math.floor((px / columns) * peaks.count));
          const y = centerY - peaks.min[index] * amplitude;
          ctx.lineTo(x0 + px, y);
        }
        ctx.closePath();
      }

      function drawWaveform() {
        if (!el.vizCanvas) return;
        const { ctx, width, height } = fitCanvas(el.vizCanvas);
        const layout = waveformLayout(width, height);
        const plotWidth = Math.max(10, width - layout.padLeft - layout.padRight);
        const plotHeight = Math.max(10, height - layout.padTop - layout.padBottom);
        const centerY = layout.padTop + plotHeight / 2;
        const amplitude = plotHeight * 0.41;
        ctx.clearRect(0, 0, width, height);
        const background = ctx.createLinearGradient(0, 0, 0, height);
        background.addColorStop(0, tc("paper", 1));
        background.addColorStop(1, tc("paper", 1));
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);

        ctx.strokeStyle = tc("ink", 0.077);
        ctx.lineWidth = 1;
        for (let i = 0; i < 4; i += 1) {
          const y = layout.padTop + (plotHeight / 3) * i;
          ctx.beginPath();
          ctx.moveTo(layout.padLeft, y + 0.5);
          ctx.lineTo(width - layout.padRight, y + 0.5);
          ctx.stroke();
        }

        if (!state.buffer || !state.peaks) {
          ctx.fillStyle = tc("ink", 0.7);
          ctx.font = '11px "Figtree", sans-serif';
          ctx.textAlign = "center";
          ctx.fillText("Load a track to see its waveform and beat grid", width / 2, height / 2);
          return;
        }

        const duration = state.buffer.duration;
        const beatInterval = 60 / state.bpm;
        const totalBeats = Math.floor(duration / beatInterval) + 1;
        const meterBeats = clamp(parseInt(state.track?.timeSignature || "4/4", 10) || 4, 2, 12);
        const time = state.seekPreview ?? currentTime();
        const progressX = layout.padLeft + clamp(time / duration, 0, 1) * plotWidth;

        const dimGradient = ctx.createLinearGradient(layout.padLeft, 0, width - layout.padRight, 0);
        dimGradient.addColorStop(0, tc("acc", 0.2));
        dimGradient.addColorStop(0.55, tc("ink", 0.18));
        dimGradient.addColorStop(1, tc("acc", 0.2));
        drawWaveformShape(ctx, state.peaks, layout.padLeft, centerY, plotWidth, amplitude);
        ctx.fillStyle = dimGradient;
        ctx.fill();

        ctx.save();
        ctx.beginPath();
        ctx.rect(layout.padLeft, layout.padTop, Math.max(0, progressX - layout.padLeft), plotHeight);
        ctx.clip();
        const brightGradient = ctx.createLinearGradient(layout.padLeft, 0, width - layout.padRight, 0);
        brightGradient.addColorStop(0, tc("acc", 0.82));
        brightGradient.addColorStop(0.55, tc("ink", 0.72));
        brightGradient.addColorStop(1, tc("acc", 0.74));
        drawWaveformShape(ctx, state.peaks, layout.padLeft, centerY, plotWidth, amplitude);
        ctx.fillStyle = brightGradient;
        ctx.fill();
        ctx.restore();

        ctx.strokeStyle = tc("ink", 0.091);
        ctx.beginPath();
        ctx.moveTo(layout.padLeft, centerY + 0.5);
        ctx.lineTo(width - layout.padRight, centerY + 0.5);
        ctx.stroke();

        ctx.lineWidth = 1;
        ctx.strokeStyle = tc("ink", 0.16);
        ctx.beginPath();
        for (let beat = 0; beat <= totalBeats; beat += 1) {
          if (beat % meterBeats === 0) continue;
          const x = layout.padLeft + (beat * beatInterval * plotWidth) / duration;
          if (x > width - layout.padRight + 0.5) break;
          ctx.moveTo(x + 0.5, layout.padTop);
          ctx.lineTo(x + 0.5, layout.padTop + plotHeight);
        }
        ctx.stroke();
        ctx.strokeStyle = tc("ink", 0.34);
        ctx.beginPath();
        for (let beat = 0; beat <= totalBeats; beat += 1) {
          if (beat % meterBeats !== 0) continue;
          const x = layout.padLeft + (beat * beatInterval * plotWidth) / duration;
          if (x > width - layout.padRight + 0.5) break;
          ctx.moveTo(x + 0.5, layout.padTop);
          ctx.lineTo(x + 0.5, layout.padTop + plotHeight);
        }
        ctx.stroke();

        const labelEvery = Math.max(meterBeats, Math.ceil(totalBeats / 10 / meterBeats) * meterBeats);
        ctx.font = '8px "Geist Mono", monospace';
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        for (let beat = 0; beat <= totalBeats; beat += labelEvery) {
          const x = layout.padLeft + (beat * beatInterval * plotWidth) / duration;
          if (x > width - layout.padRight - 2) continue;
          ctx.fillStyle = tc("muted", 0.68);
          ctx.fillText(String(beat + 1), x, height - 8);
          ctx.fillStyle = tc("ink", 0.8);
          ctx.fillRect(x - 0.5, layout.padTop + plotHeight + 1, 1, 3);
        }

        const currentBeatIndex = Math.floor(time / beatInterval);
        if (state.isPlaying || time > 0) {
          const currentBeatX = layout.padLeft + (currentBeatIndex * beatInterval * plotWidth) / duration;
          if (currentBeatX >= layout.padLeft && currentBeatX <= width - layout.padRight) {
            ctx.strokeStyle = tc("ink", 0.72);
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(currentBeatX, layout.padTop);
            ctx.lineTo(currentBeatX, layout.padTop + plotHeight);
            ctx.stroke();
          }
        }

        if (state.waveHoverX !== null) {
          const hoverProgress = clamp((state.waveHoverX - layout.padLeft) / plotWidth, 0, 1);
          const hoverTime = hoverProgress * duration;
          ctx.save();
          ctx.setLineDash([3, 4]);
          ctx.strokeStyle = tc("ink", 0.38);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(state.waveHoverX, layout.padTop);
          ctx.lineTo(state.waveHoverX, layout.padTop + plotHeight);
          ctx.stroke();
          ctx.restore();
          const label = formatTime(hoverTime, true);
          ctx.font = '8px "Geist Mono", monospace';
          const labelWidth = ctx.measureText(label).width + 10;
          const labelX = clamp(state.waveHoverX - labelWidth / 2, layout.padLeft, width - layout.padRight - labelWidth);
          ctx.fillStyle = tc("paper", 0.9);
          ctx.strokeStyle = tc("ink", 0.154);
          roundTopRect(ctx, labelX, layout.padTop + 4, labelWidth, 16, 4);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = tc("ink", 0.8);
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(label, labelX + labelWidth / 2, layout.padTop + 12.5);
        }

        ctx.save();
        ctx.shadowColor = tc("acc", 0.8);
        ctx.shadowBlur = 0;
        ctx.strokeStyle = tc("accInk", 1);
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(progressX, layout.padTop);
        ctx.lineTo(progressX, layout.padTop + plotHeight);
        ctx.stroke();
        ctx.restore();
        ctx.fillStyle = tc("accInk", 1);
        ctx.beginPath();
        ctx.arc(progressX, layout.padTop, 2.8, 0, TAU);
        ctx.fill();
        ctx.fillStyle = tc("ink", 0.75);
        ctx.font = '8px "Geist Mono", monospace';
        ctx.textAlign = progressX > width - 80 ? "right" : "left";
        ctx.textBaseline = "alphabetic";
        const beatLabel = `beat ${Math.max(1, currentBeatIndex + 1)}`;
        ctx.fillText(beatLabel, progressX + (progressX > width - 80 ? -6 : 6), layout.padTop + 11);

        if (el.peakReadout && state.track) {
          const beats = Math.floor((duration * state.bpm) / 60);
          el.peakReadout.textContent = `${beats} beats · T = ${(60 / state.bpm).toFixed(3)} s`;
        }
        el.vizCanvas.style.cursor = "crosshair";
      }

      function drawPitchGraph() {
        if (!el.pitchCanvas) return;
        const { ctx, width, height } = fitCanvas(el.pitchCanvas);
        const compact = width < 420;
        const padLeft = compact ? 34 : 42;
        const padRight = compact ? 10 : 16;
        const padTop = 18;
        const padBottom = 28;
        const plotWidth = Math.max(10, width - padLeft - padRight);
        const plotHeight = Math.max(10, height - padTop - padBottom);
        const xForN = (n) => padLeft + ((n + 12) / 24) * plotWidth;
        const yForF = (freq) => padTop + (1 - freq / 920) * plotHeight;
        ctx.clearRect(0, 0, width, height);
        const bg = ctx.createLinearGradient(0, 0, 0, height);
        bg.addColorStop(0, tc("paper", 0.94));
        bg.addColorStop(1, tc("paper", 0.96));
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, width, height);

        ctx.font = `${compact ? 8 : 9}px "Geist Mono", monospace`;
        ctx.textBaseline = "middle";
        const horizontalTicks = [0, 220, 440, 660, 880];
        horizontalTicks.forEach((tick) => {
          const y = yForF(tick);
          ctx.strokeStyle = tick === 440 ? tc("acc", 0.18) : tc("ink", 0.063);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(padLeft, y + 0.5);
          ctx.lineTo(width - padRight, y + 0.5);
          ctx.stroke();
          ctx.fillStyle = tc("muted", 0.62);
          ctx.textAlign = "right";
          ctx.fillText(String(tick), padLeft - 7, y);
        });

        [-12, -9, -6, -3, 0, 3, 6, 9, 12].forEach((tick) => {
          const x = xForN(tick);
          ctx.strokeStyle = tick === 0 ? tc("ink", 0.16) : tc("ink", 0.052);
          ctx.beginPath();
          ctx.moveTo(x + 0.5, padTop);
          ctx.lineTo(x + 0.5, padTop + plotHeight);
          ctx.stroke();
          ctx.fillStyle = tc("muted", 0.62);
          ctx.textAlign = "center";
          ctx.textBaseline = "alphabetic";
          if (compact && Math.abs(tick) % 6 !== 0) return;
          ctx.fillText(String(tick), x, height - 8);
        });

        ctx.fillStyle = tc("muted", 0.55);
        ctx.font = `${compact ? 7.5 : 8.5}px "Geist Mono", monospace`;
        ctx.textAlign = "left";
        ctx.fillText("Hz", 7, padTop + 1);
        ctx.textAlign = "right";
        ctx.fillText("semitones from A4", width - padRight, height - 23);

        const area = ctx.createLinearGradient(0, padTop, 0, padTop + plotHeight);
        area.addColorStop(0, tc("acc", 0.2));
        area.addColorStop(1, tc("acc", 0.0));
        ctx.beginPath();
        ctx.moveTo(xForN(-12), padTop + plotHeight);
        for (let n = -12; n <= 12; n += 0.12) {
          ctx.lineTo(xForN(n), yForF(freqForN(n)));
        }
        ctx.lineTo(xForN(12), padTop + plotHeight);
        ctx.closePath();
        ctx.fillStyle = area;
        ctx.fill();

        ctx.beginPath();
        for (let n = -12; n <= 12; n += 0.08) {
          const x = xForN(n);
          const y = yForF(freqForN(n));
          if (n === -12) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = tc("acc", 1);
        ctx.lineWidth = 2;
        ctx.shadowColor = tc("acc", 0.28);
        ctx.shadowBlur = 0;
        ctx.stroke();
        ctx.shadowBlur = 0;

        [-12, -7, 0, 7, 12].forEach((n) => {
          ctx.beginPath();
          ctx.arc(xForN(n), yForF(freqForN(n)), 2, 0, TAU);
          ctx.fillStyle = tc("ink", 0.48);
          ctx.fill();
        });

        const hover = state.pitchHoverN;
        const activeN = hover ?? state.pitchN;
        const activeFreq = freqForN(activeN);
        const activeX = xForN(activeN);
        const activeY = yForF(activeFreq);
        ctx.save();
        ctx.setLineDash([3, 4]);
        ctx.strokeStyle = hover === null ? tc("ink", 0.4) : tc("acc", 0.4);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(activeX, padTop + plotHeight);
        ctx.lineTo(activeX, activeY);
        ctx.stroke();
        ctx.restore();
        ctx.beginPath();
        ctx.arc(activeX, activeY, hover === null ? 5 : 4.5, 0, TAU);
        ctx.fillStyle = hover === null ? tc("ink", 1) : tc("acc", 1);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(activeX, activeY, 9, 0, TAU);
        ctx.fillStyle = hover === null ? tc("ink", 0.12) : tc("acc", 0.12);
        ctx.fill();

        const label = `n = ${activeN} · ${activeFreq.toFixed(2)} Hz`;
        ctx.font = `${compact ? 8 : 9}px "Geist Mono", monospace`;
        const labelWidth = ctx.measureText(label).width + 12;
        const labelX = clamp(activeX - labelWidth / 2, padLeft, width - padRight - labelWidth);
        const labelY = clamp(activeY - 32, padTop + 2, padTop + plotHeight - 20);
        ctx.fillStyle = tc("paper", 0.94);
        ctx.strokeStyle = tc("ink", 0.154);
        roundTopRect(ctx, labelX, labelY, labelWidth, 18, 4);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = tc("ink", 0.88);
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, labelX + labelWidth / 2, labelY + 9.5);
      }

      function drawActiveVisualizer() {
        if (!el.vizCanvas) return;
        if (state.view === "waveform") drawWaveform();
        else drawSpectrum();
      }

      // Read-only bridge for js/live.js (animations + live listening).
      window.MBMApp = {
        get analyser() { return state.analyser; },
        get ctx() { return state.ctx; },
        get isPlaying() { return Boolean(state.isPlaying); },
        get time() { return currentTime(); },
        get bpm() { return state.bpm; },
        get meter() { return state.track ? state.track.timeSignature : "4/4"; },
        sessionBpms() { return state.tracks.map((t) => t.bpm).filter(Number.isFinite); },
        addTrack(track) {
          const key = makeKey(track.key.tonicPc, track.key.mode, track.key.confidence || 0.5);
          state.tracks.push({
            id: uid(), kind: "live", sourceLabel: "Live", formatLabel: "LIVE",
            analysis: { source: "auto" }, edited: false,
            name: track.name, duration: track.duration, bpm: track.bpm,
            key, rootMidi: keyRootMidi(key), timeSignature: track.timeSignature || "4/4"
          });
          renderStats();
        }
      };

      function startAnimationLoop() {
        const frame = (now) => {
          if (!document.hidden) {
            if (state.isPlaying && now - state.frameAt > 32) {
              drawActiveVisualizer();
              state.frameAt = now;
            }
            if (state.isPlaying && now - state.uiAt > 100) {
              updateTransport();
              state.uiAt = now;
            }
            if (poly.playing) updatePolyAnimation();
          }
          requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }

      function installCanvasEvents() {
        if (el.vizCanvas) {
          el.vizCanvas.addEventListener("pointermove", (event) => {
            if (state.view !== "waveform" || !state.buffer) return;
            const rect = el.vizCanvas.getBoundingClientRect();
            const layout = waveformLayout(rect.width, rect.height);
            const x = event.clientX - rect.left;
            if (x >= layout.padLeft && x <= rect.width - layout.padRight) {
              state.waveHoverX = x;
              drawWaveform();
            } else if (state.waveHoverX !== null) {
              state.waveHoverX = null;
              drawWaveform();
            }
          });
          el.vizCanvas.addEventListener("pointerleave", () => {
            if (state.waveHoverX !== null) {
              state.waveHoverX = null;
              drawWaveform();
            }
          });
          el.vizCanvas.addEventListener("click", (event) => {
            if (state.view !== "waveform" || !state.buffer) return;
            const rect = el.vizCanvas.getBoundingClientRect();
            const layout = waveformLayout(rect.width, rect.height);
            const plotWidth = rect.width - layout.padLeft - layout.padRight;
            const progress = clamp((event.clientX - rect.left - layout.padLeft) / plotWidth, 0, 1);
            seekTo(progress * state.buffer.duration);
          });
        }

        if (el.pitchCanvas) {
          el.pitchCanvas.addEventListener("pointermove", (event) => {
            const rect = el.pitchCanvas.getBoundingClientRect();
            const padLeft = rect.width < 420 ? 34 : 42;
            const padRight = rect.width < 420 ? 10 : 16;
            const plotWidth = rect.width - padLeft - padRight;
            if (event.clientX < rect.left + padLeft || event.clientX > rect.right - padRight) return;
            const ratio = clamp((event.clientX - rect.left - padLeft) / plotWidth, 0, 1);
            state.pitchHoverN = Math.round(ratio * 24 - 12);
            drawPitchGraph();
          });
          el.pitchCanvas.addEventListener("pointerleave", () => {
            state.pitchHoverN = null;
            drawPitchGraph();
          });
          el.pitchCanvas.addEventListener("click", (event) => {
            if (state.pitchHoverN === null) return;
            setPitchN(state.pitchHoverN, { play: false });
          });
        }

        const resize = () => {
          if (state.resizeQueued) return;
          state.resizeQueued = true;
          requestAnimationFrame(() => {
            state.resizeQueued = false;
            drawActiveVisualizer();
            drawPitchGraph();
          });
        };
        if ("ResizeObserver" in window) {
          const observer = new ResizeObserver(resize);
          if (el.vizCanvas) observer.observe(el.vizCanvas);
          if (el.pitchCanvas) observer.observe(el.pitchCanvas);
        }
        window.addEventListener("resize", resize, { passive: true });
        if (document.fonts && document.fonts.ready) {
          document.fonts.ready.then(() => {
            drawActiveVisualizer();
            drawPitchGraph();
          }).catch(() => {});
        }
      }


      const WHITE_KEYS = [
        { n: -9, name: "C", octave: 4 },
        { n: -7, name: "D", octave: 4 },
        { n: -5, name: "E", octave: 4 },
        { n: -4, name: "F", octave: 4 },
        { n: -2, name: "G", octave: 4 },
        { n: 0, name: "A", octave: 4 },
        { n: 2, name: "B", octave: 4 }
      ];
      const BLACK_KEYS = [
        { n: -8, name: "C♯", position: 1 },
        { n: -6, name: "D♯", position: 2 },
        { n: -3, name: "F♯", position: 4 },
        { n: -1, name: "G♯", position: 5 },
        { n: 1, name: "A♯", position: 6 }
      ];

      function buildPiano() {
        if (!el.piano) return;
        el.piano.innerHTML = "";
        const fragment = document.createDocumentFragment();
        WHITE_KEYS.forEach((key) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "piano-key white";
          button.dataset.n = String(key.n);
          button.setAttribute("aria-label", `${key.name}${key.octave}, ${freqForN(key.n).toFixed(2)} hertz`);
          button.innerHTML = `<span>${key.name}</span><small>${key.octave}</small>`;
          button.addEventListener("click", () => setPitchN(key.n, { play: true }));
          fragment.appendChild(button);
        });
        BLACK_KEYS.forEach((key) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "piano-key black";
          button.dataset.n = String(key.n);
          button.style.left = `${(key.position / 7) * 100}%`;
          button.setAttribute("aria-label", `${key.name}${4}, ${freqForN(key.n).toFixed(2)} hertz`);
          button.addEventListener("click", () => setPitchN(key.n, { play: true }));
          fragment.appendChild(button);
        });
        el.piano.appendChild(fragment);
      }

      function buildRootSelect() {
        if (!el.rootSelect) return;
        el.rootSelect.innerHTML = "";
        for (let midi = 48; midi <= 83; midi += 1) {
          const option = document.createElement("option");
          option.value = String(midi);
          option.textContent = noteFromMidi(midi);
          el.rootSelect.appendChild(option);
        }
        el.rootSelect.value = String(state.rootMidi);
      }

      function setPitchN(n, { play = false } = {}) {
        const clamped = clamp(Math.round(Number(n) || 0), -12, 12);
        state.pitchN = clamped;
        const midi = 69 + clamped;
        const parts = notePartsFromMidi(midi);
        const frequency = freqForN(clamped);
        const ratio = Math.pow(2, clamped / 12);
        if (el.noteName) el.noteName.innerHTML = `${parts.name}<sup>${parts.octave}</sup>`;
        if (el.noteFreq) el.noteFreq.textContent = frequency.toFixed(2);
        if (el.noteSemitones) el.noteSemitones.textContent = `n = ${clamped > 0 ? "+" : ""}${clamped}`;
        if (el.noteRatio) el.noteRatio.textContent = `× ${ratio.toFixed(4)} from A4`;
        if (el.semitoneSlider) el.semitoneSlider.value = String(clamped);
        if (el.semitoneOutput) el.semitoneOutput.textContent = `n = ${clamped > 0 ? "+" : ""}${clamped}`;
        if (el.graphCurrent) el.graphCurrent.textContent = `n = ${clamped > 0 ? "+" : ""}${clamped} · ${frequency.toFixed(2)} Hz`;
        $$(".piano-key", el.piano || document).forEach((key) => {
          key.classList.toggle("is-active", Number(key.dataset.n) === clamped);
        });
        setRangeFill(el.semitoneSlider);
        drawPitchGraph();
        if (play) playSine(frequency, `${parts.name}${parts.octave}`);
      }

      function playSine(frequency, noteLabel) {
        try {
          const ctx = ensureAudio();
          if (ctx.state === "suspended") ctx.resume().catch(() => {});
          const now = ctx.currentTime;
          if (state.pitchTone) {
            const previous = state.pitchTone;
            try {
              previous.gain.gain.cancelScheduledValues(now);
              previous.gain.gain.setTargetAtTime(0.0001, now, 0.01);
              previous.oscillator.stop(now + 0.06);
            } catch (error) {}
          }
          const oscillator = ctx.createOscillator();
          const gain = ctx.createGain();
          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(frequency, now);
          gain.gain.setValueAtTime(0.0001, now);
          gain.gain.exponentialRampToValueAtTime(0.17, now + 0.018);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.15);
          oscillator.connect(gain);
          gain.connect(ctx.destination);
          oscillator.start(now);
          oscillator.stop(now + 1.22);
          const token = { oscillator, gain };
          state.pitchTone = token;
          oscillator.onended = () => {
            if (state.pitchTone === token) state.pitchTone = null;
            try { oscillator.disconnect(); gain.disconnect(); } catch (error) {}
          };
          if (el.toneStatus) el.toneStatus.textContent = `♪ ${noteLabel} · ${frequency.toFixed(2)} Hz`;
        } catch (error) {
          showToast("The sine reference could not play in this browser.", "error");
        }
      }

      function setRootMidi(midi, { announce = false } = {}) {
        const next = clamp(Math.round(midi), 48, 83);
        state.rootMidi = next;
        if (state.track) {
          state.track.rootMidi = next;
          state.track.key = makeKey(pitchClass(next), state.track.key?.mode || "major", 0);
          state.track.edited = true;
          syncCurrentTrackToSession();
          updateTrackUI();
          updateAnalysisUI();
        }
        if (el.rootSelect) el.rootSelect.value = String(next);
        renderStats();
        if (announce) showToast(`Root set to ${noteFromMidi(next)} · ${keyLabel(state.track?.key)}.`);
      }

      function setKeyMode(mode) {
        if (!state.track) return;
        const tonic = state.track.key?.tonicPc ?? pitchClass(state.rootMidi);
        state.track.key = makeKey(tonic, mode, 0);
        state.track.edited = true;
        syncCurrentTrackToSession();
        updateTrackUI();
        updateAnalysisUI();
        renderStats();
      }

      function setMeter(meter) {
        if (!state.track || !/^(2\/4|3\/4|4\/4|6\/8)$/.test(meter)) return;
        state.track.timeSignature = meter;
        state.track.edited = true;
        syncCurrentTrackToSession();
        updateTrackUI();
        updateAnalysisUI();
        updateVizCopy();
        drawActiveVisualizer();
        renderStats();
      }

      function playTone() {
        const midi = 69 + state.pitchN;
        const parts = notePartsFromMidi(midi);
        playSine(freqForN(state.pitchN), `${parts.name}${parts.octave}`);
      }

      function setPolyRatio(x, y, { announce = false } = {}) {
        const nextX = clamp(Math.round(x), 2, 9);
        const nextY = clamp(Math.round(y), 2, 9);
        if (nextX === nextY) {
          showToast("Choose two different pulse counts.", "error");
          return;
        }
        const wasPlaying = poly.playing;
        if (wasPlaying) stopPoly();
        poly.x = nextX;
        poly.y = nextY;
        updatePolyUI();
        if (wasPlaying) startPoly();
        if (announce) showToast(`${nextX} against ${nextY}: the grid resolves every ${lcm(nextX, nextY)} steps.`);
      }

      function updatePolyUI() {
        if (!el.polyRows) return;
        const x = poly.x;
        const y = poly.y;
        const steps = lcm(x, y);
        const beatInterval = 60 / state.bpm;
        const cycleDuration = beatInterval * 4;
        const stepDuration = cycleDuration / steps;
        poly.cycleDur = cycleDuration;
        if (el.lcmValue) el.lcmValue.textContent = String(steps);
        if (el.lcmCaption) el.lcmCaption.textContent = `LCM(${x}, ${y}) = ${steps}`;
        if (el.polyCycleTime) el.polyCycleTime.textContent = `Cycle = 4 beats · ${cycleDuration.toFixed(3)} s`;
        if (el.polyStepTime) el.polyStepTime.textContent = `Step = ${stepDuration.toFixed(3)} s`;
        if (el.seqTitle) el.seqTitle.innerHTML = `<strong>${x} : ${y}</strong> · ${x} against ${y}`;
        if (el.seqStepReadout) el.seqStepReadout.textContent = `step — / ${steps}`;
        if (el.seqCaption) el.seqCaption.textContent = `Step = ${stepDuration.toFixed(3)} s`;
        if (el.polyTempoLabel) el.polyTempoLabel.textContent = `Tempo-locked · ${formatBpm(state.bpm)} BPM`;
        el.ratioButtons.forEach((button) => {
          button.setAttribute("aria-pressed", String(Number(button.dataset.x) === x && Number(button.dataset.y) === y));
        });
        renderPolyGrid(steps);
      }

      function renderPolyGrid(steps) {
        if (!el.polyRows) return;
        el.polyRows.innerHTML = "";
        const rows = [
          { key: "a", letter: "A", count: poly.x, color: "cyan" },
          { key: "b", letter: "B", count: poly.y, color: "violet" }
        ];
        rows.forEach((row) => {
          const rowEl = document.createElement("div");
          rowEl.className = "poly-row";
          rowEl.dataset.row = row.key;
          const label = document.createElement("div");
          label.className = "poly-row-label";
          label.innerHTML = `<span class="row-letter">${row.letter}</span><span class="row-count"><strong>${row.count}</strong></span>`;
          const cells = document.createElement("div");
          cells.className = "poly-cells";
          cells.style.setProperty("--steps", String(steps));
          cells.setAttribute("role", "img");
          const hitSpacing = steps / row.count;
          cells.setAttribute("aria-label", `${row.count} pulses across ${steps} subdivisions.`);
          for (let step = 0; step < steps; step += 1) {
            const cell = document.createElement("span");
            cell.className = "poly-cell";
            cell.dataset.step = String(step);
            if (step % hitSpacing === 0) cell.classList.add("is-hit");
            cells.appendChild(cell);
          }
          rowEl.appendChild(label);
          rowEl.appendChild(cells);
          el.polyRows.appendChild(rowEl);
        });
        if (poly.playing) updatePolyAnimation(true);
      }

      function schedulePolyTick(time, frequency, gainValue, panValue) {
        const ctx = state.ctx;
        if (!ctx) return;
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(frequency, time);
        gain.gain.setValueAtTime(0.0001, time);
        gain.gain.exponentialRampToValueAtTime(gainValue, time + 0.004);
        gain.gain.exponentialRampToValueAtTime(0.0001, time + 0.082);
        oscillator.connect(gain);
        let output = gain;
        if (typeof ctx.createStereoPanner === "function") {
          const panner = ctx.createStereoPanner();
          panner.pan.setValueAtTime(panValue, time);
          gain.connect(panner);
          output = panner;
        }
        output.connect(ctx.destination);
        oscillator.start(time);
        oscillator.stop(time + 0.1);
        oscillator.onended = () => {
          try { oscillator.disconnect(); gain.disconnect(); output.disconnect(); } catch (error) {}
        };
      }

      function schedulePolyCycle(startTime) {
        const steps = lcm(poly.x, poly.y);
        const stepDuration = poly.cycleDur / steps;
        for (let step = 0; step < steps; step += 1) {
          const time = startTime + step * stepDuration;
          const accent = step === 0;
          if (step % (steps / poly.x) === 0) {
            schedulePolyTick(time, accent ? 1318.51 : 1046.5, accent ? 0.055 : 0.038, -0.58);
          }
          if (step % (steps / poly.y) === 0) {
            schedulePolyTick(time, accent ? 880 : 659.25, accent ? 0.045 : 0.032, 0.58);
          }
        }
      }

      function schedulePolyTicks() {
        if (!poly.playing || !state.ctx) return;
        const horizon = state.ctx.currentTime + 0.28;
        let guard = 0;
        while (poly.nextCycle < horizon && guard < 8) {
          if (poly.nextCycle >= state.ctx.currentTime - 0.02) schedulePolyCycle(poly.nextCycle);
          poly.nextCycle += poly.cycleDur;
          guard += 1;
        }
      }

      function startPoly() {
        if (poly.playing) return;
        try {
          const ctx = ensureAudio();
          if (ctx.state === "suspended") ctx.resume().catch(() => {});
          updatePolyUI();
          poly.playing = true;
          poly.lastStep = -1;
          poly.anchor = ctx.currentTime + 0.09;
          poly.nextCycle = poly.anchor;
          poly.timer = window.setInterval(schedulePolyTicks, 50);
          schedulePolyTicks();
          updatePolyButton();
          if (el.seqStepReadout) el.seqStepReadout.textContent = `count-in / ${lcm(poly.x, poly.y)}`;
        } catch (error) {
          showToast("The polyrhythm ticks could not start.", "error");
          poly.playing = false;
          updatePolyButton();
        }
      }

      function stopPoly() {
        if (poly.timer) {
          clearInterval(poly.timer);
          poly.timer = null;
        }
        poly.playing = false;
        poly.lastStep = -1;
        poly.anchor = 0;
        $$(".poly-cell.is-current").forEach((cell) => cell.classList.remove("is-current"));
        if (el.seqStepReadout) el.seqStepReadout.textContent = `step — / ${lcm(poly.x, poly.y)}`;
        updatePolyButton();
      }

      function restartPoly() {
        const wasPlaying = poly.playing;
        if (wasPlaying) stopPoly();
        updatePolyUI();
        if (wasPlaying) startPoly();
      }

      function updatePolyButton() {
        if (!el.polyPlayBtn) return;
        el.polyPlayBtn.setAttribute("aria-pressed", String(poly.playing));
        const playIcon = $(".poly-play-icon", el.polyPlayBtn);
        const stopIcon = $(".poly-stop-icon", el.polyPlayBtn);
        if (playIcon) playIcon.style.display = poly.playing ? "none" : "block";
        if (stopIcon) stopIcon.style.display = poly.playing ? "block" : "none";
        if (el.polyPlayLabel) el.polyPlayLabel.textContent = poly.playing ? "Stop" : "Play";
      }

      function updatePolyAnimation(force = false) {
        if (!poly.playing || !state.ctx) return;
        const steps = lcm(poly.x, poly.y);
        const elapsed = state.ctx.currentTime - poly.anchor;
        if (elapsed < 0) {
          if (el.seqStepReadout) el.seqStepReadout.textContent = `count-in / ${steps}`;
          return;
        }
        const phase = (elapsed % poly.cycleDur) / poly.cycleDur;
        const step = Math.min(steps - 1, Math.floor(phase * steps));
        if (step === poly.lastStep && !force) return;
        poly.lastStep = step;
        $$(".poly-cell", el.polyRows).forEach((cell) => {
          cell.classList.toggle("is-current", Number(cell.dataset.step) === step);
        });
        if (el.seqStepReadout) {
          el.seqStepReadout.textContent = `step ${String(step + 1).padStart(2, "0")} / ${steps}`;
        }
      }

      function summarize(values, modeDecimals = 0) {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        const count = sorted.length;
        const sum = sorted.reduce((total, value) => total + value, 0);
        const mean = sum / count;
        const middle = Math.floor(count / 2);
        const median = count % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
        const counts = new Map();
        sorted.forEach((value) => {
          const key = modeDecimals === 0 ? String(Math.round(value)) : value.toFixed(modeDecimals);
          counts.set(key, (counts.get(key) || 0) + 1);
        });
        let highestFrequency = 0;
        counts.forEach((frequency) => { highestFrequency = Math.max(highestFrequency, frequency); });
        const modes = highestFrequency > 1
          ? Array.from(counts.entries())
              .filter(([, frequency]) => frequency === highestFrequency)
              .map(([key]) => Number(key))
              .sort((a, b) => a - b)
          : [];
        return {
          count,
          mean,
          median,
          modes,
          min: sorted[0],
          max: sorted[count - 1],
          range: sorted[count - 1] - sorted[0]
        };
      }

      function statCell(label, value, unit, title = "") {
        return `<div class="stat-cell"><span>${label}</span><strong title="${escapeHTML(title || value)}">${value}</strong><small>${unit}</small></div>`;
      }

      function renderTempoStats(tracks) {
        if (!el.tempoValues) return;
        if (!tracks.length) {
          el.tempoValues.innerHTML = [
            statCell("Mean", "—", "BPM"),
            statCell("Median", "—", "BPM"),
            statCell("Mode", "—", "BPM"),
            statCell("Range", "—", "BPM")
          ].join("");
          renderRange(el.tempoRange, [], null, "tempo", "BPM");
          return;
        }
        const values = tracks.map((track) => track.bpm);
        const summary = summarize(values, 0);
        const modeText = summary.modes.length ? summary.modes.map(formatBpm).join(", ") : "No mode";
        el.tempoValues.innerHTML = [
          statCell("Mean", summary.mean.toFixed(1), "BPM"),
          statCell("Median", summary.median.toFixed(1), "BPM"),
          statCell("Mode", modeText, summary.modes.length > 1 ? "tied values" : "most frequent"),
          statCell("Range", formatBpm(summary.range), "BPM · max − min")
        ].join("");
        renderRange(el.tempoRange, values, summary, "tempo", "BPM");
      }

      function renderDurationStats(tracks) {
        if (!el.durationValues) return;
        if (!tracks.length) {
          el.durationValues.innerHTML = [
            statCell("Mean", "—", "min:sec"),
            statCell("Median", "—", "min:sec"),
            statCell("Mode", "—", "min:sec"),
            statCell("Range", "—", "min:sec")
          ].join("");
          renderRange(el.durationRange, [], null, "duration", "min:sec");
          return;
        }
        const values = tracks.map((track) => track.duration);
        const summary = summarize(values, 1);
        const modeText = summary.modes.length ? summary.modes.map((value) => formatTime(value, true)).join(", ") : "No mode";
        el.durationValues.innerHTML = [
          statCell("Mean", formatTime(summary.mean, true), "min:sec"),
          statCell("Median", formatTime(summary.median, true), "min:sec"),
          statCell("Mode", modeText, summary.modes.length > 1 ? "tied values" : "most frequent"),
          statCell("Range", formatTime(summary.range, true), "min:sec")
        ].join("");
        renderRange(el.durationRange, values, summary, "duration", "min:sec");
      }

      function renderRange(container, values, summary, kind, unit) {
        if (!container) return;
        if (!summary || !values.length) {
          container.innerHTML = `<p class="range-empty">The spread appears after the first track is logged.</p>`;
          return;
        }
        const min = summary.min;
        const max = summary.max;
        const scale = max - min;
        const pct = (value) => (scale > 0 ? clamp(((value - min) / scale) * 100, 1.5, 98.5) : 50);
        const meanPct = pct(summary.mean);
        const display = (value) => kind === "duration" ? formatTime(value, true) : `${formatBpm(value)} ${unit}`;
        const dots = values.slice(0, 40).map((value, index) => {
          const offset = ((index % 3) - 1) * 4;
          const label = kind === "duration" ? formatTime(value, true) : `${formatBpm(value)} BPM`;
          return `<span class="range-dot" style="left:${pct(value)}%; top:calc(50% + ${offset}px)" title="${escapeHTML(label)}"></span>`;
        }).join("");
        const a11y = `${kind === "duration" ? "Duration" : "Tempo"} range: minimum ${display(min)}, mean ${display(summary.mean)}, maximum ${display(max)}.`;
        container.innerHTML = `
          <div class="range-rail" role="img" aria-label="${escapeHTML(a11y)}">
            <div class="range-track"></div>
            <span class="range-mean" style="left:${meanPct}%" title="Mean ${escapeHTML(display(summary.mean))}"></span>
            ${dots}
          </div>
          <div class="range-labels">
            <span>min ${display(min)}</span>
            <span class="mean-label">mean ${display(summary.mean)}</span>
            <span>max ${display(max)}</span>
          </div>
          <p class="range-legend">${values.length} ${values.length === 1 ? "track" : "tracks"} · line = mean${values.length > 40 ? " · first 40 dots shown" : ""}</p>
        `;
      }

      function renderSessionTable() {
        if (!el.sessionBody) return;
        const reversed = [...state.tracks].reverse();
        if (!reversed.length) {
          el.sessionBody.innerHTML = `
            <tr class="empty-row">
              <td colspan="7">No tracks in this session. Upload a file${state.track ? ` or <button class="text-btn table-empty-action" type="button" data-add-current>add the current track</button>` : ""}.</td>
            </tr>
          `;
          return;
        }
        el.sessionBody.innerHTML = reversed.map((track) => {
          const isCurrent = state.track && track.id === state.track.id;
          const tags = [
            track.kind === "sample" ? '<span class="mini-tag sample">Sample</span>' : "",
            track.kind === "demo" ? '<span class="mini-tag demo">Demo</span>' : "",
            isCurrent ? '<span class="mini-tag current">Current</span>' : ""
          ].filter(Boolean).join("");
          const sourceLabel = track.kind === "sample" ? "Example dataset" : track.kind === "demo" ? "Generated demo" : track.kind === "live" ? "Live listening" : "Local upload";
          const interval = (60 / track.bpm).toFixed(3);
          const rootFrequency = midiToFreq(track.rootMidi).toFixed(2);
          return `
            <tr class="${isCurrent ? "is-current" : ""}">
              <td>
                <div class="table-track">
                  <div style="min-width:0">
                    <span class="table-track-title" title="${escapeHTML(track.name)}">${escapeHTML(track.name)}</span>
                    <small>${sourceLabel}</small>
                  </div>
                  ${tags}
                </div>
              </td>
              <td class="num">${formatTime(track.duration, true)}</td>
              <td class="num">${formatBpm(track.bpm)}</td>
              <td class="num">${interval} s</td>
              <td class="root-cell"><strong>${escapeHTML(keyLabel(track.key))}</strong><span>root ${noteFromMidi(track.rootMidi)} · ${rootFrequency} Hz</span></td>
              <td class="num">${escapeHTML(track.timeSignature || "4/4")}</td>
              <td>
                <button class="row-delete" type="button" data-delete="${escapeHTML(track.id)}" aria-label="Remove ${escapeHTML(track.name)} from the session">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M5 7h14M9 7V4.5h6V7M8 10v8M12 10v8M16 10v8M6.5 7l.7 13h9.6l.7-13"/></svg>
                </button>
              </td>
            </tr>
          `;
        }).join("");
      }

      function updateSessionMeta() {
        if (!el.sessionCount) return;
        const count = state.tracks.length;
        el.sessionCount.textContent = `${count} ${count === 1 ? "track" : "tracks"}`;
        if (el.sessionNote) {
          const hasSamples = state.tracks.some((track) => track.kind === "sample");
          el.sessionNote.textContent = count === 0
            ? "No tracks logged yet"
            : hasSamples
              ? "Includes samples"
              : "Live session data";
        }
        if (el.clearSessionBtn) {
          el.clearSessionBtn.disabled = count === 0;
          if (count === 0) resetClearButton();
        }
        if (el.logCurrentBtn) {
          const alreadyLogged = state.track && state.tracks.some((track) => track.id === state.track.id);
          el.logCurrentBtn.hidden = !state.track || Boolean(alreadyLogged);
        }
      }

      function renderStats() {
        renderTempoStats(state.tracks);
        renderDurationStats(state.tracks);
        renderSessionTable();
        updateSessionMeta();
      }

      function addCurrentTrackToSession() {
        if (!state.track) {
          showToast("Load a track before adding it to the session.", "error");
          return;
        }
        if (state.tracks.some((track) => track.id === state.track.id)) {
          showToast("This track is already in the session.");
          return;
        }
        state.tracks.push({ ...state.track });
        renderStats();
        showToast(`${state.track.name} added to the session table.`);
      }

      function syncCurrentTrackToSession() {
        if (!state.track) return;
        const row = state.tracks.find((track) => track.id === state.track.id);
        if (!row) return;
        row.name = state.track.name;
        row.duration = state.track.duration;
        row.bpm = state.bpm;
        row.rootMidi = state.rootMidi;
        row.key = state.track.key ? { ...state.track.key } : undefined;
        row.timeSignature = state.track.timeSignature || "4/4";
        row.analysis = state.track.analysis ? { ...state.track.analysis } : undefined;
        row.edited = Boolean(state.track.edited);
        row.kind = state.track.kind;
      }

      function deleteSessionTrack(id) {
        const track = state.tracks.find((item) => item.id === id);
        if (!track) return;
        state.tracks = state.tracks.filter((item) => item.id !== id);
        resetClearButton();
        renderStats();
        showToast(`${track.name} removed from the session.`);
      }

      function resetClearButton() {
        state.clearArmed = false;
        clearTimeout(state.clearTimer);
        if (!el.clearSessionBtn) return;
        el.clearSessionBtn.textContent = "Clear session";
        el.clearSessionBtn.classList.remove("clear-armed");
      }

      function handleClearSession() {
        if (!el.clearSessionBtn) return;
        if (!state.clearArmed) {
          state.clearArmed = true;
          el.clearSessionBtn.textContent = "Confirm clear?";
          el.clearSessionBtn.classList.add("clear-armed");
          clearTimeout(state.clearTimer);
          state.clearTimer = window.setTimeout(resetClearButton, 4200);
          return;
        }
        state.tracks = [];
        resetClearButton();
        renderStats();
        showToast("Session cleared. Uploads can start a new data set.");
      }

      function setBpm(value, source = "manual") {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return;
        const next = clamp(Math.round(numeric * 10) / 10, 30, 300);
        state.bpm = next;
        if (state.track) {
          state.track.bpm = next;
          state.track.edited = true;
        }
        syncCurrentTrackToSession();
        updateBpmUI();
        updateMetrics();
        updateTransport();
        updateAnalysisUI();
        updatePolyUI();
        if (poly.playing) restartPoly();
        renderStats();
        updateVizCopy();
        drawActiveVisualizer();
        if (source !== "tap") {
          state.tapTimes = [];
          if (el.tapHint) el.tapHint.textContent = `${formatBpm(next)} BPM`;
        }
      }

      function nudgeBpm(delta) {
        setBpm(state.bpm + delta, "manual");
        if (el.bpmInput) el.bpmInput.value = formatBpm(state.bpm);
      }

      function tapTempo() {
        const now = performance.now();
        if (state.tapTimes.length && now - state.tapTimes[state.tapTimes.length - 1] > 2000) {
          state.tapTimes = [];
        }
        state.tapTimes.push(now);
        if (state.tapTimes.length > 8) state.tapTimes.shift();
        if (el.tapBtn) {
          el.tapBtn.classList.add("is-tapping");
          window.setTimeout(() => el.tapBtn.classList.remove("is-tapping"), 110);
        }
        clearTimeout(state.tapResetTimer);
        state.tapResetTimer = window.setTimeout(() => {
          state.tapTimes = [];
          if (el.tapHint) el.tapHint.textContent = "Tap 4× or type BPM";
        }, 2400);
        if (state.tapTimes.length === 1) {
          if (el.tapHint) el.tapHint.textContent = "Tap again…";
          return;
        }
        const intervals = [];
        for (let i = 1; i < state.tapTimes.length; i += 1) {
          const interval = state.tapTimes[i] - state.tapTimes[i - 1];
          if (interval >= 190 && interval <= 2100) intervals.push(interval);
        }
        if (!intervals.length) return;
        intervals.sort((a, b) => a - b);
        const median = intervals[Math.floor(intervals.length / 2)];
        const bpm = clamp(Math.round(60000 / median), 30, 300);
        setBpm(bpm, "tap");
        if (el.tapHint) el.tapHint.textContent = `${bpm} BPM from ${state.tapTimes.length} taps · keep tapping to refine.`;
      }

      function openConcepts(trigger = null) {
        if (!el.conceptDrawer) return;
        state.drawerOpen = true;
        state.drawerReturnFocus = trigger || document.activeElement;
        el.conceptDrawer.hidden = false;
        document.body.classList.add("modal-open");
        if (el.closeConcepts) el.closeConcepts.focus();
        requestAnimationFrame(() => {
          if (el.closeConcepts) el.closeConcepts.focus();
        });
      }

      function closeConcepts() {
        if (!el.conceptDrawer) return;
        state.drawerOpen = false;
        el.conceptDrawer.hidden = true;
        document.body.classList.remove("modal-open");
        if (state.drawerReturnFocus && typeof state.drawerReturnFocus.focus === "function") {
          state.drawerReturnFocus.focus();
        }
        state.drawerReturnFocus = null;
      }

      function trapDrawerFocus(event) {
        if (!state.drawerOpen) return;
        if (event.key === "Escape") {
          event.preventDefault();
          closeConcepts();
          return;
        }
        if (event.key !== "Tab" || !el.conceptDrawer) return;
        const focusables = $$('a[href], button:not([disabled]), input, select, textarea, [tabindex]', el.conceptDrawer)
          .filter((node) => node.offsetParent !== null && node.tabIndex >= 0);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }

      function bindEvents() {
        el.playBtn?.addEventListener("click", togglePlayback);
        el.loopBtn?.addEventListener("click", () => setLoop(!state.loop));
        el.bpmDown?.addEventListener("click", () => nudgeBpm(-1));
        el.bpmUp?.addEventListener("click", () => nudgeBpm(1));
        el.halfTempoBtn?.addEventListener("click", () => setBpm(state.bpm / 2, "manual"));
        el.doubleTempoBtn?.addEventListener("click", () => setBpm(state.bpm * 2, "manual"));
        el.tapBtn?.addEventListener("click", tapTempo);
        el.loadDemo?.addEventListener("click", () => loadDemoTrack({ announce: true }));
        el.playToneBtn?.addEventListener("click", playTone);
        el.resetPitchBtn?.addEventListener("click", () => {
          setPitchN(0, { play: false });
          if (el.toneStatus) el.toneStatus.textContent = "A4 = 440.00 Hz · sine reference";
        });
        el.setRootBtn?.addEventListener("click", () => {
          if (!state.track) {
            showToast("Load a track before setting its root pitch.", "error");
            return;
          }
          setRootMidi(69 + state.pitchN, { announce: true });
        });

        el.semitoneSlider?.addEventListener("input", () => {
          setPitchN(Number(el.semitoneSlider.value), { play: false });
        });

        el.rootSelect?.addEventListener("change", () => {
          const midi = Number(el.rootSelect.value);
          if (Number.isFinite(midi)) setRootMidi(midi);
        });
        el.keyModeSelect?.addEventListener("change", () => {
          setKeyMode(el.keyModeSelect.value);
        });
        el.meterSelect?.addEventListener("change", () => {
          setMeter(el.meterSelect.value);
        });
        el.analyzeBtn?.addEventListener("click", analyzeCurrentTrack);

        el.volume?.addEventListener("input", () => {
          state.volume = clamp(Number(el.volume.value) / 100, 0, 1);
          if (state.masterGain) {
            state.masterGain.gain.setTargetAtTime(gainForVolume(state.volume), state.ctx.currentTime, 0.015);
          }
          setRangeFill(el.volume);
        });

        el.bpmInput?.addEventListener("input", () => {
          const value = Number(el.bpmInput.value);
          if (Number.isFinite(value) && value >= 30 && value <= 300) {
            el.bpmInput.classList.remove("bpm-input-invalid");
            setBpm(value, "input");
          } else {
            el.bpmInput.classList.add("bpm-input-invalid");
          }
        });
        const commitBpmInput = () => {
          const value = Number(el.bpmInput.value);
          if (!Number.isFinite(value)) {
            el.bpmInput.value = formatBpm(state.bpm);
            return;
          }
          setBpm(value, "manual");
          el.bpmInput.value = formatBpm(state.bpm);
          el.bpmInput.classList.remove("bpm-input-invalid");
        };
        el.bpmInput?.addEventListener("change", commitBpmInput);
        el.bpmInput?.addEventListener("blur", commitBpmInput);

        if (el.seekBar) {
          el.seekBar.addEventListener("pointerdown", () => {
            state.seeking = true;
          });
          el.seekBar.addEventListener("input", () => {
            state.seeking = true;
            state.seekPreview = Number(el.seekBar.value);
            if (el.currentTime) el.currentTime.textContent = formatTime(state.seekPreview);
            setRangeFill(el.seekBar);
          });
          const commitSeek = () => {
            if (state.seekPreview !== null) {
              const target = state.seekPreview;
              state.seekPreview = null;
              state.seeking = false;
              seekTo(target);
            } else {
              state.seeking = false;
            }
          };
          el.seekBar.addEventListener("change", commitSeek);
          el.seekBar.addEventListener("pointerup", commitSeek);
        }

        const openFilePicker = () => {
          if (state.loading) return;
          el.fileInput?.click();
        };
        el.dropzone?.addEventListener("click", openFilePicker);
        el.dropzone?.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openFilePicker();
          }
        });
        el.fileInput?.addEventListener("change", () => {
          const file = el.fileInput.files && el.fileInput.files[0];
          if (file) loadFile(file);
        });

        ["dragenter", "dragover"].forEach((type) => {
          el.dropzone?.addEventListener(type, (event) => {
            event.preventDefault();
            event.stopPropagation();
            el.dropzone.classList.add("is-dragover");
          });
        });
        ["dragleave", "dragend"].forEach((type) => {
          el.dropzone?.addEventListener(type, (event) => {
            event.preventDefault();
            event.stopPropagation();
            el.dropzone.classList.remove("is-dragover");
          });
        });
        el.dropzone?.addEventListener("drop", (event) => {
          event.preventDefault();
          event.stopPropagation();
          el.dropzone.classList.remove("is-dragover");
          const file = event.dataTransfer?.files?.[0];
          if (file) loadFile(file);
        });

        el.vizTabs.forEach((tab) => {
          tab.addEventListener("click", () => setView(tab.dataset.view));
          tab.addEventListener("keydown", (event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const next = state.view === "spectrum" ? "waveform" : "spectrum";
            setView(next, { focus: true });
          });
        });

        el.ratioButtons.forEach((button) => {
          button.addEventListener("click", () => setPolyRatio(Number(button.dataset.x), Number(button.dataset.y)));
        });
        el.polyPlayBtn?.addEventListener("click", () => {
          if (poly.playing) stopPoly();
          else startPoly();
        });

        el.logCurrentBtn?.addEventListener("click", addCurrentTrackToSession);
        el.clearSessionBtn?.addEventListener("click", handleClearSession);
        el.sessionBody?.addEventListener("click", (event) => {
          const deleteButton = event.target.closest("[data-delete]");
          if (deleteButton) {
            deleteSessionTrack(deleteButton.dataset.delete);
            return;
          }
          if (event.target.closest("[data-add-current]")) addCurrentTrackToSession();
        });

        el.conceptTriggers.forEach((trigger) => {
          trigger.addEventListener("click", () => openConcepts(trigger));
        });
        el.closeConcepts?.addEventListener("click", closeConcepts);
        el.drawerBackdrop?.addEventListener("click", closeConcepts);
        el.gotoConceptLinks.forEach((link) => {
          link.addEventListener("click", (event) => {
            event.preventDefault();
            const target = document.querySelector(link.getAttribute("href"));
            closeConcepts();
            if (target) window.setTimeout(() => target.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth" }), 80);
          });
        });
        document.addEventListener("keydown", trapDrawerFocus);
      }


      async function boot() {
        cacheElements();
        buildPiano();
        buildRootSelect();
        bindEvents();
        paintAllRanges();
        updateLoopButton();
        setPitchN(0, { play: false });
        updatePolyUI();
        renderStats();
        updateTransport();
        installCanvasEvents();
        setView("spectrum");
        startAnimationLoop();
        await loadDemoTrack();
      }

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", () => {
          boot().catch((error) => {
            console.error(error);
            showToast("The lab could not initialize completely. Reload the page to try again.", "error");
          });
        });
      } else {
        boot().catch((error) => {
          console.error(error);
          showToast("The lab could not initialize completely. Reload the page to try again.", "error");
        });
      }
    })();

