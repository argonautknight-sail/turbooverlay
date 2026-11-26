// Session generator. Pure: no Electron, no I/O.
import {
  Answers,
  IntervalType,
  Levels,
  LevelType,
  SessionPlan,
  SessionType,
  Slot,
  Step,
  TYPE_LABEL,
} from '../../shared/types';
import { effectiveLevel } from './progression';

export const SLOTS: Record<Slot, { warmS: number; coolS: number; mainS: number }> = {
  30: { warmS: 7 * 60, coolS: 5 * 60, mainS: 18 * 60 },
  45: { warmS: 10 * 60, coolS: 5 * 60, mainS: 30 * 60 },
  60: { warmS: 10 * 60, coolS: 8 * 60, mainS: 42 * 60 },
};

type Range = [number, number];
interface IntervalSpec {
  pct: Range;
  workMin: Record<Slot, Range>;
  longestMin: Range;
  recoveryShare: number;
  fewest: number;
}

/** Every value moves in a straight line from its level 1 figure to its level 10 figure. */
export const INTERVAL_TABLE: Record<IntervalType, IntervalSpec> = {
  Tempo: {
    pct: [0.78, 0.87],
    workMin: { 30: [10, 16], 45: [15, 26], 60: [24, 36] },
    longestMin: [8, 18],
    recoveryShare: 0.25,
    fewest: 1,
  },
  SweetSpot: {
    pct: [0.88, 0.94],
    workMin: { 30: [9, 15], 45: [14, 25], 60: [18, 34] },
    longestMin: [6, 17],
    recoveryShare: 1 / 3,
    fewest: 1,
  },
  Threshold: {
    pct: [0.95, 1.02],
    workMin: { 30: [8, 13], 45: [12, 21], 60: [16, 30] },
    longestMin: [4, 15],
    recoveryShare: 0.5,
    fewest: 2,
  },
  VO2max: {
    pct: [1.1, 1.2],
    workMin: { 30: [6, 10], 45: [8, 16], 60: [9, 20] },
    longestMin: [1.5, 4],
    recoveryShare: 1,
    fewest: 3,
  },
};

export const RECOVERY_PCT = 0.5;
export const FILLER_PCT = 0.62;
export const RECOVERY_RIDE_PCT = 0.52;

const lerp = ([a, b]: Range, level: number) => a + ((b - a) * (level - 1)) / 9;
const roundTo = (x: number, step: number) => Math.round(x / step) * step;
const floorTo = (x: number, step: number) => Math.floor(x / step + 1e-9) * step;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export interface IntervalSet {
  n: number;
  intervalS: number;
  recoveryS: number;
  pct: number;
}

/** The fitting rule from the plan, in seconds. */
export function fitIntervals(type: IntervalType, level: number, slot: Slot): IntervalSet {
  const spec = INTERVAL_TABLE[type];
  const budget = SLOTS[slot].mainS;
  const longestS = lerp(spec.longestMin, level) * 60;
  let workS = roundTo(lerp(spec.workMin[slot], level) * 60, 30);
  for (;;) {
    const n = Math.max(spec.fewest, Math.ceil(workS / longestS - 1e-9));
    const intervalS = floorTo(workS / n, 15);
    const recoveryS = roundTo(spec.recoveryShare * intervalS, 15);
    if (n * intervalS + (n - 1) * recoveryS <= budget || workS <= 60) {
      return { n, intervalS, recoveryS, pct: Math.round(lerp(spec.pct, level) * 1000) / 1000 };
    }
    workS -= 30;
  }
}

export function enduranceSurges(level: number, slot: Slot): { n: number; pct: number } {
  if (level < 4) return { n: 0, pct: 0 };
  const n = Math.min(5, 2 + Math.round((level - 4) / 2 + 1e-9));
  return {
    n: slot === 30 ? Math.min(3, n) : n,
    pct: Math.round((0.8 + (0.05 * (level - 4)) / 6) * 1000) / 1000,
  };
}

// ---------- Variants and cadence ----------

export type Variant = 'classic' | 'overunder' | 'bursts' | 'cadence' | 'sprints' | '3030' | '4020';

