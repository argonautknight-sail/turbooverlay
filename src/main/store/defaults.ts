import { Profile, SCHEMA_VERSION, Settings } from '../../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  overlay: { position: 'bottom', compact: false, opacity: 0.7, displayId: null },
  hotkeys: {
    pause: 'Ctrl+Alt+P',
    up: 'Ctrl+Alt+Up',
    down: 'Ctrl+Alt+Down',
    skip: 'Ctrl+Alt+N',
    cycle: 'Ctrl+Alt+O',
    hide: 'Ctrl+Alt+H',
  },
  hrCeiling: null,
  simulate: null,
};

/** Every type starts here. The plan does not give a starting level; 3 is a cautious choice. */
export const START_LEVEL = 3;

/** Placeholders only: the first-run wizard asks for the rider's own values. */
export const DEFAULT_AGE = 40;
export const DEFAULT_FTP = 200;

export function defaultProfile(now: Date): Profile {
  return {
    schemaVersion: SCHEMA_VERSION,
    age: DEFAULT_AGE,
    ftp: DEFAULT_FTP,
    ftpHistory: [{ date: now.toISOString(), ftp: DEFAULT_FTP, source: 'seed' }],
    ftpEstimates: [],
    maxHrObserved: null,
    maxHrManual: null,
    levels: {
      Endurance: START_LEVEL,
      Tempo: START_LEVEL,
      SweetSpot: START_LEVEL,
      Threshold: START_LEVEL,
      VO2max: START_LEVEL,
    },
    lastDone: {},
    levelHistory: [],
    settings: structuredClone(DEFAULT_SETTINGS),
    devices: { trainerId: null, hrId: null },
    firstRunDone: false,
  };
}
