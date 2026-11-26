// Real devices over an ANT+ USB stick, using incyclist-ant-plus. Main process only.
import { FoundDevice } from '../../shared/types';
import { DeviceHub, HrReading, HrService, TrainerReading, TrainerService } from './types';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

const OPEN_MESSAGES: Record<string, string> = {
  NoStick:
    'No ANT+ stick found. Plug it in, and on Windows install the WinUSB driver with Zadig (see README).',
  AlreadyInUse: 'The ANT+ stick is in use by another program. Close Garmin Express, Zwift or similar.',
  CommunicationError: 'The ANT+ stick did not respond. Unplug it and plug it back in.',
  // The library returns nothing when it finds a stick but cannot claim it.
  Busy: 'An ANT+ stick is plugged in but could not be opened. Another program is using it, or the WinUSB driver is missing (see README).',
  StartupError:
    'The ANT+ stick failed to start. On Windows, check the WinUSB driver was installed with Zadig.',
};

const REOPEN_AFTER_MS = 30_000;

export class AntHub implements DeviceHub {
  readonly simulated = false;
  private ant: Any = null;
  private feSensor: Any = null;
  private feChannel: Any = null;
  private hrChannel: Any = null;
  private trainerReading: TrainerReading | null = null;
  private hrReading: HrReading | null = null;
  private sending = false;
  private opened = false;
  private message = 'Not connected';
  private ids: { trainerId: number | null; hrId: number | null } = { trainerId: null, hrId: null };
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private connectedAt = 0;

  readonly trainer: TrainerService = {
    latest: () => this.trainerReading,
    setTargetPower: (w) => {
      if (!this.feSensor || this.sending) return;
      this.sending = true;
      Promise.resolve(this.feSensor.sendTargetPower(Math.max(0, Math.round(w))))
        .catch(() => undefined)
        .finally(() => {
          this.sending = false;
        });
    },
  };
  readonly hr: HrService = { latest: () => this.hrReading };

  async open() {
    // Opening twice would try to claim a stick this app already holds.
    if (this.opened && this.ant) return { ok: true, message: this.message };
    try {
      // Loaded lazily so the simulator works on machines without the USB library.
      const { AntDevice } = require('incyclist-ant-plus/lib/bindings');
      this.ant = new AntDevice({ startupTimeout: 3000, detailedStartReport: true });
      const res = await this.ant.open();
      this.opened = res === true || res === 'Success';
      if (this.opened) this.message = 'ANT+ stick ready';
      else if (res === undefined) this.message = OPEN_MESSAGES.Busy;
      else this.message = OPEN_MESSAGES[String(res)] ?? `Could not open the ANT+ stick (${res}).`;
      if (!this.opened) this.ant = null;
    } catch (e) {
      this.opened = false;
      this.message = `Could not load the ANT+ USB library: ${(e as Error).message}`;
    }
    if (!this.watchdog) this.watchdog = setInterval(() => void this.check(), 10_000);
    return { ok: this.opened, message: this.message };
  }

  /** If the trainer has been silent for a while, rebuild the connection from the stick up. */
  private async check() {
    if (this.busy || this.ids.trainerId === null) return;
    const now = Date.now();
    const lastHeard = this.trainerReading?.at ?? this.connectedAt;
    if (this.opened && now - lastHeard < REOPEN_AFTER_MS) return;
    this.busy = true;
    try {
      await this.closeStick();
      const r = await this.open();
      if (r.ok) await this.connectInner(this.ids.trainerId, this.ids.hrId);
    } catch {
      // Try again on the next watchdog pass.
    } finally {
      this.busy = false;
    }
  }

  private async stopSensors() {
    for (const ch of [this.feChannel, this.hrChannel]) {
      try {
        if (ch) await ch.stopAllSensors();
      } catch {
        // Ignore: the channel may already be closed.
      }
    }
    this.feChannel = this.hrChannel = this.feSensor = null;
  }

  async scan(ms: number): Promise<FoundDevice[]> {
    if (!this.opened) {
      const r = await this.open();
      if (!r.ok) return [];
    }
    this.busy = true;
    const found = new Map<string, FoundDevice>();
    try {
      // A scan needs every other channel closed.
      await this.stopSensors();
      const { FitnessEquipmentSensor, HeartRateSensor } = require('incyclist-ant-plus');
      const ch = this.ant.getChannel();
      if (!ch) return [];
      ch.on('detected', (profile: string, id: number) => {
        if (profile === 'FE' || profile === 'HR') found.set(`${profile}:${id}`, { profile, id });
      });
      ch.attach(new FitnessEquipmentSensor());
      ch.attach(new HeartRateSensor());
      if (await ch.startScanner()) await new Promise((r) => setTimeout(r, ms));
      await ch.stopScanner();
      ch.removeAllListeners();
    } catch (e) {
      this.message = `Scan failed: ${(e as Error).message}`;
    } finally {
      this.busy = false;
    }
    // Put back whatever was connected before the scan.
    if (this.ids.trainerId !== null || this.ids.hrId !== null)
      await this.connect(this.ids.trainerId, this.ids.hrId);
    return [...found.values()];
  }

  async connect(trainerId: number | null, hrId: number | null) {
    this.ids = { trainerId, hrId };
    if (!this.opened) {
      const r = await this.open();
      if (!r.ok) return;
    }
    this.busy = true;
    try {
      await this.connectInner(trainerId, hrId);
    } finally {
      this.busy = false;
    }
  }

  private async connectInner(trainerId: number | null, hrId: number | null) {
    await this.stopSensors();
    const { FitnessEquipmentSensor, HeartRateSensor } = require('incyclist-ant-plus');
    const parts: string[] = [];
    this.connectedAt = Date.now();
    if (trainerId !== null) {
      const ch = this.ant.getChannel();
      const sensor = new FitnessEquipmentSensor(trainerId);
      ch.on('data', (_profile: string, _id: number, s: Any) => {
        this.trainerReading = {
          power: Number(s?.InstantaneousPower ?? 0) || 0,
          cadence: Number(s?.Cadence ?? 0) || 0,
          at: Date.now(),
        };
      });
      if (await ch.startSensor(sensor)) {
        this.feChannel = ch;
        this.feSensor = sensor;
        parts.push(`trainer ${trainerId}`);
      } else parts.push(`trainer ${trainerId} failed to start`);
    }
    if (hrId !== null) {
      const ch = this.ant.getChannel();
      ch.on('data', (_profile: string, _id: number, s: Any) => {
        const bpm = Number(s?.ComputedHeartRate ?? 0);
        if (bpm > 0) this.hrReading = { bpm, at: Date.now() };
      });
      if (await ch.startSensor(new HeartRateSensor(hrId))) {
        this.hrChannel = ch;
        parts.push(`HR ${hrId}`);
      } else parts.push(`HR ${hrId} failed to start`);
    }
    this.message = parts.length ? `ANT+: ${parts.join(', ')}` : 'ANT+ stick ready, no devices paired';
  }

  status() {
    return this.message;
  }

  private async closeStick() {
    await this.stopSensors();
    try {
      if (this.ant) await this.ant.close();
    } catch {
      // Ignore.
    }
    this.ant = null;
    this.opened = false;
  }

  async close() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    await this.closeStick();
  }
}
