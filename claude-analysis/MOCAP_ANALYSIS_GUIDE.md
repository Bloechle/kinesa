# Mocap Analysis Guide

This guide tells **Claude** how to produce high-quality biomechanics analyses
from Motive JSON mocap data, across any sport that the lab's students may
record. It is paired with two Python modules: **`mocap.py`** (universal
data-loading and kinematics primitives) and **`report.py`** (HTML report
template). **Read this guide in full before touching any data file.** The
taxonomy in §6 is what tells you which metrics, events, and visualizations
are appropriate for the gesture in front of you.

---

## 1. Project purpose

The lab captures students performing a wide variety of sports gestures with
the Motive optical mocap system at the University of Fribourg. Captures are
exported to JSON via the project's companion exporter, then dropped into a
chat for analysis. Examples range from racquet sports (tennis, badminton,
ping-pong) to ice hockey slap shots, gymnastics rotations (cartwheel,
round-off, pirouette), combat sports (boxing, karate), team sports
(soccer, basketball, hockey), throwing (frisbee, javelin), explosive
launches (sprint start, jumps), and static balance (handstand, single-leg
stand).

The deliverable expected from Claude is a **focused, biomechanically sound
analysis** of one or more takes: identification of key events, derivation
of the metrics that actually matter for that gesture family, comparison
across athletes or trials, and informative visualizations. **Do not** apply
a generic recipe to everything — the taxonomy in §6 is the routing layer.

---

## 2. JSON file format

Each take is a JSON file produced by the project's exporter from the
Motive CSV export. Top-level structure:

```
{
  "metadata": {
    "formatVersion": 1.25,
    "takeName":      "...",
    "frameRate":     360,                    // Hz, almost always 360
    "captureStartTime": "...",
    "rotationType":  "quaternion",
    "lengthUnits":   "Meters",
    "coordinateSpace": "Global",             // Y-up, right-handed
    "totalFrames":   <int>,
    "firstFrame":    0,
    "coordinates":   { "pos": ["x","y","z"], "quat": ["x","y","z","w"] },
    "objects": {                             // <-- inventory of what's tracked
      "<SkeletonName>":  { "type": "skeleton",  "nodes": [25 bone names] },
      "<RigidBodyName>": { "type": "rigidbody", "nodes": ["Origin"] },
      "Unlabeled":       { "type": "marker",    "nodes": ["10081", ...] }
    },
    "originalFilename": "..."
  },
  "frames": [
    { "frame": 0, "time": 0.0,
      "objects": {
        "<SkeletonName>": { "Hip": {"pos":[x,y,z], "quat":[x,y,z,w]}, ... },
        "<RigidBodyName>": { "Origin": {"pos":[...], "quat":[...]} },
        "Unlabeled": { "10081": {"pos":[...]}, ..., "Center": {"pos":[...]} }
      }
    },
    ...
  ]
}
```

Important properties:

- **Y-up, global frame.** Y is vertical, X and Z are horizontal. Yaw =
  rotation around Y. Confirm with `metadata.coordinateSpace`.
- **Quaternions are stored `(x, y, z, w)`** — same convention scipy uses.
- **`metadata.objects` is the canonical inventory.** Read it first to learn
  what skeletons, rigid bodies, and marker collections exist. Names are
  arbitrary: a hockey stick may be called `"Stick"`, `"Crosse"`, or just
  `"Rigid Body 001"`. A tennis racket may be named or unnamed. Skeletons
  are usually named after the subject.
- **N skeletons are possible** (e.g. 1v1 captures, doubles tennis, judo).
  Iterate over `take.skeletons.values()`.
- **Implements (racket/stick/club/bat) come as rigid bodies.** Their
  position and orientation over time are crucial for striking sports.
- **Marker collections include `Center`**, the centroid of all unlabeled
  markers, computed by the exporter. Useful as a rough "ball" position
  in some captures, but treat with caution — it includes spurious markers.
- **Missing data is `null`** in JSON, becoming `NaN` in numpy after load.
  All primitives in `mocap.py` are NaN-safe.

---

## 3. Skeleton & coordinate system

The standard Motive skeleton used in this project has **25 bones**:

```
Hip, Ab, Spine2, Spine3, Spine4, Chest, Neck, Neck2, Head,
LShoulder, LUArm, LFArm, LHand,
RShoulder, RUArm, RFArm, RHand,
LThigh, LShin, LFoot, LToe,
RThigh, RShin, RFoot, RToe
```

Naming convention:

- `L` / `R` prefix = left / right.
- `UArm` = upper arm (humerus), `FArm` = forearm.
- `Hip` is the pelvis root; `Ab` is the lumbar segment; `Chest` is the
  thoracic segment. `Spine2/3/4` are intermediate spine bones.

Predefined kinematic chains in `mocap.py`:

- `RIGHT_ARM_CHAIN = ['Hip', 'Chest', 'RShoulder', 'RUArm', 'RFArm', 'RHand']`
- `LEFT_ARM_CHAIN`
- `RIGHT_LEG_CHAIN`, `LEFT_LEG_CHAIN`

Use these for proximal-to-distal sequencing analysis (§6.1, §6.6).

**Plot mapping.** When rendering 3D, `mocap.py` remaps Y-up data so that
the plot's vertical axis (z in matplotlib) shows Y from the data. Don't
fight this — use `draw_skeleton_3d` and `equalize_3d_axes` and you get
correct orientation automatically.

**Subset skeletons.** Not every capture uses the full 25-bone skeleton —
some configurations omit `Spine2/3/4` and `Neck2`, leaving 21 bones with
otherwise-identical names. When this happens, **pass `bones=sk.bones`
explicitly** to `draw_skeleton_3d`; without it the function will raise a
clear error rather than silently produce a broken figure. The default
shorthand `mc.draw_skeleton_3d(ax, sk.pos[frame])` only works when the
skeleton has exactly the standard 25 bones.

