# TurboOverlay — Design

A TrainerRoad-style indoor cycling app for Windows (primary) and Linux (secondary). It shows a small, minimal overlay on top of whatever video is playing. The rider answers 3 quick questions, gets a session built for them, the app controls the trainer in ERG mode, and FTP is **inferred from normal rides — no FTP tests, ever.**

This is the design the app was built from. It describes what the code does and why.

---

## 1. Who it is for

| Item | Value |
|---|---|
| Rider | Trains about 3 times a week, at most 60 minutes per session |
| Goal | Raise FTP without a rigid plan |
| Starting FTP | Entered once in the first-run wizard (a seed value only — the app refines it) |
| Max HR | Not needed up front — starts from an age prior and ratchets up from ride data (section 7) |
| Trainer | Any smart trainer that speaks ANT+ FE-C (developed against a Saris Hammer) |
| HRM | Any ANT+ heart-rate strap |
| Receiver | Generic ANT+ USB stick (USB ID `0fcf:1008` or `0fcf:1009`) |
| OS | Windows required, Linux nice-to-have |
| Integrations | None. Fully offline, local data only |

---

## 2. Tech stack (decided)

- **Electron + TypeScript**, Vite for the renderer, plain React (or Preact) for the UI
- **ANT+:** `incyclist-ant-plus` (maintained for the Incyclist Electron app; FE-C, HR, power; auto-detects Garmin2/Garmin3 sticks). Runs in the **main process only**; it talks to the renderer over IPC
- **Charts:** a lightweight library (e.g. uPlot or Chart.js)
- **Storage:** plain JSON files in `app.getPath('userData')`. No database. Every file carries a `schemaVersion`
  - `profile.json`: FTP history, max HR history, zone levels, settings, device IDs, hotkey bindings. Written atomically (write a temp file, then rename)
  - `rides/YYYY-MM-DD-HHmm.json`: session plan, summary, outcome, and **the FTP, max HR and progression levels in force when the ride started** (analytics and TSS depend on these)
  - `rides/YYYY-MM-DD-HHmm.samples.ndjson`: 1 Hz samples, **appended during the ride** (flushed at least every 10 s) so a crash never loses a ride. On next launch, an unfinished ride is detected and finalised from its samples
- **Tests:** Vitest for all pure logic (generator, FTP estimator, workout engine)
- **Packaging:** electron-builder → Windows NSIS installer + portable `.exe`; Linux AppImage. Use `@electron/rebuild` for the native `usb` dependency

### Platform setup notes (document these in README)
- **Windows:** the ANT+ stick needs the **WinUSB** driver installed once with **Zadig** (Options → List All Devices → select the ANT stick → WinUSB → Replace Driver). Without it you get `LIBUSB_ERROR_NOT_SUPPORTED`. This can be reverted in Device Manager. Close Garmin Express or any other app that grabs the stick. Note that replacing the driver takes the stick away from any other program that relies on Garmin's own driver, until it is reverted.
- **Linux:** add a udev rule so the stick doesn't need root:
  `SUBSYSTEM=="usb", ATTRS{idVendor}=="0fcf", ATTRS{idProduct}=="100[89]", MODE="0666"`
  Overlay transparency needs a compositor. On Wayland, launch with `--ozone-platform=x11` (XWayland) so always-on-top works. **Known limit:** under XWayland, global hotkeys only fire while an X11 window has focus, so they may not work over a Wayland-native browser. Run the browser under X11 too, or accept no hotkeys on Wayland.
- **Trainer:** recommend a spindown calibration in the trainer maker's app occasionally. The app does not need to implement calibration.
- **Cooling:** indoor heart rate depends heavily on cooling. Use the same fan setup every ride; a change of fan will look like a change of fitness.

---

## 3. Architecture

```
main process
 ├─ devices/        TrainerService + HrService interfaces: open stick, scan, pair, reconnect, emit samples
 │   ├─ AntTrainerService / AntHrService   (incyclist-ant-plus)
 │   └─ SimulatedTrainerService / SimulatedHrService (fake rider for dev/tests)
 ├─ engine/         WorkoutEngine: runs a session, sets ERG target each second, handles pause/skip/±%
 ├─ recorder/       1 Hz sample recorder → append to samples file, finalise ride JSON
 ├─ store/          profile + rides JSON read/write (atomic writes, schema versions)
 ├─ coach/          SessionGenerator (pure), FtpEstimator (pure), Progression (pure)
 └─ windows/        Home window + Overlay window, global hotkeys
 
renderer
 ├─ home/           pre-ride questions, session preview, history & analytics, settings/pairing
 └─ overlay/        the minimal on-video HUD
```

