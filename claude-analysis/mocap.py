"""
mocap.py — Universal primitives for Motive JSON mocap analysis.

Single-file toolkit for biomechanics analysis of any sport captured with the
Motive system and exported as JSON (via the project's `_ai-bundle` companion
exporter). Designed to compose with custom per-sport analysis scripts rather
than to be a one-size-fits-all framework.

Provides:
  - JSON loading with N-skeleton, N-rigidbody, marker support
  - Savitzky-Golay smoothing (NaN-safe)
  - Linear velocity / speed / acceleration
  - Angular velocity from quaternion time series
  - Yaw/pitch/roll extraction (auto vertical-axis detection)
  - Inter-segment angle (joint angle) computation
  - Robust event detection (peak, threshold crossing)
  - Time-series alignment around a chosen event
  - 3D skeleton rendering for matplotlib
  - Equal-aspect 3D axes
  - Trajectory normalization (translate + rotate to align travel direction)
  - Signal detrending (separate intentional drift from oscillation)

Conventions:
  - Position arrays are shaped (T, N_bones, 3); quaternions (T, N_bones, 4)
    in (x, y, z, w) order matching the Motive JSON.
  - Angles in degrees unless stated otherwise.
  - Vertical axis is auto-detected per take from `metadata.coordinateSpace`
    and the Y-up vs Z-up convention; defaults to 'Y' (Motive default).
"""
from __future__ import annotations
from pathlib import Path
from dataclasses import dataclass, field
import json
import numpy as np
from scipy.signal import savgol_filter
from scipy.spatial.transform import Rotation as R


__all__ = [
    # Data containers
    'Skeleton', 'RigidBody', 'Take',
    # Constants
    'SKELETON_BONES', 'SKELETON_EDGES', 'SKELETON_CHAINS', 'edges_for_bones',
    'RIGHT_ARM_CHAIN', 'LEFT_ARM_CHAIN',
    'RIGHT_LEG_CHAIN', 'LEFT_LEG_CHAIN',
    # Loading
    'load_take',
    # Smoothing
    'smooth',
    # Kinematics
    'velocity', 'speed', 'acceleration',
    'angular_velocity_from_quat',
    'yaw', 'yaw_pitch_roll',
    'inter_bone_angle', 'joint_angle',
    # Event detection & alignment
    'find_event_peak', 'find_event_first_peak', 'find_threshold_crossing',
    'align_on_event', 'time_axis',
    # 3D rendering
    'draw_skeleton_3d', 'equalize_3d_axes',
    # Convenience
    'all_bone_speeds',
    # Trajectory + signal helpers
    'normalize_trajectory', 'detrend_signal',
]


# ---------------------------------------------------------------------------
# Standard Motive 25-bone skeleton (matches the export in this project)
# ---------------------------------------------------------------------------
SKELETON_BONES = [
    'Hip', 'Ab', 'Spine2', 'Spine3', 'Spine4', 'Chest',
    'Neck', 'Neck2', 'Head',
    'LShoulder', 'LUArm', 'LFArm', 'LHand',
    'RShoulder', 'RUArm', 'RFArm', 'RHand',
    'LThigh', 'LShin', 'LFoot', 'LToe',
    'RThigh', 'RShin', 'RFoot', 'RToe',
]

# Stick-figure structure as a list of canonical chains (proximal → distal).
# This drives both edge construction and works on reduced rigs (skeletons
# missing intermediate bones like Spine2-4 or Neck2): edges_for_bones()
# walks each chain and links only the bones actually present, bridging
# across missing ones automatically.
SKELETON_CHAINS = [
    ['Hip', 'Ab', 'Spine2', 'Spine3', 'Spine4', 'Chest', 'Neck', 'Neck2', 'Head'],
    ['Chest', 'LShoulder', 'LUArm', 'LFArm', 'LHand'],
    ['Chest', 'RShoulder', 'RUArm', 'RFArm', 'RHand'],
    ['Hip', 'LThigh', 'LShin', 'LFoot', 'LToe'],
    ['Hip', 'RThigh', 'RShin', 'RFoot', 'RToe'],
]


