export interface ParsedWandbModelId {
  entity: string;
  project: string;
  name: string;
  version: string | null;
  runId: string | null;
  /** Deep link to the producing run, when a run id can be recovered. */
  runUrl: string | null;
  /** Always available fallback when the run id is unknown. */
  projectUrl: string;
}

function splitOnLast(s: string, sep: string): [string, string | null] {
  const idx = s.lastIndexOf(sep);
  if (idx === -1) return [s, null];
  return [s.slice(0, idx), s.slice(idx + 1)];
}

/**
 * Parse a `wandb://entity/project/artifact-name:version` model id, returning
 * null for ids that aren't wandb URIs.
 *
 * Our artifact names embed the producing run id (an 8-char [a-z0-9] token)
 * immediately before a trailing `-final` segment, e.g.
 * `...-imagenet-mlqfg361-final`. When present we can deep-link to the run page;
 * otherwise (e.g. checkpoint-style names) we fall back to the project page.
 */
export function parseWandbModelId(modelId: string): ParsedWandbModelId | null {
  const prefix = "wandb://";
  if (!modelId.startsWith(prefix)) return null;

  const [path, version] = splitOnLast(modelId.slice(prefix.length), ":");
  const segments = path.split("/");
  if (segments.length < 3) return null;

  const [entity, project, ...nameParts] = segments;
  const name = nameParts.join("/");
  const projectUrl = `https://wandb.ai/${entity}/${project}`;

  const runMatch = name.match(/([a-z0-9]{8})-final$/);
  const runId = runMatch ? runMatch[1] : null;
  const runUrl = runId ? `${projectUrl}/runs/${runId}` : null;

  return { entity, project, name, version, runId, runUrl, projectUrl };
}
