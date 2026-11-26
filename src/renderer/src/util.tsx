import { useEffect, useState } from 'react';
import type { Api } from '../../shared/api';
import type { AppState } from '../../shared/types';

declare global {
  interface Window {
    api: Api;
  }
}

export const api = window.api;

export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null);
  useEffect(() => {
    void api.getState().then(setState);
    return api.onState(setState);
  }, []);
  return state;
}

export const mmss = (s: number) => {
  const v = Math.max(0, Math.round(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};

/** Colour for a fraction of FTP. */
export function zoneColour(pct: number): string {
  if (pct < 0.56) return '#7c8794';
  if (pct < 0.76) return '#4a9eda';
  if (pct < 0.88) return '#43b581';
  if (pct < 0.95) return '#e6c229';
  if (pct < 1.06) return '#f08a24';
  return '#e5484d';
}

/** Green within 5% of target, amber within 10%, red beyond. */
export function powerColour(power: number, target: number): string {
  if (target <= 0) return '#e8eaed';
  const d = Math.abs(power - target) / target;
  if (d <= 0.05) return '#4cd08a';
  if (d <= 0.1) return '#f2b84b';
  return '#ff6369';
}

/** Green within 5 rpm of the target cadence, amber within 10, red beyond. */
export function cadenceColour(cadence: number, target: number | null | undefined): string | undefined {
  if (!target) return undefined;
  const d = Math.abs(cadence - target);
  if (d <= 5) return '#4cd08a';
  if (d <= 10) return '#f2b84b';
  return '#ff6369';
}

/** "Next: 4:00 @ 205 W · 95 rpm" */
export function nextText(next: { durationS: number; watts: number; cadence: number | null } | null): string {
  if (!next) return 'Last interval';
  return `Next: ${mmss(next.durationS)} @ ${next.watts} W${next.cadence ? ` · ${next.cadence} rpm` : ''}`;
}

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** The step outline of a workout (a and b are the start and end fractions of FTP), with an optional progress marker. */
export function ProfileBar({
  steps,
  progress,
  height = 60,
}: {
  steps: { durationS: number; a: number; b: number }[];
  progress?: number;
  height?: number;
}) {
  const total = steps.reduce((acc, s) => acc + s.durationS, 0) || 1;
  const top = Math.max(1.25, ...steps.map((s) => Math.max(s.a, s.b)));
  let x = 0;
  return (
    <svg className="profile-bar" viewBox="0 0 1000 100" preserveAspectRatio="none" style={{ height }}>
      {steps.map((s, i) => {
        const w = (s.durationS / total) * 1000;
        const x1 = x + Math.max(w - 0.6, 0.4);
        const ya = 100 - (s.a / top) * 100;
        const yb = 100 - (s.b / top) * 100;
        const el = (
          <polygon
            key={i}
            points={`${x},100 ${x},${ya} ${x1},${yb} ${x1},100`}
            fill={zoneColour((s.a + s.b) / 2)}
          />
        );
        x += w;
        return el;
      })}
      {progress !== undefined && (
        <rect x={Math.min(997, progress * 1000)} y={0} width={3} height={100} fill="#fff" />
      )}
    </svg>
  );
}