/** Variants rotate so the same type is not the same session every time. The first is always classic. */
export const VARIANTS: Record<LevelType, Variant[]> = {
  Endurance: ['classic', 'sprints', 'cadence'],
  Tempo: ['classic', 'cadence', 'bursts'],
  SweetSpot: ['classic', 'overunder', 'bursts'],
  Threshold: ['classic', 'overunder'],
  VO2max: ['classic', '3030', '4020'],
};

/** Target cadences, rpm. Guidance only: cadence never affects the outcome of a ride. */
export const CADENCE = {
  easy: 85,
  Endurance: 88,
  Tempo: 85,
  SweetSpot: 90,
  Threshold: 92,
  VO2max: 100,
  surge: 95,
  low: 70,
  high: 105,
  under: 88,
  over: 95,
  micro: 105,
  sprint: 115,
  opener: 100,
};

export const SPRINT_S = 10;
export const ENDURANCE_SPRINT_PCT = 1.75;
const BURST_PCT: Partial<Record<IntervalType, number>> = { Tempo: 1.3, SweetSpot: 1.5 };
const ENDURANCE_SPRINTS: Record<Slot, number> = { 30: 4, 45: 6, 60: 8 };

const step = (kind: Step['kind'], durationS: number, pct: number, cadence: number, isWork = false): Step => ({
  kind,
  durationS,
  pctStart: pct,
  pctEnd: pct,
  isWork,
  cadence,
});
const ramp = (kind: Step['kind'], durationS: number, from: number, to: number): Step => ({
  kind,
  durationS,
  pctStart: from,
  pctEnd: to,
  isWork: false,
  cadence: CADENCE.easy,
});

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const pc = (x: number) => `${Math.round(x * 100)}%`;

/** One work interval, in the shape the variant asks for. Average power stays close to pct. */
function intervalBody(type: IntervalType, variant: Variant, intervalS: number, pct: number): Step[] {
  const cad = CADENCE[type];
  if (variant === 'cadence') {
    // Same power throughout; 2-minute blocks alternating low and high cadence.
    const out: Step[] = [];
    let left = intervalS;
    for (let k = 0; left > 0; k++) {
      const s = left < 180 ? left : 120;
      out.push(step('work', s, pct, k % 2 === 0 ? CADENCE.low : CADENCE.high, true));
      left -= s;
    }
    return out;
  }
  if (variant === 'bursts') {
    // A 10-second burst at the end of every full 3 minutes.
    const out: Step[] = [];
    let left = intervalS;
    while (left >= 180) {
      out.push(
        step('work', 180 - SPRINT_S, pct, cad, true),
        step('sprint', SPRINT_S, BURST_PCT[type] ?? 1.3, CADENCE.sprint, true),
      );
      left -= 180;
    }
    if (left > 0) out.push(step('work', left, pct, cad, true));
    return out;
  }
  if (variant === 'overunder') {
    // 3-minute cycles: 2 minutes just under, 1 minute over. The average is the classic power.
    const out: Step[] = [];
    for (let left = intervalS; left >= 180; left -= 180) {
      out.push(
        step('work', 120, r3(pct - 0.04), CADENCE.under, true),
        step('work', 60, r3(pct + 0.08), CADENCE.over, true),
      );
    }
    return out;
  }
  return [step('work', intervalS, pct, cad, true)];
}

/** VO2max as short on/off repeats in sets (30/30s or 40/20s). */
function microIntervals(
  level: number,
  slot: Slot,
  onS: number,
  offS: number,
  bump: number,
): { steps: Step[]; name: string; usedS: number } {
  const spec = INTERVAL_TABLE.VO2max;
  const budget = SLOTS[slot].mainS;
  const pct = r3(lerp(spec.pct, level) + bump);
  const totalOn = roundTo(lerp(spec.workMin[slot], level) * 60, 30);
  const sets = totalOn >= 720 ? 3 : 2;
  const setRest = 180;
  let reps = Math.max(3, Math.floor(totalOn / sets / onS));
  const used = (r: number) => sets * (r * onS + (r - 1) * offS) + (sets - 1) * setRest;
  while (used(reps) > budget && reps > 3) reps--;
  const steps: Step[] = [];
  for (let s = 0; s < sets; s++) {
    for (let r = 0; r < reps; r++) {
      steps.push(step('work', onS, pct, CADENCE.micro, true));
      if (r < reps - 1) steps.push(step('recovery', offS, RECOVERY_PCT, CADENCE.easy));
    }
    if (s < sets - 1) steps.push(step('recovery', setRest, RECOVERY_PCT, CADENCE.easy));
  }
  return { steps, name: `VO2max ${onS}/${offS}s ${sets}×${reps} @ ${pc(pct)}`, usedS: used(reps) };
}

