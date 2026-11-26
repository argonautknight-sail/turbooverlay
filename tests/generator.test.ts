import { describe, expect, it } from 'vitest';
import {
  buildSteps,
  decide,
  enduranceSurges,
  fitIntervals,
  generate,
  RideLite,
  SLOTS,
} from '../src/main/coach/generator';
import { Answers, IntervalType, LevelType, SessionType, Slot } from '../src/shared/types';

const SLOT_LIST: Slot[] = [30, 45, 60];
const now = new Date('2026-03-20T18:00:00Z');
const ago = (hours: number) => new Date(now.getTime() - hours * 3600e3).toISOString();
const rideOf = (type: SessionType, hours: number, done = 1): RideLite => ({
  startedAt: ago(hours),
  type,
  workPlannedS: 1000,
  workCompletedS: 1000 * done,
});
const profile = {
  ftp: 190,
  levels: { Endurance: 3, Tempo: 3, SweetSpot: 3, Threshold: 3, VO2max: 3 },
  lastDone: {},
};

describe('fitting rule', () => {
  it('fits every type, quarter-level and slot, and lasts exactly the slot', () => {
    for (const type of ['Endurance', 'Tempo', 'SweetSpot', 'Threshold', 'VO2max'] as LevelType[]) {
      for (const slot of SLOT_LIST) {
        for (let level = 1; level <= 10; level += 0.25) {
          const { steps } = buildSteps(type, level, slot);
          expect(
            steps.reduce((a, s) => a + s.durationS, 0),
            `${type} L${level} ${slot}`,
          ).toBe(slot * 60);
          expect(steps.every((s) => s.durationS > 0)).toBe(true);
          if (type !== 'Endurance') {
            const set = fitIntervals(type as IntervalType, level, slot);
            expect(set.n * set.intervalS + (set.n - 1) * set.recoveryS).toBeLessThanOrEqual(
              SLOTS[slot].mainS,
            );
          }
        }
      }
    }
  });

  it('matches the reference sessions for the 60 minute slot', () => {
    const f = (t: IntervalType, l: number) => {
      const s = fitIntervals(t, l, 60);
      return `${s.n}x${s.intervalS / 60}@${Math.round(s.pct * 100)}`;
    };
    expect(f('Tempo', 1)).toBe('3x8@78');
    expect(f('Tempo', 10)).toBe('2x18@87');
    expect(f('SweetSpot', 1)).toBe('3x6@88');
    expect(f('SweetSpot', 10)).toBe('2x17@94');
    expect(f('Threshold', 1)).toBe('4x4@95');
    expect(f('Threshold', 10)).toBe('2x15@102');
    expect(f('VO2max', 1)).toBe('6x1.5@110');
    expect(f('VO2max', 10)).toBe('5x4@120');
  });

  it('adds endurance surges from level 4', () => {
    expect(enduranceSurges(3.5, 60).n).toBe(0);
    expect(enduranceSurges(4, 60).n).toBe(2);
    expect(enduranceSurges(5, 60).n).toBe(3);
    expect(enduranceSurges(8, 60).n).toBe(4);
    expect(enduranceSurges(10, 60)).toEqual({ n: 5, pct: 0.85 });
    expect(enduranceSurges(10, 30).n).toBe(3);
  });

  it('recovery is the whole session at 52%', () => {
    const { steps } = buildSteps('Recovery', 1, 45);
    expect(steps).toHaveLength(1);
    expect(steps[0].pctStart).toBe(0.52);
    expect(steps[0].durationS).toBe(45 * 60);
  });
});

