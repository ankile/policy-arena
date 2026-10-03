import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createRef, useState } from "react";
import { ReviewViewer, type ViewerControls } from "./ReviewViewer";
import type { ReviewEpisode } from "../../lib/hf-api";
import type { TimelineMarker } from "../../lib/timelineMarkers";

GlobalRegistrator.register({ url: "http://localhost/" });
const { act, cleanup, fireEvent, render } = await import("@testing-library/react");
const cameras = ["side", "wrist"];
const episode: ReviewEpisode = { episodeIndex: 0, rawLength: 300, dataPath: "test.parquet", perCamera: {
  side: { fileIndex: 0, fromTimestamp: 20, toTimestamp: 30 },
  wrist: { fileIndex: 1, fromTimestamp: 40, toTimestamp: 50 },
} };
const callbacks = new Map<number, FrameRequestCallback>();
let nextHandle = 0;
let restore: (() => void)[] = [];
beforeEach(() => {
  const raf = spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => { callbacks.set(++nextHandle, callback); return nextHandle; });
  const cancel = spyOn(globalThis, "cancelAnimationFrame").mockImplementation((handle) => { callbacks.delete(handle); });
  restore = [() => raf.mockRestore(), () => cancel.mockRestore()];
});
afterEach(() => { cleanup(); restore.forEach((fn) => fn()); callbacks.clear(); });
afterAll(() => GlobalRegistrator.unregister());

function Fixture({ fps, controls, markers }: { fps: number; controls: ReturnType<typeof createRef<ViewerControls>>; markers?: TimelineMarker[] }) {
  const [frame, setFrame] = useState(0);
  return <ReviewViewer datasetId="test/repo" episode={episode} cameraKeys={cameras} primaryKey="side" fps={fps}
    frame={frame} onFrame={setFrame} lastValidFrame={200} controlsRef={controls}
    cropByCameraKey={null} storedFrameHW={null} onDrift={() => {}} timelineMarkers={markers} />;
}

for (const fps of [15, 30]) test(`live playback and frame step use the video clock at ${fps} FPS with camera offsets`, () => {
  const controls = createRef<ViewerControls>();
  const view = render(<Fixture fps={fps} controls={controls} />);
  const [primary, secondary] = Array.from(view.container.querySelectorAll("video"));
  fireEvent.click(view.getByRole("button", { name: /^Play/ }));
  act(() => {
    primary.currentTime = 22.5;
    const [handle, callback] = [...callbacks][0]; callbacks.delete(handle); callback(0);
  });
  expect(view.container.textContent).toContain(`frame ${Math.floor(2.5 * fps)} /`);
  expect(secondary.currentTime).toBe(42.5);
  // Video advances between animation ticks: step from its synchronous snap,
  // not the stale React frame value from the preceding render.
  primary.currentTime = 23.1;
  fireEvent.click(view.getByRole("button", { name: "Next frame" }));
  const expected = Math.round(3.1 * fps - 0.5) + 1;
  expect(view.container.textContent).toContain(`frame ${expected} /`);
  expect(view.getByRole("button", { name: /^Play/ })).toBeTruthy();
  expect(primary.currentTime).toBeCloseTo(20 + (expected + 0.5) / fps);
  expect(secondary.currentTime).toBeCloseTo(40 + (expected + 0.5) / fps);
});

test("speed and camera enlargement preserve the video elements", () => {
  const view = render(<Fixture fps={30} controls={createRef<ViewerControls>()} />);
  const videos = Array.from(view.container.querySelectorAll("video"));
  fireEvent.change(view.getByRole("combobox", { name: "Playback speed" }), { target: { value: "0.5" } });
  videos.forEach((video) => expect(video.playbackRate).toBe(0.5));
  fireEvent.click(view.getByRole("button", { name: /Enlarge.*wrist.*camera/ }));
  expect(view.getByRole("button", { name: /Restore.*wrist.*camera/ })).toBeTruthy();
  expect(Array.from(view.container.querySelectorAll("video"))).toEqual(videos);
});

test("stage markers stay visible during playback and clicking one pauses and seeks both cameras", () => {
  const view = render(<Fixture fps={15} controls={createRef<ViewerControls>()}
    markers={[{ id: "transition:0", frame: 37.5, label: "S2", title: "S2 at 2.50 s" }]} />);
  const videos = Array.from(view.container.querySelectorAll("video"));
  fireEvent.click(view.getByRole("button", { name: /^Play/ }));
  fireEvent.click(view.getByRole("button", { name: "Go to S2 at 2.50 s" }));
  expect(view.getByRole("button", { name: /^Play/ })).toBeTruthy();
  expect(view.container.textContent).toContain("frame 38 / 299");
  expect(videos[0].currentTime).toBeCloseTo(20 + 38.5 / 15);
  expect(videos[1].currentTime).toBeCloseTo(40 + 38.5 / 15);
  expect(Array.from(view.container.querySelectorAll("video"))).toEqual(videos);
});