**Skeleton names are not reliable subject identifiers.** Students
sometimes record under the wrong profile in Motive (a take labelled
"Seppey_1" might have its skeleton named "Loic_expert" because it was
recorded under Loic's profile). When grouping takes by subject for
comparison, **use the file-name prefix**, not `skeleton.name`. A simple
`subject_of(filename)` function that returns one of a known list of
subjects is the right pattern.

---

## 4. The `mocap.py` toolkit

A single-file module with universal primitives. Import as `import mocap as mc`.

### Loading

```python
take = mc.load_take('path/to/take.json')
take.fps              # frame rate
take.dt               # 1/fps
take.n_frames
take.vertical_axis    # 'Y' (Motive default)
take.skeletons        # {name: Skeleton}
take.rigidbodies      # {name: RigidBody}
take.markers          # {"Unlabeled:10081": (T,3), ...}

sk = take.skeleton()                # only one? returns it; else specify name
sk.p('RHand')                       # (T, 3) position of RHand
sk.q('Chest')                       # (T, 4) quaternion of Chest
sk.idx('RHand')                     # bone index in sk.bones / sk.pos / sk.quat
```

### Smoothing

```python
pos_s  = mc.smooth(sk.pos)                # Savitzky-Golay, win=21, poly=3
quat_s = mc.smooth(sk.quat, win=15)       # quats can be smoothed too (small windows)
```

Default Savitzky-Golay window of 21 frames at 360 Hz ≈ 58 ms — preserves
sharp peaks (impact, take-off) while killing noise. Lower the window for
very brief events; raise it for steady-state signals.

### Kinematics

```python
v   = mc.velocity(pos, dt)                # (T, ..., 3) linear velocity
sp  = mc.speed(pos, dt)                   # (T, ...) magnitude
a   = mc.acceleration(pos, dt)            # (T, ..., 3)

w   = mc.angular_velocity_from_quat(q, dt)  # (T, 3) rad/s in body frame
ypr = mc.yaw_pitch_roll(q, vertical='Y')    # (T, 3) degrees, unwrapped
y   = mc.yaw(q, vertical='Y')               # convenience: (T,) yaw only

# Joint angle at the elbow (proximal=shoulder, joint=elbow, distal=wrist)
elb = mc.joint_angle(sk.p('RUArm'), sk.p('RFArm'), sk.p('RHand'))

# Generic inter-segment angle from quaternions (rotation magnitude between two frames)
trunk_torsion = mc.inter_bone_angle(sk.q('Hip'), sk.q('Chest'))
```

### Event detection & alignment

```python
# Global peak of a signal, optionally within a window
f0 = mc.find_event_peak(speeds_RHand)
f0 = mc.find_event_peak(speeds_RHand, search_range=(int(1*fps), int(3*fps)))

# First peak >= 80% of global max — for double-contact gestures (slap shot,
# golf drive…). Degenerates to find_event_peak for single-peak signals.
f0 = mc.find_event_first_peak(stick_speed, fps)

# Threshold crossing (returns first index)
f_takeoff = mc.find_threshold_crossing(speed_LToe, threshold=0.5, direction='down')

# Align a 1D signal so event_frame lands at index win_before
aligned = mc.align_on_event(signal, event_frame, win_before, win_after)
t_ms = mc.time_axis(win_before, win_after, fps, unit='ms')   # x-axis

# Trajectory normalization for cross-subject overlay
hip_n, head_n = mc.normalize_trajectory(hip, head)   # translate to origin + rotate to +X

# Detrend a signal (separate intentional drift from oscillation, useful for balance analyses)
sway_residual, sway_trend = mc.detrend_signal(hip_x_during_hold, order=1)
```

### 3D rendering

```python
fig = plt.figure(); ax = fig.add_subplot(111, projection='3d')
mc.draw_skeleton_3d(ax, sk.pos[frame_idx],
                    highlight_chain=mc.RIGHT_ARM_CHAIN,
                    vertical=take.vertical_axis)
mc.equalize_3d_axes(ax, [sk.pos[frame_idx]], vertical=take.vertical_axis)
ax.view_init(elev=15, azim=-65)
```

### Body-wide speed table

```python
speeds = mc.all_bone_speeds(sk, take.dt)   # {bone: (T,) array}
```

---

## 5. Standard analysis pipeline

**Core principle — every gesture has an alignment event.** Every analysis
in this project is organized around a single biomechanical instant that
corresponds to the same moment across all takes and subjects, regardless
of when it happens within the take. This event is what makes cross-subject
overlay comparisons meaningful: detect it once per take, then align every
signal on it before comparing. Each gesture family in §6 names its own
alignment event explicitly:

| Family | Alignment event | How it's detected |
|---|---|---|
| Striking | Implement (or end-effector) impact | peak speed of the implement rigid body |
| Whole-body rotation | Peak inversion | minimum head Y |
| Cyclic locomotion | Foot strike | local minima of foot vertical position |
| Explosive launch | Take-off | last foot-ground contact |
| Static posture / balance | Onset of stable hold | dynamic threshold on the bone defining the hold (e.g. feet within 10 cm of their max) |
| Multi-segment kicking | Ball impact | peak foot speed |

Once you have the event frame, `mc.align_on_event(signal, event_frame,
win_before, win_after)` shifts any 1-D signal so the event lands at
`win_before` in the output, padded with NaN on either side. All
subjects' signals can then be plotted on the same `t = 0 at event` axis
with `mc.time_axis(win_before, win_after, fps)`. This is the single
operation that turns "four random curves" into "four comparable curves".

**Twin principle — every analysis has a region of interest (ROI).** Once
the alignment event (POI) is detected, every metric, plot, and statistic
in the analysis is computed over a finite window around it, not over the
whole take. This window is the **ROI**. It serves three roles: (i)
restricting peak detection to the biomechanically relevant phase so a
noise spike elsewhere in the take cannot win; (ii) defining the x-axis
range of aligned plots; (iii) bounding the per-take frame range for any
timing or duration metric. The POI tells you *where* to anchor the
analysis; the ROI tells you *how much* of the surrounding signal counts.

A useful ROI is shaped by the gesture: striking needs more time *before*
impact than after (the swing is visible there); cyclic locomotion uses
one cycle as the natural unit; balance uses the hold span itself. Each
family in §6 names its standard ROI alongside its POI:

| Family | Standard ROI | Why this shape |
|---|---|---|
| Striking / kicking | `[-500, +300]` ms around impact (asymmetric) | swing visible before, follow-through after |
| Cyclic locomotion | one full stride (same-side strike → next same-side strike) | the natural repeating unit |
| Explosive launch | `[-200, +500]` ms around take-off | set-up before, flight after |
| Whole-body rotation (in-place) | `[rotation onset, rotation end]` (dynamic) | matches the gesture's actual span |
| Whole-body rotation (travelling) | full gesture (entry → landing) | gesture is bounded by its own endpoints |
| Static posture / balance | `[hold onset, hold end]` (dynamic) | the hold itself *is* the analysis |

Some sub-windows live *inside* the ROI for specific metrics — e.g.
backswing duration in striking is computed inside `[-800, -100]` ms
before impact, X-factor loading magnitude inside `[-300, 0]` ms. These
are metric-specific and noted in each family's metrics table. The ROI
above is the default *plotting and overall analysis* window.

Five steps, applied in order to any take:

1. **Load and inventory.** `load_take`, then look at `take.skeletons`,
   `take.rigidbodies`. Identify subject(s) and any implement.
2. **Smooth positions** (and quaternions if used for derivatives) with
   `mc.smooth`.
3. **Detect the alignment event (POI) and set the ROI** around it. Both
   family-dependent — see §6. The default ROI per family covers most
   analyses; tighten to a sub-window only when a specific metric needs it.
4. **Derive the metrics** specified by the family for that gesture.
5. **Visualize.** Always include at least:
   - one time-series plot aligned on the event (for striking) or one cycle
     (for cyclic gestures);
   - one 3D skeleton view (poses at key phases, or trajectory of the
     dominant end-effector).

---

## 6. Movement family taxonomy

The taxonomy below routes common gestures to their analysis pattern. It
is **deliberately not exhaustive** — it covers the families seen most
often in this lab, not every sport that exists. **Match the gesture to a
family first when one fits.** If a capture spans multiple gestures (e.g.
sprint start = launch + cyclic locomotion), apply both patterns to the
relevant phases. **If no family fits, apply the deduction procedure in
§6bis** rather than forcing a square peg into a round hole.

### 6.1 Striking — racket, club, stick, bat, hand, foot

Examples: tennis (forehand/backhand/serve), badminton, ping-pong, golf,
ice-hockey slap/wrist shot, baseball, cricket, volleyball spike, boxing
punch, karate strike, frisbee throw.

**Key event.** Impact frame = global peak of striking-end-effector speed.
For implement sports the implement's tip (rigid body position) is more
accurate than the hand bone. If a rigid body is present, prefer it.

**Double-contact gestures.** Some striking gestures produce two distinct
peaks in the implement speed within a few tens of milliseconds — e.g.
hockey slap shot (stick contacts ice, then puck), golf drive (clubhead
contacts ground rough/divot, then ball), baseball swing if the bat
brushes the strike zone. The second peak is usually the larger one
because the elastic energy stored on first contact releases there.
Naively aligning on `argmax` will then snap to whichever peak happens
to be marginally taller in each take, mixing pre-contact and post-
contact frames across takes and bloating the X-factor / chain-timing
variance. Align instead on the **first peak that reaches at least 80%
of the global maximum** — this picks the first physical contact
consistently. For single-peak gestures the rule degenerates to the
global max (no change). The slap-shot reference analysis showed
within-subject X-factor std drop from 21° to 4° after the switch,
purely from better alignment.

**Standard ROI.** `[-500, +300]` ms around impact (asymmetric: the
backswing must be visible to read X-factor and chain timing, but the
follow-through tail beyond ~300 ms adds little). Sub-windows used by
specific metrics inside this ROI: `[-800, -100]` ms for backswing
duration (allowed to extend before the ROI start), `[-300, 0]` ms for
X-factor loading magnitude.

```python
# Hand-based fallback
sp_R = mc.speed(mc.smooth(sk.pos[:, sk.idx('RHand')][:, None]), take.dt).ravel()
impact = mc.find_event_peak(sp_R)

# Implement-based (preferred when present)
rb = next(iter(take.rigidbodies.values()))
sp_imp = mc.speed(mc.smooth(rb.pos[:, None]), take.dt).ravel()
impact = mc.find_event_peak(sp_imp)

# Double-contact gestures (slap shot, golf drive, baseball with brush…):
# align on the first peak ≥ 80% of the global maximum, not the global max.
# Falls back to global max for single-peak gestures, so safe by default.
impact = mc.find_event_first_peak(sp_imp, take.fps)
```

**Determine handedness** from which hand reaches a higher peak speed. For
two-handed strokes (tennis backhand 2H, hockey, golf, baseball), both
hands move in concert; pick the trailing/dominant hand or the implement.

**Two-handed strikes with lower-body initiation (slap shot, golf drive,
baseball swing, two-handed backhand)** have an inverted X-factor
signature compared to single-handed strikes. The pelvis *initiates* the
rotation (hip leads), the trunk *lags* by 30–90° during the loading
phase, then unwinds rapidly to catch up at impact. So `Chest yaw - Hip
yaw` is *negative* before impact and rises toward zero at impact —
opposite to a single-handed tennis forehand where the trunk leads the
pelvis. When reporting X-factor for these gestures, use the **absolute
loading magnitude** (max deviation from impact value, in either
direction) rather than a signed peak — this stays direction-agnostic and
comparable across striking sub-types.

**Mixed-cohort note.** When a single dataset contains players from
different stroke families (e.g. one tennis cohort with a mix of one- and
two-handed backhands), keep the *signed* X-factor at the loading peak
**separately** from its *absolute magnitude*: the sign tells you the
technique family (positive = trunk-led, negative = pelvis-led), the
magnitude tells you whether the player produces meaningful dissociation
at all. Reporting only a signed peak across the mixed cohort makes a
two-handed player look like a flat one (the signed peak averages toward
zero); reporting only the magnitude hides the family split. Default to
absolute magnitude in the metrics table and call out the sign in the
figure caption.

**Handedness mirror.** Yaw is signed around the vertical axis — positive
CCW, negative CW — so a left-handed player swinging the same stroke as
a right-handed player produces an X-factor signal of the *opposite
sign*, by pure mirror geometry, with no technique difference involved.
A left-handed one-handed backhand looks like a right-handed two-handed
one if you don't correct for it. Before overlaying X-factor curves
across a mixed-handedness cohort, **multiply the left-handed players'
signed X-factor by -1** so all curves rise into positive loading during
the swing. This is directly analogous to the §6.4 CW/CCW sign-flip rule
for pirouettes. Detect handedness from peak hand speed (whichever side
is higher), apply the flip per take, then read the curves on a common
axis. The absolute loading magnitude is unaffected by the flip and
remains the safest default for the metrics table — but the *plot*
needs the flip or the comparison is wrong. Failing to do this flip is
how you mistake a left-hander's one-handed backhand for a two-handed
one (real story; corrected with the flip the curves overlay cleanly).

**Canonical metrics.**

| Metric | How |
|---|---|
| Peak end-effector speed (m/s) | max of smoothed speed |
| Backswing/swing duration | time from local speed minimum (in [-800, -100] ms before impact) to impact |
| Trunk rotation (yaw) of Hip and Chest | `mc.yaw(sk.q('Hip')/sk.q('Chest'))` |
| **X-factor** (trunk-pelvis separation) | `yaw_chest - yaw_hip`; report range and value at impact |
| Proximal-to-distal sequencing | timing of peak speed for Hip → Chest → RShoulder → RFArm → RHand (chain depends on side & sport) |
| Reproducibility across takes | coefficient of variation on peak speed |

**Recommended plots.** Speed profile of striking end-effector aligned on
impact (overlay all takes). 3D skeleton at preparation / impact /
follow-through. 3D trajectory of the end-effector around impact. Kinematic
chain timing plot. Trunk rotation curves with X-factor envelope.

**Pitfalls.** A noisy hand position can produce a spurious early peak;
always smooth first. For very fast strikes (boxing, karate), reduce the
Savitzky-Golay window to ~11 frames so you don't blur the impact peak.
For golf and tennis serve, the impact is at maximal *implement* speed,
not maximal hand speed — they differ by the angular velocity of the
implement times its length. **Where the rigid body sits on the implement
matters**: on rackets it is typically calibrated at the centre of the
string bed (where the ball contacts), not at the tip of the frame. The
centre-of-string-bed speed is the right number for ball impact velocity;
a point at the frame tip would be faster by an additional `ω × r` term.
Ask the user if uncertain — never assume the marker is at the tip.

---

### 6.2 Cyclic locomotion — running, walking, skating, cross-country skiing

**Key events.** Foot strike and toe-off, repeating. Detect from vertical
position or vertical velocity of `LFoot` / `RFoot` / `LToe` / `RToe`.

**Standard ROI.** One full stride = same-side strike → next same-side
strike (typically 0.5–1.2 s for running, 1.0–1.5 s for walking). Per-cycle
metrics are computed within this window; cohort comparisons normalize
each cycle to 0–100% to overlay strides of different durations.

```python
# Foot strikes: local minima of vertical foot position
y_RFoot = mc.smooth(sk.p('RFoot'))[:, 1]   # Y is vertical
from scipy.signal import find_peaks
strike_idx, _ = find_peaks(-y_RFoot, distance=int(0.3*take.fps))
```

**Canonical metrics.**

| Metric | How |
|---|---|
| Cadence (steps/min) | from inter-strike intervals |
| Stride length (m) | horizontal displacement of Hip between same-foot strikes |
| Stance & flight time | time from strike to toe-off vs. toe-off to next strike |
| Vertical oscillation of Hip | range of `Hip.y` per cycle |
| Left-right asymmetry | compare metrics between sides |
| Trunk lean | pitch of Chest |

**Recommended plots.** Foot-Y vs time with strikes marked. Hip-Y oscillation.
Stick-figure overlay at strike / mid-stance / toe-off / mid-flight.
Per-cycle metric bar charts comparing L vs R.

**Pitfalls.** The hip is not the center of mass; its vertical oscillation
underestimates true CoM motion. Treadmill vs. overground captures behave
differently (treadmill: subject stationary in X, lab frame moves). Detect
from velocity rather than position to be robust to drift.

---

### 6.3 Explosive launch — sprint start, vertical/broad jump, take-off

Examples: sprint start from blocks, basketball jump shot, volleyball
block, long/high jump take-off, plyometric push-off.

**Key events.** Onset of motion, take-off (last foot contact), peak
vertical velocity of CoM, peak height.

**Standard ROI.** `[-200, +500]` ms around take-off. The set-up
(squat, arm swing) lives in the 200 ms before, the flight phase and peak
height in the 500 ms after. Onset-of-motion is reported as a sub-metric
inside this window (time from rest to first speed > threshold).

```python
# Take-off: last frame before BOTH feet leave the ground (Y > threshold)
foot_y = np.minimum(mc.smooth(sk.p('LFoot'))[:, 1],
                    mc.smooth(sk.p('RFoot'))[:, 1])
takeoff = mc.find_threshold_crossing(foot_y, threshold=0.05, direction='up')
```

**Canonical metrics.**

| Metric | How |
|---|---|
| Time to first movement | from rest to first speed > threshold |
| Peak Hip vertical velocity | max of `velocity(Hip)[:, 1]` |
| Take-off velocity (vector) | velocity of Hip at takeoff frame |
| Take-off angle | `atan2(v_horizontal, v_vertical)` |
| Knee flexion at lowest squat | min of `joint_angle(thigh, knee, shin)` |
| Arm swing contribution | timing of arm peak speed vs takeoff |

**Recommended plots.** Hip-Y and Hip-Y velocity over time with takeoff
marked. Knee angle profile. Stick figure at deepest squat / takeoff /
peak height.

**Pitfalls.** "Take-off" by foot position is sensitive to threshold; cross-
check with vertical Hip velocity going positive. The "jump height" from
mocap is the displacement of Hip (or, better, of the centroid of the
torso bones), not necessarily the standard "Sargent jump" measure.

---

### 6.4 Whole-body rotation — cartwheel, round-off, pirouette, salto, twist

Examples: gymnastics cartwheel (roue), round-off (rondade), back/front
salto, dance pirouette, figure-skating spin, judo throw rotation.

**Key challenge.** Yaw extracted from the Hip quaternion will wrap and
become discontinuous when the body inverts (cartwheel) or spins fast
(pirouette). `mc.yaw_pitch_roll` already unwraps, but the Tait-Bryan
decomposition can hit gimbal lock when pitch approaches ±90°. For these
gestures:

- For **pure spin around vertical** (pirouette, spin): use yaw of Hip
  with `vertical='Y'`. Unwrapping handles multi-turn rotations.
- For **inversions** (cartwheel, salto): use `mc.angular_velocity_from_quat`
  to get the body's instantaneous rotation rate (rad/s) without
  decomposition issues. Integrate the magnitude to get total rotation.
- Track the **head-to-feet vector** (`Head.pos - Hip.pos`) to detect when
  the body is inverted (vector dot product with vertical changes sign).

**Specific patterns for vertical-axis in-place rotation (pirouette/spin):**

- **Alignment event** = rotation onset, detected as the first frame where
  the cumulative Hip yaw change from the take's start exceeds a small
  threshold (e.g. 30°). The gesture is symmetric in time around this event,
  so aligning all takes here makes the ramp-up / sustained / ramp-down
  phases directly comparable.
- **End of rotation** = first frame after the angular-velocity peak where
  the smoothed `|ω|` drops below a low threshold (e.g. 60°/s). This marks
  the moment the dancer comes to rest.
- **Standard ROI** = `[rotation onset, rotation end]` (dynamic per take).
  For travelling rotations (cartwheel, salto) the ROI is the full gesture
  bounded by the entry and landing events instead.
- **Sign-flip CW takes for visualization.** Subjects pivot off whichever
  foot is dominant for them, so half the cohort spins CCW and half CW.
  When overlaying yaw curves to compare *shapes*, multiply the CW takes'
  yaw by −1 so all curves rise in the same direction. Report the
  direction separately in the metrics table — it's per-subject, not a
  technique difference.
- **Axis-stability metric**: maximum distance the Hip travels from its
  position at rotation onset, in the horizontal plane, during the spin.
  Smaller is better — an ideal pirouette has the Hip sitting on a fixed
  vertical axis. Travel beyond ~30 cm typically means the dancer is
  hopping or 'walking' the rotation rather than spinning in place.

**Canonical metrics.**

| Metric | How |
|---|---|
| Total rotation (deg) | integral of \|angular velocity\| around relevant axis |
| Number of turns | total rotation / 360 |
| Peak angular velocity (deg/s) | max of \|ang_vel\| |
| Inversion duration | time the head-feet vector points downward |
| Hands-on-ground duration (cartwheel) | time when `LHand.y` or `RHand.y` < threshold |
| Center-of-mass trajectory | trajectory of Hip in 3D |
| Symmetry | compare durations of mirror phases |

**Recommended plots.** Differs slightly between in-place rotations and
travelling rotations.

For **in-place rotations** (pirouette, spin, judo throw rotation):
3D trajectory of Hip and Head over the full gesture. Stick figures at
5-7 key phases evenly spaced through the rotation. Angular velocity
magnitude over time. The body stays roughly in one spot, so 3D phase
grids work well — the depth dimension carries information.

A note on stroboscopic / multi-pose figures for in-place rotations.
They're useful as orientation when the reader hasn't seen the gesture
in mocap before, but they often **don't add diagnostic content** beyond
the timeseries figures (omega profile, tilt-over-time, foot-pattern,
top-down trajectory). For a pirouette every pose is at the same
location — the comic-strip layout used for travelling rotations
(cartwheel, salto) becomes lanes-of-rotated-skeletons, which mostly
shows "the body rotates" rather than what differs between subjects.
If the analysis already covers angular velocity, body tilt, foot
pattern, and Hip trajectory, the strobe is decorative; skip it. Add
it only when (a) the reader needs visual orientation about the
gesture, or (b) a phase-specific posture (e.g. peak-rotation arm
position, retiré at apex) is the actual finding to highlight.

For **travelling rotations** (cartwheel, round-off, salto, vault):
prefer a **2D comic-strip view in the moving sagittal plane** over 3D
static-pose grids. One panel per subject; sample 6 frames evenly across
the ROI; project each pose into (along_travel × vertical) and lay them
out left-to-right in fixed-width lanes (each pose centred on its lane
by subtracting the Hip's along-travel coordinate). Use a light-to-dark
colour gradient to mark time; draw the body axis (Hip→Head) thicker.
This reads like the textbook gesture-strip image gymnastics coaches
already use, and shows the *form* of the motion (apex pose, leg split
at inversion, body extension) directly. A 4-row × 5-column 3D phase
grid does not — it shows three or five static instants whose lean and
leg-split signals are already quantified by the time-series and metric
plots elsewhere in the report. Travel distance and gesture duration
go in a small annotation per panel rather than as plot dimensions.
The pure-3D trajectory plot of Hip alone (no skeleton) is still useful
as a complement, but the multi-pose 3D grid is mostly redundant with
the timeseries figures and harder to read.

Add: angular velocity magnitude over time (after smoothing — see below)
and an inversion-state timeline.

**Pitfalls.** The Motive skeleton can lose tracking briefly during fast
rotations or when markers occlude — check for NaN gaps. Pirouettes done
in place have small Hip translation and small yaw of Hip *segment*
because the segment itself rotates with the body — that's exactly what
you want, just be sure to unwrap.

**Angular velocity needs smoothing for rotation gestures.** The raw
`angular_velocity_from_quat` output frequently shows isolated 1–2 frame
spikes during the fastest rotation (when markers are partially occluded
during inversion). These are tracking artifacts, not real motion, but
they wreck any naive `nanmax`. Standard practice: smooth the *magnitude*
of angular velocity with a short Savitzky-Golay window (≈ 30 ms = 11
frames at 360 Hz, polynomial order 3) before extracting peaks. For
summary metrics across multiple takes, prefer `np.median` over `np.mean`
to be robust against any residual spikes.

**Trajectory comparison across subjects requires normalization.** When
overlaying gestures from multiple subjects, their captures start at
different positions and orientations in the lab frame, so raw
trajectories don't overlay meaningfully. Use `mc.normalize_trajectory(hip,
head)` to translate each pair to the origin and rotate so they all travel
in +X — the resulting plots actually compare *gesture shapes* rather than
spatial layouts. A side view (XY) then shows the iconic vertical loop, a
top view (XZ) shows lateral wobble.

---

### 6.5 Static posture & balance

Examples: handstand, single-leg stand, gymnastics holds, yoga.

**Alignment events.** Onset of stable hold and end of hold. For a true
static balance test (single-leg stand on the spot) the simplest detection
is "moving variance of CoM-proxy drops below a threshold". For inverted
holds with a dynamic entry (handstand, with kick-up), use the
**end-effector that defines the held position** — feet for a handstand —
and detect the hold span as the period when that bone is **within a small
distance of its absolute maximum** for that take. A *dynamic* threshold
adapted to the take (e.g. `feet_y > max(feet_y) - 0.10`) is more reliable
than an absolute threshold (`feet_y > 1.5`), because the latter
incorrectly includes the rapid kick-up/come-down phases where the body
has crossed the threshold but not yet stabilized.

**Standard ROI** = the hold span itself, i.e. `[hold onset, hold end]`.
Unlike striking or launch families, the ROI here is not a fixed window
around a single instant but a dynamic interval whose length is the
metric (hold duration). Every other balance metric — sway range, sway
path, drift, vertical alignment — is computed strictly inside this
interval, never outside.

**Canonical metrics.**

| Metric | How |
|---|---|
| Hold duration | time between onset and end of stability |
| CoM-proxy sway range (detrended) | range of Hip in horizontal plane after removing linear drift |
| CoM-proxy sway path length (detrended) | sum of horizontal Hip displacement per frame, drift removed |
| CoM-proxy sway velocity | sway path divided by hold duration |
| Drift (intentional translation) | length of the linear-trend vector — how far the Hip moved from start to end of hold |
| Vertical alignment | angle between Head→Hip (or Head→ankle) vector and vertical |

**Recommended plots.** Phase timeline (key bones' Y over time, with hold
span shaded). Top-down (X-Z) trace of Hip during the hold, **detrended**.
Vertical-alignment angle vs time. Stick figure at start / mid / end of hold.

**Hold-onset alignment in figures.** When showing one bone's Y trace
across all takes (e.g. feet height for a handstand), **align each take
on its own hold onset (t=0 = hold start)** rather than on the recording
start. Without alignment, holds appear at wherever they happen to fall
in the take and durations aren't visually comparable. Aligned, the
right-hand end of each take's hold span shows the duration directly,
the entry ramps converge near t=0, and the comparison across takes and
across subjects becomes immediate.

**Mid-50% summary, not whole-hold mean.** When summarizing a
within-hold metric (tilt, sway range, body alignment angle) into one
number per take, average the **middle 50% of the hold** (frames between
25% and 75% of the hold span), not the full hold. The entry and exit
phases mechanically include transition frames where the body is still
rotating into or out of the held position; including these inflates
the metric and unfairly penalizes longer holds (which have more time
in those transitions even if their stabilized portion is identical).
Real example from the handstand reference analysis: Loic's mean tilt
was 6.8° over the full hold but 4.1° on the middle 50% — the difference
is whether the metric reflects "how vertical was the held pose" (the
question we want answered) versus "how vertical was the gesture
overall including transitions" (less useful). The ranking across
subjects rarely changes, but the absolute values become comparable to
what a coach evaluates visually. Show the middle-50% region as a
shaded band on the time-series plot so the reader can see exactly
where the metric is computed.

**Shoulder lift for inverted holds.** For handstands and other holds
where the shoulders bear weight against an immobile end (the floor for
a handstand, parallel bars for a planche), measure shoulder elevation
as a key technique metric: `(Chest.y − mean(LShoulder.y, RShoulder.y))
/ arm_length`, where `arm_length` is the sum of Shoulder→UArm,
UArm→FArm, FArm→Hand at the hold midpoint. This captures whether the
subject is actively pushing the trunk away from the shoulders ("pressed"
posture) or letting it sit on them ("collapsed" posture). The
normalization by arm length makes the metric comparable across
subjects of different stature. Real values from the handstand
reference: ~22% (Loic), ~27% (Seppey), ~7% (Lucas) — Lucas's chest is
essentially sitting on his shoulders, the others are actively pressed.
Also report L/R shoulder asymmetry as |LShoulder.y − RShoulder.y|
averaged over the hold; for clean handstands it should be a few mm,
larger values indicate one shoulder bearing disproportionate load.

**Pitfalls.**
- **Always detrend** the horizontal CoM-proxy signal before measuring
  sway range and path. Use `mc.detrend_signal(x, order=1)` to separate
  the linear drift (intentional translation, e.g. an expert hand-walking
  on a handstand) from the residual oscillation (postural sway proper).
  Without detrending, an active expert who deliberately walks 30 cm to
  maintain balance scores worse on "sway" than a beginner who falls
  after 1 second — backwards.
- Marker dropouts mid-hold inflate sway estimates artificially.
- Don't apply a generic "duration outlier" filter to balance tasks. For
  striking and rotation gestures, an outlier duration suggests a
  different gesture; for balance, **longer holds are precisely the best
  performances** (often labelled `_Best` or `_best` in filenames). Drop
  this filter for §6.5 and rely on the per-take validity check only.

---

### 6.6 Multi-segment kicking & shooting

Examples: soccer kick / pass / shot, taekwondo kick, capoeira, hockey
stick handling, basketball shot release.

This is essentially §6.1 (striking) applied to the foot or to a
two-handed implement, but with extra emphasis on the lower-body
kinematic chain.

**Key event.** Ball impact = peak speed of the kicking foot (`RFoot` or
`LFoot`) or stick blade. For shots without a visible ball (shadow
practice), use peak segmental speed.

**Standard ROI.** Same as §6.1: `[-500, +300]` ms around impact. For
sports with a long approach run-up (soccer kick, javelin), report the
run-up speed as a sub-metric inside `[-800, -200]` ms before impact —
that sub-window may extend outside the plotting ROI.

**Additional metrics on top of §6.1.**

| Metric | How |
|---|---|
| Hip flexion at impact | `joint_angle(Chest, Hip, RThigh)` |
| Knee extension velocity | `np.diff(joint_angle(Thigh, Shin foot))/dt` |
| Plant-foot stability | sway of opposite foot during contact |
| Approach run-up speed | Hip horizontal speed in [-800, -200] ms before impact |

**Recommended plots.** Same as §6.1 but with leg chain instead of arm
chain. Add the plant-foot trajectory.

**Two-handed-grip considerations.** Sports where both hands grip the
same implement (hockey stick, golf club, two-handed-backhand racket,
cricket bat, baseball bat) need special handling on two points:

- **Detecting handedness from the grip, not from peak hand speed.** With
  two hands on the same implement both hands move at comparable speeds,
  so picking "the dominant hand = the faster hand" gives unstable
  results that can flip take-to-take inside the same subject. Use the
  hand position on the implement instead: at the impact frame, the
  **bottom hand on the stick** (lower Y in a Y-up coordinate system)
  is the grip-side hand. That defines shooting/swinging handedness:
  bottom hand right = right-shooter / right-handed swing, bottom hand
  left = left. This signal is stable take-to-take because it reflects
  the grip itself, not the noisy speed peak.

- **Hand-signal QA at impact.** Optical mocap can briefly snap a hand
  marker to the implement rigid body at impact, producing a hand-speed
  peak that is non-physiological (>18 m/s) and/or peaks 50–150 ms after
  the implement impact. Flag these takes — keep them for implement-
  based metrics (stick speed, X-factor, etc.) but **mask the hand
  signal in any plot that overlays hand vs. implement**, and don't
  pick them as the representative take for the kinematic-chain figure.
  Practical thresholds: peak hand speed > 18 m/s OR hand peak time
  > 100 ms after impact. Without this masking, a single track-glitch
  take can mislead the reader into thinking the subject's wrist is
  moving faster than the implement, which is biomechanically backward.

---

## 6bis. Deduction procedure for unlisted gestures

When a take is dropped that doesn't obviously match any family in §6 —
or when the user explicitly says "I don't know what this fits, just
analyze it" — do not force the gesture into the closest-looking family.
Instead, derive the analysis from the data itself, then borrow patterns
from §6 piece by piece.

**Step 1 — Probe the data.** Load one take and compute body-wide speeds:

```python
take = mc.load_take(path); sk = take.skeleton(); fps, dt = take.fps, take.dt
speeds = mc.all_bone_speeds(sk, dt)
peaks  = {b: float(np.nanmax(s))      for b, s in speeds.items()}
t_peak = {b: int(np.nanargmax(s))     for b, s in speeds.items()}
print(sorted(peaks.items(), key=lambda kv: -kv[1])[:8])
```

**Step 2 — Read the four signals that classify any gesture.**

| Signal | Quick test | Tells you |
|---|---|---|
| **Where the energy goes** | which bone has the highest peak speed | end-effector candidate (hand → striking/throwing; foot → kicking/locomotion; head/hip → rotation/jump) |
| **Periodicity** | autocorrelation of foot-Y, or count of `find_peaks` over the whole take | cyclic vs. one-shot |
| **Vertical excursion** | range of `Hip.y` | jump/launch (large) vs. ground gesture (small) |
| **Trunk yaw amplitude** | range of `mc.yaw(sk.q('Hip'))` over the take | rotation-dominant gesture (large) vs. translation-dominant (small) |

**Step 3 — Decide the event model.** Three cases cover almost everything:

- **Single peak event.** Use `find_event_peak` on the dominant bone's
  speed. → striking, throwing, kicking, jumping.
- **Repeated events.** Use `scipy.signal.find_peaks` with a `distance`
  guard ≈ 0.3 × fps. → locomotion, repeated punches, dribbles.
- **State change / hold.** Use `find_threshold_crossing` on a stillness
  signal (e.g. moving variance of speed). → balance, posture transitions.

**Step 4 — Pick metrics from §6 by analogy, not by label.** A frisbee
throw isn't in §6 by name but is biomechanically a striking-family
gesture: dominant hand peak, X-factor, proximal-to-distal sequencing
all apply. A cartwheel-into-handstand is §6.4 followed by §6.5. A judo
uchi-mata is rotation (§6.4) of the thrower combined with launch (§6.3)
of the partner.

**Step 5 — Add gesture-specific metrics only if they're informative.**
Don't invent metrics for the sake of it. The bar is: *would a coach or
biomechanist look at this number and learn something?* If yes, include
it; if no, drop it. Examples of legitimate gesture-specific additions:

- For a goalkeeper dive: peak horizontal Hip velocity and dive distance.
- For a basketball free throw: stillness of the lower body during arm motion.
- For a fencing lunge: ratio of front-foot to rear-foot horizontal travel.

**Step 6 — Be explicit about uncertainty.** When a gesture isn't in §6,
state in the deliverable that the analysis used a custom recipe derived
from the data, briefly justify the chosen event and metrics, and flag
anything you're unsure about. Don't pretend to canonical authority you
don't have.

**Worked example — handball jump shot** (not in §6):

1. Probe → highest peak speed at `RHand` (~12 m/s), Hip vertical excursion
   ~50 cm, single dominant peak. → Striking + Launch hybrid.
2. Apply §6.3 to the take-off phase: Hip vertical velocity, takeoff frame.
3. Apply §6.1 from takeoff to ball release (= peak `RHand` speed):
   X-factor, kinematic chain, peak hand speed.
4. Add one gesture-specific metric: vertical position of Hip *at moment
   of release* — a signature of how high the player jumps before
   throwing.
5. Deliver three plots: take-off detection, hand speed aligned on
   release, X-factor with release marked. Note in the prose that this is
   a hybrid §6.1+§6.3 analysis derived from the data.

This procedure is the default for any gesture I haven't seen before. The
taxonomy is a head-start, not a cage.

---

## 7. Workflow when receiving new takes

When the user drops new files (typically a folder of JSON takes):

1. **Inventory.** `ls` the folder. Note number of subjects, takes per
   subject, durations.
2. **Identify the gesture family.** Use the folder name and a quick look
   at one take's `metadata.objects` (skeletons, rigid bodies present).
   If unclear, ask the user. **If the gesture isn't in §6, switch to
   §6bis** — derive the analysis from the data rather than forcing a
   bad fit.
3. **Run a probe.** Load one take, smooth, compute speed of all bones,
   look at which bone has the highest peak — this often reveals what
   the gesture is and which side dominates.
4. **Apply the family pattern from §6.** Detect events, compute metrics,
   generate plots.
5. **Validate takes and exclude outliers.** Real datasets contain noisy
   takes — students sometimes stop the recording mid-gesture, do a
   different movement, warm up before the actual trial, or export the
   same recording multiple times. Always:
   - **File-level cleanup** first: skip files with `ROM` in the name
     (range-of-motion calibration, not actual gestures), files missing
     the rigid body needed for the analysis (e.g. no stick for a slap
     shot), and duplicate exports of the same recording (detect by
     hashing the first + last frame of position data — duplicates have
     identical signatures).
   - **Validity check** per take: verify the take matches the canonical
     signature for the family (e.g. for striking — clear single peak in
     end-effector speed; for cartwheel — both hands touch ground, head
     drops below ~0.7 m, both feet land within plausible duration; for
     locomotion — at least 2 full cycles detected). Reject takes that
     fail with a structural reason ("no hand touchdown", "shallow
     inversion", "duration outside [0.5, 3.0] s").
   - **Data-quality probe** per take: count NaN frames on every bone
     the analysis depends on — the bone used to detect the POI (e.g.
     implement rigid body for striking, foot for kicking) plus any
     bone feeding a downstream metric (Hip and Chest for X-factor;
     dominant Hand for hand-vs-implement contrast; foot bones for
     locomotion timing) — restricted to inside the ROI. Report two
     numbers: % NaN coverage and longest consecutive NaN run. A clean
     take has 0%; >1% coverage or any consecutive run >5 frames at
     360 Hz is suspect. Mocap markers occasionally drop out for tens
     of frames during fast occlusion (impact, inversion, hands close
     together) and an undetected hole silently corrupts every
     downstream metric: peak speed dips into the gap, joint angles
     snap to NaN, the smoother extrapolates across the void. The
     probe takes ~10 lines and catches the problem at the boundary;
     without it, the issue surfaces later as a "weird outlier" that
     looks like a gesture variation but isn't. Stash the per-take
     results and report them collectively in the report's caveat
     ("worst NaN coverage on a key bone was 0.4% — well below the
     1% threshold, no take flagged"). When the probe finds a real
     dropout, treat it like a validity-check failure: reject the
     take with a structural reason in the caveat.
   - **Statistical outlier check** per subject. Purpose: catch
     gesture-misclassification ("Camilla did a different gesture on take
     3"), not legitimate within-subject variation. Among the validated
     takes, flag any whose key metric (typically duration or peak speed)
     deviates by more than ~40% from that subject's **median**. Median,
     not mean — the rule must resist the very outlier it's trying to
     identify. Apply only when **n ≥ 5 takes** per subject; with 3–4
     the median is itself too volatile to anchor a 40% threshold, fall
     back to the per-take validity check alone. **Never trim
     symmetrically** (drop best + worst to "clean up" the distribution):
     for ceiling-bounded metrics §11 explicitly wants the best take
     reported, and trimming collapses the within-subject CV — which is
     itself often the headline finding (consistency vs. inconsistency
     can be the most informative thing in the whole report; see the
     tennis backhand reference for a case where the CV gap *is* the
     conclusion). **This rule is family-specific** — it makes sense for
     striking and rotation gestures where extreme variation suggests a
     different gesture, but **does not apply to balance tasks** (§6.5)
     where the longest holds are precisely the best performances and
     high variability is meaningful, not noise. Skip outlier filtering
     for §6.5; rely on the per-take validity check only.

     **Noise-floor escape.** The 40% rule is purely *relative*: a take
     deviating 40% from a 16 m/s median is a 6.4 m/s gap (almost
     certainly real), but a take deviating 40% from a 0.7 cm median is
     a 2.8 mm gap — well inside the mocap system's positional noise.
     Don't flag a take when the *absolute* deviation falls below the
     sensor's noise floor, even if the relative deviation exceeds 40%.
     Suggested noise-floor scales for common metric types:
     - positional RMS / drift in cm: ~5 mm
     - body-segment angles (yaw, pitch, lean): ~3°
     - durations: ~30 ms (one frame at 30 Hz, three frames at 360 Hz)
     - peak speeds (m/s): ~0.2 m/s
     Stated as one rule: flag take *T* on metric *m* iff
     `|m_T − median(m)| > max(0.4 × median(m), noise_floor(m))`.
     Otherwise the rule produces noise itself when the metric's typical
     magnitude is small (real example: in the cartwheel reference
     analysis, three of the cleanest subject's path-RMS takes tripped
     the rule because her median was 0.7 cm — every dot was sub-mocap-
     noise, so no take was actually anomalous). When in doubt, render
     flagged takes as *hollow* dots in the consistency dotplot rather
     than dropping them silently — the reader can judge whether the
     flag is real spread or noise-floor artifact.
   - **Always list excluded takes in the report's caveat box** with
     their reason — never silently drop data.
6. **Compare across takes / subjects.** Reproducibility (CV on peak
   metric), inter-subject differences in technique signatures.
7. **Deliver as a self-contained HTML report.** A small set of high-
   information figures (4-6 typically) embedded in an HTML file with
   short captions explaining how to read each plot and what to notice.
   **Save figures to a temporary directory** (e.g. `tempfile.mkdtemp()`
   or `/tmp`); they get embedded as base64 inside the HTML, so there is
   no need to ship them alongside. **Only the HTML goes to**
   `/mnt/user-data/outputs/<topic>_report.html`. Use `report.py` to
   handle CSS, structure, embedding, and download buttons — see §11.

When the user asks for a quick check rather than a full analysis,
deliver one focused figure inline and a 3-line summary instead — no HTML.

---

## 8. Visualization conventions

- Subject-color convention when comparing two athletes: subject A in
  blues, subject B in reds. Use sequential colormaps (`Blues`, `Reds`)
  for the multiple takes of one subject so trial number reads naturally.
- Always mark events with vertical dashed lines and label units (ms or s).
- Always include the equal-aspect 3D axes for skeleton plots; default
  view `elev=15, azim=-65` works for most lateral-facing captures.
- Highlight the dominant kinematic chain in red on skeleton stick
  figures (`highlight_chain=mc.RIGHT_ARM_CHAIN` etc.).
- Keep figure DPI at 130 — readable in chat without being huge.

---

## 9. Pitfalls

- **Don't confuse Hip with center of mass.** Hip is a segment, not the
  CoM. For a CoM proxy, average several torso bones or apply Dempster
  segment weights if precision matters.
- **Watch for marker dropouts.** Long NaN runs in a key bone make
  velocities explode at the boundary. Smoothing helps but doesn't fix
  large gaps; for those, interpolate first or restrict the analysis
  window.
- **Quaternion sign flips** between adjacent frames are valid (q and -q
  represent the same rotation) but can break naive Euler decomposition.
  `mc.yaw_pitch_roll` and `mc.angular_velocity_from_quat` handle this
  via scipy's `Rotation` class.
- **The unlabeled-marker `Center` is not the ball.** It's the centroid
  of all unlabeled markers, which may include reflections and noise.
  Useful as a coarse hint, not as a measurement.
- **Don't apply X-factor analysis to non-rotational gestures** (running,
  jumping straight up). It's only meaningful when there is a deliberate
  trunk-vs-pelvis dissociation, i.e. striking and throwing.
- **Smoothing window must match the gesture's timescale.** Default 21
  frames at 360 Hz is good for most full-body gestures. Reduce to 11 for
  punches/kicks; raise to 31 for slow holds.
- **Frame rate is not always 360 Hz.** Always read it from
  `metadata.frameRate`, never hard-code.
- **The vertical axis is not always Y.** Read `take.vertical_axis` and
  pass it to `mc.yaw`, `mc.draw_skeleton_3d`, `mc.equalize_3d_axes`.
- **Restrict peak detection to a window around the alignment event when
  the signal has baseline noise.** Hand markers in particular often have
  ~1–2 m/s of baseline noise even at rest (intermittent occlusion,
  marker swap), so a global `nanargmax` on the whole take can pick up a
  noise spike instead of the real biomechanical peak. Use
  `mc.find_event_peak(signal, search_range=(impact - 0.3*fps, impact +
  0.1*fps))` to anchor the search to the relevant biomechanical window
  defined by the already-detected alignment event.

---

## 10. Reference: minimal striking-sport analysis from scratch

```python
import numpy as np, matplotlib.pyplot as plt
import mocap as mc

take = mc.load_take('path/to/take.json')
sk = take.skeleton()
fps, dt = take.fps, take.dt

# 1. Smooth & compute body-wide speeds
speeds = mc.all_bone_speeds(sk, dt)

# 2. Determine handedness & impact frame
peak_R = np.nanmax(speeds['RHand']); peak_L = np.nanmax(speeds['LHand'])
dom = 'RHand' if peak_R >= peak_L else 'LHand'
impact = mc.find_event_peak(speeds[dom])

# 3. Trunk rotation (X-factor)
yaw_hip   = mc.yaw(sk.q('Hip'),   vertical=take.vertical_axis)
yaw_chest = mc.yaw(sk.q('Chest'), vertical=take.vertical_axis)
xfactor   = yaw_chest - yaw_hip

# 4. Aligned hand speed plot
wb, wa = int(0.5*fps), int(0.3*fps)
t_ms = mc.time_axis(wb, wa, fps)
sp_aligned = mc.align_on_event(speeds[dom], impact, wb, wa)
plt.plot(t_ms, sp_aligned); plt.axvline(0, ls='--'); plt.show()

# 5. Skeleton at impact with dominant chain highlighted
fig = plt.figure(); ax = fig.add_subplot(111, projection='3d')
chain = mc.RIGHT_ARM_CHAIN if dom == 'RHand' else mc.LEFT_ARM_CHAIN
mc.draw_skeleton_3d(ax, mc.smooth(sk.pos)[impact],
                    highlight_chain=chain, vertical=take.vertical_axis)
mc.equalize_3d_axes(ax, [sk.pos[impact]], vertical=take.vertical_axis)
```

That's the skeleton of every striking-sport script. The other families
follow the same shape: load → smooth → detect family-specific event →
compute family-specific metrics → visualize.

---

## 11. HTML report — standard deliverable format

The default deliverable for any full analysis is a **single self-contained
HTML file** with embedded base64 PNG figures and per-figure download
buttons. Use the `report.py` template — it provides a one-call API and
keeps CSS, JS, structure, and styling consistent across all reports.

### File-system convention

- **Figures**: save to a temporary directory (e.g.
  `tempfile.mkdtemp(prefix='mocap_')`). They get embedded into the HTML
  as base64; no need to ship them separately.
- **Report HTML**: write to `/mnt/user-data/outputs/<topic>_report.html`.
  This is the only file the user receives.

The `outputs/` directory should normally contain only the HTML report
(plus, if the user is iterating, the persistent project files
`mocap.py`, `report.py`, `MOCAP_ANALYSIS_GUIDE.md`).

### Using `report.py`

```python
from report import Report

r = Report(
    title="Tennis backhand — Adrien vs Julie",
    subjects=[("Adrien", "a"), ("Julie", "b")],   # color keys: a=blue, b=red, c=green, d=amber
    conditions="5 takes per player &nbsp;·&nbsp; Motive @ 360 Hz "
               "&nbsp;·&nbsp; Racket rigid body (centre of string bed)",
)

r.lede = "At the racket face, <strong>Adrien strikes at 16.1 m/s</strong>..."

# A figure section (PNG embedded as base64, with a download button)
r.add_section(
    heading="1. Why the racket face, not the hand",
    fig_path="/tmp/A_racket_vs_hand.png",
    caption="Solid = racket; dashed = hand. The racket reaches max <b>after</b>...",
    method="Savitzky-Golay window 21, central-difference velocity.",   # optional
)
# ... more figure sections

# A metrics section (rendered as native HTML cards — no PNG, no truncation)
r.add_metrics(
    heading="5. Summary metrics",
    columns=["Racket peak (m/s)", "Hand peak (m/s)", "Racket / Hand",
             "X-factor before impact", "Reproducibility (CV)"],
    rows=[
        ("Adrien", "a", ["16.14 ± 0.98", "5.91 ± 0.40", "2.73×", "28.7° ± 2.4", "6.1%"]),
        ("Julie",  "b", ["9.63 ± 0.72",  "3.36 ± 0.28", "2.87×", "4.9° ± 3.4",  "7.5%"]),
    ],
    caption="Five takes per player, mean ± std...",
)

r.caveat = "n = 1 player on each side, so technical signatures..."
r.synthesis = "All four diagnostics point in the same direction: ..."
r.footer = "Pipeline: <code>mocap.py</code> + <code>report.py</code>."

r.write("/mnt/user-data/outputs/tennis_backhand_report.html")
```

That's it. The template handles:

- HTML head, doctype, charset, page title
- All CSS (single source of truth for visual style — rounded cards with
  subtle shadows, hover effects, tabular-numbers alignment, responsive
  layout that stacks metric rows on narrow screens)
- Header with title and colour-coded subject keys
- Lede paragraph block
- Figure cards: image, **two icon buttons** (copy image to clipboard,
  download PNG with chosen filename), caption, optional method note in
  a grey sub-box. The copy button gives a brief green-checkmark feedback
  on success.
- **Metrics tables: rendered as semantic HTML `<table>`** with rounded
  outer container, muted uppercase header (wraps on narrow screens to
  avoid horizontal scroll), tabular-figures alignment, hover row
  highlight, and the subject's coloured dot prefixing each player's
  name. **Two icon buttons** below the table: copy (puts the data on
  the clipboard as TSV + HTML — pastes cleanly into Excel/Sheets) and
  download (exports a UTF-8 CSV with BOM, opens correctly in Excel
  including ° and ± characters). Real `<table>` markup means proper
  accessibility too.
- Caveat box (amber-bordered)
- Footer
- The JS download helper at the end of `<body>`

### When to use `add_section` vs `add_metrics` vs `add_observations`

- **`add_section`** for any visualisation that is fundamentally graphical:
  speed curves, skeleton poses, trajectories, kinematic chain plots,
  X-factor envelopes, etc. → matplotlib PNG embedded.
- **`add_metrics`** for any *summary table* of numerical values: peak
  speeds, durations, angles, reproducibility CVs, etc. → rendered as a
  semantic HTML `<table>` (proper `<thead>`/`<tbody>`, color-coded row
  labels, tabular numbers). Avoid generating these as matplotlib
  `ax.table()` PNGs — the result is cramped, hard to align, prone to
  font truncation, and can't be copy-pasted into a spreadsheet.
- **`add_observations`** for a clean bulleted card of factual extremes
  derived from the metrics table — typically generated automatically
  from `extract_observations(rows, columns, column_directions)`.
  Useful for readers who don't yet have the domain intuition for which
  direction is good on each metric. Always factual ("Loic has the
  highest hold duration"), never prescriptive ("Loic should keep
  training holds").

### Heatmap colouring on metrics tables

Pass `column_directions` (a list parallel to `columns`) to `add_metrics`
to enable heatmap tinting of cells:

- `'higher'` — bigger value = better (green); smaller = worse (red).
  Use for: peak speeds, hold durations, X-factor amplitude, number of
  rotations, lateral travel for a striking gesture, etc.
- `'lower'` — smaller value = better (green); bigger = worse (red).
  Use for: reproducibility CV, sway range/speed during balance, body
  tilt from vertical, hip travel during pirouette, etc.
- `'neutral'` or `None` — leave the cell uncoloured. Use when the metric
  has no clear "good direction" (e.g. lead-hand for a cartwheel, rotation
  direction for a pirouette, intentional drift during an expert
  handstand).

The tint is a soft semi-transparent overlay (max alpha 0.20 green,
0.18 red) — visible at a glance, not garish. Indicate the convention
in the table caption with two inline chips so non-domain readers see
the colour code immediately:

```python
caption=(
    "Cells are tinted: "
    "<span style='background:rgba(34,197,94,0.20);padding:1px 5px;"
    "border-radius:3px'>green</span> = stronger on that metric, "
    "<span style='background:rgba(239,68,68,0.18);padding:1px 5px;"
    "border-radius:3px'>red</span> = weaker..."
)
```

### Auto-generating observations

```python
from report import extract_observations

COLUMNS    = ["Stick peak (m/s)", "L / R hand peak", "Stick / Hand",
              "X-factor before impact", "Backswing (ms)", "Reproducibility"]
DIRECTIONS = ["higher",            "neutral",        "higher",
              "higher",            "neutral",       "lower"]

r.add_metrics(
    heading="6. Summary metrics",
    columns=COLUMNS,
    column_directions=DIRECTIONS,
    rows=compute_metrics_rows(),
    caption="...",
)
r.add_observations(
    extract_observations(compute_metrics_rows(), COLUMNS, DIRECTIONS),
    heading="7. Key observations",
)
```

`extract_observations` yields one bullet per scoreable column,
identifying who's at each extreme (e.g. "*Stick peak (m/s):* Remo
(expert) highest (27.4 ± 0.8) — Julien lowest (20.7 ± 2.2)"). It uses
the same `column_directions` so the framing matches the heatmap
convention. Skip the call entirely when no column has a meaningful
direction (cartwheels, where most metrics are descriptive rather than
performance-oriented).

### Anatomy of a good report

1. **Title and subjects** in the header — colour-coded keys make the
   rest of the report scan-able.
2. **Lede paragraph** — one sentence with the headline number, one
   sentence on what makes the comparison interesting beyond the number.
3. **One section per visual element**, mixing two kinds:
   - **Figure sections** (`add_section`) for plots and 3D views: a
     heading framing what the figure is *about* not what it *shows*
     (good: "Why the racket face, not the hand"; bad: "Speed plot");
     the image full width; a caption (3-5 sentences) saying (a) what
     to look at, (b) what to notice, (c) — only when relevant — a tiny
     method note via the `method=` parameter.
   - **Metrics sections** (`add_metrics`) for summary tables: card per
     subject, columns of numerical values, optional caption below.
4. **Synthesis** — a closing paragraph that connects observations
   *across* sections. Different in spirit from the lede: the lede
   announces the headline number, the synthesis pulls together what the
   pattern across all sections means together. 3-5 sentences. Set via
   `r.synthesis = "..."`. Always include this — readers who skim the
   figures use it as the bottom-line takeaway.
5. **Caveat box** — sample size, what the analysis cannot tell you,
   sources of error. Always present.
6. **Footer** — pipeline, key metadata (rigid bodies used, vertical
   axis, units).

### Tone for captions

Concise. The figures carry the information; the text guides the eye and
prevents misreading. **Avoid**: redundant restatement of the figure,
generic biomechanics lectures, repeating numbers already in the table.
**Include**: what the reader might miss, what differs between
subjects/takes, what a coach would care about.

### Show both median and best for ceiling-bounded performance metrics

When a metric represents *peak performance* the subject is trying to
maximise — number of pirouette turns, hold duration on a handstand, peak
strike speed — show **both the median (typical performance) and the best
take's value (peak performance)** in the summary table. The median alone
hides the upper bound of what the subject can do; the best alone hides
how reliably they reach it. Together they tell the full story: a subject
with median 1.0 and best 1.1 turns is consistent but capped; a subject
with median 1.0 and best 2.0 has higher potential but variability. For
metrics without an obvious performance ceiling (kinematic chain timing,
trunk rotation amplitude), median ± std is enough.

### Multi-take overlay patterns

When a figure shows the same time-series across many takes per subject,
two specific traps appear that are worth handling explicitly:

- **Median frame-by-frame erases peaks.** Naively computing a per-frame
  median across N takes lines up the takes' peaks at slightly different
  frame indices (because timing is never identical even after event
  alignment), and the median curve smooths the peaks toward the
  surrounding valleys. The result looks tame even when each individual
  take has sharp peaks. Two robust alternatives:
  - **Best-take-highlighted overlay** — draw the subject's best take in
    bold subject-colour, the others as thin grey lines for spread.
    Reads like a single curve with context, peaks survive intact, the
    eye is correctly drawn to the highest-performance trace.
  - **Per-take small multiples** — one mini-plot per take in a strip.
    More space-hungry but the only option when the question is
    "do all takes look the same shape" (which median+band can't answer).

- **Cascade timing chart > overlaid chain curves for kinematic chains.**
  When showing proximal-to-distal sequencing across multiple takes and
  several segments (Hip, Shoulder, Hand, Stick), overlaying the speed
  curves of one representative take per subject hides the within-
  subject variability and depends sensitively on the choice of
  representative. A more diagnostic alternative: for each segment,
  plot the *peak time* (relative to the alignment event) as a dot per
  take, with median tick + ±std band, on a shared time axis. The shape
  of the median-connecting line then encodes the cascade type at a
  glance: descending diagonal = textbook proximal-to-distal cascade;
  near-vertical = compressed/arm-driven; segments peaking *after* the
  event = the segment was still accelerating through impact (typical
  of wrist-driven shots). The within-segment spread also surfaces
  cases where a "peak" reflects tracking noise rather than a real
  kinematic event (e.g. a near-static hip whose peak time wanders by
  ±300 ms across takes). The slap-shot reference report uses both
  patterns side-by-side: chain-speed curves of one rep take (§2) for
  the qualitative shape, cascade timing chart (§3) for the
  quantitative summary.

- **Stabilized "median + band + individuals" timeseries.** When every
  take of a subject covers the same kind of phase-bounded interval
  (full hold for a balance task, full rotation for a pirouette, full
  swing for a striking gesture) and you want to show how a within-
  interval signal evolves over time, the cleanest layout is:
  resample each take to a common 0–100% progress axis, then plot
  (i) every individual take as a thin transparent line in the
  subject's colour, (ii) the median across takes as a thick line in
  full subject colour on top, (iii) ±1 std as a filled band, (iv)
  optionally a horizontal reference line at a meaningful threshold
  (e.g. 5° "clean axis", impact reference 0 ms), (v) optionally a
  shaded region marking the sub-interval used for the summary metric
  (e.g. middle 50% for a balance/rotation task per §6.5). This
  pattern reads at four levels simultaneously: median = typical
  performance, band = within-subject variability, individuals =
  whether the variability is one outlier or genuine spread, reference
  line + shaded zone = where the metric is computed and what counts
  as "good". Reused in the handstand reference (Fig 4 tilt) and the
  pirouette reference (Figs A omega, B tilt). Keep it for cases that
  match the description above; <em>don't</em> generalize it to every
  multi-take figure — phase-portrait views (top-down trajectory
  overlays, kinematic-chain cascade dots, comic-strip strobes) carry
  different information that this layout would flatten.

### Rendering inverted or unusual orientations

`mc.draw_skeleton_3d` maps the world's vertical axis to the plot's
vertical axis. For most gestures this is what you want — a standing
subject looks standing in the figure. For **inverted gestures**
(handstand, salto apex, cartwheel inversion phase) this produces the
counter-intuitive result that the figure looks upright while the
subject was head-down. Three workable approaches, in order of
preference:

1. **Don't use a 3D skeleton if the question doesn't need it.** For
   "how vertical is the inverted body axis" the answer is a tilt
   number, not a posture image — a top-down sphere view (each take as
   a dot in a polar disc, centre = perfectly vertical) often shows
   more diagnostically. For "how does the body look during the hold"
   a *front* view in 2D drawn manually (with `ax.plot` calls into a
   2D axes, in matplotlib's natural Y-up orientation) reads more
   cleanly than a 3D inverted view that requires the reader to mentally
   flip everything.
2. **Negating the world-Y of the position array** before passing to
   `draw_skeleton_3d` works in principle (renders head at the bottom)
   but pollutes the axis labels and `equalize_3d_axes` bounds. Tested
   on the handstand reference and the result was visually fine but
   the axes read as upside-down. Acceptable when noted in the caption.
3. **Building the figure manually in 2D** (loop over the canonical
   skeleton chains, call `ax.plot([xa, xb], [ya, yb])` per bone) gives
   full control. Use this when the figure carries narrative weight
   (e.g. the shoulder-portance front view in the handstand reference)
   — the extra code pays off in clarity. Re-use `mc.SKELETON_CHAINS`
   to iterate through bones; bridge missing bones the same way
   `mc.edges_for_bones` does.

### Figure file naming

Save figures with single-letter or short-word prefixes matching their
order in the report (e.g. `A_racket_vs_hand.png`, `B_skeleton_impact.png`,
…). The download button uses the file's basename by default, so this
naming flows through to what the user gets when they click "Download PNG".

### Reference example

`tennis_backhand_report.html` in the project is a known-good example
generated end-to-end with `report.py`. The companion script
`tennis_with_template.py` shows the full pattern for a comparative
2-subject striking analysis and is a good starting point to copy.

### When NOT to produce HTML

- Quick check / single-question requests → answer inline with one figure.
- Iterative work where the user is fine-tuning a single plot → present
  the plot, not a report.
- The user explicitly asks for a different format (PDF, slides, raw figures).

---

## 12. Continuous improvement of the project

This guide and the two Python modules are **living documents**. They
exist precisely because the previous Claude session distilled lessons
from previous analyses into them — and the next session is expected to
do the same. After completing any non-trivial analysis, take a moment
before delivering to ask: *what did I just learn that the project files
don't already know?*

### What counts as a worthwhile improvement

**Update `mocap.py`** when you encounter:
- A genuine bug (a function gives wrong results in some edge case).
- A primitive missing that you had to write inline and that future
  sessions will need too (e.g. `detrend_signal` was added after the
  handstand analysis revealed every postural analysis needs it).
- A function whose error mode is unhelpful (e.g. silent failure on
  subset skeletons → switched to an explicit error message).

**Update `MOCAP_ANALYSIS_GUIDE.md`** when you encounter:
- A new movement family or sub-family worth a §6.x entry, or a
  clarification to an existing one (e.g. the slap-shot X-factor reversal
  vs tennis added a sub-section to §6.1).
- A pitfall that wasn't documented and cost you time to debug (e.g.
  hand-marker baseline noise polluting global peak detection).
- A new pattern worth promoting to canonical workflow (e.g. dynamic
  threshold for stabilised-phase detection in §6.5).
- An anti-pattern observed in your own work (e.g. applying the
  duration-outlier filter to balance tasks where longer holds are
  precisely the best performances).

**Skip the update** when:
- The lesson is specific to one dataset's quirks rather than generalisable.
- The "improvement" would just add detail to an already-clear section.
- You're not confident the lesson holds across other gestures.

### How to deliver an updated project

When you have updates to `mocap.py` or `MOCAP_ANALYSIS_GUIDE.md` (or
`report.py`) at the end of an analysis:

1. Make the edits to the files in `/mnt/user-data/outputs/`.
2. **Smoke-test** by re-running existing analysis scripts to verify
   nothing has regressed.
3. List the changes in your final summary so the user knows what's
   new — what file, what section, what behaviour change.
4. Use `present_files` to surface the updated files alongside the
   new analysis report.

The user re-uploads the updated files into the project's knowledge base,
and the next session inherits the improvement automatically.

### Tone of additions

Match the existing voice: terse, opinionated, no academic hedging.
Examples that are right in tone: "Always detrend before measuring sway,"
"Don't apply the duration-outlier filter to balance tasks," "Skeleton
names are not reliable subject identifiers." Examples that are wrong in
tone: "It might be useful to consider detrending in some cases,"
"Subjects should perhaps be identified by filename when possible." The
guide is meant to *direct* future Claude, not to discuss possibilities
with it.

### What the user sees vs what gets persisted

Per-analysis observations (e.g. "Loic uses an active hand-walking
strategy") belong in the **synthesis** of that report — they describe
that specific dataset and stay there. Generalisable patterns (e.g.
"experts often use active rather than passive balance strategies, so
'longer hold + smaller sway' isn't always the right ranking criterion")
belong in the **guide** — they describe the analysis approach and
compound across sessions. Get the boundary right: a synthesis full of
methodology = a missed opportunity to update the guide; a guide full of
specific subject names = noise that ages badly.
