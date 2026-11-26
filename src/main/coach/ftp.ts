// Implied FTP. Pure.
// The heart-rate regression (B) is the estimate. Completed and failed intervals (A) are
// guard rails that the estimate may not cross.
import { FtpEntry, FtpEstimate, IntervalResult, Outcome, Segment } from '../../shared/types';

const DAY = 24 * 3600e3;
const K_POINTS: [number, number][] = [
  [3, 1.2],
  [5, 1.13],
  [8, 1.08],
  [12, 1.04],
  [20, 1.0],
];

/** Duration factor: how far above FTP a rider can hold power for this long. */
export function durationFactor(seconds: number): number {
  const m = seconds / 60;
  if (m <= K_POINTS[0][0]) return K_POINTS[0][1];
  for (let i = 1; i < K_POINTS.length; i++) {
    const [m1, k1] = K_POINTS[i];
    const [m0, k0] = K_POINTS[i - 1];
    if (m <= m1) return k0 + ((k1 - k0) * (m - m0)) / (m1 - m0);
  }
  return 1;
}

export interface FtpRide {
  startedAt: string;
  outcome: Outcome;
  intervals: IntervalResult[];
  segments: Segment[];
}

export interface FtpInput {
  ftp: number;
  ftpHistory: FtpEntry[];
  maxHr: number;
  rides: FtpRide[];
  now: Date;
}

export const MIN_SEGMENTS = 8;
export const MIN_HR_RANGE = 15;

export function regress(points: { hr: number; p: number }[]): { slope: number; intercept: number } | null {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((a, s) => a + s.hr, 0) / n;
  const my = points.reduce((a, s) => a + s.p, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const s of points) {
    sxx += (s.hr - mx) ** 2;
    sxy += (s.hr - mx) * (s.p - my);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

export function estimateFtp(input: FtpInput): FtpEstimate {
  const { ftp, maxHr, now } = input;
  const t = now.getTime();
  const rides = input.rides
    .filter((r) => Date.parse(r.startedAt) <= t)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const within = (r: FtpRide, days: number) => t - Date.parse(r.startedAt) <= days * DAY;
  const lthr = 0.9 * maxHr;

  // --- Estimate B ---
  const segs = rides.filter((r) => within(r, 42)).flatMap((r) => r.segments);
  const hrs = segs.map((s) => s.hr);
  const hrRange = segs.length ? Math.max(...hrs) - Math.min(...hrs) : 0;
  const fit = regress(segs);
  let ftpB: number | null = null;
  const bValid = segs.length >= MIN_SEGMENTS && hrRange >= MIN_HR_RANGE && !!fit && fit.slope > 0;
  if (bValid && fit) ftpB = fit.intercept + fit.slope * lthr;

  // --- Guard rail A ---
  let lower: { value: number; date: string } | null = null;
  for (const r of rides.filter((x) => within(x, 42))) {
    for (const iv of r.intervals) {
      if (iv.failed || iv.plannedS < 180) continue;
      const v = iv.avgPower / durationFactor(iv.plannedS);
      if (!lower || v > lower.value) lower = { value: v, date: r.startedAt };
    }
  }
  const failures: { value: number; date: string }[] = [];
  for (const r of rides.filter((x) => within(x, 28))) {
    for (const iv of r.intervals) {
      if (!iv.failed || iv.completedS === 0 || iv.endHr === null || iv.endHr < 0.9 * maxHr) continue;
      failures.push({ value: iv.peakTarget / durationFactor(iv.plannedS), date: r.startedAt });
    }
  }
  let upper = failures.length >= 2 ? failures.reduce((m, f) => (f.value > m.value ? f : m)) : null;
  if (lower && upper && lower.value > upper.value) {
    if (Date.parse(lower.date) >= Date.parse(upper.date)) upper = null;
    else lower = null;
  }

  // --- Combine ---
  let cand = ftpB ?? ftp;
  let decidedBy =
    ftpB !== null ? 'heart-rate regression' : 'not enough steady heart-rate data; no new estimate';
  if (lower && cand < lower.value) {
    cand = lower.value;
    decidedBy = 'raised to the lower bound from completed intervals';
  }
  if (upper && cand > upper.value) {
    cand = upper.value;
    decidedBy = 'held down by the upper bound from failed intervals';
  }

  const lastChange = [...input.ftpHistory].sort((a, b) => Date.parse(b.date) - Date.parse(a.date))[0];
  const since = lastChange ? Date.parse(lastChange.date) : rides.length ? Date.parse(rides[0].startedAt) : t;
  const ridesSince = rides.filter((r) => Date.parse(r.startedAt) > since).length;
  const firstRide = rides.length ? Date.parse(rides[0].startedAt) : t;
  const weeks = Math.min(1, (t - Math.max(since, firstRide)) / (7 * DAY));
  const cap = 0.03 * ftp * weeks;
  let next = Math.round(Math.min(ftp + cap, Math.max(ftp - cap, cand)));

  const last3 = rides.slice(-3);
  if (next !== ftp && ridesSince < 3) {
    next = ftp;
    decidedBy += '; waiting for 3 rides since the last change';
  } else if (Math.abs(next - ftp) < 2) {
    next = ftp;
    if (Math.abs(cand - ftp) >= 2) decidedBy += '; weekly cap leaves less than 2 W';
    else decidedBy += '; within 2 W of current';
  } else if (next < ftp && last3.length === 3 && last3.every((r) => r.outcome === 'success')) {
    next = ftp;
    decidedBy += '; not lowered because the last 3 rides were all successes';
  }

  return {
    date: now.toISOString(),
    ftpBefore: ftp,
    ftpAfter: next,
    applied: next !== ftp,
    decidedBy,
    maxHr,
    lthr: Math.round(lthr * 10) / 10,
    b: {
      valid: bValid,
      n: segs.length,
      hrRange: Math.round(hrRange * 10) / 10,
      slope: fit ? Math.round(fit.slope * 1000) / 1000 : 0,
      intercept: fit ? Math.round(fit.intercept * 10) / 10 : 0,
      ftpB: ftpB === null ? null : Math.round(ftpB * 10) / 10,
    },
    lower: lower && { value: Math.round(lower.value * 10) / 10, date: lower.date },
    upper: upper && { value: Math.round(upper.value * 10) / 10, date: upper.date },
  };
}
