// Profile and ride files on disk. Plain JSON, atomic writes, crash-safe sample log.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Profile, RideHeader, RideSummary, Sample, SCHEMA_VERSION } from '../../shared/types';
import { summarise } from '../coach/metrics';
import { DEFAULT_SETTINGS, defaultProfile } from './defaults';

const pad = (n: number) => String(n).padStart(2, '0');
export const rideId = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;

export class Store {
  private readonly profilePath: string;
  private readonly ridesDir: string;
  private pending: string[] = [];
  private pendingId: string | null = null;

  constructor(readonly dir: string) {
    this.profilePath = path.join(dir, 'profile.json');
    this.ridesDir = path.join(dir, 'rides');
    fs.mkdirSync(this.ridesDir, { recursive: true });
  }

  private writeAtomic(file: string, data: unknown) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
    fs.renameSync(tmp, file);
  }

  loadProfile(): Profile {
    const fresh = defaultProfile(new Date());
    if (!fs.existsSync(this.profilePath)) return fresh;
    try {
      const raw = JSON.parse(fs.readFileSync(this.profilePath, 'utf8')) as Partial<Profile>;
      // Merge over defaults so files from older versions pick up new fields.
      return {
        ...fresh,
        ...raw,
        schemaVersion: SCHEMA_VERSION,
        levels: { ...fresh.levels, ...raw.levels },
        devices: { ...fresh.devices, ...raw.devices },
        settings: {
          ...DEFAULT_SETTINGS,
          ...raw.settings,
          overlay: { ...DEFAULT_SETTINGS.overlay, ...raw.settings?.overlay },
          hotkeys: { ...DEFAULT_SETTINGS.hotkeys, ...raw.settings?.hotkeys },
        },
      };
    } catch {
      // Keep the unreadable file for inspection rather than overwriting it.
      fs.copyFileSync(this.profilePath, `${this.profilePath}.corrupt-${Date.now()}`);
      return fresh;
    }
  }

  saveProfile(p: Profile) {
    this.writeAtomic(this.profilePath, p);
  }

  private headerPath = (id: string) => path.join(this.ridesDir, `${id}.json`);
  private samplesPath = (id: string) => path.join(this.ridesDir, `${id}.samples.ndjson`);

  /** A ride id that is not already on disk (two rides in the same minute get a suffix). */
  freeRideId(d: Date): string {
    const base = rideId(d);
    let id = base;
    for (let n = 2; fs.existsSync(this.headerPath(id)); n++) id = `${base}-${n}`;
    return id;
  }

  beginRide(header: RideHeader) {
    this.writeAtomic(this.headerPath(header.id), header);
    fs.writeFileSync(this.samplesPath(header.id), '');
    this.pending = [];
    this.pendingId = header.id;
  }

  /** Buffered; call flush() every few seconds. */
  appendSample(s: Sample) {
    this.pending.push(JSON.stringify(s));
  }

  flush() {
    if (!this.pendingId || !this.pending.length) return;
    fs.appendFileSync(this.samplesPath(this.pendingId), this.pending.join('\n') + '\n');
    this.pending = [];
  }

  saveRide(ride: RideSummary) {
    this.flush();
    this.writeAtomic(this.headerPath(ride.id), ride);
    if (this.pendingId === ride.id) this.pendingId = null;
  }

  discardRide(id: string) {
    this.pending = [];
    if (this.pendingId === id) this.pendingId = null;
    for (const f of [this.headerPath(id), this.samplesPath(id)]) fs.rmSync(f, { force: true });
  }

  readSamples(id: string): Sample[] {
    const f = this.samplesPath(id);
    if (!fs.existsSync(f)) return [];
    const out: Sample[] = [];
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A torn last line after a crash: ignore it.
      }
    }
    return out;
  }

  /** All finished rides, oldest first. */
  loadRides(): RideSummary[] {
    const out: RideSummary[] = [];
    for (const f of fs.readdirSync(this.ridesDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.ridesDir, f), 'utf8')) as RideSummary;
        if (r.finished) out.push(r);
      } catch {
        // Skip unreadable files.
      }
    }
    return out.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  }

  /**
   * Rides that were never finalised (the app crashed or was killed mid-ride).
   * Returns summaries built from the samples on disk; very short ones are deleted.
   */
  recoverUnfinished(): RideSummary[] {
    const out: RideSummary[] = [];
    for (const f of fs.readdirSync(this.ridesDir)) {
      if (!f.endsWith('.json')) continue;
      let header: RideHeader;
      try {
        header = JSON.parse(fs.readFileSync(path.join(this.ridesDir, f), 'utf8'));
      } catch {
        continue;
      }
      if (header.finished) continue;
      const samples = this.readSamples(header.id);
      if (samples.length < 60) {
        this.discardRide(header.id);
        continue;
      }
      const last = samples[samples.length - 1];
      const endedAt = new Date(Date.parse(header.startedAt) + last.w * 1000).toISOString();
      out.push(summarise(header, samples, endedAt));
    }
    return out.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  }
}
