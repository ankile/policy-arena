/** Derivation of routing_d1 snapshots after the released v5. Each version is
 * its predecessor plus additive failure modes and the boundary text that keeps
 * them disjoint; stages, key actions, and existing mode IDs never change.
 *  - v6: first_clip_pulled_out — the robot pulls the rope back out of a fully
 *    seated LEFT clip instead of routing it onward to the RIGHT clip.
 *  - v7: second_clip_rope_slack_insufficient — after the LEFT seat, the RIGHT-
 *    phase regrasp takes up too little free rope, so the rope cannot slide
 *    through the seated LEFT clip and tension stalls the RIGHT attempt.
 * Hashes are recomputed with the same digest functions the Convex upsert and
 * the release script verify against.
 * Usage: bun scripts/derive_routing_d1_specs.ts  (rewrites v6 and v7). */
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalDigest } from "../convex/stagePredictionContract";
import { trajectoryTaskDefinitionDigest } from "../convex/trajectoryReview";
import { normalizeStageSpec } from "../src/lib/stage-spec";

const dir = new URL("../data/stage-review/", import.meta.url);
type Mode = { id: string; name?: string; description: string };
type Spec = any; // eslint-disable-line @typescript-eslint/no-explicit-any

function replaceOnce(text: string, from: string, to: string): string {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`expected exactly one match for ${JSON.stringify(from.slice(0, 60))}, found ${n}`);
  return text.replace(from, to);
}
function insertAfter(list: string[], after: string, id: string, label: string) {
  const i = list.indexOf(after);
  if (i < 0 || list.includes(id)) throw new Error(`${label}: cannot insert ${id}`);
  list.splice(i + 1, 0, id);
}
const mode = (spec: Spec, id: string): Mode => spec.trajectory.task_definition.failureModes.find((m: Mode) => m.id === id);
const rule = (spec: Spec, id: string) => spec.trajectory.task_definition.decisionRules.find((r: { id: string }) => r.id === id);

/** Bump the version strings and add one failure mode after `after` everywhere it is enumerated. */
function addMode(prev: Spec, from: string, to: string, after: string, added: Mode): Spec {
  const spec = structuredClone(prev);
  spec.taxonomy_version = replaceOnce(spec.taxonomy_version, `routing_d1/${from}`, `routing_d1/${to}`);
  const def = spec.trajectory.task_definition;
  def.taxonomyVersion = replaceOnce(def.taxonomyVersion, `routing_d1/${from}`, `routing_d1/${to}`);
  insertAfter(spec.failure_modes, after, added.id, "failure_modes");
  const modes = def.failureModes as Mode[];
  modes.splice(modes.indexOf(mode(spec, after)) + 1, 0, added);
  const props = spec.trajectory.response_schema.properties;
  props.taxonomy_version.enum = [`routing_d1/${to}`];
  insertAfter(props.failure_events.items.properties.failure_mode_id.enum, after, added.id, "failure_events enum");
  insertAfter(props.primary_failure.properties.failure_mode_id.enum, after, added.id, "primary_failure enum");
  return spec;
}

async function seal(spec: Spec, version: string) {
  const leftover = JSON.stringify(spec).match(/routing_d1\/v\d+/g)?.filter((v) => v !== `routing_d1/${version}`);
  if (leftover?.length) throw new Error(`stale version references remain: ${leftover.join(", ")}`);
  spec.trajectory.task_definition_sha256 = await trajectoryTaskDefinitionDigest(normalizeStageSpec(spec).trajectory!.task_definition);
  delete spec.taxonomy_hash;
  spec.taxonomy_hash = await canonicalDigest(spec);
  writeFileSync(new URL(`routing_d1_${version}.spec.json`, dir), JSON.stringify(spec, null, 2));
  console.log(`routing_d1 ${version}: definition ${spec.trajectory.task_definition_sha256}, taxonomy ${spec.taxonomy_hash}`);
  return spec;
}

const v5 = JSON.parse(readFileSync(new URL("routing_d1_v5.spec.json", dir), "utf8"));

