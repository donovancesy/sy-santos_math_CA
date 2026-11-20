/* Sipra beat editor: tap along to set the tempo when Sipra hears it wrong.
 * Shared by the website and the extension.
 *
 *   SipraTapTempo.attach({ tap, auto, note, getEngine, getSongKey, onChange })
 *
 * Tap the button on each beat. After 4 taps the tempo is 60 / (median gap), and
 * a moment after the last tap it's handed to the engine, which re-tracks the
 * beats at that speed (it still finds where each beat lands). Remembered per song.
 * "Auto" goes back to Sipra's own tempo.
 */
(function (global) {
  "use strict";
  const KEY = "sipra-tempo-tap";
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } };
  const write = (all) => { try { localStorage.setItem(KEY, JSON.stringify(all)); } catch (e) {} };

  function attach(o) {
    let taps = [], timer = null;
    const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
    function bpmFromTaps() {
      if (taps.length < 4) return null;
      const recent = taps.slice(-9), gaps = [];
      for (let i = 1; i < recent.length; i += 1) gaps.push(recent[i] - recent[i - 1]);
      return 60000 / median(gaps);
    }
    function render() {
      const eng = o.getEngine();
      const manual = eng ? eng.manualBpm : null;
      if (o.auto) o.auto.hidden = !manual;
      if (o.tap) o.tap.setAttribute("aria-pressed", String(Boolean(manual)));
      if (!o.note) return;
      if (taps.length && taps.length < 4) o.note.textContent = `tap ${4 - taps.length} more…`;
      else if (taps.length >= 4) o.note.textContent = `♩ = ${Math.round(bpmFromTaps())} BPM`;
      else if (manual) o.note.textContent = `tapped ${Math.round(manual)} BPM`;
    }
    function apply() {
      const bpm = bpmFromTaps(), eng = o.getEngine();
      taps = [];
      if (!bpm || !eng || bpm < 30 || bpm > 300) { render(); return; }
      eng.setManualTempo(bpm);
      const k = o.getSongKey && o.getSongKey();
      if (k) { const all = read(); all[k] = Math.round(bpm * 10) / 10; write(all); }
      render();
      if (o.onChange) o.onChange(bpm);
    }
    o.tap && o.tap.addEventListener("click", () => {
      if (!o.getEngine()) return;
      const now = performance.now();
      if (taps.length && now - taps[taps.length - 1] > 2500) taps = [];
      taps.push(now);
      clearTimeout(timer);
      timer = setTimeout(apply, 1400); // applied once you stop tapping
      render();
    });
    o.auto && o.auto.addEventListener("click", () => {
      const eng = o.getEngine();
      if (!eng) return;
      taps = []; clearTimeout(timer);
      eng.setManualTempo(null);
      const k = o.getSongKey && o.getSongKey();
      if (k) { const all = read(); delete all[k]; write(all); }
      render();
      if (o.onChange) o.onChange(null);
    });
    return {
      render,
      /** Re-apply a tempo tapped earlier for this song (call when listening starts or the song changes). */
      restore() {
        const eng = o.getEngine(), k = o.getSongKey && o.getSongKey();
        if (!eng || !k) return;
        const bpm = read()[k];
        if (bpm && eng.manualBpm !== bpm) eng.setManualTempo(bpm);
        render();
      }
    };
  }

  global.SipraTapTempo = { attach };
})(typeof window !== "undefined" ? window : globalThis);
