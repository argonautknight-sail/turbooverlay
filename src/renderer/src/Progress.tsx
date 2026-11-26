import { useEffect, useState } from 'react';
import type { ProgressData, RideSummary, Sample } from '../../shared/types';
import { TYPE_LABEL } from '../../shared/types';
import { api, mmss, shortDate } from './util';

const W = 520;
const H = 170;
const PAD = { l: 38, r: 10, t: 10, b: 22 };

function scale(values: number[], padFrac = 0.1): [number, number] {
  if (!values.length) return [0, 1];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const pad = (hi - lo) * padFrac;
  return [lo - pad, hi + pad];
}

/** A small time-series line chart. */
function LineChart({
  points,
  colour,
  marks,
  step,
  digits = 0,
}: {
  points: { t: number; v: number }[];
  colour: string;
  marks?: boolean[];
  step?: boolean;
  digits?: number;
}) {
  if (points.length < 2) return <div className="empty">Not enough data yet.</div>;
  const [lo, hi] = scale(points.map((p) => p.v));
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t || t0 + 1;
  const x = (t: number) => PAD.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
  let d = '';
  points.forEach((p, i) => {
    if (i === 0) d += `M${x(p.t)},${y(p.v)}`;
    else if (step) d += `H${x(p.t)}V${y(p.v)}`;
    else d += `L${x(p.t)},${y(p.v)}`;
  });
  const ticks = [lo + (hi - lo) * 0.1, (lo + hi) / 2, hi - (hi - lo) * 0.1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart">
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className="grid" />
          <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" className="axis">
            {v.toFixed(digits)}
          </text>
        </g>
      ))}
      <path d={d} fill="none" stroke={colour} strokeWidth={2} />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={x(p.t)}
          cy={y(p.v)}
          r={marks?.[i] ? 4.5 : 2.5}
          fill={marks?.[i] ? '#fff' : colour}
          stroke={colour}
        />
      ))}
      <text x={PAD.l} y={H - 5} className="axis">
        {shortDate(new Date(t0).toISOString())}
      </text>
      <text x={W - PAD.r} y={H - 5} textAnchor="end" className="axis">
        {shortDate(new Date(t1).toISOString())}
      </text>
    </svg>
  );
}

function WeekBars({ weeks }: { weeks: ProgressData['weeks'] }) {
  const top = Math.max(50, ...weeks.map((w) => w.tss));
  const bw = (W - PAD.l - PAD.r) / weeks.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart">
      {weeks.map((w, i) => {
        const h = (w.tss / top) * (H - PAD.t - PAD.b - 14);
        const x = PAD.l + i * bw;
        return (
          <g key={i}>
            <rect x={x + 3} y={H - PAD.b - h} width={bw - 6} height={h} fill="#4a9eda" rx={2} />
            {w.rides > 0 && (
              <text x={x + bw / 2} y={H - PAD.b - h - 4} textAnchor="middle" className="axis">
                {w.tss} · {w.rides}
              </text>
            )}
            {i % 2 === 0 && (
              <text x={x + bw / 2} y={H - 6} textAnchor="middle" className="axis">
                {shortDate(w.weekStart)}
              </text>
            )}
          </g>
        );
      })}
      <text x={4} y={PAD.t + 8} className="axis">
        TSS · rides
      </text>
    </svg>
  );
}

function RideChart({ ride, samples }: { ride: RideSummary; samples: Sample[] }) {
  if (samples.length < 2) return <div className="empty">No samples stored for this ride.</div>;
  const CW = 900;
  const CH = 260;
  const n = Math.ceil(samples.length / 900);
  const pts = samples.filter((_, i) => i % n === 0);
  const tMax = samples[samples.length - 1].t;
  const pMax = Math.max(...pts.map((s) => Math.max(s.p, s.tp)), 100) * 1.1;
  const hrs = pts.map((s) => s.hr).filter((v): v is number => v !== null);
  const [hLo, hHi] = hrs.length ? [Math.min(...hrs) - 5, Math.max(...hrs) + 5] : [0, 1];
  const x = (t: number) => 40 + (t / tMax) * (CW - 80);
  const yp = (p: number) => CH - 22 - (p / pMax) * (CH - 34);
  const yh = (h: number) => CH - 22 - ((h - hLo) / (hHi - hLo)) * (CH - 34);
  const line = (f: (s: Sample) => number | null) => {
    let d = '';
    let pen = false;
    for (const s of pts) {
      const v = f(s);
      if (v === null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(s.t).toFixed(1)},${v.toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  return (
    <svg viewBox={`0 0 ${CW} ${CH}`} className="chart wide">
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <g key={f}>
          <line x1={40} x2={CW - 40} y1={yp((pMax * f) / 1.1)} y2={yp((pMax * f) / 1.1)} className="grid" />
          <text x={34} y={yp((pMax * f) / 1.1) + 4} textAnchor="end" className="axis">
            {Math.round((pMax * f) / 1.1)}
          </text>
        </g>
      ))}
      <path d={line((s) => yp(s.tp))} fill="none" stroke="#7c8794" strokeWidth={1.5} />
      <path d={line((s) => yp(s.p))} fill="none" stroke="#f2b84b" strokeWidth={1.2} />
      <path
        d={line((s) => (s.hr === null ? null : yh(s.hr)))}
        fill="none"
        stroke="#ff6369"
        strokeWidth={1.5}
      />
      <text x={40} y={CH - 5} className="axis">
        0:00
      </text>
      <text x={CW - 40} y={CH - 5} textAnchor="end" className="axis">
        {mmss(tMax)}
      </text>
      <text x={CW - 34} y={yh(hHi - 5) + 4} className="axis">
        {hrs.length ? Math.round(hHi - 5) : ''}
      </text>
      <text x={CW / 2} y={CH - 5} textAnchor="middle" className="axis">
        grey: target W · amber: power W · red: heart rate — FTP at the time {ride.ftp} W
      </text>
    </svg>
  );
}

