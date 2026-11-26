import { app, BrowserWindow, globalShortcut, ipcMain, powerSaveBlocker, screen, shell } from 'electron';
import * as path from 'node:path';
import { Api, API_METHODS, SettingsPatch } from '../shared/api';
import { AppState, HotkeyAction, Profile } from '../shared/types';
import { buildProgress } from './coach/analytics';
import { setManualFtp } from './coach/apply';
import { Controller } from './controller';
import { AntHub } from './devices/ant';
import { SimulatedHub } from './devices/simulated';
import { DeviceHub } from './devices/types';
import { Store } from './store/Store';

const OVERLAY_FULL = { w: 900, h: 96 };
const OVERLAY_COMPACT = { w: 460, h: 76 };
const OVERLAY_MARGIN = 28;
const REASSERT_MS = 2000;

let home: BrowserWindow | null = null;
let overlay: BrowserWindow | null = null;
let controller: Controller;
let hub: DeviceHub;
let overlayPreview = false;
let overlayHidden = false;
let hotkeyFailures: HotkeyAction[] = [];
let hotkeysOn = false;
let blockerId: number | null = null;
let reassert: ReturnType<typeof setInterval> | null = null;

const argv = process.argv.slice(1);
function wantSimulator(p: Profile): boolean {
  if (argv.includes('--real')) return false;
  if (argv.includes('--sim')) return true;
  return p.settings.simulate ?? !app.isPackaged;
}

function loadPage(win: BrowserWindow, page: 'index' | 'overlay') {
  const dev = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && dev) void win.loadURL(`${dev}/${page}.html`);
  else void win.loadFile(path.join(__dirname, `../renderer/${page}.html`));
}

function createHome() {
  home = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: '#14171c',
    autoHideMenuBar: true,
    title: 'TurboOverlay',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), backgroundThrottling: false },
  });
  home.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  loadPage(home, 'index');
  home.on('closed', () => {
    home = null;
    app.quit();
  });
}

// ---------- Overlay ----------

function overlayBounds() {
  const o = controller.profile.settings.overlay;
  const displays = screen.getAllDisplays();
  // Fall back to the primary display if the chosen monitor has been unplugged.
  const d = displays.find((x) => x.id === o.displayId) ?? screen.getPrimaryDisplay();
  const size = o.compact ? OVERLAY_COMPACT : OVERLAY_FULL;
  const w = Math.min(size.w, d.bounds.width - 40);
  const x = Math.round(d.bounds.x + (d.bounds.width - w) / 2);
  const y =
    o.position === 'top'
      ? d.bounds.y + OVERLAY_MARGIN
      : d.bounds.y + d.bounds.height - size.h - OVERLAY_MARGIN;
  return { x, y, width: w, height: size.h };
}

function createOverlay() {
  overlay = new BrowserWindow({
    ...overlayBounds(),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), backgroundThrottling: false },
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true, { forward: true });
  if (process.platform !== 'win32') overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  loadPage(overlay, 'overlay');
  overlay.on('closed', () => (overlay = null));
}