const v6 = addMode(v5, "v5", "v6", "first_clip_seating_incomplete", {
  id: "first_clip_pulled_out",
  name: "Left clip · pulled back out",
  description: "After the rope is fully seated in the LEFT clip, the robot itself pulls the seated rope back out of the LEFT clip instead of routing it onward to insert into the RIGHT clip — e.g. it grasps near the LEFT clip and lifts, drags, or backtracks so the seated segment is extracted. Require a visible prior full LEFT seat followed by gripper-driven extraction. Rope that slips out on its own or a partial-entry stall belongs to first_clip_seating_incomplete. Timestamp the visible onset of extraction. Subsequent restored secure LEFT seating recovers this event. A right-first insertion attempt still makes wrong_clip_order the terminal primary failure.",
});
mode(v6, "first_clip_seating_incomplete").description = replaceOnce(mode(v6, "first_clip_seating_incomplete").description,
  "it gets stuck partway, or comes out after partial or previously full seating.",
  "it gets stuck partway, or comes out after partial or previously full seating. A fully seated LEFT rope that the robot itself pulls back out belongs to first_clip_pulled_out instead.");
rule(v6, "clip_owned_grasp_failures").rule = replaceOnce(rule(v6, "clip_owned_grasp_failures").rule,
  "which uses that physical clip's seating_incomplete category, even if it comes out during work at the other clip.",
  "which uses that physical clip's seating_incomplete category, even if it comes out during work at the other clip; a fully seated LEFT rope that the gripper itself pulls back out uses first_clip_pulled_out.");
rule(v6, "failure_timing").rule = replaceOnce(rule(v6, "failure_timing").rule,
  "not the earlier successful entry or episode end.",
  "not the earlier successful entry or episode end; for first_clip_pulled_out, timestamp the onset of the robot's extraction.");
await seal(v6, "v6");

const v7 = addMode(v6, "v6", "v7", "second_clip_grasp_lost", {
  id: "second_clip_rope_slack_insufficient",
  name: "Right clip · not enough rope slack",
  description: "With the rope fully seated in the LEFT clip, the robot regrasps it for RIGHT-clip work but secures too little free rope (e.g. grasps too close to the LEFT clip or never draws slack through it) before moving toward the RIGHT clip. Because the rope cannot slide through the seated LEFT clip, rope tension holds the gripper back and the robot stalls short of, or cannot complete its attempt at, the RIGHT clip despite actively trying. Require a visible prior full LEFT seat, a RIGHT-phase grasp, and visible tension-limited progress toward RIGHT (taut rope from the LEFT clip to the gripper while arm progress stalls). Timestamp the onset of the tension stall. A later regrasp that secures enough free rope and reaches the RIGHT clip recovers this event. If the tension then extracts the rope from the LEFT clip, record first_clip_pulled_out as a separate event; if the rope slips from the gripper, record second_clip_grasp_lost.",
});
mode(v7, "second_clip_engagement_missed").description = replaceOnce(mode(v7, "second_clip_engagement_missed").description,
  "Mere spanning, approach, or overlap is insufficient evidence of failure.",
  "Mere spanning, approach, or overlap is insufficient evidence of failure. An attempt held back by a taut rope from the seated LEFT clip belongs to second_clip_rope_slack_insufficient instead.");
mode(v7, "second_clip_not_attempted").description = replaceOnce(mode(v7, "second_clip_not_attempted").description,
  "Use only when no more specific unrecovered grasp or clip failure is visible.",
  "Use only when no more specific unrecovered grasp or clip failure is visible; a RIGHT approach stalled by rope tension is second_clip_rope_slack_insufficient.");
rule(v7, "failure_timing").rule = replaceOnce(rule(v7, "failure_timing").rule,
  "for first_clip_pulled_out, timestamp the onset of the robot's extraction.",
  "for first_clip_pulled_out, timestamp the onset of the robot's extraction; for second_clip_rope_slack_insufficient, timestamp the onset of the tension stall.");
await seal(v7, "v7");