const OUTCOME = { success: 'Success', stretch: 'Stretch', fail: 'Fail' };

export function Progress() {
  const [data, setData] = useState<ProgressData | null>(null);
  const [open, setOpen] = useState<{ ride: RideSummary; samples: Sample[] } | null>(null);
  useEffect(() => void api.getProgress().then(setData), []);
  if (!data) return <div className="loading">Loading…</div>;
  const v = data.verdict;
  const cls = v.label === 'Improving' ? 'good' : v.label === 'Slipping' ? 'warn' : '';
  return (
    <div className="progress">
      <div className={`verdict ${cls}`}>
        <span className="verdict-label">{v.label}</span>
        <span>{v.why}</span>
      </div>
      <div className="grid2">
        <div className="card">
          <h3>FTP over time (W)</h3>
          <LineChart
            step
            colour="#4cd08a"
            points={data.ftpSeries.map((p) => ({ t: Date.parse(p.date), v: p.ftp }))}
            marks={data.ftpSeries.map((p) => p.manual)}
          />
          <div className="muted small">White points are manual overrides.</div>
        </div>
        <div className="card">
          <h3>Aerobic efficiency (W per bpm)</h3>
          <LineChart
            colour="#4a9eda"
            digits={2}
            points={data.efficiencySeries.map((p) => ({ t: Date.parse(p.date), v: p.value }))}
          />
        </div>
        <div className="card">
          <h3>Progression levels</h3>
          {data.levels.map((l) => (
            <div className="level-row" key={l.type}>
              <div className="level-name">{TYPE_LABEL[l.type]}</div>
              <div className="level-track">
                <div className="level-fill" style={{ width: `${(l.level / 10) * 100}%` }} />
              </div>
              <div className="level-num">{l.level.toFixed(1)}</div>
              <div
                className={l.change4w > 0 ? 'level-chg up' : l.change4w < 0 ? 'level-chg down' : 'level-chg'}
              >
                {l.change4w > 0
                  ? `▲ ${l.change4w.toFixed(1)}`
                  : l.change4w < 0
                    ? `▼ ${Math.abs(l.change4w).toFixed(1)}`
                    : '–'}
              </div>
            </div>
          ))}
          <div className="muted small">▲/▼ is the change over 4 weeks.</div>
        </div>
        <div className="card">
          <h3>Weekly load (last 12 weeks)</h3>
          <WeekBars weeks={data.weeks} />
        </div>
      </div>
      <div className="card">
        <h3>Rides</h3>
        {data.rides.length === 0 ? (
          <div className="empty">No rides yet.</div>
        ) : (
          <table className="rides">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Level</th>
                <th>Min</th>
                <th>Outcome</th>
                <th>Avg W</th>
                <th>Avg HR</th>
              </tr>
            </thead>
            <tbody>
              {data.rides.map((r) => (
                <tr key={r.id} onClick={() => void api.getRide(r.id).then(setOpen)}>
                  <td>
                    {new Date(r.date).toLocaleDateString(undefined, {
                      weekday: 'short',
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </td>
                  <td>{TYPE_LABEL[r.type]}</td>
                  <td>{r.level === null ? '—' : r.level.toFixed(1)}</td>
                  <td>{r.minutes}</td>
                  <td className={`outcome-text ${r.outcome}`}>{OUTCOME[r.outcome]}</td>
                  <td>{r.avgPower}</td>
                  <td>{r.avgHr ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open && (
        <div className="modal" onClick={() => setOpen(null)}>
          <div className="card modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="preview-head">
              <h3>
                {new Date(open.ride.startedAt).toLocaleString()} — {open.ride.plan.name}
              </h3>
              <button className="secondary" onClick={() => setOpen(null)}>
                Close
              </button>
            </div>
            <RideChart ride={open.ride} samples={open.samples} />
            <div className="muted">
              {mmss(open.ride.durationS)} · avg {open.ride.avgPower} W · NP {open.ride.np} W · TSS{' '}
              {open.ride.tss} · avg HR {open.ride.avgHr ?? '—'} · peak HR {open.ride.peakHr5s ?? '—'}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