- The pure logic in `coach/` and `engine/` must be free of Electron and I/O so it can be unit-tested.
- **All timing lives in the main process.** The engine tick, the recorder and the ERG re-send must never run in a renderer, because hidden or covered renderer windows are throttled. Renderers only display state pushed over IPC.
- The device interfaces are named for what they do, not for ANT+, so a Bluetooth FTMS implementation could be added later without touching the engine. (Bluetooth is still a non-goal for now.)
- Hold a `powerSaveBlocker('prevent-display-sleep')` for the length of a session.

---

## 4. The overlay (key UX)

- Frameless, **transparent**, `alwaysOnTop(true, 'screen-saver')`, `skipTaskbar`, not focusable. It sits above a fullscreen browser or a video app
- **Re-assert always-on-top** on a short timer (about every 2 s) and whenever another window gains focus. On Windows an always-on-top window can drop behind an app that has just gone fullscreen
- **Click-through by default** (`setIgnoreMouseEvents(true, {forward:true})`) so it never interferes with the video
- **Display choice:** a setting for which monitor the overlay appears on (default: the primary display). Handle a monitor being unplugged by falling back to the primary
- A thin strip (default **bottom-centre**, about 900×90 px, semi-transparent dark background, opacity adjustable 40–90%), showing:
  - **Power** as current → target (large, current coloured green/amber/red vs target) | **Cadence** as current → target (same size and colouring) | **HR**
  - **Interval time left** + what's next ("Next: 4:00 @ 205 W")
  - A tiny workout-profile bar with a progress marker
  - Session time remaining
- Alternative position: top strip. Compact mode shows just Power (current → target) / Cadence (current → target) / Time-left
- **Global hotkeys** (the video has focus, so these must be global; avoid Space because video players use it). Defaults below; **every binding can be changed in Settings**, because `Ctrl+Alt` is AltGr on many keyboard layouts and `Ctrl+Alt+Arrow` is already taken on some systems (GNOME workspaces, some graphics drivers). If a binding fails to register, show that in Settings
  - `Ctrl+Alt+P` pause/resume · `Ctrl+Alt+Up/Down` intensity ±5% · `Ctrl+Alt+N` skip interval
  - `Ctrl+Alt+O` cycle overlay position/compact · `Ctrl+Alt+H` hide/show overlay
- Auto-pause when cadence is 0 for more than 3 s; auto-resume on pedalling
- Big, high-contrast, glanceable numbers. No clutter

---

## 5. Pre-ride flow (Home window)

Three one-tap questions, then a preview, then Start:

1. **Time today:** 30 / 45 / 60 min
2. **Legs:** fresh / normal / tired
3. **Feel like:** steady / push me

The preview shows the session name, the profile graphic, duration, and a one-line explanation ("Sweet spot, level 4.5 — you rode hard on Tuesday, so today builds aerobic strength without digging a hole"). If the rider asked for "push me" and a rule blocked a hard session, the explanation says which rule. Buttons: **Start** · **Easier** · **Harder** (± one level per tap, limits in section 6) · **Swap session** (next variant of the same type, section 6).

Post-ride: a summary card plus one **optional** tap: "How was that?" → easy / about right / hard / couldn't finish. Skippable; outcome is also auto-detected.

---

## 6. Session generator (`coach/SessionGenerator`)

Pure function: `generate(answers, profile, recentRides, now) → SessionPlan`.

### Zones (% of current FTP)
Recovery 50–55 · Endurance 60–72 · Tempo 76–87 · Sweet Spot 88–94 · Threshold 95–102 · VO2max 106–120

