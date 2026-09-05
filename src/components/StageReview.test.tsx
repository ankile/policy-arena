import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import StageReview from "./StageReview";
import { AppTabNavigation } from "./AppTabNavigation";
import { navigateToDataset } from "../lib/appNavigation";
import { useSearchParam, useSearchParamNullable } from "../lib/useSearchParam";
import { createStageReviewFixture } from "../../tests/browser/stageReviewFixture";

GlobalRegistrator.register({ url: "http://localhost/" });
const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
afterEach(async () => { await act(async () => cleanup()); });
afterAll(() => GlobalRegistrator.unregister());

function GlobalNavigationFixture({ props }: { props: ReturnType<typeof createStageReviewFixture>["props"] }) {
  const [tab] = useSearchParam("tab", "leaderboard");
  const [repo] = useSearchParamNullable("dataset");
  const [view] = useSearchParam("view", "explorer");
  return <>
    <AppTabNavigation activeTab={tab} />
    <button onClick={() => navigateToDataset("org/other")}>Open another dataset</button>
    {tab === "explorer" && repo === "org/repo" && view === "stage"
      ? <StageReview {...props} onExit={() => { props.onExit(); navigateToDataset(null); }} />
      : <p data-testid="route">Route {tab} / {repo ?? "none"} / {view}</p>}
  </>;
}

function fixture(
  initialUrl = "?episode=0&prediction=A",
  initialReviews: Array<Record<string, unknown>> = [],
  globalNavigation = false,
) {
  window.history.replaceState(null, "", `/${initialUrl}`);
  const { state, props } = createStageReviewFixture(initialReviews);
  const element = () => globalNavigation ? <GlobalNavigationFixture props={props} /> : <StageReview {...props} />;
  const view = render(element());
  const rerender = () => view.rerender(element());
  return { state, view, rerender };
}

async function settle() { await act(async () => {}); }
function key(value: string) { fireEvent.keyDown(window, { key: value }); }

function chooseVersion(view: ReturnType<typeof render>, version: string) {
  fireEvent.change(view.getByRole("combobox", { name: "Prediction version" }), { target: { value: version } });
}

