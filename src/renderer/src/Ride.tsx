import { useEffect, useState } from 'react';
import type {
  Answers,
  AppState,
  Feel,
  Legs,
  Profile,
  Rating,
  RideSummary,
  SessionPlan,
  Slot,
} from '../../shared/types';
import { TYPE_LABEL } from '../../shared/types';
import { api, cadenceColour, mmss, nextText, powerColour, ProfileBar } from './util';

export function Ride({
  state,
  profile,
  onProfileChanged,
}: {
  state: AppState;
  profile: Profile;
  onProfileChanged: () => void;
}) {
  const [last, setLast] = useState<{ ride: RideSummary; notice: string | null } | null>(null);
  const active = state.session !== null;

  // When a session ends, fetch the summary (and the profile, which the ride has changed).
  useEffect(() => {
    if (!active) {
      void api.lastRide().then(setLast);
      onProfileChanged();
    }
  }, [active]);

  if (active) return <LiveSession state={state} />;
  if (last)
    return (
      <Summary
        ride={last.ride}
        notice={last.notice}
        onRated={(ride) => {
          setLast({ ...last, ride });
          onProfileChanged();
        }}
        onDone={() => {
          void api.clearLastRide();
          setLast(null);
        }}
      />
    );
  return <PreRide profile={profile} />;
}

