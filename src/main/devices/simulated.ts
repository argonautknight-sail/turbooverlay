// A fake rider and trainer for development and testing without hardware.
import { FoundDevice } from '../../shared/types';
import { DeviceHub, HrReading, HrService, TrainerReading, TrainerService } from './types';

export interface SimSwitches {
  pedalling: boolean;
  trainerOn: boolean;
  hrOn: boolean;
}

export class SimulatedHub implements DeviceHub {
  readonly simulated = true;
  switches: SimSwitches = { pedalling: true, trainerOn: true, hrOn: true };

  private target: number | null = null;
  private power = 0;
  private cadence = 0;
  private bpm = 72;
  private drift = 0;
  private trainerReading: TrainerReading | null = null;
  private hrReading: HrReading | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The pretend rider: reaches 148 bpm at 195 W. */
  private readonly riderFtp = 195;

  readonly trainer: TrainerService = {
    latest: () => this.trainerReading,
    setTargetPower: (w) => {
      this.target = w;
    },
  };
  readonly hr: HrService = { latest: () => this.hrReading };

  async open() {
    if (!this.timer) this.timer = setInterval(() => this.step(), 250);
    return { ok: true, message: 'Simulator running' };
  }

  private step() {
    const dt = 0.25;
    const now = Date.now();
    if (this.switches.pedalling) {
      const want = this.target ?? 120;
      this.power += ((want - this.power) * dt) / 1.5;
      this.cadence += (88 + 4 * Math.sin(now / 9000) - this.cadence) * dt;
    } else {
      this.power += (0 - this.power) * dt * 2;
      this.cadence += (0 - this.cadence) * dt * 2;
      if (this.cadence < 3) this.cadence = 0;
    }
    const noisy = Math.max(0, this.power * (1 + (Math.random() - 0.5) * 0.04));
    const steady = 62 + (148 - 62) * (this.power / this.riderFtp);
    this.drift =
      this.power > 0.7 * this.riderFtp
        ? Math.min(6, this.drift + 0.002 * dt)
        : Math.max(0, this.drift - 0.004 * dt);
    this.bpm += ((steady + this.drift - this.bpm) * dt) / 40;
    if (this.switches.trainerOn)
      this.trainerReading = { power: Math.round(noisy), cadence: Math.round(this.cadence), at: now };
    if (this.switches.hrOn) this.hrReading = { bpm: Math.round(this.bpm), at: now };
  }

  async scan(): Promise<FoundDevice[]> {
    await new Promise((r) => setTimeout(r, 800));
    return [
      { profile: 'FE', id: 12345 },
      { profile: 'HR', id: 54321 },
    ];
  }

  async connect() {}

  status() {
    return 'Simulator';
  }

  async close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
