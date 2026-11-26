// What happens to the profile after a ride. Pure: returns new objects.
import { effectiveMaxHr, LevelType, Profile, Rating, RideSummary } from '../../shared/types';
import { estimateFtp } from './ftp';
import { classifyOutcome, nextLevel, rebalanceLevels } from './progression';

const MAX_ESTIMATES = 300;

/** Undo a ride's level change (used when a rating arrives after the first classification). */
function revertLevel(profile: Profile, ride: RideSummary): Profile {
  if (!ride.levelChange) return profile;
  const { type, from, to } = ride.levelChange;
  // Only safe to revert if nothing else has moved the level since.
  if (Math.abs(profile.levels[type] - to) > 0.001) return profile;
  return {
    ...profile,
    levels: { ...profile.levels, [type]: from },
    levelHistory: profile.levelHistory.filter((e) => !(e.date === ride.endedAt && e.type === type)),
  };
}

function applyLevel(profile: Profile, ride: RideSummary): { profile: Profile; ride: RideSummary } {
  const { plan } = ride;
  if (plan.type === 'Recovery' || plan.isTest || plan.storedLevel === null || plan.riddenLevel === null) {
    return { profile, ride: { ...ride, levelChange: null } };
  }
  // A ride abandoned before the main set began says nothing about the level.
  if (ride.workCompletedS === 0) return { profile, ride: { ...ride, levelChange: null } };
  const type = plan.type as LevelType;
  const to = nextLevel(plan.storedLevel, plan.riddenLevel, ride.outcome, ride.rating, plan.minutes);
  const from = profile.levels[type];
  const next: Profile = {
    ...profile,
    levels: { ...profile.levels, [type]: to },
    lastDone: { ...profile.lastDone, [type]: ride.startedAt },
    levelHistory: [
      ...profile.levelHistory,
      {
        date: ride.endedAt,
        type,
        from,
        to,
        reason: `${ride.outcome}${ride.rating ? `, rated ${ride.rating}` : ''}`,
      },
    ],
  };
  return { profile: next, ride: { ...ride, levelChange: { type, from, to } } };
}

/**
 * Apply a finished ride: level change, max HR ratchet, FTP estimate and rebalance.
 * @param earlier all rides before this one
 */
export function applyRide(
  profile: Profile,
  ride: RideSummary,
  earlier: RideSummary[],
  now: Date,
): { profile: Profile; ride: RideSummary; notice: string | null } {
  let { profile: p, ride: r } = applyLevel(profile, ride);
  let notice: string | null = null;

  if (r.peakHr5s !== null && r.peakHr5s > (p.maxHrObserved ?? 0)) p = { ...p, maxHrObserved: r.peakHr5s };

  const est = estimateFtp({
    ftp: p.ftp,
    ftpHistory: p.ftpHistory,
    maxHr: effectiveMaxHr(p),
    rides: [...earlier, r],
    now,
  });
  p = { ...p, ftpEstimates: [...p.ftpEstimates, est].slice(-MAX_ESTIMATES) };
  if (est.applied) {
    const pct = ((est.ftpAfter - est.ftpBefore) / est.ftpBefore) * 100;
    const levels = rebalanceLevels(p.levels, pct);
    const history = [...p.levelHistory];
    for (const t of Object.keys(levels) as LevelType[]) {
      if (levels[t] !== p.levels[t]) {
        history.push({
          date: est.date,
          type: t,
          from: p.levels[t],
          to: levels[t],
          reason: `FTP ${est.ftpBefore} → ${est.ftpAfter} W`,
        });
      }
    }
    p = {
      ...p,
      ftp: est.ftpAfter,
      ftpHistory: [...p.ftpHistory, { date: est.date, ftp: est.ftpAfter, source: 'auto' }],
      levels,
      levelHistory: history,
    };
    notice = `FTP updated ${est.ftpBefore} → ${est.ftpAfter} W`;
  }
  return { profile: p, ride: r, notice };
}

/** A rating given after the ride can change the outcome and so the level. FTP is left alone. */
export function applyRating(
  profile: Profile,
  ride: RideSummary,
  rating: Rating,
): { profile: Profile; ride: RideSummary } {
  const outcome = classifyOutcome({
    workPlannedS: ride.workPlannedS,
    workCompletedS: ride.workCompletedS,
    netIntensity: ride.netIntensity,
    rating,
  });
  const reverted = revertLevel(profile, ride);
  if (reverted === profile && ride.levelChange) {
    // The level has moved since (e.g. an FTP rebalance); record the rating without recomputing.
    return { profile, ride: { ...ride, rating, outcome } };
  }
  return applyLevel(reverted, { ...ride, rating, outcome, levelChange: null });
}

/** Manual FTP from Settings. Levels are rebalanced the same way as for an automatic change. */
export function setManualFtp(profile: Profile, ftp: number, now: Date): Profile {
  if (ftp === profile.ftp) return profile;
  const pct = ((ftp - profile.ftp) / profile.ftp) * 100;
  const levels = rebalanceLevels(profile.levels, pct);
  const date = now.toISOString();
  const history = [...profile.levelHistory];
  for (const t of Object.keys(levels) as LevelType[]) {
    if (levels[t] !== profile.levels[t])
      history.push({
        date,
        type: t,
        from: profile.levels[t],
        to: levels[t],
        reason: `FTP set manually ${profile.ftp} → ${ftp} W`,
      });
  }
  return {
    ...profile,
    ftp,
    ftpHistory: [...profile.ftpHistory, { date, ftp, source: 'manual' }],
    levels,
    levelHistory: history,
  };
}
