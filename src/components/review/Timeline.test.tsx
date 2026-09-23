import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { Timeline } from "./Timeline";
import { layoutTimelineMarkers, type TimelineMarker } from "../../lib/timelineMarkers";

GlobalRegistrator.register({ url: "http://localhost/" });
const { cleanup, fireEvent, render } = await import("@testing-library/react");
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());
const mark = (id: string, frame: number): TimelineMarker => ({ id, frame, label: id, title: `${id} at ${frame / 15} s` });

test("close and simultaneous labels get separate lanes without shifting their time ticks", () => {
  const markers = [mark("S3", 22), mark("S1", 20), mark("S2", 20), mark("S10", 290)];
  const before = structuredClone(markers);
  const layout = layoutTimelineMarkers(markers, 300, 300, 48);
  expect(layout.map((entry) => [entry.id, entry.frame, entry.lane])).toEqual([["S1", 20, 0], ["S2", 20, 1], ["S3", 22, 2], ["S10", 290, 0]]);
  expect(markers).toEqual(before);
  expect(layoutTimelineMarkers([mark("S1", 20), mark("S2", 50)], 300, 300, 48).map((entry) => entry.lane)).toEqual([0, 1]);
  expect(layoutTimelineMarkers([mark("S1", 20), mark("S2", 50)], 300, 900, 48).map((entry) => entry.lane)).toEqual([0, 0]);
});

test("invalid times are not placed on the bar and episode-end marks remain reachable", () => {
  expect(layoutTimelineMarkers([mark("S1", 0)], 0, 600, 48)).toEqual([]);
  expect(layoutTimelineMarkers([mark("bad", NaN), mark("negative", -1), mark("late", 301)], 300, 600, 48)).toEqual([]);
  let frame = -1;
  const view = render(<Timeline rawLength={300} frame={0} lastValidFrame={200} markers={[mark("S10", 300)]} onScrub={(next) => { frame = next; }} />);
  fireEvent.click(view.getByRole("button", { name: "Go to S10 at 20 s" }));
  expect(frame).toBe(299);
  expect(view.container.querySelector('[title="is_valid==0 padding from frame 201"]')).toBeTruthy();
});

test("stage buttons select and seek once without triggering pointer-drag scrubbing; guards disable them", () => {
  const frames: number[] = []; const selections: string[] = [];
  const props = { rawLength: 300, frame: 40, lastValidFrame: null, markers: [{ ...mark("S2", 37.5), active: true, selected: true }],
    onScrub: (frame: number) => frames.push(frame), onMarkerSelect: (id: string) => selections.push(id) };
  const view = render(<Timeline {...props} />);
  const button = view.getByRole("button", { name: "Go to S2 at 2.5 s" });
  expect(button.getAttribute("aria-current")).toBe("step");
  expect(button.getAttribute("aria-pressed")).toBe("true");
  fireEvent.pointerDown(button, { clientX: 200, pointerId: 1 });
  expect(frames).toEqual([]);
  fireEvent.pointerUp(button, { pointerId: 1 });
  fireEvent.click(button);
  expect(frames).toEqual([38]); expect(selections).toEqual(["S2"]);
  view.rerender(<Timeline {...props} markersDisabled />);
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(frames).toEqual([38]);
});