/** The overlay should be on screen during a session or a preview, unless hidden by hotkey. */
function syncOverlay() {
  if (!overlay) return;
  const armed = controller.sessionActive || overlayPreview;
  const visible = armed && !overlayHidden;
  overlay.setBounds(overlayBounds());
  if (visible && !overlay.isVisible()) overlay.showInactive();
  if (!visible && overlay.isVisible()) overlay.hide();
  setHotkeys(armed);

  // Windows can drop an always-on-top window behind an app that has just gone fullscreen.
  if (visible && !reassert) {
    reassert = setInterval(() => {
      if (!overlay || !overlay.isVisible()) return;
      overlay.setAlwaysOnTop(true, 'screen-saver');
      overlay.moveTop();
    }, REASSERT_MS);
  } else if (!visible && reassert) {
    clearInterval(reassert);
    reassert = null;
  }

  if (controller.sessionActive && blockerId === null)
    blockerId = powerSaveBlocker.start('prevent-display-sleep');
  if (!controller.sessionActive && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

// ---------- Hotkeys ----------

function runHotkey(action: HotkeyAction) {
  if (action === 'hide') {
    overlayHidden = !overlayHidden;
    syncOverlay();
  } else if (action === 'cycle') {
    // bottom → bottom compact → top → top compact → bottom
    const o = controller.profile.settings.overlay;
    const next = !o.compact
      ? { ...o, compact: true }
      : { ...o, compact: false, position: o.position === 'bottom' ? ('top' as const) : ('bottom' as const) };
    controller.saveProfile({
      ...controller.profile,
      settings: { ...controller.profile.settings, overlay: next },
    });
    syncOverlay();
    controller.push();
  } else {
    controller.control(action);
  }
}

/** Register or release the global hotkeys. Returns the actions that could not be registered. */
function setHotkeys(on: boolean): HotkeyAction[] {
  if (on === hotkeysOn) return hotkeyFailures;
  globalShortcut.unregisterAll();
  hotkeysOn = on;
  if (!on) return hotkeyFailures;
  hotkeyFailures = registerAll();
  return hotkeyFailures;
}

function registerAll(): HotkeyAction[] {
  const failed: HotkeyAction[] = [];
  const keys = controller.profile.settings.hotkeys;
  for (const action of Object.keys(keys) as HotkeyAction[]) {
    let ok = false;
    try {
      ok = !!keys[action] && globalShortcut.register(keys[action], () => runHotkey(action));
    } catch {
      ok = false;
    }
    if (!ok) failed.push(action);
  }
  return failed;
}

/** Try the bindings so Settings can report failures, without holding them when not riding. */
function testHotkeys(): HotkeyAction[] {
  globalShortcut.unregisterAll();
  hotkeyFailures = registerAll();
  if (!hotkeysOn) globalShortcut.unregisterAll();
  return hotkeyFailures;
}

// ---------- Devices ----------

async function makeHub(): Promise<void> {
  if (hub) await hub.close();
  hub = wantSimulator(controller.profile) ? new SimulatedHub() : new AntHub();
  controller.setHub(hub);
  const r = await hub.open();
  const { trainerId, hrId } = controller.profile.devices;
  if (r.ok && (trainerId !== null || hrId !== null)) await hub.connect(trainerId, hrId);
}

// ---------- IPC ----------

function registerIpc() {
  const c = controller;
  const save = (p: Profile) => {
    c.saveProfile(p);
    c.push();
    return p;
  };
  const handlers: Omit<Api, 'onState'> = {
    getProfile: async () => c.profile,
    getState: async () => c.getState(),
    getDisplays: async () => {
      const primary = screen.getPrimaryDisplay().id;
      return screen.getAllDisplays().map((d, i) => ({
        id: d.id,
        label: `Display ${i + 1} (${d.bounds.width}×${d.bounds.height})${d.id === primary ? ' — primary' : ''}`,
        primary: d.id === primary,
      }));
    },
    preview: async (answers, taps, swap) => c.preview(answers, taps, swap),
    start: async (answers, taps, swap) => {
      overlayHidden = false;
      overlayPreview = false;
      c.startFromAnswers(answers, taps, swap);
    },
    startTest: async () => {
      overlayHidden = false;
      overlayPreview = false;
      c.startTest();
    },
    control: async (cmd) => c.control(cmd),
    lastRide: async () => c.lastRide(),
    clearLastRide: async () => c.clearLastRide(),
    rate: async (id, rating) => c.rate(id, rating),
    getProgress: async () => buildProgress(c.profile, c.rides, new Date()),
    getRide: async (id) => c.getRide(id),
    scan: async () => {
      if (c.sessionActive) return { ok: false, message: 'Finish the ride before scanning.', found: [] };
      const r = await hub.open();
      if (!r.ok) return { ok: false, message: r.message, found: [] };
      const found = await hub.scan(8000);
      return {
        ok: true,
        message: found.length
          ? `Found ${found.length} device(s).`
          : 'No devices heard. Wake the trainer by pedalling and wear the HR strap.',
        found,
      };
    },
    pair: async (trainerId, hrId) => {
      save({ ...c.profile, devices: { trainerId, hrId } });
      await hub.connect(trainerId, hrId);
      return hub.status();
    },
    updateSettings: async (patch: SettingsPatch) => {
      const s = c.profile.settings;
      const simBefore = wantSimulator(c.profile);
      const next: Profile = {
        ...c.profile,
        settings: {
          ...s,
          ...('hrCeiling' in patch ? { hrCeiling: patch.hrCeiling ?? null } : {}),
          ...('simulate' in patch ? { simulate: patch.simulate ?? null } : {}),
          overlay: {
            ...s.overlay,
            ...patch.overlay,
            opacity: Math.min(0.9, Math.max(0.4, patch.overlay?.opacity ?? s.overlay.opacity)),
          },
          hotkeys: { ...s.hotkeys, ...patch.hotkeys } as Profile['settings']['hotkeys'],
        },
      };
      save(next);
      if (patch.hotkeys) testHotkeys();
      if (wantSimulator(next) !== simBefore && !c.sessionActive) await makeHub();
      syncOverlay();
      return { profile: c.profile, hotkeyFailures };
    },
    hotkeyFailures: async () => testHotkeys(),
    setFtp: async (watts) =>
      save(setManualFtp(c.profile, Math.round(Math.min(500, Math.max(50, watts))), new Date())),
    setMaxHr: async (bpm) =>
      save({ ...c.profile, maxHrManual: bpm ? Math.round(Math.min(230, Math.max(100, bpm))) : null }),
    setAge: async (age) => save({ ...c.profile, age: Math.round(Math.min(100, Math.max(10, age))) }),
    finishFirstRun: async () => save({ ...c.profile, firstRunDone: true }),
    setManualErg: async (w) => c.setManualErg(w === null ? null : Math.round(Math.min(600, Math.max(0, w)))),
    overlayPreview: async (on) => {
      overlayPreview = on;
      if (on) overlayHidden = false;
      syncOverlay();
    },
    simControl: async (s) => {
      if (hub instanceof SimulatedHub) Object.assign(hub.switches, s);
    },
    dataDir: async () => app.getPath('userData'),
  };
  for (const name of API_METHODS) {
    const fn = handlers[name] as (...a: unknown[]) => Promise<unknown>;
    ipcMain.handle(`api:${name}`, (_e, ...args) => fn(...args));
  }
}

// ---------- App ----------

// A separate data folder (for testing) is a separate instance: it gets its own lock and never
// touches the real data or blocks the real app.
if (process.env['TURBO_DATA_DIR']) app.setPath('userData', process.env['TURBO_DATA_DIR']);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (home) {
      if (home.isMinimized()) home.restore();
      home.focus();
    }
  });

  void app.whenReady().then(async () => {
    const dir = process.env['TURBO_DATA_DIR'] || app.getPath('userData');
    controller = new Controller(new Store(dir), new SimulatedHub());
    registerIpc();
    controller.on('state', (s: AppState) => {
      for (const w of [home, overlay]) if (w && !w.isDestroyed()) w.webContents.send('state', s);
    });
    controller.on('session', () => syncOverlay());
    createHome();
    createOverlay();
    screen.on('display-removed', () => syncOverlay());
    screen.on('display-metrics-changed', () => syncOverlay());
    await makeHub();
    controller.start();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    controller?.stop();
    void hub?.close();
  });
}