function enduranceMain(level: number, slot: Slot, variant: Variant): { steps: Step[]; name: string } {
  const mainS = SLOTS[slot].mainS;
  const pct = r3(lerp([0.62, 0.72], level));
  const steady = (s: number, c: number = CADENCE.Endurance) => step('steady', s, pct, c, true);
  const steps: Step[] = [];
  if (variant === 'sprints') {
    const n = ENDURANCE_SPRINTS[slot];
    const gap = floorTo((mainS - n * SPRINT_S) / (n + 1), 5);
    for (let i = 0; i < n; i++) {
      steps.push(steady(gap), step('sprint', SPRINT_S, ENDURANCE_SPRINT_PCT, CADENCE.sprint, true));
    }
    steps.push(steady(mainS - n * SPRINT_S - n * gap));
    return { steps, name: `Endurance @ ${pc(pct)} + ${n}×0:10 sprints` };
  }
  if (variant === 'cadence') {
    // Same power throughout. Every 5 minutes, one minute of high or low cadence.
    let left = mainS;
    for (let k = 0; left >= 300; k++) {
      steps.push(steady(240), steady(60, k % 2 === 0 ? CADENCE.high : CADENCE.low));
      left -= 300;
    }
    if (left > 0) steps.push(steady(left));
    return { steps, name: `Endurance @ ${pc(pct)} with cadence drills` };
  }
  const { n, pct: surgePct } = enduranceSurges(level, slot);
  if (n === 0) {
    return { steps: [steady(mainS)], name: `Endurance ${Math.round(mainS / 60)} min @ ${pc(pct)}` };
  }
  const gap = floorTo((mainS - n * 60) / (n + 1), 15);
  for (let i = 0; i < n; i++) steps.push(steady(gap), step('surge', 60, surgePct, CADENCE.surge, true));
  steps.push(steady(mainS - n * 60 - n * gap));
  return { steps, name: `Endurance @ ${pc(pct)} + ${n}×1:00 @ ${pc(surgePct)}` };
}

const VARIANT_WORD: Partial<Record<Variant, string>> = {
  overunder: 'over-unders',
  bursts: 'with bursts',
  cadence: 'cadence',
};

/** Build the steps for a type at a level. Always lasts exactly the slot. */
export function buildSteps(
  type: SessionType,
  level: number,
  slot: Slot,
  variant: Variant = 'classic',
): { steps: Step[]; name: string } {
  const { warmS, coolS, mainS } = SLOTS[slot];
  if (type === 'Recovery') {
    return {
      steps: [step('steady', slot * 60, RECOVERY_RIDE_PCT, CADENCE.easy, true)],
      name: 'Recovery spin',
    };
  }
  const steps: Step[] = [];
  const hard = type === 'Threshold' || type === 'VO2max';
  if (hard) {
    steps.push(ramp('warmup', warmS - 120, 0.5, 0.7));
    for (let i = 0; i < 2; i++) {
      steps.push(step('opener', 30, 1.0, CADENCE.opener), step('recovery', 30, RECOVERY_PCT, CADENCE.easy));
    }
  } else {
    steps.push(ramp('warmup', warmS, 0.5, type === 'Endurance' ? 0.62 : 0.7));
  }

  let name: string;
  if (type === 'Endurance') {
    const main = enduranceMain(level, slot, variant);
    steps.push(...main.steps);
    name = main.name;
  } else {
    let usedS: number;
    if (type === 'VO2max' && (variant === '3030' || variant === '4020')) {
      const m =
        variant === '3030'
          ? microIntervals(level, slot, 30, 30, 0.08)
          : microIntervals(level, slot, 40, 20, 0.04);
      steps.push(...m.steps);
      name = m.name;
      usedS = m.usedS;
    } else {
      const set = fitIntervals(type, level, slot);
      // Over-unders come in whole 3-minute cycles.
      const intervalS = variant === 'overunder' ? Math.max(180, floorTo(set.intervalS, 180)) : set.intervalS;
      for (let i = 0; i < set.n; i++) {
        steps.push(...intervalBody(type, variant, intervalS, set.pct));
        if (i < set.n - 1) steps.push(step('recovery', set.recoveryS, RECOVERY_PCT, CADENCE.easy));
      }
      usedS = set.n * intervalS + (set.n - 1) * set.recoveryS;
      const word = VARIANT_WORD[variant];
      name = `${TYPE_LABEL[type]}${word ? ` ${word}` : ''} ${set.n}×${mmss(intervalS)} @ ${pc(set.pct)}`;
    }
    if (mainS - usedS > 0) steps.push(step('steady', mainS - usedS, FILLER_PCT, CADENCE.easy));
  }
  steps.push(ramp('cooldown', coolS, 0.55, 0.4));
  return { steps, name };
}

