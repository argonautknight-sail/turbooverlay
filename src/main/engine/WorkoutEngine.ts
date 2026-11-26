// Runs a SessionPlan one second at a time. Pure: no timers, no Electron, no I/O.
// The caller calls tick() once per second with the latest cadence and trainer status.
import { EngineSnapshot, PauseReason, SessionPlan } from '../../shared/types';

export const BOUNDARY_RAMP_S = 3;
export const MIN_BLEND_STEP_S = 20;
export const RESUME_RAMP_S = 8;
export const RESUME_START = 0.5;
export const RESUME_CADENCE = 50;
export const AUTO_PAUSE_S = 3;
export const MIN_INTENSITY = 0.5;
export const MAX_INTENSITY = 1.3;

export interface TickInput {
  cadence: number;
  trainerOk: boolean;
}

export class WorkoutEngine {
  readonly plan: SessionPlan;
  readonly totalS: number;
  private starts: number[] = [];
  private elapsed = 0;
  private state: 'running' | 'paused' | 'finished' = 'paused';
  private pauseReason: PauseReason | null = 'auto';
  private zeroCadenceS = 0;
  /** Seconds of the resume ramp completed; null when no ramp is active. */
  private resumeRampS: number | null = 0;
  private _intensity = 1;

  constructor(plan: SessionPlan) {
    this.plan = plan;
    let t = 0;
    for (const s of plan.steps) {
      this.starts.push(t);
      t += s.durationS;
    }
    this.totalS = t;
  }

  get intensity() {
    return this._intensity;
  }
  get elapsedS() {
    return this.elapsed;
  }
  get isRunning() {
    return this.state === 'running';
  }
  get isFinished() {
    return this.state === 'finished';
  }

  get stepIndex(): number {
    let i = this.plan.steps.length - 1;
    while (i > 0 && this.starts[i] > this.elapsed) i--;
    return i;
  }

  /** Planned fraction of FTP at a time, with a short blend at step boundaries. */
  private pctAt(t: number): number {
    const i = this.stepIndex;
    const st = this.plan.steps[i];
    const into = t - this.starts[i];
    const own = st.pctStart + ((st.pctEnd - st.pctStart) * Math.min(into, st.durationS)) / st.durationS;
    // Short sprints get their full target at once; a blend would eat a third of them.
    if (i > 0 && into < BOUNDARY_RAMP_S && st.durationS >= MIN_BLEND_STEP_S) {
      const prev = this.plan.steps[i - 1].pctEnd;
      return prev + ((own - prev) * (into + 1)) / (BOUNDARY_RAMP_S + 1);
    }
    return own;
  }

  /** Full planned target, before any pause or resume easing. */
  private fullTarget(): number {
    return this.plan.ftp * this.pctAt(this.elapsed) * this._intensity;
  }

  /** Watts to send to the trainer now. */
  get targetW(): number {
    if (this.state === 'finished') return Math.round(this.plan.ftp * 0.4);
    const full = this.fullTarget();
    if (this.state === 'paused') return Math.round(full * RESUME_START);
    if (this.resumeRampS !== null) {
      const f = RESUME_START + ((1 - RESUME_START) * this.resumeRampS) / RESUME_RAMP_S;
      return Math.round(full * f);
    }
    return Math.round(full);
  }

  pause() {
    if (this.state === 'running') {
      this.state = 'paused';
      this.pauseReason = 'manual';
    } else if (this.state === 'paused') {
      // A manual pause on top of an automatic one keeps it paused until the rider resumes.
      this.pauseReason = 'manual';
    }
  }

  resume() {
    if (this.state === 'paused') this.startRunning();
  }

  togglePause() {
    if (this.state === 'running') this.pause();
    else this.resume();
  }

  private startRunning() {
    this.state = 'running';
    this.pauseReason = null;
    this.zeroCadenceS = 0;
    this.resumeRampS = 0;
  }

  adjustIntensity(delta: number) {
    this._intensity =
      Math.round(Math.min(MAX_INTENSITY, Math.max(MIN_INTENSITY, this._intensity + delta)) * 100) / 100;
  }

  /** Jump to the start of the next step. Skipping the last step ends the session. */
  skip() {
    if (this.state === 'finished') return;
    const i = this.stepIndex;
    if (i >= this.plan.steps.length - 1) {
      this.elapsed = this.totalS;
      this.state = 'finished';
      this.pauseReason = null;
    } else {
      this.elapsed = this.starts[i + 1];
    }
  }

  stop() {
    this.state = 'finished';
    this.pauseReason = null;
  }

  /**
   * Advance one second.
   * @returns true if this second counted as riding (and should be recorded).
   */
  tick(input: TickInput): boolean {
    if (this.state === 'finished') return false;

    if (this.state === 'paused') {
      if (this.pauseReason === 'trainer' && input.trainerOk) this.pauseReason = 'auto';
      if (this.pauseReason === 'auto' && input.trainerOk && input.cadence > 0) this.startRunning();
      else return false;
    }

    if (!input.trainerOk) {
      this.state = 'paused';
      this.pauseReason = 'trainer';
      return false;
    }
    this.zeroCadenceS = input.cadence <= 0 ? this.zeroCadenceS + 1 : 0;
    if (this.zeroCadenceS > AUTO_PAUSE_S) {
      this.state = 'paused';
      this.pauseReason = 'auto';
      return false;
    }

    if (this.resumeRampS !== null && input.cadence >= RESUME_CADENCE) {
      this.resumeRampS += 1;
      if (this.resumeRampS >= RESUME_RAMP_S) this.resumeRampS = null;
    }

    this.elapsed += 1;
    if (this.elapsed >= this.totalS) {
      this.elapsed = this.totalS;
      this.state = 'finished';
      this.pauseReason = null;
    }
    return true;
  }

  snapshot(): EngineSnapshot {
    const i = this.stepIndex;
    const st = this.plan.steps[i];
    const nx = this.plan.steps[i + 1];
    return {
      state: this.state,
      pauseReason: this.pauseReason,
      elapsedS: this.elapsed,
      totalS: this.totalS,
      stepIndex: i,
      stepKind: st.kind,
      stepRemainingS: Math.max(0, this.starts[i] + st.durationS - this.elapsed),
      targetW: this.targetW,
      targetCadence: st.cadence ?? null,
      next: nx
        ? {
            durationS: nx.durationS,
            watts: Math.round(this.plan.ftp * nx.pctStart * this._intensity),
            cadence: nx.cadence ?? null,
          }
        : null,
      intensity: this._intensity,
    };
  }
}
