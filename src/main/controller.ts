// Glues devices, the workout engine, the recorder and the coach together.
// All timing lives here, in the main process: renderers only display what is pushed to them.
import { EventEmitter } from 'node:events';
import { ControlCommand } from '../shared/api';
import {
  Answers,
  AppState,
  effectiveMaxHr,
  Profile,
  Rating,
  RideHeader,
  RideSummary,
  Sample,
  SCHEMA_VERSION,
  SessionPlan,
} from '../shared/types';
import { applyRating, applyRide } from './coach/apply';
import { generate, RideLite, testWorkout } from './coach/generator';
import { summarise } from './coach/metrics';
import { DeviceHub } from './devices/types';
import { WorkoutEngine } from './engine/WorkoutEngine';
import { Store } from './store/Store';

const STALE_MS = 3000;
const RESEND_MS = 2000;
const FLUSH_EVERY_S = 5;
const HR_OVER_S = 20;
const HR_ALERT_S = 10;
const MIN_RIDE_S = 60;

export class Controller extends EventEmitter {
  profile: Profile;
  rides: RideSummary[];
  private engine: WorkoutEngine | null = null;
  private header: RideHeader | null = null;
  private samples: Sample[] = [];
  private wallStart = 0;
  private hrCeiling = 0;
  private hrOverS = 0;
  private hrAlertS = 0;
  private lastSent: { w: number; at: number } = { w: -1, at: 0 };
  private manualErg: number | null = null;
  private nextTick = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: { ride: RideSummary; notice: string | null } | null = null;
  private state: AppState;

  constructor(
    private readonly store: Store,
    private hub: DeviceHub,
  ) {
    super();
    this.profile = store.loadProfile();
    this.rides = store.loadRides();
    // Finalise anything a crash left behind, oldest first, as if it had just ended.
    for (const ride of store.recoverUnfinished()) this.finalise(ride);
    this.state = this.buildState();
  }

  setHub(hub: DeviceHub) {
    this.hub = hub;
  }

  get sessionActive() {
    return this.engine !== null;
  }

  start() {
    this.nextTick = Date.now() + 1000;
    this.timer = setInterval(() => {
      const now = Date.now();
      // After a long stall (sleep, debugger) do not replay the missed seconds.
      if (now - this.nextTick > 5000) this.nextTick = now;
      while (now >= this.nextTick) {
        this.second(this.nextTick);
        this.nextTick += 1000;
      }
    }, 100);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.store.flush();
  }

  saveProfile(p: Profile) {
    this.profile = p;
    this.store.saveProfile(p);
  }

  private rideLites(): RideLite[] {
    return this.rides.map((r) => ({
      startedAt: r.startedAt,
      type: r.plan.type,
      workPlannedS: r.workPlannedS,
      workCompletedS: r.workCompletedS,
    }));
  }

  preview(answers: Answers, taps: number, swap = 0): SessionPlan {
    return generate(answers, this.profile, this.rideLites(), new Date(), taps, swap);
  }

  startSession(plan: SessionPlan) {
    if (this.engine) return;
    const now = new Date();
    this.manualErg = null;
    this.last = null;
    this.engine = new WorkoutEngine(plan);
    this.samples = [];
    this.wallStart = now.getTime();
    this.hrOverS = 0;
    this.hrAlertS = 0;
    const maxHr = effectiveMaxHr(this.profile);
    // Fixed for the whole ride, and above max HR so a new peak can still be recorded.
    this.hrCeiling = this.profile.settings.hrCeiling ?? maxHr + 3;
    this.header = {
      schemaVersion: SCHEMA_VERSION,
      id: this.store.freeRideId(now),
      startedAt: now.toISOString(),
      plan,
      ftp: this.profile.ftp,
      maxHr,
      levels: { ...this.profile.levels },
      finished: false,
    };
    if (!plan.isTest) this.store.beginRide(this.header);
    this.emit('session', true);
  }

  startFromAnswers(answers: Answers, taps: number, swap = 0) {
    this.startSession(this.preview(answers, taps, swap));
  }

  startTest() {
    this.startSession(testWorkout(this.profile.ftp));
  }

  control(cmd: ControlCommand) {
    const e = this.engine;
    if (!e) return;
    if (cmd === 'pause') e.togglePause();
    else if (cmd === 'skip') e.skip();
    else if (cmd === 'up') e.adjustIntensity(0.05);
    else if (cmd === 'down') e.adjustIntensity(-0.05);
    else if (cmd === 'end') e.stop();
    if (e.isFinished) this.endSession();
    else this.push();
  }

  setManualErg(w: number | null) {
    if (this.engine) return;
    this.manualErg = w;
    this.lastSent = { w: -1, at: 0 };
  }

