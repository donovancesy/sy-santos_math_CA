/* Sipra: audio analysis building blocks.
   Extracted from the web app so the extension uses the same math.
   Pure functions on mono Float32Array PCM. */
(function (global) {
"use strict";
const TAU = Math.PI * 2;
const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
// Temperley-Kostka-Payne key profiles
const MAJOR_PROFILE = [0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400];
const MINOR_PROFILE = [0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067, 0.133, 0.330];
const fftPlanCache = new Map();
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function yieldToUI() { return new Promise((r) => setTimeout(r, 0)); }
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
      const score = onAverage; // off-beat hits (hi-hats) are normal, so they don't count against a tempo
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
  // Octave check: a strong pulse at a slow rate may really be the bar (x2 in 4/4,
  // x3 in 3/4), or a fast one may be eighth notes (/2). Compare the evidence.
  const scoreAt = (target) => {
    let s = -Infinity;
    for (const c of scores) if (Math.abs(c.bpm - target) <= Math.max(1, target * 0.012)) s = Math.max(s, c.score);
    return s;
  };
  let bpm = best.bpm;
  let multiple = 1;
  if (bpm < 85) {
    const s2 = bpm * 2 <= 200 ? scoreAt(bpm * 2) : -Infinity;
    const s3 = bpm * 3 <= 200 ? scoreAt(bpm * 3) : -Infinity;
    if (s3 > s2 * 1.04 && s3 > best.score * 0.55) multiple = 3;
    else if (s2 > best.score * 0.55) multiple = 2;
    else if (bpm < 70 && bpm * 2 <= 200) multiple = 2;
  } else if (bpm > 168 && bpm / 2 >= 55) {
    multiple = 0.5;
  }
  bpm *= multiple;
  const phase = multiple >= 1 ? best.phase % ((fps * 60) / bpm) : best.phase;
  return {
    bpm: Math.round(bpm * 10) / 10,
    confidence,
    phase,
    multiple
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

async function analyzeMono(mono, sampleRate) {
  const onset = await computeOnsetEnvelopes(mono, sampleRate);
  const tempo = detectTempoFromEnvelope(onset.flux, onset.lowFlux, onset.fps);
  const meter = detectTimeSignatureFromEnvelope(onset.flux, onset.lowFlux, onset.fps, tempo.bpm, tempo.phase);
  const key = await detectKeyFromMono(mono, sampleRate);
  return {
    bpm: tempo.bpm, bpmConfidence: tempo.confidence,
    beatPhaseSeconds: tempo.phase / onset.fps,
    key: { tonicPc: key.tonicPc, mode: key.mode, confidence: key.confidence },
    timeSignature: meter.timeSignature, meterConfidence: meter.confidence,
    seconds: mono.length / sampleRate
  };
}

const api = {
  analyzeMono, NOTE_NAMES, TAU, MAJOR_PROFILE, MINOR_PROFILE,
  getFFTPlan, fftWithPlan, percentile, sampleEnvelope, peakAround,
  detectTempoFromEnvelope, detectTimeSignatureFromEnvelope, clamp
};
global.SipraAnalysis = api;
global.MBMAnalysis = api; // old name, kept for compatibility
})(typeof window !== "undefined" ? window : globalThis);
