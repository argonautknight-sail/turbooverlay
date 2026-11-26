// End-to-end coaching simulation: weeks of rides through the real generator, engine,
// metrics, progression and FTP estimator, with a fake rider whose true fitness we control.
import { describe, expect, it } from 'vitest';
import { applyRide } from '../src/main/coach/apply';
import { buildProgress } from '../src/main/coach/analytics';
import { generate } from '../src/main/coach/generator';
import { summarise } from '../src/main/coach/metrics';
import { defaultProfile } from '../src/main/store/defaults';
import { Answers, effectiveMaxHr, Profile, RideHeader, RideSummary } from '../src/shared/types';
import { ride } from './sim';

const DAY = 24 * 3600e3;
const START = new Date('2026-01-05T18:00:00Z').getTime(); // a Monday
/** A fixed test rider: age 55 (max HR prior 165) and FTP 190 W. */
function testProfile(): Profile {
  const when = new Date(START - DAY);
  return {
    ...defaultProfile(when),
    age: 55,
    ftp: 190,
    ftpHistory: [{ date: when.toISOString(), ftp: 190, source: 'seed' }],
  };
}

const WEEK_PATTERN: { day: number; answers: Answers }[] = [
  { day: 0, answers: { minutes: 60, legs: 'fresh', feel: 'push' } },
  { day: 2, answers: { minutes: 60, legs: 'normal', feel: 'steady' } },
  { day: 4, answers: { minutes: 45, legs: 'tired', feel: 'steady' } },
];

export function simulate(weeks: number, trueFtpAt: (week: number) => number) {
  let profile: Profile = testProfile();
  const rides: RideSummary[] = [];
  const ftpSeen: number[] = [profile.ftp];
  let n = 0;
  for (let w = 0; w < weeks; w++) {
    for (const { day, answers } of WEEK_PATTERN) {
      const when = new Date(START + (w * 7 + day) * DAY);
      const lite = rides.map((r) => ({
        startedAt: r.startedAt,
        type: r.plan.type,
        workPlannedS: r.workPlannedS,
        workCompletedS: r.workCompletedS,
      }));
      const plan = generate(answers, profile, lite, when);
      const header: RideHeader = {
        schemaVersion: 1,
        id: `ride-${n}`,
        startedAt: when.toISOString(),
        plan,
        ftp: profile.ftp,
        maxHr: effectiveMaxHr(profile),
        levels: profile.levels,
        finished: false,
      };
      const samples = ride(plan, { trueFtp: trueFtpAt(w), maxHr: 165, restHr: 60 }, ++n);
      const ended = new Date(when.getTime() + 3600e3);
      const out = applyRide(profile, summarise(header, samples, ended.toISOString()), rides, ended);
      profile = out.profile;
      rides.push(out.ride);
      ftpSeen.push(profile.ftp);
    }
  }
  const end = new Date(START + weeks * 7 * DAY);
  return { profile, rides, ftpSeen, progress: buildProgress(profile, rides, end) };
}

describe('coaching simulation', () => {
  it('a rider at seed fitness who completes everything holds steady and never loses FTP', () => {
    const r = simulate(10, () => 190);
    expect(r.rides.every((x) => x.outcome === 'success')).toBe(true);
    for (let i = 1; i < r.ftpSeen.length; i++) expect(r.ftpSeen[i]).toBeGreaterThanOrEqual(r.ftpSeen[i - 1]);
    expect(Math.abs(r.profile.ftp - 190)).toBeLessThanOrEqual(6);
    expect(r.progress.verdict.label).toBe('Holding steady');
  });

  it('an improving rider is tracked upward and the verdict says so', () => {
    const r = simulate(10, (w) => 190 + 3 * w);
    expect(r.profile.ftp).toBeGreaterThan(200);
    expect(r.profile.ftp).toBeLessThanOrEqual(190 + 3 * 10 + 6);
    expect(r.progress.verdict.label).toBe('Improving');
    expect(r.profile.ftpHistory.filter((e) => e.source === 'auto').length).toBeGreaterThan(1);
  });

  it('a declining rider starts failing, FTP comes down, and the verdict says so', () => {
    const r = simulate(10, (w) => 190 - 4 * w);
    expect(r.rides.some((x) => x.outcome === 'fail')).toBe(true);
    expect(r.profile.ftp).toBeLessThan(185);
    expect(r.progress.verdict.label).toBe('Slipping');
  });

  it('FTP never moves by more than 3% in a week', () => {
    const r = simulate(10, (w) => 190 + 6 * w);
    const h = r.profile.ftpHistory;
    for (let i = 1; i < h.length; i++) {
      expect(Math.abs(h[i].ftp - h[i - 1].ftp) / h[i - 1].ftp).toBeLessThanOrEqual(0.031);
    }
  });

  it('levels come down when FTP goes up, and every change is explained', () => {
    const r = simulate(10, (w) => 190 + 3 * w);
    expect(r.profile.levelHistory.some((e) => /FTP/.test(e.reason))).toBe(true);
    expect(r.profile.ftpEstimates.length).toBe(r.rides.length);
  });

  it('the observed max HR only ratchets upward and starts from the age prior', () => {
    const r = simulate(4, () => 190);
    expect(effectiveMaxHr(r.profile)).toBeGreaterThanOrEqual(165);
  });

  it('a ride abandoned during the warm-up changes no level', () => {
    const profile = testProfile();
    const when = new Date(START);
    const plan = generate({ minutes: 60, legs: 'normal', feel: 'steady' }, profile, [], when);
    const header: RideHeader = {
      schemaVersion: 1,
      id: 'x',
      startedAt: when.toISOString(),
      plan,
      ftp: 190,
      maxHr: 165,
      levels: profile.levels,
      finished: false,
    };
    const samples = ride(plan, { trueFtp: 190, maxHr: 165, restHr: 60 }).slice(0, 200);
    const out = applyRide(profile, summarise(header, samples, when.toISOString()), [], when);
    expect(out.ride.outcome).toBe('fail');
    expect(out.ride.levelChange).toBeNull();
    expect(out.profile.levels).toEqual(profile.levels);
  });
});
