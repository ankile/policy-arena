export interface TimelineMarker {
  id: string;
  frame: number;
  label: string;
  title: string;
  active?: boolean;
  selected?: boolean;
}

/** Put nearby labels on separate rows without moving their exact time ticks. */
export function layoutTimelineMarkers(markers: TimelineMarker[], rawLength: number, width: number, labelWidth: number) {
  if (!Number.isFinite(rawLength) || rawLength <= 0) return [];
  const ends: number[] = [];
  return markers.filter((marker) => Number.isFinite(marker.frame) && marker.frame >= 0 && marker.frame <= rawLength)
    .sort((a, b) => a.frame - b.frame)
    .map((marker) => {
      const center = Math.max(labelWidth / 2, Math.min(width - labelWidth / 2, marker.frame / Math.max(1, rawLength) * width));
      let lane = ends.findIndex((end) => end + 4 <= center - labelWidth / 2);
      if (lane < 0) lane = ends.length;
      ends[lane] = center + labelWidth / 2;
      return { ...marker, lane };
    });
}
