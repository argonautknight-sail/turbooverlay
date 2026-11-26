// Types shared by the main process, the renderers and the tests.

export const SCHEMA_VERSION = 1;

export type SessionType = 'Recovery' | 'Endurance' | 'Tempo' | 'SweetSpot' | 'Threshold' | 'VO2max';
export type LevelType = Exclude<SessionType, 'Recovery'>;
export type IntervalType = Exclude<LevelType, 'Endurance'>;
export const LEVEL_TYPES: LevelType[] = ['Endurance', 'Tempo', 'SweetSpot', 'Threshold', 'VO2max'];
export const TYPE_LABEL: Record<SessionType, string> = {
  Recovery: 'Recovery',
  Endurance: 'Endurance',
  Tempo: 'Tempo',
  SweetSpot: 'Sweet Spot',
  Threshold: 'Threshold',
  VO2max: 'VO2max',
};

export type Slot = 30 | 45 | 60;
export type Legs = 'fresh' | 'normal' | 'tired';
export type Feel = 'steady' | 'push';
export interface Answers {
  minutes: Slot;
  legs: Legs;
  feel: Feel;
}

export type StepKind = 'warmup' | 'opener' | 'work' | 'surge' | 'sprint' | 'recovery' | 'steady' | 'cooldown';
export interface Step {
  kind: StepKind;
  durationS: number;
  /** Fractions of FTP (0.88 = 88%). A ramp has different start and end. */
  pctStart: number;
  pctEnd: number;
  /** Counts towards "work time" for the outcome classification. */
  isWork: boolean;
  /** Target cadence, rpm. Guidance only. Missing in rides recorded before cadence targets existed. */
  cadence?: number;
}

export interface SessionPlan {
  type: SessionType;
  name: string;
  minutes: number;
  ftp: number;
  /** Stored (decayed) level for the type before today's offsets. null for Recovery and test rides. */
  storedLevel: number | null;
  /** Level actually ridden today. */
  riddenLevel: number | null;
  /** Offset limits reached, so the UI can disable Easier / Harder. */
  canEasier: boolean;
  canHarder: boolean;
  steps: Step[];
  explanation: string;
  /** Which shape of the session this is (classic, over-unders, sprints...), and how many there are to swap between. */
  variant?: string;
  variantCount?: number;
  /** Test workouts are not recorded and never change levels or FTP. */
  isTest?: boolean;
}

export type Levels = Record<LevelType, number>;
export type Outcome = 'success' | 'stretch' | 'fail';
export type Rating = 'easy' | 'right' | 'hard' | 'dnf';

/** One line of the samples file. */
export interface Sample {
  /** Active (unpaused) seconds since the start. */
  t: number;
  /** Wall-clock seconds since the start. A jump means a pause. */
  w: number;
  /** Power, W. */
  p: number;
  /** Target power, W. */
  tp: number;
  /** Heart rate, or null when the strap is not being heard. */
  hr: number | null;
  cad: number;
  /** Step index in the plan. */
  i: number;
  /** Intensity multiplier in force (1 = as planned). */
  x: number;
}

export interface IntervalResult {
  stepIndex: number;
  pct: number;
  plannedS: number;
  completedS: number;
  avgPower: number;
  /** Highest target power during the interval: the power the rider was asked to hold. */
  peakTarget: number;
  /** Mean HR over the last 30 s ridden. */
  endHr: number | null;
  failed: boolean;
}

/** A steady chunk of riding used for the HR–power regression and efficiency. */
export interface Segment {
  t0: number;
  s: number;
  p: number;
  hr: number;
}

export interface RideHeader {
  schemaVersion: number;
  id: string;
  startedAt: string;
  plan: SessionPlan;
  /** Values in force when the ride started. */
  ftp: number;
  maxHr: number;
  levels: Levels;
  finished: boolean;
}

export interface RideSummary extends RideHeader {
  endedAt: string;
  durationS: number;
  avgPower: number;
  avgHr: number | null;
  avgCadence: number;
  peakHr5s: number | null;
  np: number;
  intensityFactor: number;
  tss: number;
  workPlannedS: number;
  workCompletedS: number;
  /** Time-weighted mean intensity multiplier over work time, minus 1. */
  netIntensity: number;
  intervals: IntervalResult[];
  segments: Segment[];
  efficiency: number | null;
  outcome: Outcome;
  rating: Rating | null;
  levelChange: { type: LevelType; from: number; to: number } | null;
}

