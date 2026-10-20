import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useFrameStepSizes, parseFrameStep } from "./frameStepSizes";
import { FrameStepControls } from "./FrameStepControls";

GlobalRegistrator.register({ url: "http://localhost/" });
const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
afterEach(async () => { await act(async () => cleanup()); window.localStorage.clear(); });
afterAll(() => GlobalRegistrator.unregister());

const KEY = "test:frame-steps";
function Harness() {
  const [sizes, update] = useFrameStepSizes(KEY, { arrow: 1, bracket: 30 });
  return <><FrameStepControls sizes={sizes} onChange={update} /><output>{`${sizes.arrow}/${sizes.bracket}`}</output></>;
}

test("parseFrameStep accepts only integers in range", () => {
  expect(parseFrameStep("3")).toBe(3);
  for (const bad of ["0", "-1", "2.5", "", "abc", "1001"]) expect(parseFrameStep(bad)).toBeNull();
});

test("edits commit on Enter, persist, and invalid input keeps the old value", () => {
  const view = render(<Harness />);
  expect(view.container.querySelector("output")!.textContent).toBe("1/30");
  const arrow = view.getByLabelText(/←\/→/) as HTMLInputElement;
  const bracket = view.getByLabelText(/\[\/\]/) as HTMLInputElement;
  fireEvent.change(arrow, { target: { value: "3" } });
  fireEvent.keyDown(arrow, { key: "Enter" });
  fireEvent.change(bracket, { target: { value: "0" } });
  fireEvent.keyDown(bracket, { key: "Enter" });
  expect(view.container.querySelector("output")!.textContent).toBe("3/30");
  fireEvent.change(bracket, { target: { value: "20" } });
  fireEvent.blur(bracket);
  expect(view.container.querySelector("output")!.textContent).toBe("3/20");
  expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({ arrow: 3, bracket: 20 });
  cleanup();
  expect(render(<Harness />).container.querySelector("output")!.textContent).toBe("3/20");
});

test("malformed storage falls back to defaults", () => {
  window.localStorage.setItem(KEY, JSON.stringify({ arrow: -4, bracket: "x" }));
  expect(render(<Harness />).container.querySelector("output")!.textContent).toBe("1/30");
});