def edges_for_bones(bones):
    """Build a stick-figure edge list for the given bone set.

    Walks each canonical chain (spine, L/R arm, L/R leg) and links only
    the bones present in `bones`, bridging across missing intermediates.
    For the full 25-bone rig this yields the same edges as the old flat
    SKELETON_EDGES list. For reduced rigs (e.g. cartwheel data with
    Hip-Ab-Chest-Neck-Head only) it yields a connected stick figure
    rather than disjoint fragments — which the old flat list silently
    produced when iterating edges referring to absent bones.
    """
    edges = []
    bones_set = set(bones)
    for chain in SKELETON_CHAINS:
        present = [b for b in chain if b in bones_set]
        edges.extend(zip(present[:-1], present[1:]))
    return edges


# Default edges for the canonical 25-bone rig (kept as a public constant
# for backwards compatibility; identical to edges_for_bones(SKELETON_BONES)).
SKELETON_EDGES = edges_for_bones(SKELETON_BONES)

# Convenience chains for proximal-to-distal kinematic-chain analysis.
RIGHT_ARM_CHAIN = ['Hip', 'Chest', 'RShoulder', 'RUArm', 'RFArm', 'RHand']
LEFT_ARM_CHAIN  = ['Hip', 'Chest', 'LShoulder', 'LUArm', 'LFArm', 'LHand']
RIGHT_LEG_CHAIN = ['Hip', 'RThigh', 'RShin', 'RFoot', 'RToe']
LEFT_LEG_CHAIN  = ['Hip', 'LThigh', 'LShin', 'LFoot', 'LToe']


# ---------------------------------------------------------------------------
# Data containers
# ---------------------------------------------------------------------------
@dataclass
class Skeleton:
    """One skeleton's time series."""
    name: str
    bones: list                       # ordered bone names actually present
    pos: np.ndarray                   # (T, N, 3) NaN where missing
    quat: np.ndarray                  # (T, N, 4) (x, y, z, w), NaN where missing

    def idx(self, bone: str) -> int:
        return self.bones.index(bone)

    def p(self, bone: str) -> np.ndarray:
        """Position time series for one bone, shape (T, 3)."""
        return self.pos[:, self.idx(bone)]

    def q(self, bone: str) -> np.ndarray:
        """Quaternion time series for one bone, shape (T, 4)."""
        return self.quat[:, self.idx(bone)]


@dataclass
class RigidBody:
    """One rigid body (racket, stick, club, etc.)."""
    name: str
    pos: np.ndarray                   # (T, 3)
    quat: np.ndarray                  # (T, 4)


@dataclass
class Take:
    """A single capture take — all skeletons, rigid bodies, markers."""
    name: str
    fps: float
    dt: float
    n_frames: int
    times: np.ndarray                 # (T,)
    vertical_axis: str                # 'Y' or 'Z'
    metadata: dict
    skeletons: dict = field(default_factory=dict)        # name -> Skeleton
    rigidbodies: dict = field(default_factory=dict)      # name -> RigidBody
    markers: dict = field(default_factory=dict)          # name -> (T, 3)

    def skeleton(self, name: str | None = None) -> Skeleton:
        """Return a skeleton by name, or the only one if there is just one."""
        if name is not None:
            return self.skeletons[name]
        if len(self.skeletons) == 1:
            return next(iter(self.skeletons.values()))
        raise ValueError(f"Multiple skeletons: {list(self.skeletons)}; specify one.")


