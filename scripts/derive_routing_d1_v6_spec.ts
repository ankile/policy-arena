/** One-shot derivation of routing_d1 v6 from the released v5 snapshot.
 * v6 = v5 + one additive failure mode, first_clip_pulled_out (the robot pulls
 * the rope back out of a fully seated LEFT clip instead of routing it onward
 * to the RIGHT clip), plus the boundary text that keeps it disjoint from
 * first_clip_seating_incomplete. Hashes are recomputed with the same digest
 * functions the Convex upsert and the release script verify against.
 * Usage: bun scripts/derive_routing_d1_v6_spec.ts  (rewrites the v6 file). */
import { readFileSync, writeFileSync } from "node:fs";
import { canonicalDigest } from "../convex/stagePredictionContract";
import { trajectoryTaskDefinitionDigest } from "../convex/trajectoryReview";
import { normalizeStageSpec } from "../src/lib/stage-spec";

const dir = new URL("../data/stage-review/", import.meta.url);
const spec = JSON.parse(readFileSync(new URL("routing_d1_v5.spec.json", dir), "utf8"));
const NEW_ID = "first_clip_pulled_out";
const AFTER = "first_clip_seating_incomplete";

function replaceOnce(text: string, from: string, to: string): string {
  const n = text.split(from).length - 1;
  if (n !== 1) throw new Error(`expected exactly one match for ${JSON.stringify(from.slice(0, 60))}, found ${n}`);
  return text.replace(from, to);
}
function insertAfter(list: string[], label: string) {
  const i = list.indexOf(AFTER);
  if (i < 0 || list.includes(NEW_ID)) throw new Error(`${label}: cannot insert ${NEW_ID}`);
  list.splice(i + 1, 0, NEW_ID);
}

spec.taxonomy_version = replaceOnce(spec.taxonomy_version, "routing_d1/v5", "routing_d1/v6");
insertAfter(spec.failure_modes, "failure_modes");
const def = spec.trajectory.task_definition;
def.taxonomyVersion = replaceOnce(def.taxonomyVersion, "routing_d1/v5", "routing_d1/v6");

const modes = def.failureModes;
const seating = modes.find((m: { id: string }) => m.id === AFTER);
seating.description = replaceOnce(seating.description,
  "it gets stuck partway, or comes out after partial or previously full seating.",
  "it gets stuck partway, or comes out after partial or previously full seating. A fully seated LEFT rope that the robot itself pulls back out belongs to first_clip_pulled_out instead.");
modes.splice(modes.indexOf(seating) + 1, 0, {
  id: NEW_ID,
  name: "Left clip · pulled back out",
  description: "After the rope is fully seated in the LEFT clip, the robot itself pulls the seated rope back out of the LEFT clip instead of routing it onward to insert into the RIGHT clip — e.g. it grasps near the LEFT clip and lifts, drags, or backtracks so the seated segment is extracted. Require a visible prior full LEFT seat followed by gripper-driven extraction. Rope that slips out on its own or a partial-entry stall belongs to first_clip_seating_incomplete. Timestamp the visible onset of extraction. Subsequent restored secure LEFT seating recovers this event. A right-first insertion attempt still makes wrong_clip_order the terminal primary failure.",
});

const rules = def.decisionRules as { id: string; rule: string }[];
const rule = (id: string) => rules.find((r) => r.id === id)!;
rule("clip_owned_grasp_failures").rule = replaceOnce(rule("clip_owned_grasp_failures").rule,
  "which uses that physical clip's seating_incomplete category, even if it comes out during work at the other clip.",
  "which uses that physical clip's seating_incomplete category, even if it comes out during work at the other clip; a fully seated LEFT rope that the gripper itself pulls back out uses first_clip_pulled_out.");
rule("failure_timing").rule = replaceOnce(rule("failure_timing").rule,
  "not the earlier successful entry or episode end.",
  "not the earlier successful entry or episode end; for first_clip_pulled_out, timestamp the onset of the robot's extraction.");

const schemaProps = spec.trajectory.response_schema.properties;
schemaProps.taxonomy_version.enum = ["routing_d1/v6"];
insertAfter(schemaProps.failure_events.items.properties.failure_mode_id.enum, "failure_events enum");
insertAfter(schemaProps.primary_failure.properties.failure_mode_id.enum, "primary_failure enum");

const leftover = JSON.stringify(spec).match(/routing_d1\/v5/g);
if (leftover) throw new Error(`stale v5 references remain: ${leftover.length}`);
spec.trajectory.task_definition_sha256 = await trajectoryTaskDefinitionDigest(normalizeStageSpec(spec).trajectory!.task_definition);
delete spec.taxonomy_hash;
spec.taxonomy_hash = await canonicalDigest(spec);
writeFileSync(new URL("routing_d1_v6.spec.json", dir), JSON.stringify(spec, null, 2));
console.log(`routing_d1 v6: definition ${spec.trajectory.task_definition_sha256}, taxonomy ${spec.taxonomy_hash}`);