export interface FtpEntry {
  date: string;
  ftp: number;
  source: 'seed' | 'auto' | 'manual';
}

export interface FtpEstimate {
  date: string;
  ftpBefore: number;
  ftpAfter: number;
  applied: boolean;
  decidedBy: string;
  maxHr: number;
  lthr: number;
  b: { valid: boolean; n: number; hrRange: number; slope: number; intercept: number; ftpB: number | null };
  lower: { value: number; date: string } | null;
  upper: { value: number; date: string } | null;
}

export interface LevelEntry {
  date: string;
  type: LevelType;
  from: number;
  to: number;
  reason: string;
}

export type HotkeyAction = 'pause' | 'up' | 'down' | 'skip' | 'cycle' | 'hide';
export const HOTKEY_LABEL: Record<HotkeyAction, string> = {
  pause: 'Pause / resume',
  up: 'Intensity +5%',
  down: 'Intensity −5%',
  skip: 'Skip interval',
  cycle: 'Cycle overlay position / compact',
  hide: 'Hide / show overlay',
};

export interface OverlaySettings {
  position: 'bottom' | 'top';
  compact: boolean;
  /** 0.4–0.9 */
  opacity: number;
  /** Electron display id, or null for the primary display. */
  displayId: number | null;
}

export interface Settings {
  overlay: OverlaySettings;
  hotkeys: Record<HotkeyAction, string>;
  /** HR ceiling for the safety rule. null = max HR + 3. */
  hrCeiling: number | null;
  /** null = simulator in development, real devices when packaged. */
  simulate: boolean | null;
}

export interface Profile {
  schemaVersion: number;
  age: number;
  ftp: number;
  ftpHistory: FtpEntry[];
  ftpEstimates: FtpEstimate[];
  maxHrObserved: number | null;
  maxHrManual: number | null;
  levels: Levels;
  /** ISO date of the last session of each type; drives inactivity decay. */
  lastDone: Partial<Record<LevelType, string>>;
  levelHistory: LevelEntry[];
  settings: Settings;
  devices: { trainerId: number | null; hrId: number | null };
  firstRunDone: boolean;
}

// ---- Live state pushed to the windows once a second ----

export type PauseReason = 'manual' | 'auto' | 'trainer';
export interface EngineSnapshot {
  state: 'running' | 'paused' | 'finished';
  pauseReason: PauseReason | null;
  elapsedS: number;
  totalS: number;
  stepIndex: number;
  stepKind: StepKind;
  stepRemainingS: number;
  targetW: number;
  targetCadence: number | null;
  next: { durationS: number; watts: number; cadence: number | null } | null;
  intensity: number;
}

export interface LiveData {
  power: number;
  cadence: number;
  hr: number | null;
  trainerOk: boolean;
  hrOk: boolean;
  simulated: boolean;
  deviceStatus: string;
}

export interface AppState {
  live: LiveData;
  session: EngineSnapshot | null;
  /** Step outline for the overlay's profile bar. */
  profile: { durationS: number; a: number; b: number }[] | null;
  planName: string | null;
  hrAlert: boolean;
  overlay: OverlaySettings;
  manualErg: number | null;
}

export interface FoundDevice {
  profile: 'FE' | 'HR';
  id: number;
}

export interface ProgressData {
  verdict: { label: 'Improving' | 'Holding steady' | 'Slipping' | 'Not enough rides yet'; why: string };
  ftpSeries: { date: string; ftp: number; manual: boolean }[];
  efficiencySeries: { date: string; value: number }[];
  levels: { type: LevelType; level: number; change4w: number }[];
  weeks: { weekStart: string; tss: number; rides: number }[];
  rides: {
    id: string;
    date: string;
    type: SessionType;
    level: number | null;
    minutes: number;
    outcome: Outcome;
    avgPower: number;
    avgHr: number | null;
  }[];
}

export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
}

export function effectiveMaxHr(p: Pick<Profile, 'age' | 'maxHrObserved' | 'maxHrManual'>): number {
  if (p.maxHrManual) return p.maxHrManual;
  return Math.max(220 - p.age, p.maxHrObserved ?? 0);
}