// ---------- Decision rules ----------

export interface RideLite {
  startedAt: string;
  type: SessionType;
  workPlannedS: number;
  workCompletedS: number;
}

const HOUR = 3600e3;
const DAY = 24 * HOUR;
export const isHardRide = (r: RideLite) =>
  (r.type === 'Threshold' || r.type === 'VO2max') &&
  r.workPlannedS > 0 &&
  r.workCompletedS >= 0.5 * r.workPlannedS;

function leastRecent(a: SessionType, b: SessionType, rides: RideLite[]): SessionType {
  const last = (t: SessionType) =>
    rides.filter((r) => r.type === t).reduce((m, r) => Math.max(m, Date.parse(r.startedAt)), -Infinity);
  return last(b) < last(a) ? b : a;
}

export interface Decision {
  type: SessionType;
  rule: 1 | 2 | 3 | 4;
  layoff: boolean;
  /** Set when "push me" was asked for and refused. */
  blocked: string | null;
  why: string;
}

/** Ordered rules: the first that matches wins. */
export function decide(answers: Answers, rides: RideLite[], now: Date): Decision {
  const t = now.getTime();
  const past = rides.filter((r) => Date.parse(r.startedAt) <= t);
  const lastRide = past.reduce<RideLite | null>(
    (m, r) => (!m || Date.parse(r.startedAt) > Date.parse(m.startedAt) ? r : m),
    null,
  );
  const layoff = !lastRide || t - Date.parse(lastRide.startedAt) > 7 * DAY;
  const hard = past.filter(isHardRide);
  const hard48 = hard.some((r) => t - Date.parse(r.startedAt) < 48 * HOUR);
  const hard7d = hard.filter((r) => t - Date.parse(r.startedAt) < 7 * DAY).length;

  if (answers.legs === 'tired') {
    if (lastRide && isHardRide(lastRide) && t - Date.parse(lastRide.startedAt) < 48 * HOUR) {
      return {
        type: 'Recovery',
        rule: 1,
        layoff,
        blocked: null,
        why: 'tired legs after a hard ride, so today is recovery only',
      };
    }
    return {
      type: 'Endurance',
      rule: 2,
      layoff,
      blocked: null,
      why: 'tired legs, so easy aerobic riding protects your recovery',
    };
  }

  let blocked: string | null = null;
  if (answers.feel === 'push') {
    if (layoff)
      blocked = lastRide ? 'it has been more than a week since your last ride' : 'this is your first ride';
    else if (hard48) blocked = 'you rode hard less than 48 hours ago';
    else if (hard7d >= 2) blocked = 'you already have 2 hard rides in the last 7 days';
    if (!blocked) {
      return {
        type: leastRecent('Threshold', 'VO2max', past),
        rule: 3,
        layoff,
        blocked: null,
        why: 'you are rested and asked for a push, so today is a hard session',
      };
    }
  }
  return {
    type: leastRecent('SweetSpot', 'Tempo', past),
    rule: 4,
    layoff,
    blocked,
    why: blocked
      ? `you asked for a push, but ${blocked}, so today builds aerobic strength instead`
      : 'a steady day that builds aerobic strength without digging a hole',
  };
}

