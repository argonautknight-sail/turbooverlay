import { describe, expect, it } from 'vitest';
import { buildSteps, generate, RideLite, SLOTS, VARIANTS } from '../src/main/coach/generator';
import { steadySegments } from '../src/main/coach/metrics';
import { WorkoutEngine } from '../src/main/engine/WorkoutEngine';
import { LEVEL_TYPES, RideHeader, SessionPlan, SessionType, Slot, Step } from '../src/shared/types';
import { ride } from './sim';

const SLOT_LIST: Slot[] = [30, 45, 60];
const now = new Date('2026-03-20T18:00:00Z');
const ago = (hours: number) => new Date(now.getTime() - hours * 3600e3).toISOString();
const rideOf = (type: SessionType, hours: number): RideLite => ({
  startedAt: ago(hours),
  type,
  workPlannedS: 1000,
  workCompletedS: 1000,
});
const profile = {
  ftp: 190,
  levels: { Endurance: 3, Tempo: 3, SweetSpot: 3, Threshold: 3, VO2max: 3 },
  lastDone: {},
};
const total = (steps: Step[]) => steps.reduce((a, s) => a + s.durationS, 0);
const mainSet = (steps: Step[]) =>
  steps.filter((s) => s.kind !== 'warmup' && s.kind !== 'opener' && s.kind !== 'cooldown');

describe('session variants', () => {
  it('every variant, level and slot lasts exactly the slot and has a cadence target on every step', () => {
    for (const type of LEVEL_TYPES)
      for (const variant of VARIANTS[type])
        for (const slot of SLOT_LIST)
          for (let level = 1; level <= 10; level += 0.5) {
            const { steps, name } = buildSteps(type, level, slot, variant);
            const tag = `${type} ${variant} L${level} ${slot}`;
            expect(total(steps), tag).toBe(slot * 60);
            expect(
              steps.every((s) => s.durationS > 0),
              tag,
            ).toBe(true);
            expect(
              steps.every((s) => typeof s.cadence === 'number' && s.cadence >= 60 && s.cadence <= 120),
              tag,
            ).toBe(true);
            expect(name.length, tag).toBeGreaterThan(5);
          }
  });

  it('the first variant of every type is the classic one', () => {
    for (const type of LEVEL_TYPES) expect(VARIANTS[type][0]).toBe('classic');
  });

  it('over-unders alternate 2 minutes under and 1 minute over, averaging the classic power', () => {
    const classic = buildSteps('SweetSpot', 5, 60, 'classic').steps.find((s) => s.kind === 'work')!;
    const work = buildSteps('SweetSpot', 5, 60, 'overunder').steps.filter((s) => s.kind === 'work');
    expect(work[0].durationS).toBe(120);
    expect(work[1].durationS).toBe(60);
    expect(work[1].pctStart).toBeGreaterThan(work[0].pctStart);
    const avg = work.reduce((a, s) => a + s.pctStart * s.durationS, 0) / total(work);
    expect(avg).toBeCloseTo(classic.pctStart, 2);
  });

  it('endurance sprints are 10 seconds, well above FTP, at a high cadence', () => {
    for (const [slot, n] of [
      [30, 4],
      [45, 6],
      [60, 8],
    ] as [Slot, number][]) {
      const sprints = buildSteps('Endurance', 3, slot, 'sprints').steps.filter((s) => s.kind === 'sprint');
      expect(sprints).toHaveLength(n);
      expect(sprints.every((s) => s.durationS === 10 && s.pctStart === 1.75 && s.cadence === 115)).toBe(true);
    }
  });

  it('bursts put a 10 second sprint at the end of every 3 minutes of an interval', () => {
    const steps = buildSteps('SweetSpot', 5, 60, 'bursts').steps;
    const i = steps.findIndex((s) => s.kind === 'sprint');
    expect(steps[i - 1].durationS).toBe(170);
    expect(steps[i].durationS).toBe(10);
    expect(steps[i].pctStart).toBe(1.5);
  });

  it('30/30s and 40/20s are built from short repeats in sets and fit the main set', () => {
    for (const slot of SLOT_LIST)
      for (const [variant, on, off] of [
        ['3030', 30, 30],
        ['4020', 40, 20],
      ] as const) {
        const steps = buildSteps('VO2max', 10, slot, variant).steps;
        const work = steps.filter((s) => s.kind === 'work');
        expect(work.every((s) => s.durationS === on)).toBe(true);
        expect(steps.some((s) => s.kind === 'recovery' && s.durationS === off)).toBe(true);
        expect(total(steps)).toBe(slot * 60);
        expect(total(mainSet(steps))).toBeGreaterThanOrEqual(SLOTS[slot].mainS);
      }
  });

  it('cadence variants change cadence but not power within an interval', () => {
    const work = buildSteps('Tempo', 5, 60, 'cadence').steps.filter((s) => s.kind === 'work');
    expect(new Set(work.map((s) => s.pctStart)).size).toBe(1);
    expect(new Set(work.map((s) => s.cadence))).toEqual(new Set([70, 105]));
  });

  it('variants rotate with each session of the type, and Swap moves to the next', () => {
    const a = { minutes: 60, legs: 'normal', feel: 'steady' } as const;
    // No sweet spot yet → classic.
    expect(generate(a, profile, [rideOf('Tempo', 50)], now).variant).toBe('classic');
    // One sweet spot done (and tempo more recent, so sweet spot is chosen again) → second variant.
    const one = [rideOf('SweetSpot', 100), rideOf('Tempo', 50)];
    expect(generate(a, profile, one, now).type).toBe('SweetSpot');
    expect(generate(a, profile, one, now).variant).toBe('overunder');
    expect(generate(a, profile, one, now, 0, 1).variant).toBe('bursts');
    expect(generate(a, profile, one, now, 0, 2).variant).toBe('classic');
    expect(generate(a, profile, one, now).variantCount).toBe(3);
  });
});

