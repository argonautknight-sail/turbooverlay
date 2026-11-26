// Ride metrics computed from 1 Hz samples. Pure.
import { IntervalResult, Rating, RideHeader, RideSummary, Sample, Segment } from '../../shared/types';
import { classifyOutcome } from './progression';

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (x: number) => Math.round(x * 10) / 10;

/** Normalised Power: fourth root of the mean of (30 s rolling average power)^4. */
export function normalisedPower(power: number[]): number {
  if (power.length < 30) return mean(power);
  let sum = 0;
  for (let i = 0; i < 30; i++) sum += power[i];
  let acc = 0;
  let n = 0;
  for (let i = 29; i < power.length; i++) {
    if (i > 29) sum += power[i] - power[i - 30];
    acc += Math.pow(sum / 30, 4);
    n++;
  }
  return Math.pow(acc / n, 0.25);
}

export const tss = (durationS: number, np: number, ftp: number) =>
  ftp > 0 ? (durationS * Math.pow(np / ftp, 2)) / 36 : 0;

/** HR with strap glitches removed: a jump of more than 10 bpm in one second is dropped. */
export function cleanHr(samples: Sample[]): (number | null)[] {
  const out: (number | null)[] = [];
  let prev: number | null = null;
  for (const s of samples) {
    let v = s.hr;
    if (v !== null && (v < 30 || v > 230)) v = null;
    if (v !== null && prev !== null && Math.abs(v - prev) > 10) {
      out.push(null);
      prev = v; // accept the new baseline next second if it persists
      continue;
    }
    out.push(v);
    if (v !== null) prev = v;
  }
  return out;
}

/** Highest 5-second average of clean HR. */
export function peakHr5s(samples: Sample[]): number | null {
  const hr = cleanHr(samples);
  let best: number | null = null;
  for (let i = 4; i < hr.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = i - 4; j <= i; j++) {
      const v = hr[j];
      if (v === null) {
        ok = false;
        break;
      }
      sum += v;
    }
    if (ok && (best === null || sum / 5 > best)) best = sum / 5;
  }
  return best === null ? null : Math.round(best);
}

/**
 * Split samples into runs of steady riding at one power with no pause inside them.
 * Consecutive steps at the same power (a cadence drill, say) stay in one run.
 */
function runs(header: RideHeader, samples: Sample[]): Sample[][] {
  const steps = header.plan.steps;
  const samePower = (a: number, b: number) => {
    if (a === b) return true;
    const x = steps[a];
    const y = steps[b];
    return !!x && !!y && x.pctStart === x.pctEnd && y.pctStart === y.pctEnd && x.pctStart === y.pctStart;
  };
  const out: Sample[][] = [];
  let cur: Sample[] = [];
  for (const s of samples) {
    const last = cur[cur.length - 1];
    if (last && (!samePower(s.i, last.i) || s.w - last.w > 2)) {
      out.push(cur);
      cur = [];
    }
    cur.push(s);
  }
  if (cur.length) out.push(cur);
  return out;
}

const SKIP_S = 120;
const CHUNK_S = 300;
const MIN_CHUNK_S = 180;

/** Steady chunks for the HR–power regression: steady step ≥ 5 min, first 2 min skipped. */
export function steadySegments(header: RideHeader, samples: Sample[]): Segment[] {
  const out: Segment[] = [];
  const hrAll = cleanHr(samples);
  const index = new Map<Sample, number>();
  samples.forEach((s, k) => index.set(s, k));
  for (const run of runs(header, samples)) {
    const st = header.plan.steps[run[0].i];
    if (!st || st.pctStart !== st.pctEnd || run.length < CHUNK_S) continue;
    for (let a = SKIP_S; a < run.length; a += CHUNK_S) {
      const chunk = run.slice(a, a + CHUNK_S);
      if (chunk.length < MIN_CHUNK_S) break;
      const xs = chunk.map((s) => s.x);
      if (Math.max(...xs) - Math.min(...xs) > 0.001) continue;
      const hr = chunk.map((s) => hrAll[index.get(s)!]).filter((v): v is number => v !== null);
      if (hr.length < 0.95 * chunk.length) continue;
      // CV on a 10 s rolling mean, so normal second-to-second trainer noise does not disqualify.
      const p = chunk.map((s) => s.p);
      const smooth: number[] = [];
      for (let k = 9; k < p.length; k++) smooth.push(mean(p.slice(k - 9, k + 1)));
      const m = mean(smooth);
      const sd = Math.sqrt(mean(smooth.map((v) => (v - m) ** 2)));
      if (m <= 0 || sd / m > 0.05) continue;
      out.push({ t0: chunk[0].t, s: chunk.length, p: r1(mean(p)), hr: r1(mean(hr)) });
    }
  }
  return out;
}

