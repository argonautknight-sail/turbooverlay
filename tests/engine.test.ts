import { describe, expect, it } from 'vitest';
import { WorkoutEngine } from '../src/main/engine/WorkoutEngine';
import { SessionPlan, Step } from '../src/shared/types';

const st = (kind: Step['kind'], durationS: number, pct: number, isWork = false): Step => ({
  kind,
  durationS,
  pctStart: pct,
  pctEnd: pct,
  isWork,
});
const plan = (steps: Step[]): SessionPlan => ({
  type: 'Tempo',
  name: 'test',
  minutes: 1,
  ftp: 200,
  storedLevel: 3,
  riddenLevel: 3,
  canEasier: true,
  canHarder: true,
  steps,
  explanation: '',
});
const pedal = { cadence: 90, trainerOk: true };
const run = (e: WorkoutEngine, n: number, input = pedal) => {
  let counted = 0;
  for (let i = 0; i < n; i++) if (e.tick(input)) counted++;
  return counted;
};

describe('WorkoutEngine', () => {
  it('waits for pedalling before it starts', () => {
    const e = new WorkoutEngine(plan([st('work', 60, 1, true)]));
    expect(run(e, 5, { cadence: 0, trainerOk: true })).toBe(0);
    expect(e.snapshot().state).toBe('paused');
    expect(run(e, 5)).toBe(5);
    expect(e.elapsedS).toBe(5);
  });

  it('runs to the end and finishes', () => {
    const e = new WorkoutEngine(plan([st('work', 30, 1, true), st('recovery', 30, 0.5)]));
    expect(run(e, 100)).toBe(60);
    expect(e.isFinished).toBe(true);
  });

  it('ramps up from 50% after a resume, only once cadence is up', () => {
    const e = new WorkoutEngine(plan([st('work', 600, 1, true)]));
    expect(e.targetW).toBe(100); // paused: half target
    e.tick({ cadence: 30, trainerOk: true });
    e.tick({ cadence: 30, trainerOk: true });
    expect(e.targetW).toBe(100); // spinning slowly: ramp holds
    run(e, 4);
    expect(e.targetW).toBe(150);
    run(e, 4);
    expect(e.targetW).toBe(200);
  });

  it('blends step changes over 3 seconds', () => {
    const e = new WorkoutEngine(plan([st('recovery', 20, 0.5), st('work', 60, 1, true)]));
    run(e, 20);
    expect(e.stepIndex).toBe(1);
    const seen = [e.targetW];
    for (let i = 0; i < 3; i++) {
      run(e, 1);
      seen.push(e.targetW);
    }
    expect(seen).toEqual([125, 150, 175, 200]);
  });

  it('follows a ramp step', () => {
    const e = new WorkoutEngine(
      plan([{ kind: 'warmup', durationS: 100, pctStart: 0.5, pctEnd: 0.7, isWork: false }]),
    );
    run(e, 50);
    expect(e.targetW).toBe(120);
  });

  it('auto-pauses after more than 3 s without cadence and resumes on pedalling', () => {
    const e = new WorkoutEngine(plan([st('work', 600, 1, true)]));
    run(e, 20);
    expect(run(e, 3, { cadence: 0, trainerOk: true })).toBe(3);
    expect(run(e, 5, { cadence: 0, trainerOk: true })).toBe(0);
    expect(e.snapshot().pauseReason).toBe('auto');
    expect(e.elapsedS).toBe(23);
    expect(run(e, 2)).toBe(2);
    expect(e.snapshot().state).toBe('running');
  });

  it('a manual pause holds until the rider resumes', () => {
    const e = new WorkoutEngine(plan([st('work', 600, 1, true)]));
    run(e, 10);
    e.togglePause();
    expect(run(e, 10)).toBe(0);
    expect(e.snapshot().pauseReason).toBe('manual');
    e.togglePause();
    expect(run(e, 10)).toBe(10);
  });

  it('pauses on a trainer dropout and resumes when it returns', () => {
    const e = new WorkoutEngine(plan([st('work', 600, 1, true)]));
    run(e, 10);
    expect(run(e, 5, { cadence: 0, trainerOk: false })).toBe(0);
    expect(e.snapshot().pauseReason).toBe('trainer');
    expect(run(e, 3)).toBe(3);
    expect(e.elapsedS).toBe(13);
  });

  it('skips to the next step, and skipping the last step ends the session', () => {
    const e = new WorkoutEngine(
      plan([st('work', 60, 1, true), st('recovery', 60, 0.5), st('work', 60, 1, true)]),
    );
    run(e, 10);
    e.skip();
    expect(e.elapsedS).toBe(60);
    expect(e.stepIndex).toBe(1);
    e.skip();
    e.skip();
    expect(e.isFinished).toBe(true);
  });

  it('applies and limits intensity changes', () => {
    const e = new WorkoutEngine(plan([st('work', 600, 1, true)]));
    run(e, 20);
    e.adjustIntensity(0.05);
    expect(e.targetW).toBe(210);
    for (let i = 0; i < 30; i++) e.adjustIntensity(-0.05);
    expect(e.intensity).toBe(0.5);
    for (let i = 0; i < 30; i++) e.adjustIntensity(0.05);
    expect(e.intensity).toBe(1.3);
  });

  it('reports what is next', () => {
    const e = new WorkoutEngine(plan([st('recovery', 60, 0.5), st('work', 240, 1.025, true)]));
    run(e, 10);
    const s = e.snapshot();
    expect(s.stepRemainingS).toBe(50);
    expect(s.next).toEqual({ durationS: 240, watts: 205, cadence: null });
  });
});
