// A fake rider used by the tests: rides a plan through the real engine and returns samples.
import { WorkoutEngine } from '../src/main/engine/WorkoutEngine';
import { durationFactor } from '../src/main/coach/ftp';
import { Sample, SessionPlan } from '../src/shared/types';

export interface Rider {
  trueFtp: number;
  maxHr: number;
  restHr: number;
}

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

/** How far above FTP this rider can hold a power. Short efforts (under 3 min) allow much more. */
const holdFactor = (seconds: number) =>
  seconds >= 180 ? durationFactor(seconds) : 1.2 + ((180 - seconds) / 150) * 0.4;

/** Steady-state HR for a power: reaches 90% of max at the rider's true FTP. */
export const steadyHr = (r: Rider, p: number) =>
  Math.min(r.maxHr + 3, r.restHr + (0.9 * r.maxHr - r.restHr) * (p / r.trueFtp));

export function ride(plan: SessionPlan, rider: Rider, seed = 1): Sample[] {
  const rand = lcg(seed);
  const eng = new WorkoutEngine(plan);
  const samples: Sample[] = [];
  let hr = rider.restHr + 20;
  let wall = 0;
  let quitAt: number | null = null;
  let lastStep = -1;
  while (!eng.isFinished && wall < 3 * 3600) {
    wall++;
    const i = eng.stepIndex;
    const target = eng.targetW;
    const st = plan.steps[i];
    if (i !== lastStep) {
      lastStep = i;
      // The rider cracks 60% of the way through a work interval that is beyond them.
      if (st.kind === 'work' && plan.ftp * st.pctStart > rider.trueFtp * holdFactor(st.durationS) * 1.01) {
        quitAt = eng.elapsedS + Math.round(st.durationS * 0.6);
      }
    }
    if (quitAt !== null && eng.elapsedS >= quitAt) {
      eng.stop();
      break;
    }
    const x = eng.intensity;
    if (!eng.tick({ cadence: 90, trainerOk: true })) continue;
    const p = Math.round(target * (1 + (rand() - 0.5) * 0.04));
    hr += (steadyHr(rider, p) - hr) / 40;
    samples.push({ t: eng.elapsedS, w: wall, p, tp: target, hr: Math.round(hr), cad: 90, i, x });
  }
  return samples;
}