/** Watts per heartbeat on easy steady riding (60–75% FTP) at least 10 min into the ride. */
export function efficiency(segments: Segment[], ftp: number): number | null {
  const ok = segments.filter((s) => s.t0 >= 600 && s.p / ftp >= 0.6 && s.p / ftp <= 0.75 && s.hr > 0);
  const time = ok.reduce((a, s) => a + s.s, 0);
  if (!time) return null;
  return Math.round((ok.reduce((a, s) => a + (s.p / s.hr) * s.s, 0) / time) * 1000) / 1000;
}

/** Per-interval results for work intervals of 3 min or more at Sweet Spot or above. */
export function intervalResults(header: RideHeader, samples: Sample[]): IntervalResult[] {
  const hrAll = cleanHr(samples);
  const out: IntervalResult[] = [];
  header.plan.steps.forEach((st, idx) => {
    if (st.kind !== 'work' || st.durationS < 180 || st.pctStart < 0.88) return;
    const ks: number[] = [];
    samples.forEach((s, k) => s.i === idx && ks.push(k));
    if (!ks.length) {
      out.push({
        stepIndex: idx,
        pct: st.pctStart,
        plannedS: st.durationS,
        completedS: 0,
        avgPower: 0,
        peakTarget: Math.round(st.pctStart * header.ftp),
        endHr: null,
        failed: true,
      });
      return;
    }
    const own = ks.map((k) => samples[k]);
    const endHr = ks
      .slice(-30)
      .map((k) => hrAll[k])
      .filter((v): v is number => v !== null);
    const cut = own[own.length - 1].x < own[0].x * 0.92 - 1e-9;
    out.push({
      stepIndex: idx,
      pct: st.pctStart,
      plannedS: st.durationS,
      completedS: own.length,
      avgPower: r1(mean(own.map((s) => s.p))),
      peakTarget: Math.max(...own.map((s) => s.tp)),
      endHr: endHr.length >= 10 ? Math.round(mean(endHr)) : null,
      failed: own.length < 0.98 * st.durationS || cut,
    });
  });
  return out;
}

export function summarise(
  header: RideHeader,
  samples: Sample[],
  endedAt: string,
  rating: Rating | null = null,
): RideSummary {
  const power = samples.map((s) => s.p);
  const hr = cleanHr(samples).filter((v): v is number => v !== null);
  const np = normalisedPower(power);
  const workPlannedS = header.plan.steps.reduce((a, s) => a + (s.isWork ? s.durationS : 0), 0);
  const work = samples.filter((s) => header.plan.steps[s.i]?.isWork);
  const netIntensity = work.length ? mean(work.map((s) => s.x)) - 1 : 0;
  const segments = steadySegments(header, samples);
  const workCompletedS = Math.min(work.length, workPlannedS);
  return {
    ...header,
    finished: true,
    endedAt,
    durationS: samples.length,
    avgPower: Math.round(mean(power)),
    avgHr: hr.length ? Math.round(mean(hr)) : null,
    avgCadence: Math.round(mean(samples.map((s) => s.cad))),
    peakHr5s: peakHr5s(samples),
    np: Math.round(np),
    intensityFactor: header.ftp ? Math.round((np / header.ftp) * 100) / 100 : 0,
    tss: Math.round(tss(samples.length, np, header.ftp)),
    workPlannedS,
    workCompletedS,
    netIntensity: Math.round(netIntensity * 1000) / 1000,
    intervals: intervalResults(header, samples),
    segments,
    efficiency: efficiency(segments, header.ftp),
    outcome: classifyOutcome({ workPlannedS, workCompletedS, netIntensity, rating }),
    rating,
    levelChange: null,
  };
}
