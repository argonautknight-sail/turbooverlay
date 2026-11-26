import { useEffect, useState } from 'react';
import type { AppState, DisplayInfo, FoundDevice, HotkeyAction, Profile } from '../../shared/types';
import { effectiveMaxHr, HOTKEY_LABEL } from '../../shared/types';
import type { SettingsPatch } from '../../shared/api';
import { api } from './util';

type SetProfile = (p: Profile) => void;

/** Scan for ANT+ devices and choose a trainer and a heart-rate strap. */
function Pairing({
  profile,
  state,
  onProfile,
}: {
  profile: Profile;
  state: AppState;
  onProfile: SetProfile;
}) {
  const [found, setFound] = useState<FoundDevice[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [trainerId, setTrainerId] = useState<number | null>(profile.devices.trainerId);
  const [hrId, setHrId] = useState<number | null>(profile.devices.hrId);

  const scan = async () => {
    setBusy(true);
    setMsg('Listening for 8 seconds… pedal the trainer and wear the strap.');
    const r = await api.scan();
    setFound(r.found);
    setMsg(r.message);
    const fe = r.found.find((d) => d.profile === 'FE');
    const hr = r.found.find((d) => d.profile === 'HR');
    if (fe && trainerId === null) setTrainerId(fe.id);
    if (hr && hrId === null) setHrId(hr.id);
    setBusy(false);
  };
  const save = async () => {
    setBusy(true);
    setMsg(await api.pair(trainerId, hrId));
    onProfile(await api.getProfile());
    setBusy(false);
  };
  const options = (kind: 'FE' | 'HR', saved: number | null) => {
    const ids = new Set(found.filter((d) => d.profile === kind).map((d) => d.id));
    if (saved !== null) ids.add(saved);
    return [...ids];
  };

  return (
    <div>
      <div className="muted">{state.live.deviceStatus}</div>
      <div className="form-row">
        <label>Trainer</label>
        <select
          value={trainerId ?? ''}
          onChange={(e) => setTrainerId(e.target.value ? Number(e.target.value) : null)}
        >
          <option value="">None</option>
          {options('FE', profile.devices.trainerId).map((id) => (
            <option key={id} value={id}>
              Trainer {id}
            </option>
          ))}
        </select>
        <span className={state.live.trainerOk ? 'dot ok' : 'dot bad'} />{' '}
        {state.live.trainerOk ? `${state.live.power} W, ${state.live.cadence} rpm` : 'not heard'}
      </div>
      <div className="form-row">
        <label>Heart rate</label>
        <select value={hrId ?? ''} onChange={(e) => setHrId(e.target.value ? Number(e.target.value) : null)}>
          <option value="">None</option>
          {options('HR', profile.devices.hrId).map((id) => (
            <option key={id} value={id}>
              HR strap {id}
            </option>
          ))}
        </select>
        <span className={state.live.hrOk ? 'dot ok' : 'dot bad'} />{' '}
        {state.live.hrOk ? `${state.live.hr} bpm` : 'not heard'}
      </div>
      <div className="actions left">
        <button className="secondary" disabled={busy || state.session !== null} onClick={() => void scan()}>
          Scan for devices
        </button>
        <button className="primary" disabled={busy} onClick={() => void save()}>
          Save and connect
        </button>
      </div>
      {msg && <div className="muted">{msg}</div>}
    </div>
  );
}

function NumberField({
  value,
  onSave,
  min,
  max,
  placeholder,
}: {
  value: number | null;
  onSave: (v: number | null) => void;
  min: number;
  max: number;
  placeholder?: string;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => setText(value === null ? '' : String(value)), [value]);
  const commit = () => {
    if (text.trim() === '') return onSave(null);
    const n = Number(text);
    if (Number.isFinite(n)) onSave(Math.min(max, Math.max(min, Math.round(n))));
  };
  return (
    <input
      type="number"
      value={text}
      min={min}
      max={max}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  );
}

/** Click, then press the key combination. */
function HotkeyField({ value, onChange }: { value: string; onChange: (accel: string) => void }) {
  const [listening, setListening] = useState(false);
  return (
    <input
      className={listening ? 'hotkey listening' : 'hotkey'}
      readOnly
      value={listening ? 'Press keys…' : value}
      onFocus={() => setListening(true)}
      onBlur={() => setListening(false)}
      onKeyDown={(e) => {
        e.preventDefault();
        if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
        const parts: string[] = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        if (e.metaKey) parts.push('Super');
        if (!parts.length) return; // a global hotkey needs a modifier
        const named: Record<string, string> = {
          ArrowUp: 'Up',
          ArrowDown: 'Down',
          ArrowLeft: 'Left',
          ArrowRight: 'Right',
          ' ': 'Space',
          '+': 'Plus',
        };
        const key = named[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
        onChange([...parts, key].join('+'));
        e.currentTarget.blur();
      }}
    />
  );
}

export function Settings({
  profile,
  state,
  onProfile,
}: {
  profile: Profile;
  state: AppState;
  onProfile: SetProfile;
}) {
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  const [failures, setFailures] = useState<HotkeyAction[]>([]);
  const [previewOn, setPreviewOn] = useState(false);
  const [erg, setErg] = useState(120);
  const [sim, setSim] = useState({ pedalling: true, trainerOn: true, hrOn: true });
  const [dataDir, setDataDir] = useState('');
  const s = profile.settings;
  const riding = state.session !== null;

  useEffect(() => {
    void api.getDisplays().then(setDisplays);
    void api.hotkeyFailures().then(setFailures);
    void api.dataDir().then(setDataDir);
    return () => void api.overlayPreview(false);
  }, []);

  const update = async (patch: SettingsPatch) => {
    const r = await api.updateSettings(patch);
    onProfile(r.profile);
    setFailures(r.hotkeyFailures);
  };
  const simSet = (patch: Partial<typeof sim>) => {
    const next = { ...sim, ...patch };
    setSim(next);
    void api.simControl(next);
  };
  const lastEstimate = profile.ftpEstimates[profile.ftpEstimates.length - 1];

  return (
    <div className="settings">
      <div className="card">
        <h3>Devices</h3>
        <div className="form-row">
          <label>Source</label>
          <select
            disabled={riding}
            value={s.simulate === null ? 'auto' : s.simulate ? 'sim' : 'real'}
            onChange={(e) =>
              void update({ simulate: e.target.value === 'auto' ? null : e.target.value === 'sim' })
            }
          >
            <option value="auto">Automatic (real devices in the installed app)</option>
            <option value="real">Real ANT+ devices</option>
            <option value="sim">Simulator</option>
          </select>
        </div>
        {state.live.simulated ? (
          <div>
            <div className="muted">
              The simulator is a pretend rider. Use these to test auto-pause and dropouts.
            </div>
            <div className="form-row">
              <label>
                <input
                  type="checkbox"
                  checked={sim.pedalling}
                  onChange={(e) => simSet({ pedalling: e.target.checked })}
                />{' '}
                Pedalling
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={sim.trainerOn}
                  onChange={(e) => simSet({ trainerOn: e.target.checked })}
                />{' '}
                Trainer signal
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={sim.hrOn}
                  onChange={(e) => simSet({ hrOn: e.target.checked })}
                />{' '}
                HR signal
              </label>
            </div>
          </div>
        ) : (
          <Pairing profile={profile} state={state} onProfile={onProfile} />
        )}
      </div>

      <div className="card">
        <h3>Rider</h3>
        <div className="form-row">
          <label>FTP (W)</label>
          <NumberField
            value={profile.ftp}
            min={50}
            max={500}
            onSave={(v) => v !== null && v !== profile.ftp && void api.setFtp(v).then(onProfile)}
          />
          <span className="muted">Setting this by hand rebalances your levels.</span>
        </div>
        <div className="form-row">
          <label>Age</label>
          <NumberField
            value={profile.age}
            min={10}
            max={100}
            onSave={(v) => v !== null && void api.setAge(v).then(onProfile)}
          />
        </div>
        <div className="form-row">
          <label>Max HR override</label>
          <NumberField
            value={profile.maxHrManual}
            min={100}
            max={230}
            placeholder="auto"
            onSave={(v) => void api.setMaxHr(v).then(onProfile)}
          />
          <span className="muted">
            In use: {effectiveMaxHr(profile)} bpm (age estimate {220 - profile.age}, highest recorded{' '}
            {profile.maxHrObserved ?? '—'})
          </span>
        </div>
        <div className="form-row">
          <label>HR safety ceiling</label>
          <NumberField
            value={s.hrCeiling}
            min={100}
            max={230}
            placeholder="auto"
            onSave={(v) => void update({ hrCeiling: v })}
          />
          <span className="muted">
            Above this for 20 s, the target eases by 5%. Auto = max HR + 3 ({effectiveMaxHr(profile) + 3}).
          </span>
        </div>
        {lastEstimate && (
          <div className="muted small">
            Last FTP check ({new Date(lastEstimate.date).toLocaleDateString()}): {lastEstimate.decidedBy}.
            Heart-rate estimate {lastEstimate.b.ftpB ?? '—'} W from {lastEstimate.b.n} segments; floor{' '}
            {lastEstimate.lower?.value ?? '—'} W; cap {lastEstimate.upper?.value ?? '—'} W.
          </div>
        )}
      </div>

      <div className="card">
        <h3>Overlay</h3>
        <div className="form-row">
          <label>Position</label>
          <select
            value={s.overlay.position}
            onChange={(e) => void update({ overlay: { position: e.target.value as 'top' | 'bottom' } })}
          >
            <option value="bottom">Bottom</option>
            <option value="top">Top</option>
          </select>
          <label>
            <input
              type="checkbox"
              checked={s.overlay.compact}
              onChange={(e) => void update({ overlay: { compact: e.target.checked } })}
            />{' '}
            Compact
          </label>
        </div>
        <div className="form-row">
          <label>Monitor</label>
          <select
            value={s.overlay.displayId ?? ''}
            onChange={(e) =>
              void update({ overlay: { displayId: e.target.value ? Number(e.target.value) : null } })
            }
          >
            <option value="">Primary display</option>
            {displays.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label>Opacity {Math.round(s.overlay.opacity * 100)}%</label>
          <input
            type="range"
            min={40}
            max={90}
            value={Math.round(s.overlay.opacity * 100)}
            onChange={(e) => void update({ overlay: { opacity: Number(e.target.value) / 100 } })}
          />
        </div>
        <div className="actions left">
          <button
            className="secondary"
            disabled={riding}
            onClick={() => {
              setPreviewOn(!previewOn);
              void api.overlayPreview(!previewOn);
            }}
          >
            {previewOn ? 'Hide overlay preview' : 'Show overlay now'}
          </button>
          <span className="muted">
            Use this to check it sits on top of your video. Hotkeys are live while it is shown.
          </span>
        </div>
      </div>

      <div className="card">
        <h3>Hotkeys</h3>
        <div className="muted">
          Click a box, then press the keys. They work while a ride is running or the overlay preview is on.
        </div>
        {(Object.keys(HOTKEY_LABEL) as HotkeyAction[]).map((a) => (
          <div className="form-row" key={a}>
            <label>{HOTKEY_LABEL[a]}</label>
            <HotkeyField
              value={s.hotkeys[a]}
              onChange={(accel) => void update({ hotkeys: { [a]: accel } })}
            />
            {failures.includes(a) && (
              <span className="warn-text">Could not register — another program may be using it.</span>
            )}
          </div>
        ))}
      </div>

      <div className="card">
        <h3>Hardware test</h3>
        <div className="form-row">
          <label>Manual ERG {erg} W</label>
          <input
            type="range"
            min={50}
            max={350}
            step={5}
            value={erg}
            disabled={riding}
            onChange={(e) => {
              setErg(Number(e.target.value));
              if (state.manualErg !== null) void api.setManualErg(Number(e.target.value));
            }}
          />
          <button
            className="secondary"
            disabled={riding}
            onClick={() => void api.setManualErg(state.manualErg === null ? erg : null)}
          >
            {state.manualErg === null ? 'Hold this power' : 'Release'}
          </button>
        </div>
        <div className="actions left">
          <button className="secondary" disabled={riding} onClick={() => void api.startTest()}>
            Run 10-minute test workout
          </button>
          <span className="muted">
            2-minute steps at 100 / 150 / 120 W. Not recorded. Watch it on the Ride tab.
          </span>
        </div>
      </div>

      <div className="muted small">Your data is stored in {dataDir}</div>
    </div>
  );
}

export function Wizard({
  profile,
  state,
  onProfile,
}: {
  profile: Profile;
  state: AppState;
  onProfile: SetProfile;
}) {
  const [step, setStep] = useState(0);
  return (
    <div className="wizard">
      <div className="card">
        <h2>Welcome to TurboOverlay</h2>
        {step === 0 && (
          <>
            <h3>1. Pair your devices</h3>
            {state.live.simulated ? (
              <p className="explain">
                The simulator is running, so there is nothing to pair. To use your real trainer, choose "Real
                ANT+ devices" in Settings afterwards.
              </p>
            ) : (
              <>
                <Pairing profile={profile} state={state} onProfile={onProfile} />
                <p className="muted">
                  No trainer to hand?{' '}
                  <button
                    className="secondary"
                    onClick={() =>
                      void api.updateSettings({ simulate: true }).then((r) => onProfile(r.profile))
                    }
                  >
                    Try the simulator
                  </button>
                </p>
              </>
            )}
            <div className="actions">
              <button className="primary" onClick={() => setStep(1)}>
                Next
              </button>
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <h3>2. Confirm your starting FTP</h3>
            <p className="explain">
              This is only a starting point. The app adjusts it from your normal rides — there are no FTP
              tests.
            </p>
            <div className="form-row">
              <label>FTP (W)</label>
              <NumberField
                value={profile.ftp}
                min={50}
                max={500}
                onSave={(v) => v !== null && v !== profile.ftp && void api.setFtp(v).then(onProfile)}
              />
            </div>
            <div className="form-row">
              <label>Age</label>
              <NumberField
                value={profile.age}
                min={10}
                max={100}
                onSave={(v) => v !== null && void api.setAge(v).then(onProfile)}
              />
            </div>
            <div className="actions">
              <button className="secondary" onClick={() => setStep(0)}>
                Back
              </button>
              <button className="primary" onClick={() => void api.finishFirstRun().then(onProfile)}>
                Done
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
