// Outcome classification and level changes. Pure.
import { LEVEL_TYPES, Levels, LevelType, Outcome, Rating } from '../../shared/types';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const r2 = (x: number) => Math.round(x * 100) / 100;
const WEEK = 7 * 24 * 3600e3;

/** Inactivity decay: −0.1 per full week without the type, at most 2.0 in total, floor 1.0. */
export function effectiveLevel(level: number, lastDone: string | undefined, now: Date): number {
  if (!lastDone) return level;
  const weeks = Math.floor((now.getTime() - Date.parse(lastDone)) / WEEK);
  if (weeks <= 0) return level;
  return r2(Math.max(1, level - Math.min(2, 0.1 * weeks)));
}

export function classifyOutcome(a: {
  workPlannedS: number;
  workCompletedS: number;
  /** Mean intensity multiplier over work time, minus 1 (−0.05 = cut by 5%). */
  netIntensity: number;
  rating: Rating | null;
}): Outcome {
  const done = a.workPlannedS > 0 ? a.workCompletedS / a.workPlannedS : 1;
  if (done < 0.95 || a.netIntensity < -0.08 - 1e-9 || a.rating === 'dnf') return 'fail';
  if (a.rating === 'hard' || a.netIntensity < -0.03 - 1e-9) return 'stretch';
  return 'success';
}

/**
 * New stored level after a ride.
 * @param stored level before the ride (already decayed)
 * @param ridden level the session was built at
 */
export function nextLevel(
  stored: number,
  ridden: number,
  outcome: Outcome,
  rating: Rating | null,
  minutes: number,
): number {
  const stepUp = minutes <= 30 ? 0.25 : 0.5;
  let next: number;
  if (outcome === 'success') {
    if (ridden < stored) next = stored;
    else next = Math.max(stored + stepUp, ridden) + (rating === 'easy' ? stepUp : 0);
  } else if (outcome === 'stretch') {
    next = Math.min(stored, ridden);
  } else {
    next = Math.min(stored, ridden) - 1;
  }
  return r2(clamp(next, 1, 10));
}

const REBALANCE: Record<LevelType, number> = {
  Endurance: 0.15,
  Tempo: 0.15,
  SweetSpot: 0.25,
  Threshold: 0.35,
  VO2max: 0.35,
};

/** When FTP moves by pctChange (%), levels move the other way so watts stay sensible. */
export function rebalanceLevels(levels: Levels, pctChange: number): Levels {
  const out = { ...levels };
  for (const t of LEVEL_TYPES) out[t] = r2(clamp(levels[t] - REBALANCE[t] * pctChange, 1, 10));
  return out;
}