describe('decision rules', () => {
  const table: [string, Answers['legs'], Answers['feel'], RideLite[], SessionType][] = [
    ['tired after a hard ride yesterday', 'tired', 'steady', [rideOf('Threshold', 24)], 'Recovery'],
    ['tired, hard ride was abandoned early', 'tired', 'push', [rideOf('VO2max', 24, 0.3)], 'Endurance'],
    ['tired, hard ride 3 days ago', 'tired', 'steady', [rideOf('Threshold', 72)], 'Endurance'],
    ['tired, last ride easy', 'tired', 'push', [rideOf('Tempo', 24)], 'Endurance'],
    [
      'tired, hard ride 30 h ago then an easy one',
      'tired',
      'steady',
      [rideOf('VO2max', 30), rideOf('Endurance', 6)],
      'Endurance',
    ],
    ['push, rested, never done hard', 'fresh', 'push', [rideOf('Tempo', 50)], 'Threshold'],
    [
      'push, threshold done most recently',
      'normal',
      'push',
      [rideOf('VO2max', 24 * 20), rideOf('Threshold', 60)],
      'VO2max',
    ],
    [
      'push, vo2 done most recently',
      'normal',
      'push',
      [rideOf('Threshold', 24 * 20), rideOf('VO2max', 60)],
      'Threshold',
    ],
    ['push blocked by 48 h', 'fresh', 'push', [rideOf('Threshold', 40)], 'SweetSpot'],
    [
      'push blocked by weekly guard',
      'fresh',
      'push',
      [rideOf('Threshold', 150), rideOf('VO2max', 60)],
      'SweetSpot',
    ],
    ['push blocked by layoff', 'fresh', 'push', [rideOf('Threshold', 24 * 9)], 'SweetSpot'],
    ['push on the very first ride', 'normal', 'push', [], 'SweetSpot'],
    ['steady, nothing done', 'normal', 'steady', [], 'SweetSpot'],
    [
      'steady, sweet spot done most recently',
      'normal',
      'steady',
      [rideOf('Tempo', 100), rideOf('SweetSpot', 50)],
      'Tempo',
    ],
    [
      'steady, tempo done most recently',
      'fresh',
      'steady',
      [rideOf('SweetSpot', 100), rideOf('Tempo', 50)],
      'SweetSpot',
    ],
    ['steady the day after a hard ride', 'normal', 'steady', [rideOf('VO2max', 24)], 'SweetSpot'],
  ];
  for (const [name, legs, feel, rides, expected] of table) {
    it(name, () => {
      expect(decide({ minutes: 60, legs, feel }, rides, now).type).toBe(expected);
    });
  }

  it('says why a push was refused', () => {
    const push: Answers = { minutes: 60, legs: 'fresh', feel: 'push' };
    expect(decide(push, [rideOf('Threshold', 40)], now).blocked).toMatch(/48 hours/);
    expect(decide(push, [rideOf('Threshold', 150), rideOf('VO2max', 60)], now).blocked).toMatch(
      /2 hard rides/,
    );
    expect(decide(push, [rideOf('Threshold', 24 * 9)], now).blocked).toMatch(/more than a week/);
  });

  it('every combination of answers resolves to one session of the right length', () => {
    const histories = [[], [rideOf('Threshold', 24)], [rideOf('Tempo', 24)], [rideOf('VO2max', 24 * 10)]];
    for (const minutes of SLOT_LIST)
      for (const legs of ['fresh', 'normal', 'tired'] as const)
        for (const feel of ['steady', 'push'] as const)
          for (const h of histories) {
            const plan = generate({ minutes, legs, feel }, profile, h, now);
            expect(plan.steps.reduce((a, s) => a + s.durationS, 0)).toBe(minutes * 60);
          }
  });
});

describe('level ridden', () => {
  const recent = [rideOf('Tempo', 50)];
  it('applies push and fresh bonuses', () => {
    expect(generate({ minutes: 60, legs: 'normal', feel: 'steady' }, profile, recent, now).riddenLevel).toBe(
      3,
    );
    expect(generate({ minutes: 60, legs: 'fresh', feel: 'steady' }, profile, recent, now).riddenLevel).toBe(
      3.5,
    );
    expect(generate({ minutes: 60, legs: 'fresh', feel: 'push' }, profile, recent, now).riddenLevel).toBe(4);
  });
  it('limits the offset to -2..+1', () => {
    const a: Answers = { minutes: 60, legs: 'normal', feel: 'steady' };
    expect(generate(a, profile, recent, now, 5).riddenLevel).toBe(4);
    expect(generate(a, profile, recent, now, 5).canHarder).toBe(false);
    expect(generate(a, profile, recent, now, -5).riddenLevel).toBe(1);
    expect(generate(a, profile, recent, now, -5).canEasier).toBe(false);
  });
  it('drops a level after a layoff', () => {
    const plan = generate(
      { minutes: 60, legs: 'normal', feel: 'steady' },
      profile,
      [rideOf('Tempo', 24 * 9)],
      now,
    );
    expect(plan.riddenLevel).toBe(2);
  });
  it('decays the stored level with inactivity', () => {
    const p = {
      ...profile,
      levels: { ...profile.levels, SweetSpot: 6 },
      lastDone: { SweetSpot: ago(24 * 22) },
    };
    const plan = generate(
      { minutes: 60, legs: 'normal', feel: 'steady' },
      p,
      [rideOf('SweetSpot', 24 * 22), rideOf('Tempo', 30)],
      now,
    );
    expect(plan.type).toBe('SweetSpot');
    expect(plan.storedLevel).toBe(5.7);
  });
});
