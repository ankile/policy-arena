import { useMemo } from "react";
import type { ReactNode } from "react";
import { ReleaseContext } from "./client";
import { createReleaseAdapter } from "./adapter";
import type { UISnapshot } from "./adapter";
import type { Release } from "./types";
export function ReleaseProvider({
  data,
  ui,
  children,
}: {
  data: Release;
  ui: UISnapshot;
  children: ReactNode;
}) {
  const adapter = useMemo(() => createReleaseAdapter(data, ui), [data, ui]);
  return (
    <ReleaseContext.Provider value={adapter}>
      {children}
    </ReleaseContext.Provider>
  );
}