### Session structure
- Warm-up: 30 min → 7 min, 45/60 → 10 min (ramp 50→70% plus 2 short openers on hard days)
- Cool-down: 5 min (30/45), 8 min (60)
- **Main-set budget** = duration − warm-up − cool-down: **18 min** (30), **30 min** (45), **42 min** (60)
- Recoveries between intervals are at 50% FTP. There is no recovery after the last interval (the cool-down follows)
- Any main-set time left over after the intervals is ridden at 62% FTP before the cool-down, so the session always lasts exactly the time chosen

### Session types and progression levels
Five types carry a progression level: Endurance, Tempo, Sweet Spot, Threshold, VO2max. A level is a number from 1.0 to 10.0, stored to two decimals, one per type, shared across the three time slots. **Recovery** is a sixth type with no level: the whole session at 52% FTP, and it never changes any level.

Each interval type is fully defined by the table below. Every value moves in a straight line from its level 1 figure to its level 10 figure: `value = L1 + (L10 − L1) × (level − 1) / 9`.

| Type | % FTP (L1 → L10) | Work minutes, 30 slot | Work minutes, 45 slot | Work minutes, 60 slot | Longest interval, min (L1 → L10) | Recovery (share of interval) | Fewest intervals |
|---|---|---|---|---|---|---|---|
| Tempo | 78 → 87 | 10 → 16 | 15 → 26 | 24 → 36 | 8 → 18 | 25% | 1 |
| Sweet Spot | 88 → 94 | 9 → 15 | 14 → 25 | 18 → 34 | 6 → 17 | 33% | 1 |
| Threshold | 95 → 102 | 8 → 13 | 12 → 21 | 16 → 30 | 4 → 15 | 50% | 2 |
| VO2max | 110 → 120 | 6 → 10 | 8 → 16 | 9 → 20 | 1.5 → 4 | 100% | 3 |

**Fitting rule** (the same for every type, level and slot):
1. Work minutes `W` = the table value for the level and slot, rounded to the nearest 0.5 min
2. Number of intervals `n` = `W ÷ longest interval`, rounded up, but never fewer than the "fewest intervals" column
3. Interval length = `W ÷ n`, rounded down to 15 s. Recovery = share × interval length, rounded to 15 s
4. If `n × interval + (n − 1) × recovery` is more than the main-set budget, take 0.5 min off `W` and repeat from step 2

With the table above, every half-level from 1.0 to 10.0 fits its slot without step 4 ever firing (checked by script). Reference points in the 60 min slot: Tempo 3×8 (L1) → 2×18 (L10); Sweet Spot 3×6 → 2×17; Threshold 4×4 → 2×15; VO2max 6×1:30 → 5×4.

**Endurance:** the whole main set is continuous at 62% (L1) → 72% (L10). From level 4, add 1-minute surges spread evenly through it: 2 surges at level 4, one more for every 2 levels above that (3 at L5–6, 4 at L7–8, 5 at L9–10), at 80% (L4) → 85% (L10). In the 30 min slot use at most 3 surges.

A unit test must assert, for every type, half-level and slot, that the generated session lasts exactly the chosen duration and the main set fits its budget.

### Session variants
Each type comes in several shapes so the same type is not the same session every time. The level table above still sets the work time and the power; a variant only changes how an interval is ridden. The first variant of each type is the classic one described above.

| Type | Variants |
|---|---|
| Endurance | Classic (steady, with 1-minute surges from level 4) · **Sprints**: 4 / 6 / 8 sprints (30 / 45 / 60 min slot) of 10 s at 175% FTP, spread evenly · **Cadence drills**: same power, one minute in every five at high (105 rpm) or low (70 rpm) cadence |
| Tempo | Classic · **Cadence**: same power, 2-minute blocks alternating 70 and 105 rpm · **Bursts**: a 10 s burst at 130% at the end of every 3 minutes |
| Sweet Spot | Classic · **Over-unders**: 3-minute cycles of 2 min at 4 points under and 1 min at 8 points over (the average is the classic power) · **Bursts**: a 10 s burst at 150% at the end of every 3 minutes |
| Threshold | Classic · **Over-unders** (as Sweet Spot) |
| VO2max | Classic · **30/30s**: 30 s on at 8 points above the classic power, 30 s off, in 2 or 3 sets with 3 min between · **40/20s**: 40 s on at 4 points above, 20 s off, same sets |