# ---------------------------------------------------------------------------
# Loading
# ---------------------------------------------------------------------------
def load_take(path: str | Path) -> Take:
    """Load a Motive JSON take produced by the project's exporter."""
    path = Path(path)
    with open(path) as f:
        d = json.load(f)
    meta = d['metadata']
    fps = float(meta['frameRate'])
    frames = d['frames']
    T = len(frames)
    times = np.array([fr['time'] for fr in frames], dtype=float)

    # Vertical axis: Motive default is Y-up. If coordinateSpace says otherwise
    # the JSON should still expose 3 floats per pos; we trust pos order.
    vertical = 'Y' if meta.get('coordinateSpace', 'Global') == 'Global' else 'Y'

    take = Take(
        name=meta.get('takeName', path.stem),
        fps=fps, dt=1.0/fps, n_frames=T, times=times,
        vertical_axis=vertical, metadata=meta,
    )

    # Allocate containers from metadata.objects
    obj_meta = meta['objects']
    for obj_name, obj in obj_meta.items():
        kind = obj['type']
        nodes = obj['nodes']
        if kind == 'skeleton':
            take.skeletons[obj_name] = Skeleton(
                name=obj_name, bones=list(nodes),
                pos=np.full((T, len(nodes), 3), np.nan),
                quat=np.full((T, len(nodes), 4), np.nan),
            )
        elif kind == 'rigidbody':
            take.rigidbodies[obj_name] = RigidBody(
                name=obj_name,
                pos=np.full((T, 3), np.nan),
                quat=np.full((T, 4), np.nan),
            )
        elif kind == 'marker':
            for nd in nodes:
                take.markers[f"{obj_name}:{nd}"] = np.full((T, 3), np.nan)
            # Also expose the 'Center' centroid if present in frames
            take.markers[f"{obj_name}:Center"] = np.full((T, 3), np.nan)

    # Fill from frames
    for i, fr in enumerate(frames):
        for obj_name, obj_data in fr['objects'].items():
            if obj_name in take.skeletons:
                sk = take.skeletons[obj_name]
                for j, b in enumerate(sk.bones):
                    nd = obj_data.get(b)
                    if nd is None: continue
                    if 'pos' in nd: sk.pos[i, j] = nd['pos']
                    if 'quat' in nd: sk.quat[i, j] = nd['quat']
            elif obj_name in take.rigidbodies:
                rb = take.rigidbodies[obj_name]
                # Rigid bodies may be stored under a single node key
                node = next(iter(obj_data.values())) if obj_data else None
                if node is not None:
                    if 'pos' in node: rb.pos[i] = node['pos']
                    if 'quat' in node: rb.quat[i] = node['quat']
            else:
                # Marker collection
                for nd_name, nd in obj_data.items():
                    key = f"{obj_name}:{nd_name}"
                    if key in take.markers and 'pos' in nd:
                        take.markers[key][i] = nd['pos']
    return take


# ---------------------------------------------------------------------------
# Smoothing
# ---------------------------------------------------------------------------
def smooth(arr: np.ndarray, win: int = 21, poly: int = 3) -> np.ndarray:
    """Savitzky-Golay smoothing along axis 0 (time). NaN-safe per channel.
    Works on arrays of any shape; smooths each tail dimension independently."""
    arr = np.asarray(arr, dtype=float)
    out = arr.copy()
    if arr.shape[0] < win:
        return out
    flat = out.reshape(out.shape[0], -1)
    for c in range(flat.shape[1]):
        col = flat[:, c]
        m = ~np.isnan(col)
        if m.sum() > win:
            flat[m, c] = savgol_filter(col[m], win, poly)
    return flat.reshape(out.shape)


# ---------------------------------------------------------------------------
# Kinematics
# ---------------------------------------------------------------------------
def velocity(pos: np.ndarray, dt: float) -> np.ndarray:
    """Central-difference linear velocity. Same shape as pos."""
    return np.gradient(np.asarray(pos, dtype=float), dt, axis=0)


def speed(pos: np.ndarray, dt: float) -> np.ndarray:
    """Magnitude of velocity along the last (3D) axis."""
    return np.linalg.norm(velocity(pos, dt), axis=-1)


def acceleration(pos: np.ndarray, dt: float) -> np.ndarray:
    """Second derivative of position."""
    return np.gradient(velocity(pos, dt), dt, axis=0)


