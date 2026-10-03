/** Matches the original trajectory contract's decimal timestamp tolerance.
 * Frame capture is stricter: the first reset frame is never a policy frame. */
export const TRAJECTORY_TIME_TOLERANCE_S = 0.01;
export function policyFrameCount(duration: number | null | undefined, fps: number): number | null {
  if (duration == null || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fps) || fps <= 0) return null;
  const count = Math.round(duration * fps);
  return count > 0 ? count : null;
}
export function isPolicyFrame(frame: number, duration: number | null | undefined, fps: number): boolean {
  const count = policyFrameCount(duration, fps);
  return count !== null && Number.isSafeInteger(frame) && frame >= 0 && frame < count;
}
