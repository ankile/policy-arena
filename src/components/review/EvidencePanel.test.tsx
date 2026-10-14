import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { EvidencePanel, type StagePrefillView } from "./EvidencePanel";
import { normalizeStageSpec } from "../../lib/stage-spec";
import markerV6 from "../../../data/stage-review/marker_d2_v6.spec.json";
import markerV7 from "../../../data/stage-review/marker_d2_v7.spec.json";

GlobalRegistrator.register({ url: "http://localhost/" });
const { cleanup, render } = await import("@testing-library/react");
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

function prefill(label: Record<string, unknown>): StagePrefillView {
  return {
    label, reviewReason: null, violationCodes: [], confidence: "high", voteSummary: null,
    episodeDurationS: 20, pipeline: { name: "gemini", version: "v2", git_commit: "abc" }, evidence: {},
    pushedAt: 0, attribution: { kind: "source_free" } as unknown as StagePrefillView["attribution"],
  };
}

test("blind v2 suggestions have no end-state line", () => {
  const spec = normalizeStageSpec(markerV7);
  const view = render(<EvidencePanel spec={spec} prefill={prefill({ max_stage: 6, failure_mode: "none" })}
    onSeekTime={() => {}} blind onUnblind={() => {}} />);
  expect(view.container.textContent).not.toContain("Invalid final state");
  expect(view.container.textContent).not.toContain("→");
});

test("historical v1 suggestions keep the end-state line", () => {
  const spec = normalizeStageSpec(markerV6);
  const view = render(<EvidencePanel spec={spec} prefill={prefill({ max_stage: 6, failure_mode: "none", final_state: "marker_fully_seated_released" })}
    onSeekTime={() => {}} blind onUnblind={() => {}} />);
  expect(view.container.textContent).toContain("→ marker_fully_seated_released");
});