def angular_velocity_from_quat(quat: np.ndarray, dt: float) -> np.ndarray:
    """Angular velocity vector (rad/s) from a quaternion time series.
    quat: (T, 4) in (x, y, z, w). Returns (T, 3)."""
    quat = np.asarray(quat, dtype=float)
    T = quat.shape[0]
    w = np.full((T, 3), np.nan)
    valid = ~np.isnan(quat).any(axis=1)
    if valid.sum() < 2:
        return w
    # Compute on contiguous valid runs only (simple approach: interp NaNs out)
    rot = R.from_quat(quat[valid])
    # Relative rotation between consecutive frames
    rel = rot[:-1].inv() * rot[1:]
    rotvec = rel.as_rotvec() / dt          # rad / s in body frame
    # Place back in full timeline at frame midpoints (assigned to first index)
    valid_idx = np.where(valid)[0]
    for k in range(len(rotvec)):
        w[valid_idx[k]] = rotvec[k]
    return w


def yaw_pitch_roll(quat: np.ndarray, vertical: str = 'Y',
                   degrees: bool = True, unwrap: bool = True) -> np.ndarray:
    """Extract yaw/pitch/roll Tait-Bryan angles.
    Yaw is rotation around the vertical axis.
    Returns (T, 3) array: (yaw, pitch, roll)."""
    quat = np.asarray(quat, dtype=float)
    seq = {'Y': 'YXZ', 'Z': 'ZXY'}[vertical]
    T = quat.shape[0]
    out = np.full((T, 3), np.nan)
    valid = ~np.isnan(quat).any(axis=1)
    if valid.any():
        eul = R.from_quat(quat[valid]).as_euler(seq, degrees=degrees)
        out[valid] = eul
        if unwrap:
            for k in range(3):
                col = out[:, k]
                m = ~np.isnan(col)
                if m.any():
                    if degrees:
                        out[m, k] = np.degrees(np.unwrap(np.radians(col[m])))
                    else:
                        out[m, k] = np.unwrap(col[m])
    return out


def yaw(quat: np.ndarray, vertical: str = 'Y', degrees: bool = True) -> np.ndarray:
    """Convenience: just the yaw component (rotation around vertical)."""
    return yaw_pitch_roll(quat, vertical=vertical, degrees=degrees)[:, 0]


def inter_bone_angle(quat_a: np.ndarray, quat_b: np.ndarray,
                     degrees: bool = True) -> np.ndarray:
    """Angle (rotation magnitude) between two segment orientations over time.
    Useful as a generic joint angle proxy. Returns (T,)."""
    qa = np.asarray(quat_a, dtype=float)
    qb = np.asarray(quat_b, dtype=float)
    T = qa.shape[0]
    out = np.full(T, np.nan)
    valid = ~(np.isnan(qa).any(axis=1) | np.isnan(qb).any(axis=1))
    if valid.any():
        ra = R.from_quat(qa[valid])
        rb = R.from_quat(qb[valid])
        rel = ra.inv() * rb
        ang = rel.magnitude()             # radians
        out[valid] = np.degrees(ang) if degrees else ang
    return out


def joint_angle(p_proximal: np.ndarray, p_joint: np.ndarray,
                p_distal: np.ndarray, degrees: bool = True) -> np.ndarray:
    """Position-based joint angle from three points (e.g. shoulder/elbow/wrist).
    Returns angle at p_joint between vectors (joint→proximal) and (joint→distal)."""
    v1 = p_proximal - p_joint
    v2 = p_distal   - p_joint
    n1 = np.linalg.norm(v1, axis=-1)
    n2 = np.linalg.norm(v2, axis=-1)
    cos = np.einsum('...i,...i->...', v1, v2) / (n1 * n2 + 1e-12)
    cos = np.clip(cos, -1.0, 1.0)
    ang = np.arccos(cos)
    return np.degrees(ang) if degrees else ang