// ---------- Generator ----------

export interface GeneratorProfile {
  ftp: number;
  levels: Levels;
  lastDone: Partial<Record<LevelType, string>>;
}

export const OFFSET_MIN = -2;
export const OFFSET_MAX = 1;

/**
 * @param taps Net taps of Harder (+1) / Easier (−1) on the preview.
 * @param swap Taps of Swap on the preview: moves on to the next variant of the session.
 */
export function generate(
  answers: Answers,
  profile: GeneratorProfile,
  rides: RideLite[],
  now: Date,
  taps = 0,
  swap = 0,
): SessionPlan {
  const d = decide(answers, rides, now);
  const slot = answers.minutes;
  if (d.type === 'Recovery') {
    const { steps, name } = buildSteps('Recovery', 1, slot);
    return {
      type: 'Recovery',
      name,
      minutes: slot,
      ftp: profile.ftp,
      storedLevel: null,
      riddenLevel: null,
      canEasier: false,
      canHarder: false,
      steps,
      explanation: `Recovery — ${d.why}.`,
    };
  }
  const type = d.type as LevelType;
  const stored = effectiveLevel(profile.levels[type], profile.lastDone[type], now);
  const base =
    (answers.feel === 'push' ? 0.5 : 0) + (answers.legs === 'fresh' ? 0.5 : 0) + (d.layoff ? -1 : 0);
  const offset = clamp(base + taps, OFFSET_MIN, OFFSET_MAX);
  const ridden = Math.round(clamp(stored + offset, 1, 10) * 100) / 100;
  // Variants rotate with each session of the type; the first session of a type is the classic one.
  const list = VARIANTS[type];
  const done = rides.filter((r) => r.type === type).length;
  const variant = list[(((done + swap) % list.length) + list.length) % list.length];
  const { steps, name } = buildSteps(type, ridden, slot, variant);
  const layoffNote = d.layoff && rides.length > 0 ? ' Level eased after a break.' : '';
  return {
    type,
    name,
    minutes: slot,
    ftp: profile.ftp,
    storedLevel: stored,
    riddenLevel: ridden,
    canEasier: offset > OFFSET_MIN && ridden > 1,
    canHarder: offset < OFFSET_MAX && ridden < 10,
    steps,
    explanation: `${TYPE_LABEL[type]}, level ${ridden.toFixed(1)} — ${d.why}.${layoffNote}${VARIANT_NOTE[variant]}`,
    variant,
    variantCount: list.length,
  };
}

const VARIANT_NOTE: Record<Variant, string> = {
  classic: '',
  overunder: ' Over-unders: 2 minutes just under, 1 minute over, repeated.',
  bursts: ' With a 10-second burst every 3 minutes.',
  cadence: ' Same power, with changes of cadence. Follow the cadence target.',
  sprints: ' With short 10-second sprints: spin up fast, then settle straight back.',
  '3030': ' Short repeats: 30 seconds hard, 30 seconds easy.',
  '4020': ' Short repeats: 40 seconds hard, 20 seconds easy.',
};

/** The hard-coded 10-minute hardware test: 2-minute steps at fixed watts. */
export function testWorkout(ftp: number): SessionPlan {
  const watts = [100, 150, 120, 100, 150];
  return {
    type: 'Recovery',
    name: 'ERG test: 2 min steps 100 / 150 / 120 W',
    minutes: 10,
    ftp,
    storedLevel: null,
    riddenLevel: null,
    canEasier: false,
    canHarder: false,
    steps: watts.map((w) => step('steady', 120, w / ftp, CADENCE.easy, true)),
    explanation: 'Hardware test. Not recorded.',
    isTest: true,
  };
}

export const planSeconds = (plan: SessionPlan) => plan.steps.reduce((s, x) => s + x.durationS, 0);
export const planWorkSeconds = (plan: SessionPlan) =>
  plan.steps.reduce((s, x) => s + (x.isWork ? x.durationS : 0), 0);
