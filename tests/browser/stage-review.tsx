import { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import StageReview from "../../src/components/StageReview";
import "../../src/index.css";
import { createStageReviewFixture, configureTrajectoryFixture } from "./stageReviewFixture";

let revision = 0;
const listeners = new Set<() => void>();
const refresh = () => { revision++; for (const listener of listeners) listener(); };
const fixture = createStageReviewFixture([], refresh);
const params = new URLSearchParams(window.location.search);
if (params.get("fixture") === "trajectory") {
  const task = params.get("task") ?? "marker_d2";
  if (!["marker_d2", "square_d2", "routing_d1"].includes(task)) throw new Error("Unknown fixture task");
  configureTrajectoryFixture(fixture, `${task}_${task === "routing_d1" ? "v1" : "v3"}`, `real_${task}_valid`);
}
if (params.get("conflict") === "1") {
  const label = fixture.state.predictionOverrides.label as { key_action_observations: Array<{ first_time_s: number; occurrences: Array<{ time_s: number }> }> };
  label.key_action_observations[1].first_time_s = 7.266667;
  label.key_action_observations[1].occurrences[0].time_s = 7.266667;
}
const { state, props } = fixture;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export default function Fixture() {
  useSyncExternalStore(subscribe, () => revision);
  return (
    <main className="p-6 max-w-[1800px] mx-auto">
      <div className="mb-4 rounded-xl border border-gold bg-gold-light p-4 text-ink">
        <p className="font-bold">Offline visual test. Fixture predictions and reviews only.</p>
        <p className="text-sm">The actual StageReview component runs with an in-memory I/O adapter.
          Camera streams are omitted. No Convex or Hugging Face requests are made.</p>
        <div className="mt-2 flex items-center gap-4 text-sm">
          <button className="border border-gold rounded px-2 py-1 cursor-pointer" onClick={() => {
            state.active = state.active === "A" ? "B" : "A";
            refresh();
          }}>Change active version to {state.active === "A" ? "B" : "A"}</button>
          <span>Saved fixture reviews: {state.saves.length}</span>
        </div>
      </div>
      <StageReview {...props} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