# ---------------------------------------------------------------------------
# Event detection & alignment
# ---------------------------------------------------------------------------
def find_event_peak(signal: np.ndarray, search_range: tuple | None = None) -> int:
    """Index of the global maximum of `signal`, optionally within (i_lo, i_hi)."""
    sig = np.asarray(signal, dtype=float)
    if search_range is not None:
        i_lo, i_hi = search_range
        sub = sig[i_lo:i_hi]
        return int(i_lo + np.nanargmax(sub))
    return int(np.nanargmax(sig))


def find_event_first_peak(signal: np.ndarray, fps: float,
                          fraction: float = 0.80,
                          min_distance_s: float = 0.04,
                          prominence: float = 0.5) -> int:
    """Index of the FIRST peak (in time) reaching at least `fraction × global maximum`.

    For double-contact striking gestures (hockey slap shot — stick contacts
    ice, then puck; golf drive — clubhead contacts ground, then ball;
    baseball bat brushing the strike zone), this picks the first physical
    contact rather than whichever local peak happens to be marginally
    taller. Aligning on this gives substantially more consistent within-
    subject overlays for X-factor and chain timing — see guide §6.1.

    For single-peak gestures the rule degenerates to the global max
    (= same as find_event_peak), so this is a safe default for any
    striking signal.
    """
    from scipy.signal import find_peaks
    sig = np.asarray(signal, dtype=float)
    global_pk = int(np.nanargmax(sig))
    threshold = fraction * float(sig[global_pk])
    pks, _ = find_peaks(sig, distance=max(1, int(min_distance_s * fps)),
                        prominence=prominence)
    pks = sorted(set(list(pks) + [global_pk]))
    sig_pks = [int(p) for p in pks if sig[p] >= threshold]
    return sig_pks[0] if sig_pks else global_pk


def find_threshold_crossing(signal: np.ndarray, threshold: float,
                            direction: str = 'up',
                            start: int = 0) -> int | None:
    """First index >= start where signal crosses threshold in given direction.
    direction: 'up' (rising) or 'down' (falling). Returns None if never."""
    sig = np.asarray(signal, dtype=float)
    if direction == 'up':
        for i in range(start, len(sig)-1):
            if sig[i] < threshold <= sig[i+1]:
                return i + 1
    else:
        for i in range(start, len(sig)-1):
            if sig[i] > threshold >= sig[i+1]:
                return i + 1
    return None


def align_on_event(signal: np.ndarray, event_frame: int,
                   win_before: int, win_after: int) -> np.ndarray:
    """Pad/clip a 1D signal so that index `event_frame` lands at index `win_before`
    in the output of length (win_before + win_after).

    This is the central primitive for cross-subject comparison: detect each
    subject's alignment event (e.g. impact frame for striking, peak inversion
    for cartwheel) with `find_event_peak`, then pass each signal through
    `align_on_event` so all subjects' curves can be plotted on the same
    `t=0 at event` axis."""
    sig = np.asarray(signal, dtype=float)
    n = win_before + win_after
    out = np.full(n, np.nan)
    src_lo = max(0, event_frame - win_before)
    src_hi = min(len(sig), event_frame + win_after)
    dst_lo = win_before - (event_frame - src_lo)
    dst_hi = dst_lo + (src_hi - src_lo)
    out[dst_lo:dst_hi] = sig[src_lo:src_hi]
    return out


def time_axis(win_before: int, win_after: int, fps: float, unit: str = 'ms') -> np.ndarray:
    """Time axis in `unit` ('ms' or 's') for an aligned window."""
    t = (np.arange(-win_before, win_after) / fps)
    return t * 1000 if unit == 'ms' else t


