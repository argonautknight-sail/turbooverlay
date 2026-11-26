import { createRoot } from 'react-dom/client';
import './styles.css';
import { cadenceColour, mmss, nextText, powerColour, ProfileBar, useAppState } from './util';

function Overlay() {
  const s = useAppState();
  if (!s) return null;
  const { live, session, overlay } = s;
  const target = session?.targetW ?? s.manualErg ?? 0;
  const paused = session?.state === 'paused';
  const banner = !live.trainerOk
    ? 'Reconnecting…'
    : paused
      ? session?.pauseReason === 'manual'
        ? 'Paused'
        : 'Pedal to start'
      : null;
  const cadTarget = session?.targetCadence ?? null;
  const cadColour = session && !paused ? cadenceColour(live.cadence, cadTarget) : undefined;
  const sprint = session?.stepKind === 'sprint' && !paused;
  const style = { background: `rgba(12, 14, 18, ${overlay.opacity})` };

  const powerCell = (
    <Big
      label="Power"
      value={String(live.power)}
      colour={session && !paused ? powerColour(live.power, target) : undefined}
      target={target || null}
    />
  );
  const cadenceCell = (
    <Big label="Cadence" value={String(live.cadence)} colour={cadColour} target={cadTarget} />
  );

  if (overlay.compact) {
    return (
      <div className="hud compact" style={style}>
        {powerCell}
        {cadenceCell}
        <Big
          label={banner ?? (sprint ? 'Sprint!' : 'Interval')}
          value={session ? mmss(session.stepRemainingS) : '—'}
          className={sprint ? 'sprint' : ''}
        />
      </div>
    );
  }

  return (
    <div className="hud" style={style}>
      <div className="hud-row">
        {powerCell}
        {cadenceCell}
        <Big
          label="HR"
          value={live.hr === null ? '—' : String(live.hr)}
          small
          className={s.hrAlert ? 'flash' : ''}
        />
        <div className="hud-interval">
          {banner ? (
            <div className="hud-banner">{banner}</div>
          ) : (
            <div className={sprint ? 'hud-time sprint' : 'hud-time'}>
              {session ? mmss(session.stepRemainingS) : '—'}
            </div>
          )}
          <div className={sprint ? 'hud-next sprint-word' : 'hud-next'}>
            {sprint ? 'SPRINT' : session ? nextText(session.next) : 'No session'}
            {session && session.intensity !== 1 ? `  ·  ${Math.round(session.intensity * 100)}%` : ''}
          </div>
        </div>
        <Big label="Remaining" value={session ? mmss(session.totalS - session.elapsedS) : '—'} small />
      </div>
      {s.profile && session && (
        <ProfileBar steps={s.profile} progress={session.elapsedS / session.totalS} height={14} />
      )}
    </div>
  );
}

function Big({
  label,
  value,
  colour,
  small,
  className,
  target,
}: {
  label: string;
  value: string;
  colour?: string;
  small?: boolean;
  className?: string;
  /** Shown beside the value at the same size, so it can be read from the bike. */
  target?: number | null;
}) {
  return (
    <div className={`hud-cell ${small ? 'small' : ''} ${className ?? ''}`}>
      <div className="hud-value">
        <span style={colour ? { color: colour } : undefined}>{value}</span>
        {target ? (
          <>
            <span className="hud-arrow">→</span>
            {target}
          </>
        ) : null}
      </div>
      <div className="hud-label">{label}</div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Overlay />);
