import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";

export function EpisodeNotes({ repoId, episodeIndex }: { repoId: string; episodeIndex: number }) {
  const args = { dataset_repo: repoId, episode_index: BigInt(episodeIndex) };
  const saved = useQuery(api.reviews.episodeNotes, args);
  const saveNotes = useMutation(api.reviews.saveNotes);
  // Keep drafts and failed saves when navigating between episodes.
  const key = JSON.stringify([repoId, episodeIndex]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const notes = drafts[key] ?? saved?.notes ?? "";
  const dirty = notes !== (saved?.notes ?? "");

  useEffect(() => {
    if (Object.keys(drafts).length === 0 && !Object.values(saving).some(Boolean)) return;
    const warnUnsaved = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnUnsaved);
    return () => window.removeEventListener("beforeunload", warnUnsaved);
  }, [drafts, saving]);

  async function save() {
    if (!dirty || saving[key] || saved === undefined) return;
    setSaving((prev) => ({ ...prev, [key]: true }));
    setErrors((prev) => ({ ...prev, [key]: "" }));
    try {
      await saveNotes({ ...args, notes });
      setDrafts((prev) => {
        if (prev[key] !== notes) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } catch (error) {
      setErrors((prev) => ({ ...prev, [key]: String(error) }));
    } finally {
      setSaving((prev) => ({ ...prev, [key]: false }));
    }
  }

  return (
    <div className="mt-4 rounded-lg border border-warm-200 p-3">
      <div className="flex items-center justify-between gap-3 mb-2">
        <label htmlFor="episode-notes" className="text-xs font-medium text-ink">
          Notes <span className="font-normal text-ink-muted">(optional)</span>
        </label>
        <button
          type="button"
          disabled={saved === undefined || !dirty || saving[key]}
          onClick={() => void save()}
          className="text-xs text-teal cursor-pointer disabled:text-ink-muted disabled:cursor-default"
        >
          {saved === undefined ? "Loading…" : saving[key] ? "Saving…" : dirty ? "Save notes" : "Saved"}
        </button>
      </div>
      <textarea
        id="episode-notes"
        rows={2}
        value={notes}
        disabled={saved === undefined}
        placeholder="Leave a note to revisit later…"
        aria-describedby="episode-notes-help"
        onChange={(event) => {
          const value = event.target.value;
          setDrafts((prev) => {
            const next = { ...prev, [key]: value };
            if (value === (saved?.notes ?? "") && !saving[key]) delete next[key];
            return next;
          });
        }}
        onBlur={() => void save()}
        className="w-full resize-y rounded-lg border border-warm-200 bg-white px-3 py-2 text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:border-teal"
      />
      <p id="episode-notes-help" className="mt-1 text-[11px] text-ink-muted">
        Saved automatically when you leave this field. Notes stay in Policy Arena.
      </p>
      {Object.entries(errors).filter(([, error]) => error).map(([failedKey, error]) => (
        <p key={failedKey} role="alert" className="mt-2 text-xs text-coral">
          Could not save notes for episode {JSON.parse(failedKey)[1]}: {error}. Return to that episode to retry.
        </p>
      ))}
    </div>
  );
}