# ---------------------------------------------------------------------------
# 3D rendering helpers
# ---------------------------------------------------------------------------
def draw_skeleton_3d(ax, pos_frame: np.ndarray, bones: list = None,
                     edges: list = None, vertical: str = 'Y',
                     highlight_chain: list | None = None,
                     base_color: str = '#444', highlight_color: str = '#d62728',
                     joint_size: int = 14, lw: float = 1.6,
                     highlight_lw: float = 3.0):
    """Render a stick figure on a matplotlib 3D axis.
    `pos_frame`: (N_bones, 3) at one instant.
    `bones`: ordered list of bone names matching the rows of `pos_frame`. If
        None (default), uses SKELETON_BONES — but only if its length matches
        `pos_frame.shape[0]`. For subset skeletons (e.g. 21-bone captures
        without Spine2/3/4 and Neck2), pass `bones=sk.bones` explicitly.
    `edges`: list of (bone_a, bone_b) tuples to draw. If None (default),
        edges are derived from SKELETON_CHAINS by linking only the bones
        present in `bones` — i.e. reduced rigs are handled automatically
        without disconnected spine fragments.
    `vertical`: 'Y' or 'Z' — the axis displayed as up.
    `highlight_chain`: list of bone names to draw in highlight_color (e.g. RIGHT_ARM_CHAIN).

    Plot mapping (always shows vertical axis up in the plot's z):
      vertical='Y':  plot_x = X, plot_y = Z, plot_z = Y
      vertical='Z':  plot_x = X, plot_y = Y, plot_z = Z
    """
    pos = np.asarray(pos_frame)
    if bones is None:
        if pos.shape[0] == len(SKELETON_BONES):
            bones = SKELETON_BONES
        else:
            raise ValueError(
                f"pos_frame has {pos.shape[0]} bones but the standard "
                f"skeleton has {len(SKELETON_BONES)}. Pass bones=sk.bones "
                f"explicitly when the skeleton differs from the default.")
    if pos.shape[0] != len(bones):
        raise ValueError(
            f"pos_frame has {pos.shape[0]} rows but bones list has "
            f"{len(bones)} entries — they must match.")
    if edges is None:
        edges = edges_for_bones(bones)

    def remap(v):
        return (v[0], v[2], v[1]) if vertical == 'Y' else (v[0], v[1], v[2])

    hi = set(zip(highlight_chain[:-1], highlight_chain[1:])) if highlight_chain else set()
    for a, b in edges:
        if a not in bones or b not in bones: continue
        ia, ib = bones.index(a), bones.index(b)
        if np.isnan(pos[ia]).any() or np.isnan(pos[ib]).any(): continue
        is_hi = (a, b) in hi or (b, a) in hi
        col = highlight_color if is_hi else base_color
        w = highlight_lw if is_hi else lw
        xa, ya, za = remap(pos[ia]); xb, yb, zb = remap(pos[ib])
        ax.plot([xa, xb], [ya, yb], [za, zb],
                color=col, lw=w, solid_capstyle='round')
    # Joints
    valid = ~np.isnan(pos).any(axis=1)
    if valid.any():
        pts = np.array([remap(p) for p in pos[valid]])
        ax.scatter(pts[:, 0], pts[:, 1], pts[:, 2],
                   c='#222', s=joint_size, depthshade=False, zorder=5)
    ax.set_xlabel('X (m)', fontsize=8)
    ax.set_ylabel(('Z' if vertical == 'Y' else 'Y') + ' (m)', fontsize=8)
    ax.set_zlabel(('Y' if vertical == 'Y' else 'Z') + ' (m)', fontsize=8)
    ax.tick_params(labelsize=7)


def equalize_3d_axes(ax, points_list, pad: float = 0.1, vertical: str = 'Y'):
    """Set equal aspect ratio on a matplotlib 3D axis given a list of (N, 3) arrays.
    Uses the same axis remapping as draw_skeleton_3d."""
    arr = np.vstack([np.asarray(p).reshape(-1, 3) for p in points_list])
    arr = arr[~np.isnan(arr).any(axis=1)]
    if vertical == 'Y':
        arr = arr[:, [0, 2, 1]]
    mn, mx = arr.min(axis=0), arr.max(axis=0)
    ctr = (mn + mx) / 2
    rng = (mx - mn).max() * (1 + pad) / 2
    ax.set_xlim(ctr[0]-rng, ctr[0]+rng)
    ax.set_ylim(ctr[1]-rng, ctr[1]+rng)
    ax.set_zlim(ctr[2]-rng, ctr[2]+rng)