function Choice<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: [T, string][];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="choice">
      <div className="choice-label">{label}</div>
      <div className="choice-row">
        {options.map(([v, text]) => (
          <button
            key={String(v)}
            className={v === value ? 'pick active' : 'pick'}
            onClick={() => onChange(v)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function PreRide({ profile }: { profile: Profile }) {
  const [minutes, setMinutes] = useState<Slot>(60);
  const [legs, setLegs] = useState<Legs>('normal');
  const [feel, setFeel] = useState<Feel>('steady');
  const [taps, setTaps] = useState(0);
  const [swap, setSwap] = useState(0);
  const [plan, setPlan] = useState<SessionPlan | null>(null);
  const answers: Answers = { minutes, legs, feel };

  useEffect(() => {
    setTaps(0);
    setSwap(0);
  }, [minutes, legs, feel]);
  useEffect(() => {
    void api.preview(answers, taps, swap).then(setPlan);
  }, [minutes, legs, feel, taps, swap, profile.ftp]);

  const work = plan?.steps.filter((s) => s.isWork).reduce((a, s) => a + s.durationS, 0) ?? 0;
  return (
    <div className="card">
      <h2>Today's ride</h2>
      <Choice
        label="Time today"
        value={minutes}
        onChange={setMinutes}
        options={[
          [30, '30 min'],
          [45, '45 min'],
          [60, '60 min'],
        ]}
      />
      <Choice
        label="Legs"
        value={legs}
        onChange={setLegs}
        options={[
          ['fresh', 'Fresh'],
          ['normal', 'Normal'],
          ['tired', 'Tired'],
        ]}
      />
      <Choice
        label="Feel like"
        value={feel}
        onChange={setFeel}
        options={[
          ['steady', 'Steady'],
          ['push', 'Push me'],
        ]}
      />
      {plan && (
        <div className="preview">
          <div className="preview-head">
            <div>
              <div className="preview-name">{plan.name}</div>
              <div className="muted">
                {plan.minutes} min · {mmss(work)} of work · FTP {plan.ftp} W
              </div>
            </div>
            {plan.riddenLevel !== null && (
              <div className="level-pill">Level {plan.riddenLevel.toFixed(1)}</div>
            )}
          </div>
          <ProfileBar
            steps={plan.steps.map((s) => ({ durationS: s.durationS, a: s.pctStart, b: s.pctEnd }))}
            height={110}
          />
          <p className="explain">{plan.explanation}</p>
          <div className="actions">
            <button className="secondary" disabled={!plan.canEasier} onClick={() => setTaps(taps - 1)}>
              Easier
            </button>
            <button className="primary big" onClick={() => void api.start(answers, taps, swap)}>
              Start
            </button>
            <button className="secondary" disabled={!plan.canHarder} onClick={() => setTaps(taps + 1)}>
              Harder
            </button>
            {(plan.variantCount ?? 1) > 1 && (
              <button className="secondary" onClick={() => setSwap(swap + 1)}>
                Swap session
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function LiveSession({ state }: { state: AppState }) {
  const s = state.session!;
  const { live } = state;
  const paused = s.state === 'paused';
  const status = !live.trainerOk
    ? 'Trainer not heard — reconnecting…'
    : paused
      ? s.pauseReason === 'manual'
        ? 'Paused'
        : 'Waiting for you to pedal'
      : null;
  return (
    <div className="card">
      <div className="preview-head">
        <h2>{state.planName}</h2>
        <div className="muted">
          {mmss(s.elapsedS)} / {mmss(s.totalS)}
        </div>
      </div>
      {status && <div className="status-banner">{status}</div>}
      <div className="live-grid">
        <Stat label="Target" value={`${s.targetW}`} unit="W" />
        <Stat
          label="Power"
          value={`${live.power}`}
          unit="W"
          colour={paused ? undefined : powerColour(live.power, s.targetW)}
        />
        <Stat
          label="Heart rate"
          value={live.hr === null ? '—' : `${live.hr}`}
          unit="bpm"
          className={state.hrAlert ? 'flash' : ''}
        />
        <Stat
          label={s.targetCadence ? `Cadence → ${s.targetCadence}` : 'Cadence'}
          value={`${live.cadence}`}
          unit="rpm"
          colour={paused ? undefined : cadenceColour(live.cadence, s.targetCadence)}
        />
        <Stat label="Interval left" value={mmss(s.stepRemainingS)} />
        <Stat label="Intensity" value={`${Math.round(s.intensity * 100)}`} unit="%" />
      </div>
      <div className="muted next-line">{nextText(s.next)}</div>
      {state.profile && <ProfileBar steps={state.profile} progress={s.elapsedS / s.totalS} height={90} />}
      {state.hrAlert && (
        <div className="status-banner warn">Heart rate above your ceiling — target eased by 5%.</div>
      )}
      <div className="actions">
        <button className="secondary" onClick={() => void api.control('down')}>
          −5%
        </button>
        <button className="secondary" onClick={() => void api.control('pause')}>
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button className="secondary" onClick={() => void api.control('skip')}>
          Skip interval
        </button>
        <button className="secondary" onClick={() => void api.control('up')}>
          +5%
        </button>
        <button className="danger" onClick={() => void api.control('end')}>
          End ride
        </button>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  unit,
  colour,
  className,
}: {
  label: string;
  value: string;
  unit?: string;
  colour?: string;
  className?: string;
}) {
  return (
    <div className={`stat ${className ?? ''}`}>
      <div className="stat-value" style={colour ? { color: colour } : undefined}>
        {value}
        {unit && <span className="unit"> {unit}</span>}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

const RATINGS: [Rating, string][] = [
  ['easy', 'Easy'],
  ['right', 'About right'],
  ['hard', 'Hard'],
  ['dnf', "Couldn't finish"],
];
const OUTCOME_TEXT = { success: 'Success', stretch: 'Stretch', fail: 'Not completed' };

export function Summary({
  ride,
  notice,
  onRated,
  onDone,
}: {
  ride: RideSummary;
  notice: string | null;
  onRated: (r: RideSummary) => void;
  onDone: () => void;
}) {
  const lc = ride.levelChange;
  return (
    <div className="card">
      <div className="preview-head">
        <h2>Ride complete</h2>
        <div className={`outcome ${ride.outcome}`}>{OUTCOME_TEXT[ride.outcome]}</div>
      </div>
      <div className="muted">{ride.plan.name}</div>
      {notice && <div className="status-banner good">{notice}</div>}
      <div className="live-grid">
        <Stat label="Time" value={mmss(ride.durationS)} />
        <Stat label="Avg power" value={`${ride.avgPower}`} unit="W" />
        <Stat label="Normalised" value={`${ride.np}`} unit="W" />
        <Stat label="Avg HR" value={ride.avgHr === null ? '—' : `${ride.avgHr}`} unit="bpm" />
        <Stat label="TSS" value={`${ride.tss}`} />
        <Stat
          label="Work done"
          value={`${ride.workPlannedS ? Math.round((ride.workCompletedS / ride.workPlannedS) * 100) : 100}`}
          unit="%"
        />
      </div>
      {lc && (
        <p className="explain">
          {TYPE_LABEL[lc.type]} level {lc.from.toFixed(2)} → {lc.to.toFixed(2)}
        </p>
      )}
      <div className="choice">
        <div className="choice-label">How was that? (optional)</div>
        <div className="choice-row">
          {RATINGS.map(([r, text]) => (
            <button
              key={r}
              className={ride.rating === r ? 'pick active' : 'pick'}
              onClick={() => void api.rate(ride.id, r).then((x) => x && onRated(x))}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
      <div className="actions">
        <button className="primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
