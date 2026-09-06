import { v } from "convex/values";

// Server ceilings apply even if a caller bypasses the browser controls.
export const MAX_EPISODES = 50;
export const LEASE_MS = 120_000;
export const generationValidator = v.object({
  model: v.string(), video_fps: v.number(), max_output_tokens: v.number(),
  temperature: v.union(v.number(), v.null()),
  media_resolution: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.null()),
  thinking_level: v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.null()),
  final_frame_stills: v.boolean(), max_attempts: v.number(),
});
export const jobStatusValidator = v.union(
  v.literal("queued"), v.literal("dispatched"), v.literal("running"),
  v.literal("cancel_requested"), v.literal("cancelled"),
  v.literal("failed"), v.literal("completed"),
);
export type Generation = {
  model: string; video_fps: number; max_output_tokens: number;
  temperature: number | null; media_resolution: "low" | "medium" | "high" | null;
  thinking_level: "low" | "medium" | "high" | null;
  final_frame_stills: boolean; max_attempts: number;
};
export function validateGeneration(value: Generation, allowedModel: string) {
  if (value.model !== allowedModel) throw new Error("Model must match the registered worker preset");
  if (!Number.isFinite(value.video_fps) || value.video_fps < 1 || value.video_fps > 12) throw new Error("Video FPS must be in 1..12");
  if (!Number.isInteger(value.max_output_tokens) || value.max_output_tokens < 1024 || value.max_output_tokens > 32768) throw new Error("Output tokens must be in 1024..32768");
  if (!Number.isInteger(value.max_attempts) || value.max_attempts < 1 || value.max_attempts > 5) throw new Error("Attempts must be in 1..5");
  if (value.temperature !== null && (!Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2)) throw new Error("Temperature must be null or in 0..2");
}
export function validateEpisodes(episodes: number[], count: number) {
  if (!episodes.length || episodes.length > MAX_EPISODES) throw new Error(`Choose 1..${MAX_EPISODES} episodes`);
  if (episodes.some((x) => !Number.isSafeInteger(x) || x < 0 || x >= count) || new Set(episodes).size !== episodes.length) throw new Error("Episodes must be unique indices within the registered dataset");
  return [...episodes].sort((a, b) => a - b);
}

export function parseEpisodes(text: string): number[] {
  const result: number[] = [];
  for (const part of text.split(",").map((s) => s.trim())) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!match) throw new Error("Use episode numbers or ranges, such as 0, 2-5");
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(end) || end < start || end - start >= MAX_EPISODES) throw new Error("Invalid episode range");
    for (let n = start; n <= end; n++) result.push(n);
    if (result.length > MAX_EPISODES) throw new Error(`At most ${MAX_EPISODES} episodes per job`);
  }
  if (new Set(result).size !== result.length) throw new Error("Episode selection contains duplicates");
  return result.sort((a, b) => a - b);
}
