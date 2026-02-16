import { useState, useCallback } from "react";

function getParam(key: string): string | null {
  return new URLSearchParams(window.location.search).get(key);
}

function setParams(updates: Record<string, string | null>) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null) {
      params.delete(key);
    } else {
      params.set(key, value);
    }
  }
  const qs = params.toString();
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
  window.history.replaceState(null, "", url);
}

/** Sync a required string param with the URL. Falls back to `defaultValue` when absent. */
export function useSearchParam(key: string, defaultValue: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => getParam(key) ?? defaultValue);

  const set = useCallback(
    (v: string) => {
      setValue(v);
      setParams({ [key]: v === defaultValue ? null : v });
    },
    [key, defaultValue],
  );

  return [value, set];
}

/** Sync an optional string param with the URL. Returns `null` when absent. */
export function useSearchParamNullable(key: string): [string | null, (v: string | null) => void] {
  const [value, setValue] = useState(() => getParam(key));

  const set = useCallback(
    (v: string | null) => {
      setValue(v);
      setParams({ [key]: v });
    },
    [key],
  );

  return [value, set];
}

/** Sync an optional numeric param with the URL. Returns `null` when absent or NaN. */
export function useSearchParamNumber(key: string): [number | null, (v: number | null) => void] {
  const [value, setValue] = useState(() => {
    const raw = getParam(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isNaN(n) ? null : n;
  });

  const set = useCallback(
    (v: number | null) => {
      setValue(v);
      setParams({ [key]: v === null ? null : String(v) });
    },
    [key],
  );

  return [value, set];
}

/** Remove multiple search params from the URL at once. */
export function clearSearchParams(...keys: string[]) {
  const updates: Record<string, null> = {};
  for (const key of keys) {
    updates[key] = null;
  }
  setParams(updates);
}