- **Rotation:** the variant is chosen by how many sessions of that type have been done before, so they come round in turn. The preview has a **Swap session** button that moves to the next variant.
- Over-under intervals are rounded down to whole 3-minute cycles; the time left over is ridden at 62% like any other spare main-set time.
- Sprints and bursts are steps of kind `sprint`. They get their full target at once (no 3-second blend). In ERG mode the trainer takes a second or two to respond, so a 10 s sprint is felt as roughly 8 s.
- Only whole classic intervals of 3 minutes or more feed the FTP guard rails. Consecutive steps at the same power (cadence drills) still count as one steady segment for the heart-rate regression.

### Target cadence
Every step carries a target cadence in rpm. It is guidance only: it is shown next to the live cadence (green within 5 rpm, amber within 10, red beyond) and in the "Next:" line, and it never affects the outcome of a ride.

| Where | rpm |
|---|---|
| Warm-up, recoveries, cool-down, recovery rides | 85 |
| Endurance | 88 (surges 95) |
| Tempo | 85 |
| Sweet Spot | 90 |
| Threshold | 92 |
| VO2max | 100 (30/30s and 40/20s: 105) |
| Over-unders | 88 under, 95 over |
| Cadence drills | 70 low, 105 high |
| Sprints and bursts | 115 |
| Openers | 100 |

### Decision rules (age-appropriate: intensity is earned, recovery is protected)

Definitions used below:
- A **hard ride** is a Threshold or VO2max session in which at least half the planned work time was completed
- **Layoff** = more than 7 days since the last ride, or no rides yet
- "Least recently done" compares the date of the last session of each type. A type never done counts as oldest. Ties go to the first type named

The rules are an ordered list. Take the first one that matches and stop.

1. `legs = tired` and the last ride was a hard ride less than 48 h ago → **Recovery**
2. `legs = tired` → **Endurance**
3. A hard session is allowed → **Threshold or VO2max**, whichever was least recently done. It is allowed only if **all** of these hold: the rider chose `push me`; it is not a layoff; no hard ride in the last 48 h; fewer than 2 hard rides in the last 7 days (rolling)
4. Otherwise → **Sweet Spot or Tempo**, whichever was least recently done. If `push me` was chosen but a condition in rule 3 blocked it, the preview's explanation says which one

The ideal 3-ride week is 1 hard, 1 sweet spot or tempo, 1 endurance. The rules do not force this; the rider gets Endurance by answering "tired".

### Level ridden today
The session is built at `stored level + offset`:
- `push me` +0.5 · `fresh` +0.5 · layoff −1.0
- Each tap of **Harder** +1.0, each tap of **Easier** −1.0
- The total offset is limited to between −2.0 and +1.0, and the resulting level to between 1.0 and 10.0

The ride file records both the stored level and the level ridden.

### Progression (`coach/Progression`)
After each ride, classify the outcome from the data, then apply the rider's rating if one was given:
- **Success:** at least 95% of work time completed, and the net intensity change was no lower than −3% (raising the intensity counts as success), and the rating is not "hard" or "couldn't finish"
- **Stretch:** completed but rated "hard", or intensity cut by more than 3% and up to 8%
- **Fail:** stopped early (less than 95% of work time), or intensity cut by more than 8%, or rated "couldn't finish"

New stored level for that type, where `s` is the stored level and `r` the level ridden:
- Success at or above the stored level (`r ≥ s`) → `max(s + 0.5, r)`, plus a further 0.5 if rated "easy". In the 30 min slot each 0.5 step is 0.25, because the same level is less total work there
- Success below the stored level (`r < s`, e.g. after Easier or a layoff) → no change
- Stretch → `min(s, r)`
- Fail → `min(s, r) − 1.0`
- Bounds 1.0–10.0. Recovery rides change nothing

**When FTP changes, rebalance levels.** A higher FTP makes every % target harder in watts, so levels must come down or the next session will overshoot. On an FTP rise of x%, lower the levels by roughly 0.15 × x for Endurance/Tempo, 0.25 × x for Sweet Spot, and 0.35 × x for Threshold/VO2 (e.g. +3% FTP → Threshold −1.0). Reverse this for a drop. Record each adjustment so the levels history explains it.

**Inactivity decay:** a type loses 0.1 for each full week with no session of that type. The total lost this way is limited to 2.0 below the level held after the last session of that type, and never goes below 1.0.

