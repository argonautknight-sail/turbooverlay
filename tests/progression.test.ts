import { describe, expect, it } from 'vitest';
import { classifyOutcome, effectiveLevel, nextLevel, rebalanceLevels } from '../src/main/coach/progression';

describe('outcome classification', () => {
  const base = { workPlannedS: 1000, workCompletedS: 1000, netIntensity: 0, rating: null };
  it('success when completed as planned', () => expect(classifyOutcome(base)).toBe('success'));
  it('success when intensity was raised', () =>
    expect(classifyOutcome({ ...base, netIntensity: 0.05 })).toBe('success'));
  it('success at exactly -3%', () =>
    expect(classifyOutcome({ ...base, netIntensity: -0.03 })).toBe('success'));
  it('stretch when cut by 5%', () =>
    expect(classifyOutcome({ ...base, netIntensity: -0.05 })).toBe('stretch'));
  it('stretch when rated hard', () => expect(classifyOutcome({ ...base, rating: 'hard' })).toBe('stretch'));
  it('fail when cut by 10%', () => expect(classifyOutcome({ ...base, netIntensity: -0.1 })).toBe('fail'));
  it('fail when stopped early', () => expect(classifyOutcome({ ...base, workCompletedS: 900 })).toBe('fail'));
  it('fail when rated could not finish', () =>
    expect(classifyOutcome({ ...base, rating: 'dnf' })).toBe('fail'));
  it('95% of work time is enough', () =>
    expect(classifyOutcome({ ...base, workCompletedS: 950 })).toBe('success'));
});

describe('level changes', () => {
  it('success at the stored level adds 0.5', () => expect(nextLevel(4, 4, 'success', null, 60)).toBe(4.5));
  it('success rated easy adds 1.0', () => expect(nextLevel(4, 4, 'success', 'easy', 60)).toBe(5));
  it('success one level up keeps the level ridden', () =>
    expect(nextLevel(4, 5, 'success', null, 60)).toBe(5));
  it('success below the stored level changes nothing', () =>
    expect(nextLevel(4, 3, 'success', 'easy', 60)).toBe(4));
  it('30 minute slot earns half credit', () => {
    expect(nextLevel(4, 4, 'success', null, 30)).toBe(4.25);
    expect(nextLevel(4, 4, 'success', 'easy', 30)).toBe(4.5);
  });
  it('stretch holds the level', () => expect(nextLevel(4, 4.5, 'stretch', 'hard', 60)).toBe(4));
  it('stretch at an easier level lowers to it', () => expect(nextLevel(4, 3, 'stretch', null, 60)).toBe(3));
  it('fail drops a level', () => expect(nextLevel(4, 4.5, 'fail', null, 60)).toBe(3));
  it('stays within 1..10', () => {
    expect(nextLevel(1, 1, 'fail', null, 60)).toBe(1);
    expect(nextLevel(10, 10, 'success', 'easy', 60)).toBe(10);
  });
});

describe('rebalance and decay', () => {
  it('+3% FTP lowers threshold by about one level', () => {
    const l = rebalanceLevels({ Endurance: 5, Tempo: 5, SweetSpot: 5, Threshold: 5, VO2max: 5 }, 3);
    expect(l).toEqual({ Endurance: 4.55, Tempo: 4.55, SweetSpot: 4.25, Threshold: 3.95, VO2max: 3.95 });
  });
  it('an FTP drop raises levels', () => {
    expect(
      rebalanceLevels({ Endurance: 5, Tempo: 5, SweetSpot: 5, Threshold: 5, VO2max: 5 }, -2).Threshold,
    ).toBe(5.7);
  });
  it('decays 0.1 per full week, at most 2.0, floor 1.0', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const weeksAgo = (w: number) => new Date(now.getTime() - w * 7 * 24 * 3600e3 - 1000).toISOString();
    expect(effectiveLevel(6, undefined, now)).toBe(6);
    expect(effectiveLevel(6, weeksAgo(0), now)).toBe(6);
    expect(effectiveLevel(6, weeksAgo(3), now)).toBe(5.7);
    expect(effectiveLevel(6, weeksAgo(40), now)).toBe(4);
    expect(effectiveLevel(1.5, weeksAgo(40), now)).toBe(1);
  });
});
