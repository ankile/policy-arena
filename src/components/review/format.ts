// Shared pure helpers for the review surfaces (outcome + stage). Extracted
// VERBATIM from OutcomeReview.tsx in the Phase-2 component extraction — no
// behavior changes.

export type CropBox = [number, number, number, number];

// Station roles read left-to-right the way the operator looks at the cell.
export const CAMERA_ROLE_ORDER = ["side_1", "side_2", "wrist_left", "wrist_right"];

/** Port of camera_role_for_video_key in sir/real/camera_utils.py. */
export function cameraRoleForVideoKey(
  key: string,
  keysByRole: Record<string, string>
): string | null {
  const bare = key.split(".").at(-1) ?? key;
  if (bare in keysByRole) return bare;
  for (const [role, serial] of Object.entries(keysByRole)) {
    if (bare === serial) return role;
  }
  return null;
}

export function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function orderCameraKeys(keys: string[]): string[] {
  const rank = (key: string) => {
    const bare = key.split(".").at(-1) ?? key;
    const index = CAMERA_ROLE_ORDER.indexOf(bare);
    return index === -1 ? CAMERA_ROLE_ORDER.length : index;
  };
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export function cameraLabel(key: string): string {
  return key.split(".").at(-1) ?? key;
}

export function formatClock(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