---

## 7. Implied FTP — no tests (`coach/FtpEstimator`)

**Important:** in ERG mode the power is dictated by the target, so best-power curves alone are meaningless. Completed intervals mostly prove the rider can do what the current FTP already predicts. So the design is: **the heart-rate relationship (B) is the estimate; completed and failed work (A) are guard rails that the estimate may not cross.**

### Max heart rate
- `maxHr = the higher of the age prior (220 − age) and the observed peak`
- Observed peak = the highest 5-second average HR **ever recorded**. It only ratchets upward; it does not expire. Ignore samples where HR jumps by more than 10 bpm in one second (strap glitches)
- `maxHr` is updated after a ride, never during one. A manual value in Settings overrides it
- Estimated LTHR = 0.90 × `maxHr`
- This rider never does maximal efforts, so the observed peak will usually sit below the true maximum. The age prior stops the estimate starting far too low, and the ratchet lets it correct upward over time

### Guard rail A: what the rider has actually done
Duration factor: `k(3 min)=1.20, k(5)=1.13, k(8)=1.08, k(12)=1.04, k(20)=1.00` (interpolate; use 1.00 above 20 min).

- **Lower bound.** Every completed work interval of at least 3 min at Sweet Spot or above gives `lower = avg_power / k(duration)`. No heart-rate condition: finishing it is proof enough. The working lower bound is the highest such value in the last 6 weeks
- **Upper bound.** An interval the rider failed (stopped, or cut intensity by more than 8% during it) while HR was at least 90% of `maxHr` gives `upper = planned_power / k(planned duration)`. Failures with lower HR are ignored (they are more likely motivation, a phone call, or a mechanical). The upper bound only applies once there are 2 such failures in the last 4 weeks; use the higher of them
- If the lower bound is above the upper bound, the more recent one wins
- Repeats are deliberately not credited (5×4 min counts the same as 1×4 min). This keeps the lower bound conservative; it protects against a wrong drop and is not expected to drive increases

### Estimate B: HR–power relationship
- Take steady segments (at least 5 min, power CV under 5%, skipping the first 2 min of each so HR has settled) from the last 6 weeks
- Skip rides, or parts of rides, where HR data is missing
- Fit linear regression of power against HR
- `FTP_B = predicted power at LTHR`
- B is only valid with at least 8 segments covering an HR range of at least 15 bpm. Otherwise there is no new estimate and FTP stays where it is

### Combining
1. Start from `FTP_B`. If B is not valid, keep the current FTP
2. Clamp to the guard rails: no lower than the lower bound, no higher than the upper bound
3. Limit the change to **±3% per week**, and require at least 3 rides since the last change. Ignore changes of less than 2 W
4. **Never lower FTP while the last 3 rides were all Success.** Completed work outranks a pessimistic heart-rate reading
5. Auto-apply to future sessions with a gentle notice ("FTP updated 200 → 204 W"), and allow a manual override in Settings
6. Store every estimate with its inputs (segments used, regression, bounds, which rule decided) in `profile.json` so it can be explained

No extra smoothing is applied: the 6-week regression window, the weekly cap and the 3-ride rule already damp it.

### Aerobic Efficiency
Average power ÷ average HR, measured only on steady segments at 60–75% of FTP that start at least 10 min into the ride, skipping the first 2 min of each segment. One value per ride (time-weighted mean of its segments); rides with no qualifying segment or no HR have no value. It's a good early signal that fitness is improving even before FTP moves.

---

## 8. Analytics (Home → Progress)

Keep it to one screen:
1. **Verdict line** at the top: "Improving / Holding steady / Slipping", based on the 4-week FTP slope and the efficiency trend, with one sentence of why
2. **FTP over time** (line, weekly points, with the manual override marked)
3. **Aerobic efficiency over time** (watts per heartbeat, line)
4. **Progression levels**: horizontal bars, one per type (Endurance, Tempo, Sweet Spot, Threshold, VO2max), 1–10 scale, with a small ▲/▼ showing the change over 4 weeks
5. **Weekly load** (bar: TSS per week, last 12 weeks) plus rides per week
6. **Ride list**: date, type, level, duration, outcome, avg W, avg HR. Click to open a ride chart (power/target/HR)