# ---------------------------------------------------------------------------
# Quick utility: bone speed table (for ranking events across the whole body)
# ---------------------------------------------------------------------------
def all_bone_speeds(skeleton: Skeleton, dt: float, smooth_win: int = 21) -> dict:
    """Return {bone_name: (T,) speed array} after smoothing."""
    pos_s = smooth(skeleton.pos, win=smooth_win)
    sp = speed(pos_s, dt)
    return {b: sp[:, i] for i, b in enumerate(skeleton.bones)}


def normalize_trajectory(primary: np.ndarray, *secondary: np.ndarray,
                         vertical: str = 'Y'):
    """Translate to start at origin and rotate so the primary trajectory's
    horizontal motion is aligned with +X. Same transform applied to every
    `secondary` trajectory so they stay consistent with `primary`.

    Useful when overlaying gestures from multiple subjects whose captures
    started at different positions and orientations in the lab frame.

    primary, *secondary : (N, 3) arrays of positions, all of the same length.
    vertical            : 'Y' (default) or 'Z' — the axis kept untouched.

    Returns: tuple of normalized arrays in the same order as inputs.

    Example:
        hip_n, head_n = mc.normalize_trajectory(hip, head)
        # Now both start at (0, y_start, 0) and the cartwheel travels in +X.
    """
    primary = np.asarray(primary, dtype=float)
    if vertical == 'Y':
        h_axes = (0, 2)             # horizontal axes are X, Z
    else:
        h_axes = (0, 1)             # horizontal axes are X, Y
    p0 = primary[0].copy()
    end = primary[-1] - p0
    angle = np.arctan2(end[h_axes[1]], end[h_axes[0]])
    cos_a, sin_a = np.cos(-angle), np.sin(-angle)

    def transform(arr):
        a = np.asarray(arr, dtype=float) - p0
        out = a.copy()
        out[..., h_axes[0]] = a[..., h_axes[0]]*cos_a - a[..., h_axes[1]]*sin_a
        out[..., h_axes[1]] = a[..., h_axes[0]]*sin_a + a[..., h_axes[1]]*cos_a
        return out

    if not secondary:
        return transform(primary)
    return (transform(primary),) + tuple(transform(s) for s in secondary)


def detrend_signal(signal: np.ndarray, order: int = 1) -> tuple:
    """Remove a polynomial trend from a 1D signal. Returns (residual, trend).

    Standard step in postural sway analysis: when measuring how stable a
    subject is during a balance task, you usually want the high-frequency
    oscillation around the mean position, not net translation. A subject
    holding a handstand may intentionally 'walk' on their hands across
    20-30 cm to keep the centre of mass over the support — that drift is
    intentional motion, not instability. Subtracting the linear trend
    isolates the residual sway.

    signal : 1D array, may contain NaN
    order  : polynomial order to remove (1 = linear, 2 = quadratic; default 1)

    Returns: (residual, trend), both same shape as signal. NaN-safe — the
    fit is computed on valid points only and then evaluated everywhere.

    Example:
        x = pos_s[onset:end, sk.idx('Hip'), 0]   # Hip X during balance hold
        x_res, x_trend = mc.detrend_signal(x)
        # x_res is the sway oscillation; x_trend is the drift (CoP migration)
    """
    sig = np.asarray(signal, dtype=float)
    n = len(sig)
    if n < order + 2:
        return sig - np.nanmean(sig), np.full_like(sig, np.nanmean(sig))
    t = np.arange(n)
    valid = ~np.isnan(sig)
    if valid.sum() < order + 2:
        m = np.nanmean(sig)
        return sig - m, np.full_like(sig, m)
    coeffs = np.polyfit(t[valid], sig[valid], order)
    trend = np.polyval(coeffs, t)
    return sig - trend, trend
