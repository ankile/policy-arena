import { useCallback, useState } from "react";

/** Per-reviewer frame-step sizes for ←/→ and [/], persisted in this browser. */
export interface FrameStepSizes { arrow: number; bracket: number }

export const MAX_FRAME_STEP = 1000;

export function parseFrameStep(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value);
  return n >= 1 && n <= MAX_FRAME_STEP ? n : null;
}

function load(storageKey: string, defaults: FrameStepSizes): FrameStepSizes {
  try {
    const stored = JSON.parse(window.localStorage.getItem(storageKey) ?? "null") as Partial<FrameStepSizes> | null;
    const valid = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= MAX_FRAME_STEP;
    return {
      arrow: valid(stored?.arrow) ? stored!.arrow! : defaults.arrow,
      bracket: valid(stored?.bracket) ? stored!.bracket! : defaults.bracket,
    };
  } catch {
    // Malformed storage only loses a UI preference; the defaults are always valid.
    return defaults;
  }
}

export function useFrameStepSizes(storageKey: string, defaults: FrameStepSizes) {
  const [sizes, setSizes] = useState(() => load(storageKey, defaults));
  const update = useCallback((patch: Partial<FrameStepSizes>) => {
    setSizes((prev) => {
      const next = { ...prev, ...patch };
      window.localStorage.setItem(storageKey, JSON.stringify(next));
      return next;
    });
  }, [storageKey]);
  return [sizes, update] as const;
}
