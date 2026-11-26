import { describe, expect, it } from 'vitest';
import { durationFactor, estimateFtp, FtpRide } from '../src/main/coach/ftp';
import { cleanHr, normalisedPower, peakHr5s, summarise, tss } from '../src/main/coach/metrics';
import { buildSteps } from '../src/main/coach/generator';
import { IntervalResult, RideHeader, Sample, Segment } from '../src/shared/types';
import { ride } from './sim';

const now = new Date('2026-05-01T18:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600e3).toISOString();
const seed = [{ date: daysAgo(60), ftp: 200, source: 'seed' as const }];

/** Segments on a straight line that predicts `ftpAtLthr` at an LTHR of 148.5 (max HR 165). */
const segsFor = (ftpAtLthr: number): Segment[] =>
  [0.6, 0.65, 0.7, 0.8, 0.9].map((f, k) => ({ t0: 700 + k, s: 300, p: ftpAtLthr * f, hr: 60 + 88.5 * f }));
const iv = (o: Partial<IntervalResult>): IntervalResult => ({
  stepIndex: 1,
  pct: 1,
  plannedS: 480,
  completedS: 480,
  avgPower: 200,
  peakTarget: 200,
  endHr: 150,
  failed: false,
  ...o,
});
const rideAt = (d: number, o: Partial<FtpRide> = {}): FtpRide => ({
  startedAt: daysAgo(d),
  outcome: 'success',
  intervals: [],
  segments: [],
  ...o,
});
const est = (rides: FtpRide[], ftp = 200) => estimateFtp({ ftp, ftpHistory: seed, maxHr: 165, rides, now });

describe('duration factor', () => {
  it('interpolates the table', () => {
    expect(durationFactor(180)).toBe(1.2);
    expect(durationFactor(240)).toBeCloseTo(1.165);
    expect(durationFactor(480)).toBe(1.08);
    expect(durationFactor(900)).toBeCloseTo(1.025);
    expect(durationFactor(1200)).toBe(1);
    expect(durationFactor(2400)).toBe(1);
  });
});

describe('FTP estimate', () => {
  it('keeps FTP when there is not enough heart-rate data', () => {
    const e = est([rideAt(10), rideAt(5), rideAt(1)]);
    expect(e.b.valid).toBe(false);
    expect(e.applied).toBe(false);
    expect(e.ftpAfter).toBe(200);
  });

  it('follows the regression upward, limited to 3% per week', () => {
    const rides = [10, 7, 4, 1].map((d) => rideAt(d, { segments: segsFor(220) }));
    const e = est(rides);
    expect(e.b.valid).toBe(true);
    expect(e.b.ftpB).toBeCloseTo(220, 0);
    expect(e.ftpAfter).toBe(206);
    expect(e.applied).toBe(true);
  });

  it('waits for 3 rides since the last change', () => {
    const history = [...seed, { date: daysAgo(3), ftp: 200, source: 'auto' as const }];
    const rides = [10, 7, 4, 1].map((d) => rideAt(d, { segments: segsFor(220) }));
    const e = estimateFtp({ ftp: 200, ftpHistory: history, maxHr: 165, rides, now });
    expect(e.applied).toBe(false);
    expect(e.decidedBy).toMatch(/3 rides/);
  });

  it('never lowers FTP while the last 3 rides were successes', () => {
    const rides = [10, 7, 4, 1].map((d) => rideAt(d, { segments: segsFor(180) }));
    const e = est(rides);
    expect(e.b.ftpB).toBeCloseTo(180, 0);
    expect(e.applied).toBe(false);
    expect(e.decidedBy).toMatch(/successes/);
  });

  it('lowers FTP when the regression is low and rides are not all successes', () => {
    const rides = [10, 7, 4, 1].map((d, k) =>
      rideAt(d, { segments: segsFor(180), outcome: k === 3 ? 'fail' : 'success' }),
    );
    expect(est(rides).ftpAfter).toBe(194);
  });

  it('a completed interval is a floor the estimate cannot go below', () => {
    // 8 min at 216 W completed → lower bound 200 W. The regression says 180.
    const rides = [10, 7, 4, 1].map((d, k) =>
      rideAt(d, {
        segments: segsFor(180),
        outcome: k === 3 ? 'stretch' : 'success',
        intervals: [iv({ avgPower: 216, peakTarget: 216 })],
      }),
    );
    const e = est(rides);
    expect(e.lower?.value).toBeCloseTo(200, 0);
    expect(e.applied).toBe(false);
    expect(e.decidedBy).toMatch(/lower bound/);
  });

  it('a completed interval never drags FTP down', () => {
    // Bound of 185 W is below a regression of 200 W: it must not pull the estimate down.
    const rides = [10, 7, 4, 1].map((d) =>
      rideAt(d, { segments: segsFor(200), intervals: [iv({ avgPower: 200 })] }),
    );
    const e = est(rides);
    expect(e.lower?.value).toBeCloseTo(185.2, 0);
    expect(e.ftpAfter).toBe(200);
  });

  it('two hard failures cap the estimate', () => {
    const fail = iv({ failed: true, completedS: 300, peakTarget: 210, endHr: 155 });
    const rides = [10, 7, 4, 1].map((d, k) =>
      rideAt(d, {
        segments: segsFor(220),
        outcome: k < 2 ? 'fail' : 'success',
        intervals: k < 2 ? [fail] : [],
      }),
    );
    const e = est(rides);
    expect(e.upper?.value).toBeCloseTo(194.4, 0);
    expect(e.ftpAfter).toBe(194);
  });

  it('ignores failures with low heart rate, and a single failure', () => {
    const lowHr = iv({ failed: true, completedS: 300, peakTarget: 210, endHr: 130 });
    const rides = [10, 7, 4, 1].map((d) => rideAt(d, { segments: segsFor(200), intervals: [lowHr] }));
    expect(est(rides).upper).toBeNull();
    const one = [10, 7, 4, 1].map((d, k) =>
      rideAt(d, {
        segments: segsFor(200),
        intervals: k === 0 ? [iv({ failed: true, completedS: 300, endHr: 155 })] : [],
      }),
    );
    expect(est(one).upper).toBeNull();
  });

  it('ignores changes of less than 2 W', () => {
    const rides = [10, 7, 4, 1].map((d) => rideAt(d, { segments: segsFor(201) }));
    expect(est(rides).applied).toBe(false);
  });
});

describe('ride metrics', () => {
  it('NP equals power for a flat ride and exceeds the average for a variable one', () => {
    expect(normalisedPower(Array(600).fill(200))).toBeCloseTo(200);
    const variable = Array.from({ length: 1200 }, (_, i) => (Math.floor(i / 120) % 2 ? 300 : 100));
    expect(normalisedPower(variable)).toBeGreaterThan(210);
  });
  it('one hour at FTP is 100 TSS', () => expect(tss(3600, 200, 200)).toBeCloseTo(100));

  const s = (t: number, hr: number | null): Sample => ({ t, w: t, p: 150, tp: 150, hr, cad: 90, i: 0, x: 1 });
  it('drops strap glitches from peak HR', () => {
    const samples = Array.from({ length: 60 }, (_, i) => s(i + 1, 140));
    samples[30] = s(31, 215);
    expect(cleanHr(samples)[30]).toBeNull();
    expect(peakHr5s(samples)).toBe(140);
  });

  it('summarises a simulated sweet spot ride', () => {
    const { steps, name } = buildSteps('SweetSpot', 5, 60);
    const header: RideHeader = {
      schemaVersion: 1,
      id: 'r',
      startedAt: daysAgo(0),
      plan: {
        type: 'SweetSpot',
        name,
        minutes: 60,
        ftp: 200,
        storedLevel: 5,
        riddenLevel: 5,
        canEasier: true,
        canHarder: true,
        steps,
        explanation: '',
      },
      ftp: 200,
      maxHr: 165,
      levels: { Endurance: 3, Tempo: 3, SweetSpot: 5, Threshold: 3, VO2max: 3 },
      finished: false,
    };
    const samples = ride(header.plan, { trueFtp: 200, maxHr: 165, restHr: 60 });
    const sum = summarise(header, samples, now.toISOString());
    expect(sum.durationS).toBe(3600);
    expect(sum.outcome).toBe('success');
    expect(sum.workCompletedS).toBe(sum.workPlannedS);
    expect(sum.intervals).toHaveLength(3);
    expect(sum.intervals.every((i) => !i.failed)).toBe(true);
    expect(sum.segments.length).toBeGreaterThanOrEqual(3);
    expect(sum.tss).toBeGreaterThan(40);
    expect(sum.tss).toBeLessThan(90);
  });
});