**TSS definition:** Normalised Power = the fourth root of the mean of (30-second rolling average power)⁴. Intensity Factor = NP ÷ the FTP stored in that ride's file. TSS = ride seconds × IF² ÷ 36. Paused time is excluded.

---

## 9. ANT+ details

- Channels: 1× FE-C (trainer), 1× HR. Optionally a standalone cadence sensor later. FE-C trainers supply cadence
- Pairing: first run scans and lists found devices with IDs; the rider picks; IDs are saved; later runs auto-connect to the saved IDs
- ERG: send **FE-C Target Power (page 49)** whenever the target changes and re-send every 2 s (some trainers drop commands). User Configuration (page 55) is not needed: it has no effect in ERG mode
- Ramp target changes over 2–3 s at interval boundaries to soften steps
- **Resume ramp:** after any pause (manual, auto-pause or trainer reconnect), start at 50% of the target and ramp to the full target over 8 s once cadence is above 50 rpm. Going straight to full target at zero cadence locks the flywheel
- **Dropouts are handled per device:**
  - Trainer silent for more than 3 s → show "Reconnecting…" on the overlay, pause the timer, auto-reattach, resume with the resume ramp
  - HR silent for more than 3 s → show "HR —" on the overlay and keep riding. The workout does not pause. Samples record HR as missing, and the estimator skips that stretch
  - Never crash the session
- **Safety:** each ride has an HR ceiling, fixed when the ride starts: `maxHr + 3 bpm`, or a value set in Settings. If HR stays above the ceiling for more than 20 s, ease ERG by 5% and flash the HR. Because the ceiling sits above `maxHr`, a ride can still record a new peak, which raises `maxHr` (and so the ceiling) for the next ride

---

## 10. Milestones (the order it was built in)

The two biggest unknowns are the overlay sitting on top of fullscreen protected video, and the ANT+ stick driver. Both are tested early (M1 and M2).

**M0: Scaffold + simulator**
Electron + TS + Vite project, lint/format, Vitest, `TrainerService`/`HrService` interfaces plus simulated versions (fake power that follows the target with noise, HR with realistic lag/drift, cadence 85–95). Home window shows live simulated numbers. *Test:* `npm run dev` shows moving numbers.

**M1: Overlay** (runs on the simulator, no hardware needed)
Transparent click-through always-on-top HUD, global hotkeys with rebinding, monitor/position/compact/opacity settings. *Test:* over fullscreen video in Chrome/Edge on Windows, including going fullscreen after the overlay is already showing.

**M2: Real ANT+ data**
`incyclist-ant-plus` in the main process, scan/pair UI, live HR + FE-C power/cadence on the Home window and overlay, saved device IDs, per-device reconnect logic. README setup for Zadig (Windows) and udev (Linux). *Test:* on a PC with the stick, HRM and trainer.

**M3: ERG control**
Set target power from a manual slider; a hard-coded 10-minute test workout (2 min steps 100/150/120 W); resume ramp. *Test:* the trainer resistance follows the target; stopping and restarting pedalling does not lock the flywheel.

**M4: Workout engine + recording**
Run any `SessionPlan`, pause/skip/±%, auto-pause, 1 Hz crash-safe recording, end-of-ride summary. Unit tests for the engine. *Test:* kill the app mid-ride and confirm the ride is recovered on next launch.

**M5: Session generator + progression**
The three questions, generator rules, level table and fitting rule, preview with Easier/Harder, post-ride outcome classification and level updates. Thorough unit tests: a table of answer/history combinations → expected session type, and the fit test for every type × half-level × slot.

**M6: Implied FTP + analytics**
Max HR ratchet, guard rails, estimate B, combiner, efficiency metric, TSS, Progress screen. Unit tests using synthetic ride histories (improving, flat and declining riders should produce the right verdict; a rider who completes everything must never see FTP fall).

**M7: Packaging**
Windows installer and portable exe, Linux AppImage, app icon, first-run wizard (pair devices → confirm starting FTP and age → done).

---

## 11. Non-goals (keep it simple)
No accounts, cloud, Strava/Zwift/Garmin sync, Bluetooth, virtual worlds, or FTP tests. No embedded video player: the overlay sits on top of whatever the rider is already watching.
