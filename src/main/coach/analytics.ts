// Progress screen data. Pure.
import { LEVEL_TYPES, Profile, ProgressData, RideSummary } from '../../shared/types';
import { effectiveLevel } from './progression';

const DAY = 24 * 3600e3;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Monday 00:00 (local time) of the week containing d. */
function weekStart(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function ftpAt(profile: Profile, t: number): number {
  const h = [...profile.ftpHistory].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  let v = h.length ? h[0].ftp : profile.ftp;
  for (const e of h) if (Date.parse(e.date) <= t) v = e.ftp;
  return v;
}

export function verdict(profile: Profile, rides: RideSummary[], now: Date): ProgressData['verdict'] {
  const t = now.getTime();
  if (rides.length < 3)
    return {
      label: 'Not enough rides yet',
      why: 'Ride at least three times and this will start to say something.',
    };
  const ftpPct = ((profile.ftp - ftpAt(profile, t - 28 * DAY)) / ftpAt(profile, t - 28 * DAY)) * 100;
  const eff = rides
    .filter((r) => r.efficiency !== null)
    .map((r) => ({ t: Date.parse(r.startedAt), v: r.efficiency as number }));
  const recent = eff.filter((e) => t - e.t <= 14 * DAY).map((e) => e.v);
  const before = eff.filter((e) => t - e.t > 14 * DAY && t - e.t <= 42 * DAY).map((e) => e.v);
  const effPct = recent.length && before.length ? ((mean(recent) - mean(before)) / mean(before)) * 100 : 0;
  const ftpTxt = `FTP ${ftpPct >= 0 ? '+' : ''}${ftpPct.toFixed(1)}% over 4 weeks`;
  const effTxt =
    recent.length && before.length ? `, efficiency ${effPct >= 0 ? '+' : ''}${effPct.toFixed(1)}%` : '';
  if (ftpPct >= 1 || (ftpPct >= 0 && effPct >= 2)) return { label: 'Improving', why: `${ftpTxt}${effTxt}.` };
  if (ftpPct <= -1 || (ftpPct <= 0 && effPct <= -2)) return { label: 'Slipping', why: `${ftpTxt}${effTxt}.` };
  return { label: 'Holding steady', why: `${ftpTxt}${effTxt}.` };
}

export function buildProgress(profile: Profile, rides: RideSummary[], now: Date): ProgressData {
  const t = now.getTime();
  const sorted = [...rides].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));

  // FTP: one point per change, plus today.
  const ftpSeries = [...profile.ftpHistory]
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
    .map((e) => ({ date: e.date, ftp: e.ftp, manual: e.source === 'manual' }));
  ftpSeries.push({ date: now.toISOString(), ftp: profile.ftp, manual: false });

  const levels = LEVEL_TYPES.map((type) => {
    const level = effectiveLevel(profile.levels[type], profile.lastDone[type], now);
    const old = profile.levelHistory.filter((e) => e.type === type && Date.parse(e.date) >= t - 28 * DAY);
    const start = old.length ? old[0].from : level;
    return { type, level, change4w: Math.round((level - start) * 100) / 100 };
  });

  const weeks: ProgressData['weeks'] = [];
  const thisWeek = weekStart(now);
  for (let i = 11; i >= 0; i--) {
    const ws = new Date(thisWeek);
    ws.setDate(ws.getDate() - 7 * i);
    const we = new Date(ws);
    we.setDate(we.getDate() + 7);
    const inWeek = sorted.filter(
      (r) => Date.parse(r.startedAt) >= ws.getTime() && Date.parse(r.startedAt) < we.getTime(),
    );
    weeks.push({
      weekStart: ws.toISOString(),
      tss: inWeek.reduce((a, r) => a + r.tss, 0),
      rides: inWeek.length,
    });
  }

  return {
    verdict: verdict(profile, sorted, now),
    ftpSeries,
    efficiencySeries: sorted
      .filter((r) => r.efficiency !== null)
      .map((r) => ({ date: r.startedAt, value: r.efficiency as number })),
    levels,
    weeks,
    rides: sorted
      .map((r) => ({
        id: r.id,
        date: r.startedAt,
        type: r.plan.type,
        level: r.plan.riddenLevel,
        minutes: Math.round(r.durationS / 60),
        outcome: r.outcome,
        avgPower: r.avgPower,
        avgHr: r.avgHr,
      }))
      .reverse(),
  };
}
