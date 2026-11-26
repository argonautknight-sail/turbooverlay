import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Profile } from '../../shared/types';
import { Progress } from './Progress';
import { Ride } from './Ride';
import { Settings, Wizard } from './Settings';
import './styles.css';
import { api, useAppState } from './util';

type Tab = 'ride' | 'progress' | 'settings';

function Home() {
  const state = useAppState();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [tab, setTab] = useState<Tab>('ride');
  const reload = () => api.getProfile().then(setProfile);
  useEffect(() => void reload(), []);
  if (!state || !profile) return <div className="loading">Loading…</div>;

  if (!profile.firstRunDone) return <Wizard profile={profile} state={state} onProfile={setProfile} />;

  const { live } = state;
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">TurboOverlay</div>
        <nav>
          {(['ride', 'progress', 'settings'] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
              {t === 'ride' ? 'Ride' : t === 'progress' ? 'Progress' : 'Settings'}
            </button>
          ))}
        </nav>
        <div className="live">
          {live.simulated && <span className="badge">Simulator</span>}
          <span className={live.trainerOk ? 'dot ok' : 'dot bad'} title={live.deviceStatus} />
          <span>
            <b>{live.power}</b> W
          </span>
          <span>
            <b>{live.cadence}</b> rpm
          </span>
          <span className={live.hrOk ? '' : 'muted'}>
            <b>{live.hr ?? '—'}</b> bpm
          </span>
          <span className="muted">FTP {profile.ftp} W</span>
        </div>
      </header>
      <main>
        {tab === 'ride' && <Ride state={state} profile={profile} onProfileChanged={reload} />}
        {tab === 'progress' && <Progress />}
        {tab === 'settings' && <Settings profile={profile} state={state} onProfile={setProfile} />}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Home />);