describe('engine with sprints and cadence', () => {
  const st = (kind: Step['kind'], durationS: number, pct: number, cadence: number): Step => ({
    kind,
    durationS,
    pctStart: pct,
    pctEnd: pct,
    isWork: true,
    cadence,
  });
  const plan: SessionPlan = {
    type: 'Endurance',
    name: 't',
    minutes: 1,
    ftp: 200,
    storedLevel: 3,
    riddenLevel: 3,
    canEasier: true,
    canHarder: true,
    steps: [st('steady', 20, 0.65, 88), st('sprint', 10, 1.75, 115), st('steady', 30, 0.65, 88)],
    explanation: '',
  };

  it('a sprint gets its full target at once, and the cadence target follows the step', () => {
    const e = new WorkoutEngine(plan);
    for (let i = 0; i < 19; i++) e.tick({ cadence: 90, trainerOk: true });
    expect(e.snapshot().targetCadence).toBe(88);
    expect(e.snapshot().next).toEqual({ durationS: 10, watts: 350, cadence: 115 });
    e.tick({ cadence: 90, trainerOk: true });
    expect(e.snapshot().stepKind).toBe('sprint');
    expect(e.targetW).toBe(350);
    expect(e.snapshot().targetCadence).toBe(115);
  });
});

describe('steady segments', () => {
  it('a cadence-drill ride at one power still yields long steady segments', () => {
    const { steps, name } = buildSteps('Endurance', 3, 60, 'cadence');
    const header: RideHeader = {
      schemaVersion: 1,
      id: 'r',
      startedAt: now.toISOString(),
      plan: {
        type: 'Endurance',
        name,
        minutes: 60,
        ftp: 190,
        storedLevel: 3,
        riddenLevel: 3,
        canEasier: true,
        canHarder: true,
        steps,
        explanation: '',
      },
      ftp: 190,
      maxHr: 165,
      levels: profile.levels,
      finished: false,
    };
    const samples = ride(header.plan, { trueFtp: 190, maxHr: 165, restHr: 60 });
    // 42 minutes at one power: 2 minutes skipped, then 5-minute chunks.
    expect(steadySegments(header, samples).length).toBeGreaterThanOrEqual(7);
  });
});
