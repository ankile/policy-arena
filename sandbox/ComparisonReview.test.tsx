import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { ComparisonDetail } from "./ComparisonReview";
import { fixtureBundle } from "./labelComparison.test";
import type { Feedback } from "./labelComparison";

GlobalRegistrator.register({ url: "http://localhost/" });
const { act, cleanup, fireEvent, render } =
  await import("@testing-library/react");
afterEach(async () => {
  await act(async () => cleanup());
});
afterAll(() => GlobalRegistrator.unregister());

test("comparison exposes the three supervised fields, correct pinned video and timestamp seeks", async () => {
  const bundle = fixtureBundle();
  const row = bundle.cases[0];
  const original = JSON.stringify(row);
  const saves: Feedback[] = [];
  const view = render(
    <ComparisonDetail
      bundle={bundle}
      row={row}
      onSave={async (feedback) => {
        saves.push(feedback);
      }}
      onDirty={() => {}}
    />,
  );
  expect(
    view.getByRole("region", { name: "Your labels compared with Gemini" }),
  ).toBeTruthy();
  expect(
    view.getByRole("combobox", { name: "Feedback on Success / failure" }),
  ).toBeTruthy();
  expect(view.container.querySelector("video")?.src).toBe(row.cameras[0].url);
  fireEvent.click(
    view.getByRole("button", { name: "Go to your S1 at 1.25 s · attempt 1" }),
  );
  await act(async () => {});
  expect(view.getByText(/frame 19 \/ 224/)).toBeTruthy();
  fireEvent.change(
    view.getByRole("combobox", { name: "Feedback on Success / failure" }),
    { target: { value: "criteria" } },
  );
  fireEvent.change(
    view.getByRole("textbox", {
      name: "What should the criteria or prompt say differently?",
    }),
    { target: { value: "Require a sustained grasp" } },
  );
  fireEvent.click(view.getByRole("button", { name: "Save feedback" }));
  await act(async () => {});
  expect(saves).toHaveLength(1);
  expect(saves[0].verdicts.success).toBe("criteria");
  expect(saves[0].comparison_sha256).toBe(bundle.comparison_sha256);
  expect(view.getByRole("status").textContent).toBe("Feedback saved locally");
  expect(JSON.stringify(row)).toBe(original);
});

test("failed persistence keeps the feedback and shows an error, never a saved message", async () => {
  const bundle = fixtureBundle();
  const view = render(
    <ComparisonDetail
      bundle={bundle}
      row={bundle.cases[0]}
      onSave={async () => {
        throw new Error("storage full");
      }}
      onDirty={() => {}}
    />,
  );
  fireEvent.change(view.getByRole("textbox"), {
    target: { value: "Important feedback" },
  });
  fireEvent.click(view.getByRole("button", { name: "Save feedback" }));
  await act(async () => {});
  expect(view.getByRole("alert").textContent).toBe("storage full");
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "Important feedback",
  );
  expect(view.getByRole("status").textContent).toBe("Unsaved feedback");
});