  private send(w: number, now: number) {
    if (w !== this.lastSent.w || now - this.lastSent.at >= RESEND_MS) {
      this.hub.trainer.setTargetPower(w);
      this.lastSent = { w, at: now };
    }
  }

  /** One second of the world. */
  private second(now: number) {
    const tr = this.hub.trainer.latest();
    const hr = this.hub.hr.latest();
    const trainerOk = !!tr && now - tr.at < STALE_MS;
    const hrOk = !!hr && now - hr.at < STALE_MS;
    const e = this.engine;

    if (e && this.header) {
      const i = e.stepIndex;
      const tp = e.targetW;
      const x = e.intensity;
      const counted = e.tick({ cadence: trainerOk ? tr!.cadence : 0, trainerOk });
      if (counted) {
        const s: Sample = {
          t: e.elapsedS,
          w: Math.round((now - this.wallStart) / 1000),
          p: tr!.power,
          tp,
          hr: hrOk ? hr!.bpm : null,
          cad: tr!.cadence,
          i,
          x,
        };
        this.samples.push(s);
        if (!this.header.plan.isTest) {
          this.store.appendSample(s);
          if (this.samples.length % FLUSH_EVERY_S === 0) this.store.flush();
        }
        // Safety: sustained HR above the ceiling eases the target and flashes the HR.
        this.hrOverS = hrOk && hr!.bpm > this.hrCeiling ? this.hrOverS + 1 : 0;
        if (this.hrOverS > HR_OVER_S) {
          e.adjustIntensity(-0.05);
          this.hrOverS = 0;
          this.hrAlertS = HR_ALERT_S;
        }
      }
      if (this.hrAlertS > 0) this.hrAlertS--;
      this.send(e.targetW, now);
      if (e.isFinished) {
        this.endSession();
        return;
      }
    } else if (this.manualErg !== null) {
      this.send(this.manualErg, now);
    }
    this.push();
  }

  private endSession() {
    const e = this.engine;
    const header = this.header;
    if (!e || !header) return;
    this.engine = null;
    this.header = null;
    this.hub.trainer.setTargetPower(Math.round(this.profile.ftp * 0.4));
    if (header.plan.isTest) {
      // Test workouts are never stored.
    } else if (this.samples.length < MIN_RIDE_S) {
      this.store.discardRide(header.id);
    } else {
      this.store.flush();
      const ride = summarise(header, this.samples, new Date().toISOString());
      this.last = this.finalise(ride);
    }
    this.samples = [];
    this.emit('session', false);
    this.push();
  }

  /** Apply a finished ride to the profile and write both to disk. */
  private finalise(ride: RideSummary): { ride: RideSummary; notice: string | null } {
    const out = applyRide(this.profile, ride, this.rides, new Date(ride.endedAt));
    this.store.saveRide(out.ride);
    this.saveProfile(out.profile);
    this.rides = [...this.rides, out.ride];
    return { ride: out.ride, notice: out.notice };
  }

  lastRide() {
    return this.last;
  }
  clearLastRide() {
    this.last = null;
  }

  rate(id: string, rating: Rating): RideSummary | null {
    const idx = this.rides.findIndex((r) => r.id === id);
    if (idx < 0) return null;
    const out = applyRating(this.profile, this.rides[idx], rating);
    this.rides = this.rides.map((r, k) => (k === idx ? out.ride : r));
    this.store.saveRide(out.ride);
    this.saveProfile(out.profile);
    if (this.last?.ride.id === id) this.last = { ...this.last, ride: out.ride };
    return out.ride;
  }

  getRide(id: string) {
    const ride = this.rides.find((r) => r.id === id);
    return ride ? { ride, samples: this.store.readSamples(id) } : null;
  }

  private buildState(): AppState {
    const now = Date.now();
    const tr = this.hub.trainer.latest();
    const hr = this.hub.hr.latest();
    const trainerOk = !!tr && now - tr.at < STALE_MS;
    const hrOk = !!hr && now - hr.at < STALE_MS;
    const e = this.engine;
    return {
      live: {
        power: trainerOk ? tr!.power : 0,
        cadence: trainerOk ? tr!.cadence : 0,
        hr: hrOk ? hr!.bpm : null,
        trainerOk,
        hrOk,
        simulated: this.hub.simulated,
        deviceStatus: this.hub.status(),
      },
      session: e ? e.snapshot() : null,
      profile: e ? e.plan.steps.map((s) => ({ durationS: s.durationS, a: s.pctStart, b: s.pctEnd })) : null,
      planName: e ? e.plan.name : null,
      hrAlert: this.hrAlertS > 0,
      overlay: this.profile.settings.overlay,
      manualErg: this.manualErg,
    };
  }

  getState() {
    return this.state;
  }

  push() {
    this.state = this.buildState();
    this.emit('state', this.state);
  }
}
