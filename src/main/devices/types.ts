import { FoundDevice } from '../../shared/types';

export interface TrainerReading {
  power: number;
  cadence: number;
  /** Date.now() when this was heard. */
  at: number;
}
export interface HrReading {
  bpm: number;
  at: number;
}

/** A controllable trainer. Named for what it does, not for ANT+, so FTMS could be added later. */
export interface TrainerService {
  latest(): TrainerReading | null;
  /** ERG target in watts. Safe to call repeatedly. */
  setTargetPower(watts: number): void;
}

export interface HrService {
  latest(): HrReading | null;
}

export interface DeviceHub {
  readonly simulated: boolean;
  readonly trainer: TrainerService;
  readonly hr: HrService;
  open(): Promise<{ ok: boolean; message: string }>;
  /** Listen for nearby devices. Connected sensors are dropped while scanning. */
  scan(ms: number): Promise<FoundDevice[]>;
  connect(trainerId: number | null, hrId: number | null): Promise<void>;
  status(): string;
  close(): Promise<void>;
}
