/* Sipra chord chart: draws the engine's bar-by-bar transcription.
 * Shared by the website (Live) and the extension's side panel.
 *
 *   const view = SipraChart.mount(container, { onCopy })
 *   view.update(result, meta)   // result from SipraEngine/SipraListener.update()
 *   view.clear()
 */
(function (global) {
  "use strict";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function mount(root, options = {}) {
    root.classList.add("sc");
    root.innerHTML = `
      <div class="sc-head">
        <span class="sc-title">Chart</span>
        <div class="sc-tools">
          <button type="button" class="sc-btn" data-sc="names" aria-pressed="false" title="Show chord names or Roman numerals">I–V</button>
          <button type="button" class="sc-btn" data-sc="copy" disabled title="Copy the chart as text">Copy</button>
        </div>
      </div>
      <p class="sc-loop" hidden></p>
      <p class="sc-meta"></p>
      <p class="sc-joined" hidden></p>
      <ol class="sc-bars" aria-label="Chords, bar by bar"></ol>
      <p class="sc-empty">The chart fills in bar by bar once the beat is found.</p>`;
    const el = {
      loop: root.querySelector(".sc-loop"), meta: root.querySelector(".sc-meta"), joined: root.querySelector(".sc-joined"),
      bars: root.querySelector(".sc-bars"), empty: root.querySelector(".sc-empty"),
      names: root.querySelector('[data-sc="names"]'), copy: root.querySelector('[data-sc="copy"]')
    };
    let roman = false;
    try { roman = localStorage.getItem("sipra-chart-roman") === "1"; } catch (e) {}
    let last = { result: null, meta: {} }, sig = "", stick = true;
    el.names.setAttribute("aria-pressed", String(roman));

    // Follow the newest bar unless the reader scrolled up to look back.
    el.bars.addEventListener("scroll", () => {
      stick = el.bars.scrollTop + el.bars.clientHeight >= el.bars.scrollHeight - 8;
    });
    el.names.addEventListener("click", () => {
      roman = !roman;
      el.names.setAttribute("aria-pressed", String(roman));
      try { localStorage.setItem("sipra-chart-roman", roman ? "1" : "0"); } catch (e) {}
      sig = "";
      update(last.result, last.meta);
    });
    el.copy.addEventListener("click", async () => {
      const r = last.result;
      if (!r || !r.chart) return;
      let text = global.SipraEngine.chartText(r.chart, metaFor(r, last.meta));
      const j = last.meta.joinedAt;
      if (Number.isFinite(j) && j > 4) text += `

(Chart starts ${Math.floor(j / 60)}:${String(Math.floor(j % 60)).padStart(2, "0")} into the song.)`;
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
        // Fallback for pages without clipboard permission.
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.append(ta); ta.select();
        try { ok = document.execCommand("copy"); } catch (err) {}
        ta.remove();
      }
      el.copy.textContent = ok ? "Copied" : "Couldn't copy";
      setTimeout(() => { el.copy.textContent = "Copy"; }, 1600);
      if (options.onCopy) options.onCopy(text, ok);
    });

    function metaFor(r, meta) {
      const N = global.SipraEngine.NOTE_NAMES;
      const k = r.keyNow || r.key;
      return {
        title: meta.title, artist: meta.artist, bpm: r.bpm,
        key: k ? `${N[k.tonicPc]} ${k.mode}${r.keyNow ? ` (key change from ${N[r.key.tonicPc]} ${r.key.mode})` : ""}` : "",
        tuning: r.tuning && Math.abs(r.tuning.cents) >= 5 ? `A4 = ${r.tuning.a4.toFixed(1)} Hz` : ""
      };
    }

    function label(c) { return roman && c.roman ? c.roman : c.name; }

    function update(r, meta = {}) {
      last = { result: r, meta };
      const chart = r && r.ready ? r.chart : null;
      const bars = chart ? chart.bars : [];
      el.copy.disabled = !bars.length;
      el.empty.hidden = bars.length > 0;
      if (!chart) { el.bars.innerHTML = ""; el.loop.hidden = true; el.joined.hidden = true; el.meta.textContent = ""; sig = ""; return; }

      // Loop line: the progression that keeps coming back.
      const loop = chart.loop;
      if (loop) {
        const names = (roman ? loop.romans : loop.names).map(esc).join(" → ");
        const other = (roman ? loop.names : loop.romans).filter(Boolean).map(esc).join(" – ");
        el.loop.innerHTML = `<span>Loop · ${loop.bars} bar${loop.bars > 1 ? "s" : ""}</span><b>${names}</b>${other ? `<small>${other}</small>` : ""}`;
        el.loop.hidden = false;
      } else el.loop.hidden = true;

      // Facts: tempo trend, tuning, harmonic rhythm.
      const facts = [];
      if (chart.meter) facts.push(`${chart.meter}${chart.meterFromChords ? " (from chord changes)" : ""}`);
      const t = r.tempo;
      if (t) {
        if (t.trend === "steady") facts.push(`tempo steady ±${t.sd.toFixed(1)}`);
        else if (t.trend === "loose") facts.push(`tempo varies ${Math.round(t.min)}–${Math.round(t.max)}`);
        else facts.push(`${t.trend} ${t.perMinute > 0 ? "+" : ""}${t.perMinute.toFixed(1)} BPM/min`);
      }
      if (r.tuning) facts.push(Math.abs(r.tuning.cents) >= 5 ? `tuned ${r.tuning.cents > 0 ? "+" : ""}${r.tuning.cents}¢ (A4 = ${r.tuning.a4.toFixed(1)} Hz)` : "A4 = 440 Hz");
      if (chart.changesPerMinute !== null) facts.push(`${chart.changesPerMinute} changes/min`);
      el.meta.textContent = facts.join(" · ");
      // Joined partway through: say so, so nobody mistakes bar 1 for the top of the song.
      const j = meta.joinedAt;
      if (Number.isFinite(j) && j > 4) {
        el.joined.textContent = `Started listening at ${Math.floor(j / 60)}:${String(Math.floor(j % 60)).padStart(2, "0")}, so the chart begins there, not at the top of the song. Replay the song from the start for the whole chart.`;
        el.joined.hidden = false;
      } else el.joined.hidden = true;

      // Bars: rebuild only when something changed.
      const s = (roman ? "R" : "N") + bars.map((b) => b.number + ":" + b.chords.map((c) => c.name + c.beats).join(",")).join("|");
      if (s === sig) return;
      sig = s;
      const perRow = 4;
      const loopLen = loop ? loop.bars : 0;
      const html = bars.map((b, i) => {
        const now = i === bars.length - 1;
        const start = loopLen > 1 && b.number > 0 && (b.number - 1) % loopLen === 0;
        const cells = b.chords.length
          ? b.chords.map((c) => `<span class="sc-c" style="flex-grow:${c.beats}" title="${esc(c.name)}${c.roman ? " · " + esc(c.roman) : ""} · ${c.beats} beat${c.beats > 1 ? "s" : ""}">${esc(label(c))}</span>`).join("")
          : `<span class="sc-c sc-nc">N.C.</span>`;
        return `<li class="sc-bar${now ? " now" : ""}${start ? " loop-start" : ""}${b.pickup ? " pickup" : ""}"><i>${b.pickup ? "pick" : b.number}</i>${cells}</li>`;
      }).join("");
      el.bars.style.setProperty("--sc-per-row", perRow);
      el.bars.innerHTML = html;
      if (stick) el.bars.scrollTop = el.bars.scrollHeight;
    }

    function clear() { update(null); }
    return { update, clear };
  }

  global.SipraChart = { mount };
})(typeof window !== "undefined" ? window : globalThis);