describe("stage prediction version review", () => {
  test("browsing and inspecting canonical predictions never saves or success-overlays them", async () => {
    const { state, view } = fixture();
    await settle();
    expect(state.saves).toHaveLength(0);
    expect(view.container.textContent).not.toContain("inherited from outcome");
    fireEvent.click(view.getByRole("button", { name: /model evidence/ }));
    expect(view.container.textContent).not.toContain("raw-A");
    expect(state.armFetches).toBe(0);
    await act(async () => fireEvent.click(view.getAllByRole("button", { name: "Show provenance and unblind" })[0]));
    expect(view.container.textContent).toContain("raw-A");
    expect(view.container.textContent).toContain("max_stage: S3");
    expect(view.container.textContent).toContain("Review source: prediction A-prediction-0");
    expect(state.saves).toHaveLength(0);
  });

  test("default pins active ID and reactive publication never switches the working version", async () => {
    const { state, view, rerender } = fixture("?episode=0");
    await settle();
    expect(new URLSearchParams(window.location.search).get("prediction")).toBe("A");
    state.active = "B";
    await act(async () => rerender());
    expect((view.getByRole("combobox", { name: "Prediction version" }) as HTMLSelectElement).value).toBe("A");
    expect(view.container.textContent).toContain("Historical prediction version: A");
    expect(state.saves).toHaveLength(0);
  });

  test("invalid version fails closed and cannot create a source-free review", async () => {
    const { state, view } = fixture("?episode=0&prediction=does-not-exist");
    await settle();
    expect(view.getByRole("alert").textContent).toContain("is not published for this dataset");
    key("5"); key("u");
    await settle();
    expect(state.saves).toHaveLength(0);
    expect((view.getByRole("button", { name: /^uncertain/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("switch awaits the old draft save and preserves its identity on resumed own labels", async () => {
    const { state, view } = fixture();
    await settle();
    let release: (() => void) | undefined;
    state.save = () => new Promise<void>((resolve) => { release = resolve; });
    key("4");
    await act(async () => chooseVersion(view, "B"));
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0].label?.max_stage).toBe(4);
    expect(state.saves[0].prediction_id).toBe("A-prediction-0");
    expect(state.saves[0].prediction_sha256).toBe("A".repeat(64));
    expect(state.saves[0].episode_duration_s).toBe(12);
    expect(new URLSearchParams(window.location.search).get("prediction")).toBe("A");
    expect((view.getByRole("combobox", { name: "Prediction version" }) as HTMLSelectElement).disabled).toBe(true);
    key("8"); key("u");
    expect(state.saves).toHaveLength(1);
    await act(async () => release?.());
    expect(new URLSearchParams(window.location.search).get("prediction")).toBe("B");
    expect(view.container.textContent).toContain("Your saved label is in the form");
    expect(view.container.textContent).toContain("Review source: prediction A-prediction-0");
    state.save = async () => {};
    await act(async () => fireEvent.click(view.getByRole("button", { name: /^uncertain/ })));
    expect(state.saves[1].label?.max_stage).toBe(4);
    expect(state.saves[1].prediction_id).toBe("A-prediction-0");
    expect(state.saves[1].episode_duration_s).toBe(12);
  });

  test("save failures keep edits and selection in place for retry", async () => {
    const { state, view } = fixture();
    await settle();
    state.save = async () => { throw new Error("offline"); };
    key("4");
    await act(async () => chooseVersion(view, "B"));
    expect(new URLSearchParams(window.location.search).get("prediction")).toBe("A");
    expect(view.container.textContent).toContain("Episode 0: offline");
    state.save = async () => {};
    await act(async () => chooseVersion(view, "B"));
    expect(state.saves[1].label?.max_stage).toBe(4);
    expect(state.saves[1].prediction_id).toBe("A-prediction-0");
    expect(new URLSearchParams(window.location.search).get("prediction")).toBe("B");
  });

  test("a partially loaded version hides stale marks and disables editing and saves", async () => {
    const { state, view, rerender } = fixture();
    await settle();
    state.ready = false;
    await act(async () => { chooseVersion(view, "B"); rerender(); });
    expect(view.getByRole("status").textContent).toContain("complete version loads");
    expect(view.container.textContent).not.toContain("Review source: prediction A-prediction-0");
    key("8"); key("u");
    await settle();
    expect(state.saves).toHaveLength(0);
    state.ready = true;
    await act(async () => rerender());
    expect(view.container.textContent).toContain("Review source: prediction B-prediction-0");
  });

  test("explicit historical selection changes selected evidence without writing reviews", async () => {
    const { state, view } = fixture("?episode=0&prediction=B");
    await settle();
    expect(view.container.textContent).toContain("Historical prediction version: B");
    fireEvent.click(view.getByRole("button", { name: /model evidence/ }));
    await act(async () => fireEvent.click(view.getAllByRole("button", { name: "Show provenance and unblind" })[0]));
    expect(view.container.textContent).toContain("raw-B");
    expect(view.container.textContent).not.toContain("raw-A");
    await act(async () => chooseVersion(view, "legacy"));
    expect(view.container.textContent).toContain("Review source: legacy prediction legacy-0");
    expect(view.container.textContent).toContain("inherited from outcome");
    expect(state.saves).toHaveLength(0);
  });

  test("external URL switches retain unsaved edits under their original prediction", async () => {
    const { state, view } = fixture();
    await settle();
    key("4");
    await act(async () => {
      window.history.replaceState(null, "", "/?episode=0&prediction=B");
      window.dispatchEvent(new Event("popstate"));
    });
    expect(view.container.textContent).toContain("Unsaved edits are retained");
    expect(view.container.textContent).toContain("Review source: prediction B-prediction-0");
    await act(async () => chooseVersion(view, "A"));
    await act(async () => fireEvent.click(view.getByRole("button", { name: /^uncertain/ })));
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0].label?.max_stage).toBe(4);
    expect(state.saves[0].prediction_id).toBe("A-prediction-0");
  });
  test("edits to committed human labels block navigation instead of discarding or demoting them", async () => {
    const { state, view } = fixture("?episode=0&prediction=B&sstatus=all", [{
      _id: "own-review", episode_index: 0n, reviewer: "annotator", reviewer_user_id: "user-1", status: "confirmed", saved_at: 1_700_000_100_000,
      label: { max_stage: 5 }, prediction_id: "A-prediction-0", prediction_sha256: "A".repeat(64),
      episode_duration_s: 12,
    }]);
    await settle();
    key("6");
    await act(async () => chooseVersion(view, "A"));
    expect(view.container.textContent).toContain("unsaved edits to your confirmed review are still in the form");
    expect(new URLSearchParams(window.location.search).get("prediction")).toBe("B");
    expect(state.saves).toHaveLength(0);
    await act(async () => fireEvent.click(view.getByRole("button", { name: /^uncertain/ })));
    expect(state.saves[0].label?.max_stage).toBe(6);
    expect(state.saves[0].prediction_id).toBe("A-prediction-0");
  });

  test("historical own labels with unknown source retain their timestamp and duration", async () => {
    const { state, view } = fixture("?episode=0&prediction=B", [{
      _id: "own-review", episode_index: 0n, reviewer: "annotator", reviewer_user_id: "user-1", status: "draft", saved_at: 1_700_000_100_000,
      label: { max_stage: 5 }, prefill_pushed_at: 1_600_000_000_000, episode_duration_s: 9,
    }]);
    await settle();
    expect(view.container.textContent).toContain("exact prediction was not recorded");
    await act(async () => fireEvent.click(view.getByRole("button", { name: /^uncertain/ })));
    expect(state.saves[0].prediction_id).toBeUndefined();
    expect(state.saves[0].legacy_prefill_id).toBeUndefined();
    expect(state.saves[0].prefill_pushed_at).toBe(1_600_000_000_000);
    expect(state.saves[0].episode_duration_s).toBe(9);
    expect(state.saves[0].label?.max_stage).toBe(5);
  });

  test("completed pagination with a manifest count mismatch fails closed", async () => {
    const { state, view, rerender } = fixture();
    await settle();
    state.runs[0].expected_count = 3;
    await act(async () => rerender());
    expect(view.getByRole("alert").textContent).toContain("its published manifest requires 3");
    key("u");
    await settle();
    expect(state.saves).toHaveLength(0);
  });

  test("leaving cannot discard dirty drafts retained after an external URL change", async () => {
    const { state, view } = fixture();
    await settle();
    key("4");
    await act(async () => {
      window.history.replaceState(null, "", "/?episode=0&prediction=B");
      window.dispatchEvent(new Event("popstate"));
    });
    await act(async () => fireEvent.click(view.getByRole("button", { name: /Back to explorer/ })));
    expect(state.exits).toBe(0);
    expect(view.container.textContent).toContain("Save the retained edits");
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  test("copied human labels save the donor review and its exact original prediction source", async () => {
    const { state, view } = fixture("?episode=0&prediction=A&sstatus=adjudicate", [{
      _id: "donor-review", episode_index: 0n, reviewer: "other", reviewer_user_id: "user-2",
      status: "uncertain", saved_at: 1_700_000_100_000, label: { max_stage: 8 },
      prediction_id: "B-prediction-0", prediction_sha256: "B".repeat(64), episode_duration_s: 20,
    }]);
    await settle();
    fireEvent.click(view.getByRole("button", { name: "load their label" }));
    expect(view.container.textContent).toContain("Copied from human review donor-review");
    await act(async () => fireEvent.click(view.getByRole("button", { name: /^uncertain/ })));
    expect(state.saves[0].copied_from_review_id).toBe("donor-review");
    expect(state.saves[0].prediction_id).toBe("B-prediction-0");
    expect(state.saves[0].prediction_sha256).toBe("B".repeat(64));
    expect(state.saves[0].episode_duration_s).toBe(20);
    expect(state.saves[0].label?.max_stage).toBe(8);
  });

  test("stable user ID finds an own review saved under a previous username", async () => {
    const { state, view } = fixture("?episode=0&prediction=A", [{
      _id: "old-username-review", episode_index: 0n, reviewer: "previous-name", reviewer_user_id: "user-1",
      status: "draft", saved_at: 1_700_000_100_000, label: { max_stage: 8 },
      prediction_id: "B-prediction-0", prediction_sha256: "B".repeat(64), episode_duration_s: 20,
    }]);
    await settle();
    expect(view.container.textContent).toContain("Your saved label is in the form");
    await act(async () => fireEvent.click(view.getByRole("button", { name: /^uncertain/ })));
    expect(state.saves[0].prediction_id).toBe("B-prediction-0");
    expect(state.saves[0].label?.max_stage).toBe(8);
  });

  test("a same-name service review without the signed-in user's ID cannot seed their form", async () => {
    const { state, view } = fixture("?episode=0&prediction=A", [{
      _id: "service-review", episode_index: 0n, reviewer: "annotator",
      status: "confirmed", saved_at: 1_700_000_100_000, label: { max_stage: 8 },
      prediction_id: "B-prediction-0", prediction_sha256: "B".repeat(64), episode_duration_s: 20,
    }]);
    await settle();
    expect(view.container.textContent).not.toContain("Your saved label is in the form");
    await act(async () => fireEvent.click(view.getByRole("button", { name: /^uncertain/ })));
    expect(state.saves[0].prediction_id).toBe("A-prediction-0");
    expect(state.saves[0].label?.max_stage).toBe(3);
  });

  test("blind review hides arbitrary provenance and notes, then records explicit unblinding", async () => {
    const { state, view, rerender } = fixture();
    // These values arrive before the asynchronous episode fetch seeds the form.
    state.predictionOverrides = {
      label: { max_stage: 3, notes: "sensitive-policy-notes" },
      canonical_response: { notes: "sensitive-canonical-policy" },
      evidence: { arm: "sensitive-arm" },
      pipeline: { name: "sensitive-pipeline", version: "v1", git_commit: "abc" },
      review_reason: "sensitive-review-reason", vote_summary: { "sensitive-vote": 1 },
    };
    state.runs[0] = { ...state.runs[0], run_key: "sensitive-run-key" };
    await act(async () => rerender());
    fireEvent.click(view.getByRole("button", { name: /model evidence/ }));
    expect(view.container.innerHTML).not.toContain("sensitive-");
    expect(state.armFetches).toBe(0);
    await act(async () => fireEvent.click(view.getAllByRole("button", { name: "Show provenance and unblind" })[0]));
    expect(view.container.innerHTML).toContain("sensitive-policy-notes");
    expect(view.container.innerHTML).toContain("sensitive-canonical-policy");
    expect(view.container.innerHTML).toContain("sensitive-arm");
    expect(view.container.innerHTML).toContain("sensitive-run-key");
    // Re-hiding identity does not erase the fact it was shown in this session.
    fireEvent.click(view.getByRole("button", { name: /unblinded/ }));
    await act(async () => fireEvent.click(view.getByRole("button", { name: /^uncertain/ })));
    expect(state.saves[0].blind).toBe(false);
    expect(state.saves[0].label?.notes).toBe("sensitive-policy-notes");
  });

  test("invalid known-field values cannot reveal policy identity anywhere in blind DOM", async () => {
    const { state, view, rerender } = fixture();
    state.predictionOverrides = {
      label: { max_stage: "hidden-policy-stage", failure_mode: "hidden-policy-failure", final_state: "hidden-policy-final", notes: "hidden-policy-notes" },
      confidence: "hidden-policy-confidence", canonical_response: { notes: "hidden-policy-raw" },
    };
    await act(async () => rerender());
    fireEvent.click(view.getByRole("button", { name: /model evidence/ }));
    expect(view.container.innerHTML).not.toContain("hidden-policy-");
    expect(view.container.textContent).toContain("invalid stage");
    expect(view.container.textContent).toContain("invalid confidence");
    expect(view.container.textContent).toContain("unparseable_stage");
    await act(async () => fireEvent.click(view.getAllByRole("button", { name: "Show provenance and unblind" })[0]));
    expect(view.container.innerHTML).toContain("hidden-policy-stage");
    expect(view.container.innerHTML).toContain("hidden-policy-failure");
    expect(view.container.innerHTML).toContain("hidden-policy-final");
  });

  test("actual App tab navigation cannot unmount a dirty review or partially clear its URL", async () => {
    const { state, view } = fixture("?tab=explorer&dataset=org%2Frepo&view=stage&episode=0&prediction=A", [], true);
    await settle();
    key("4");
    const sourceUrl = window.location.href;
    fireEvent.click(view.getByRole("button", { name: "Eval Sessions" }));
    expect(window.location.href).toBe(sourceUrl);
    expect(view.queryByTestId("route")).toBeNull();
    expect(view.container.textContent).toContain("Save them before changing tabs or datasets");
    expect(state.saves).toHaveLength(0);
    await act(async () => fireEvent.click(view.getByRole("button", { name: /^uncertain/ })));
    fireEvent.click(view.getByRole("button", { name: "Eval Sessions" }));
    expect(view.getByTestId("route").textContent).toContain("Route sessions / none / explorer");
    expect(new URLSearchParams(window.location.search).has("prediction")).toBe(false);
    expect(state.saves[0].prediction_id).toBe("A-prediction-0");
    expect(state.saves[0].label?.max_stage).toBe(4);
  });

  test("DataExplorer dataset navigation blocks dirty edits; the review's awaited exit can leave after saving", async () => {
    const { state, view } = fixture("?tab=explorer&dataset=org%2Frepo&view=stage&episode=0&prediction=A", [], true);
    await settle();
    key("4");
    fireEvent.click(view.getByRole("button", { name: "Open another dataset" }));
    expect(new URLSearchParams(window.location.search).get("dataset")).toBe("org/repo");
    expect(view.queryByTestId("route")).toBeNull();
    await act(async () => fireEvent.click(view.getByRole("button", { name: /Back to explorer/ })));
    expect(state.saves[0].status).toBe("draft");
    expect(state.saves[0].prediction_id).toBe("A-prediction-0");
    expect(view.getByTestId("route").textContent).toContain("Route explorer / none / explorer");
  });

  test("global navigation is blocked during a save and after its failure", async () => {
    const { state, view } = fixture("?tab=explorer&dataset=org%2Frepo&view=stage&episode=0&prediction=A", [], true);
    await settle();
    let rejectSave: ((error: Error) => void) | undefined;
    state.save = () => new Promise<void>((_resolve, reject) => { rejectSave = reject; });
    key("4");
    await act(async () => chooseVersion(view, "B"));
    fireEvent.click(view.getByRole("button", { name: "Eval Sessions" }));
    expect(view.container.textContent).toContain("Stay on this page until the save finishes");
    expect(view.queryByTestId("route")).toBeNull();
    await act(async () => rejectSave?.(new Error("offline")));
    fireEvent.click(view.getByRole("button", { name: "Eval Sessions" }));
    expect(view.queryByTestId("route")).toBeNull();
    expect(state.saves).toHaveLength(1);
    expect(new URLSearchParams(window.location.search).get("prediction")).toBe("A");
  });

  test("Back/Forward route changes are stopped before parent subscribers unmount dirty review", async () => {
    const { state, view } = fixture("?tab=explorer&dataset=org%2Frepo&view=stage&episode=0&prediction=A", [], true);
    await settle();
    key("4");
    const sourceUrl = window.location.href;
    await act(async () => {
      // Browser traversal changes the URL before dispatching popstate.
      window.history.pushState(null, "", "/?tab=sessions");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(window.location.href).toBe(sourceUrl);
    expect(view.queryByTestId("route")).toBeNull();
    expect(state.saves).toHaveLength(0);
    await act(async () => fireEvent.click(view.getByRole("button", { name: /^uncertain/ })));
    await act(async () => {
      window.history.pushState(null, "", "/?tab=sessions");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(view.getByTestId("route").textContent).toContain("Route sessions");
  });

  test("global navigation also protects a dirty draft retained under another prediction version", async () => {
    const { state, view } = fixture("?tab=explorer&dataset=org%2Frepo&view=stage&episode=0&prediction=A", [], true);
    await settle();
    key("4");
    await act(async () => {
      const url = new URL(window.location.href);
      url.searchParams.set("prediction", "B");
      window.history.replaceState(null, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(view.container.textContent).toContain("Unsaved edits are retained");
    fireEvent.click(view.getByRole("button", { name: "Eval Sessions" }));
    expect(view.queryByTestId("route")).toBeNull();
    expect(state.saves).toHaveLength(0);
    expect(new URLSearchParams(window.location.search).get("prediction")).toBe("B");
  });

});
