// The IPC surface between the renderers and the main process.
import {
  Answers,
  AppState,
  DisplayInfo,
  FoundDevice,
  HotkeyAction,
  Profile,
  ProgressData,
  Rating,
  RideSummary,
  Sample,
  SessionPlan,
  Settings,
} from './types';

export type ControlCommand = 'pause' | 'skip' | 'up' | 'down' | 'end';

export interface SettingsPatch {
  overlay?: Partial<Settings['overlay']>;
  hotkeys?: Partial<Settings['hotkeys']>;
  hrCeiling?: number | null;
  simulate?: boolean | null;
}

export interface Api {
  getProfile(): Promise<Profile>;
  getState(): Promise<AppState>;
  getDisplays(): Promise<DisplayInfo[]>;
  preview(answers: Answers, taps: number, swap: number): Promise<SessionPlan>;
  start(answers: Answers, taps: number, swap: number): Promise<void>;
  startTest(): Promise<void>;
  control(cmd: ControlCommand): Promise<void>;
  lastRide(): Promise<{ ride: RideSummary; notice: string | null } | null>;
  clearLastRide(): Promise<void>;
  rate(id: string, rating: Rating): Promise<RideSummary | null>;
  getProgress(): Promise<ProgressData>;
  getRide(id: string): Promise<{ ride: RideSummary; samples: Sample[] } | null>;
  scan(): Promise<{ ok: boolean; message: string; found: FoundDevice[] }>;
  pair(trainerId: number | null, hrId: number | null): Promise<string>;
  updateSettings(patch: SettingsPatch): Promise<{ profile: Profile; hotkeyFailures: HotkeyAction[] }>;
  hotkeyFailures(): Promise<HotkeyAction[]>;
  setFtp(watts: number): Promise<Profile>;
  setMaxHr(bpm: number | null): Promise<Profile>;
  setAge(age: number): Promise<Profile>;
  finishFirstRun(): Promise<Profile>;
  setManualErg(watts: number | null): Promise<void>;
  overlayPreview(on: boolean): Promise<void>;
  simControl(s: { pedalling?: boolean; trainerOn?: boolean; hrOn?: boolean }): Promise<void>;
  dataDir(): Promise<string>;
  onState(cb: (s: AppState) => void): () => void;
}

export const API_METHODS = [
  'getProfile',
  'getState',
  'getDisplays',
  'preview',
  'start',
  'startTest',
  'control',
  'lastRide',
  'clearLastRide',
  'rate',
  'getProgress',
  'getRide',
  'scan',
  'pair',
  'updateSettings',
  'hotkeyFailures',
  'setFtp',
  'setMaxHr',
  'setAge',
  'finishFirstRun',
  'setManualErg',
  'overlayPreview',
  'simControl',
  'dataDir',
] as const satisfies readonly Exclude<keyof Api, 'onState'>[];
