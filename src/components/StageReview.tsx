import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import {
  validateStageLabel,
  type ExportedStageSpec,
  type StageLabelRow,
} from "../../convex/stageConsistency";
import {
  explorerCameraKeys,
  fetchAppliedProgress,
  fetchEpisodeFrameSignals,
  fetchLabelHistory,
  fetchLedgerArms,
  fetchReviewEpisodes,
  selectPrimaryCameraKey,
  type AppliedProgress,
  type EpisodeFrameSignals,
  type LabelEvent,
  type ReviewEpisode,
} from "../lib/hf-api";
import { normalizeStageSpec } from "../lib/stage-spec";
import { useSearchParam, useSearchParamNumber } from "../lib/useSearchParam";
import { EvidencePanel, type StagePrefillView } from "./review/EvidencePanel";
import { HelpOverlay } from "./review/HelpOverlay";
import { LabelHistoryPanel } from "./review/LabelHistoryPanel";
import { ReviewViewer, type ViewerControls } from "./review/ReviewViewer";
import { StageLabelForm } from "./review/StageLabelForm";
import {
  cameraRoleForVideoKey,
  clamp,
  formatClock,
  orderCameraKeys,
  type CropBox,
} from "./review/format";
import { isTypingTarget, useWindowKeydown } from "./review/useWindowKeydown";

// ---------------------------------------------------------------------------
// Stage-label review (Phase 2). Web successor to the cv2 CorrectionUIServer:
// per (episode, taxonomy_version) the surface shows the CURRENT label — the
// reviewer's own committed row if one exists, else the labeling pipeline's
// most recent prediction (stagePrefills) — and captures verdicts into the
// append-only stageReviews table. The form, its instant consistency feedback,
// and the fps math are all driven by the EXPORTED spec (stageTaskSpecs); no
// task names or field names appear below.
//
// Blind mode is ON by default: the stage-bucket protocol forbids policy/arm
// identity from influencing labels, so arm data is not even FETCHED while
// blind (single data-layer choke point, not per-render discipline).
// ---------------------------------------------------------------------------

type StatusFilter = "unreviewed" | "draft" | "confirmed" | "corrected" | "uncertain" | "all";

interface StageReviewRecord {
  episodeIndex: number;
  status: string;
  label: StageLabelRow | null;
  reviewer: string;
  savedAt: number;
  blind: boolean;
}

const STATUS_GLYPH: Record<string, string> = {
  confirmed: "✓",
  corrected: "✎",
  uncertain: "?",
  draft: "…",
};

const CONFIDENCE_DOT: Record<string, string> = {
  high: "bg-teal",
  medium: "bg-gold",
  low: "bg-coral",
};

const OUTCOME_CHIP: Record<string, string> = {
  success: "bg-teal-light text-teal",
  failure: "bg-coral-light text-coral",
  timeout: "bg-gold-light text-gold",
};

/**
 * The outcome-editor decision for an episode. Stage labeling is GATED on the
 * outcome flow having run first: `null` outcome under source "detected" means
 * the decision was keep-as-is (a skip) and the dataset's own frame signals are
 * still loading for the selected episode.
 */
interface ResolvedOutcome {
  outcome: string | null;
  source: "review" | "applied" | "detected";
}

const HELP_KEYS: [string, string][] = [
  ["← / →", "step 1 frame (shift: 10)"],
  ["[ / ]", "step 30 frames"],
  ["Home / End", "first / last frame"],
  ["space", "play / pause"],
  ["0–9", "set the stage rung"],
  ["- / =", "decrement / increment the stage (covers S10)"],
  ["c", "confirm: episode fully annotated (gold-eligible) + advance"],
  ["u", "uncertain: reviewed but not gold-eligible + advance"],
  ["e", "toggle the model-evidence rail"],
  ["n", "next episode (drafts unsaved edits)"],
  ["p / b", "previous episode in the queue"],
  ["q / Esc", "exit stage review"],
  ["?", "toggle this help"],
];

export default function StageReview({
  repoId,
  task,
  onExit,
  onOpenOutcomeReview,
}: {
  repoId: string;
  task?: string;
  onExit: () => void;
  /** Jump to outcome review for this dataset (episode param carries over). */
  onOpenOutcomeReview: () => void;
}) {
  const viewer = useQuery(api.users.viewer);
  const specRows = useQuery(api.stageTaskSpecs.forTask, task ? { task } : "skip");
  const taskSpec = useQuery(api.taskSpecs.forTask, task ? { task } : "skip");
  const saveReview = useMutation(api.stageReviews.save);
  // Stage labeling is gated on the outcome-editor flow: every episode must
  // carry an outcome decision (web review, or the applied HF record) BEFORE it
  // may be stage-labeled — and a successful outcome seeds the stage prefill.
  const outcomeReviews = useQuery(api.reviews.latestForRepo, { dataset_repo: repoId });

  // -- Taxonomy (schema) selection: live by default, candidates addressable --
  const [schemaParam, setSchemaParam] = useSearchParam("schema", "");
  const liveRow = specRows?.find((row) => row.live) ?? null;
  // A stale/typo'd ?schema= must not strand the surface on a loading card
  // with no selector on screen — fall back to the live row, loudly.
  const schemaFellBack = Boolean(
    schemaParam && specRows !== undefined &&
      !specRows.some((row) => row.taxonomy_version === schemaParam)
  );
  const specRow =
    (schemaParam && !schemaFellBack
      ? specRows?.find((row) => row.taxonomy_version === schemaParam)
      : liveRow) ?? null;
  // A malformed spec payload must render as a banner, not a render-throw that
  // white-screens the app (there is no ErrorBoundary above us).
  const specResult = useMemo<{ spec: ExportedStageSpec | null; error: string | null }>(() => {
    if (!specRow) return { spec: null, error: null };
    try {
      return { spec: normalizeStageSpec(specRow.spec), error: null };
    } catch (err) {
      return { spec: null, error: (err as Error).message };
    }
  }, [specRow]);
  const spec = specResult.spec;
  const taxonomyVersion = spec?.taxonomy_version ?? null;

  const reviews = useQuery(
    api.stageReviews.latestForRepo,
    taxonomyVersion ? { dataset_repo: repoId, taxonomy_version: taxonomyVersion } : "skip"
  );
  const prefillRows = useQuery(
    api.stagePrefills.forRepo,
    taxonomyVersion ? { dataset_repo: repoId, taxonomy_version: taxonomyVersion } : "skip"
  );

  // -- Blind mode (default ON): policy/arm identity hidden AND unfetched -----
  const [blindParam, setBlindParam] = useSearchParam("blind", "1");
  const blind = blindParam !== "0";

  // -- Queue filters (stage-prefixed params; REPLACE_KEYS members) ----------
  const [statusFilter, setStatusFilter] = useSearchParam("sstatus", "unreviewed");
  const [confFilter, setConfFilter] = useSearchParam("sconf", "all");
  const [flagFilter, setFlagFilter] = useSearchParam("sflag", "all");
  const [armFilter, setArmFilter] = useSearchParam("sarm", "all");
  const [selectedEpisode, setSelectedEpisode] = useSearchParamNumber("episode");

  // -- HF loads ---------------------------------------------------------------
  const [episodes, setEpisodes] = useState<ReviewEpisode[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [labelHistory, setLabelHistory] = useState<LabelEvent[] | null | undefined>(undefined);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [ledgerArms, setLedgerArms] = useState<Map<number, string> | null>(null);
  const [ledgerError, setLedgerError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect -- imperative reset of
       fetch state on repo change, not derived render state (same pattern as
       OutcomeReview). */
    setEpisodes(null);
    setLoadError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    fetchReviewEpisodes(repoId)
      .then((result) => {
        if (!cancelled) setEpisodes(result);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  useEffect(() => {
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect -- imperative fetch-state reset. */
    setLabelHistory(undefined);
    setHistoryError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    fetchLabelHistory(repoId)
      .then((events) => {
        if (!cancelled) setLabelHistory(events);
      })
      .catch((err: Error) => {
        if (!cancelled) setHistoryError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  useEffect(() => {
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect -- imperative fetch-state reset. */
    setLedgerArms(null);
    setLedgerError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    if (blind) return; // data-layer redaction: never even fetch arm identity
    fetchLedgerArms(repoId)
      .then((arms) => {
        if (!cancelled) setLedgerArms(arms);
      })
      .catch((err: Error) => {
        if (!cancelled) setLedgerError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, blind]);

  // -- Outcome gate: the applied HF outcome-edit record (cv2-era + worker
  // applies) complements the web outcome-review ledger. Tri-state like
  // OutcomeReview: undefined = loading, null = never treated.
  const [applied, setApplied] = useState<AppliedProgress | null | undefined>(undefined);
  const [appliedError, setAppliedError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    /* eslint-disable react-hooks/set-state-in-effect -- imperative fetch-state reset. */
    setApplied(undefined);
    setAppliedError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    fetchAppliedProgress(repoId)
      .then((progress) => {
        if (!cancelled) setApplied(progress);
      })
      .catch((err: Error) => {
        // Fail CLOSED but loud: episodes whose only outcome decision lives in
        // the unreadable applied record stay gated until it loads.
        if (!cancelled) setAppliedError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId]);

  // Frame signals, fetched lazily for the SELECTED episode only — needed to
  // resolve the outcome of a keep-as-is (skip) decision, whose recorded
  // outcome is whatever the dataset's own reward/done signals say.
  const [outcomeSignals, setOutcomeSignals] = useState<Map<number, EpisodeFrameSignals>>(
    () => new Map()
  );
  const [outcomeSignalErrors, setOutcomeSignalErrors] = useState<Map<number, string>>(
    () => new Map()
  );

  const outcomeByEpisode = useMemo(() => {
    const map = new Map<number, { status: string; newOutcome: string | null }>();
    for (const row of outcomeReviews?.episodes ?? []) {
      map.set(Number(row.episode_index), {
        status: row.status,
        newOutcome: (row.new_outcome as string | undefined) ?? null,
      });
    }
    return map;
  }, [outcomeReviews]);

  // Ready once both outcome sources settled (an applied-record load ERROR
  // counts as settled: the gate then fails closed with a loud banner).
  const outcomeGateReady =
    outcomeReviews !== undefined && (applied !== undefined || appliedError !== null);

  // The episode's outcome decision, or null when the outcome flow has not been
  // run on it yet (⇒ stage labeling is blocked for that episode).
  const resolveOutcome = useCallback(
    (episodeIndex: number): ResolvedOutcome | null => {
      const web = outcomeByEpisode.get(episodeIndex);
      if (web?.status === "confirmed" && web.newOutcome !== null) {
        return { outcome: web.newOutcome, source: "review" };
      }
      const appliedRecord = applied?.changed.get(episodeIndex);
      if (appliedRecord !== undefined) {
        return { outcome: appliedRecord.newOutcome, source: "applied" };
      }
      if (web !== undefined || applied?.skipped.has(episodeIndex)) {
        // keep-as-is decision — the outcome is the dataset's detected signals
        return {
          outcome: outcomeSignals.get(episodeIndex)?.detectedOutcome ?? null,
          source: "detected",
        };
      }
      return null;
    },
    [outcomeByEpisode, applied, outcomeSignals]
  );

  // -- Convex rows -> typed views ---------------------------------------------
  const prefillByEpisode = useMemo(() => {
    const map = new Map<number, StagePrefillView>();
    for (const row of prefillRows ?? []) {
      map.set(Number(row.episode_index), {
        label: row.label as Record<string, unknown>,
        reviewReason: row.review_reason ?? null,
        violationCodes: row.violation_codes ?? [],
        confidence: row.confidence ?? null,
        voteSummary: (row.vote_summary as Record<string, unknown> | undefined) ?? null,
        episodeDurationS: row.episode_duration_s ?? null,
        pipeline: row.pipeline,
        evidence: row.evidence as Record<string, unknown>,
        pushedAt: row.pushed_at,
      });
    }
    return map;
  }, [prefillRows]);

  // Only the signed-in reviewer's OWN rows prefill/queue — blinded double
  // labeling means another reviewer's decision must never leak into the form.
  const ownReviewByEpisode = useMemo(() => {
    const map = new Map<number, StageReviewRecord>();
    const username = viewer?.username;
    if (!username) return map;
    for (const row of reviews?.episodes ?? []) {
      if (row.reviewer !== username) continue;
      map.set(Number(row.episode_index), {
        episodeIndex: Number(row.episode_index),
        status: row.status,
        label: (row.label as StageLabelRow | undefined) ?? null,
        reviewer: row.reviewer,
        savedAt: row.saved_at,
        blind: row.blind ?? false,
      });
    }
    return map;
  }, [reviews, viewer]);

  // Other reviewers' latest rows — surfaced ONLY under the "Needs
  // adjudication" filter (an annotator presses uncertain to hand an episode
  // off; the adjudicator deliberately unblinds to their progress + notes).
  const otherReviewsByEpisode = useMemo(() => {
    const map = new Map<number, StageReviewRecord[]>();
    const username = viewer?.username;
    for (const row of reviews?.episodes ?? []) {
      if (username && row.reviewer === username) continue;
      const ep = Number(row.episode_index);
      map.set(ep, [
        ...(map.get(ep) ?? []),
        {
          episodeIndex: ep,
          status: row.status,
          label: (row.label as StageLabelRow | undefined) ?? null,
          reviewer: row.reviewer,
          savedAt: row.saved_at,
          blind: row.blind ?? false,
        },
      ]);
    }
    return map;
  }, [reviews, viewer]);

  const historyByEpisode = useMemo(() => {
    const byEpisode = new Map<number, LabelEvent[]>();
    for (const event of labelHistory ?? []) {
      const list = byEpisode.get(event.episode_index);
      if (list) list.push(event);
      else byEpisode.set(event.episode_index, [event]);
    }
    for (const list of byEpisode.values()) {
      list.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    }
    return byEpisode;
  }, [labelHistory]);

  // -- Queue -------------------------------------------------------------------
  const armOptions = useMemo(
    () => (ledgerArms ? [...new Set(ledgerArms.values())].sort() : []),
    [ledgerArms]
  );

  const flagCount = useCallback(
    (episodeIndex: number): number => {
      const reason = prefillByEpisode.get(episodeIndex)?.reviewReason;
      return reason ? reason.split(";").filter((r) => r.trim()).length : 0;
    },
    [prefillByEpisode]
  );

  // Episodes the outcome flow has not addressed yet — gated out of the queue.
  const awaitingOutcome = useMemo(() => {
    if (!episodes || !outcomeGateReady) return [];
    return episodes
      .filter((episode) => resolveOutcome(episode.episodeIndex) === null)
      .map((episode) => episode.episodeIndex);
  }, [episodes, outcomeGateReady, resolveOutcome]);

  const filteredEpisodes = useMemo(() => {
    if (!episodes) return [];
    // The outcome gate must settle before the queue exists at all — an
    // ungated flash would let a verdict land on an episode that later turns
    // out to lack its outcome decision.
    if (!outcomeGateReady) return [];
    let result = episodes.filter(
      (episode) => resolveOutcome(episode.episodeIndex) !== null
    );
    if (statusFilter === "adjudicate") {
      result = result.filter((episode) =>
        (otherReviewsByEpisode.get(episode.episodeIndex) ?? []).some(
          (r) => r.status === "uncertain"
        )
      );
    } else if (statusFilter !== "all") {
      result = result.filter((episode) => {
        const own = ownReviewByEpisode.get(episode.episodeIndex);
        if (statusFilter === "unreviewed") return own === undefined || own.status === "draft";
        return own?.status === statusFilter;
      });
    }
    if (confFilter !== "all") {
      result = result.filter(
        (episode) => prefillByEpisode.get(episode.episodeIndex)?.confidence === confFilter
      );
    }
    if (flagFilter === "flagged") {
      result = result.filter((episode) => flagCount(episode.episodeIndex) > 0);
    } else if (flagFilter === "unflagged") {
      result = result.filter((episode) => flagCount(episode.episodeIndex) === 0);
    }
    if (!blind && armFilter !== "all" && ledgerArms && armOptions.includes(armFilter)) {
      result = result.filter(
        (episode) => ledgerArms.get(episode.episodeIndex) === armFilter
      );
    }
    // Flagged-first (by flag count), then low confidence first, then index.
    const confRank: Record<string, number> = { low: 0, medium: 1, high: 2 };
    return [...result].sort((a, b) => {
      const flagDelta = flagCount(b.episodeIndex) - flagCount(a.episodeIndex);
      if (flagDelta !== 0) return flagDelta;
      const confA = confRank[prefillByEpisode.get(a.episodeIndex)?.confidence ?? ""] ?? 3;
      const confB = confRank[prefillByEpisode.get(b.episodeIndex)?.confidence ?? ""] ?? 3;
      if (confA !== confB) return confA - confB;
      return a.episodeIndex - b.episodeIndex;
    });
  }, [
    episodes,
    outcomeGateReady,
    resolveOutcome,
    statusFilter,
    confFilter,
    flagFilter,
    armFilter,
    blind,
    ledgerArms,
    armOptions,
    ownReviewByEpisode,
    otherReviewsByEpisode,
    prefillByEpisode,
    flagCount,
  ]);

  const currentEpisode = useMemo(
    () => episodes?.find((episode) => episode.episodeIndex === selectedEpisode) ?? null,
    [episodes, selectedEpisode]
  );
  const currentPrefill =
    selectedEpisode !== null ? (prefillByEpisode.get(selectedEpisode) ?? null) : null;

  // undefined = outcome gate still loading; null = outcome flow never ran on
  // this episode (stage labeling blocked).
  const currentResolvedOutcome =
    selectedEpisode !== null && outcomeGateReady
      ? resolveOutcome(selectedEpisode)
      : undefined;
  const currentOutcomeSignalError =
    selectedEpisode !== null ? (outcomeSignalErrors.get(selectedEpisode) ?? null) : null;

  // A keep-as-is (skip) decision needs the episode's own frame signals to name
  // its outcome — fetch them for the selected episode only (per-file cached).
  useEffect(() => {
    if (
      !currentEpisode ||
      currentResolvedOutcome?.source !== "detected" ||
      currentResolvedOutcome.outcome !== null ||
      outcomeSignalErrors.has(currentEpisode.episodeIndex)
    ) {
      return;
    }
    let cancelled = false;
    fetchEpisodeFrameSignals(repoId, currentEpisode.dataPath, currentEpisode.episodeIndex)
      .then((result) => {
        if (!cancelled) {
          setOutcomeSignals((prev) => new Map(prev).set(currentEpisode.episodeIndex, result));
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setOutcomeSignalErrors((prev) =>
            new Map(prev).set(currentEpisode.episodeIndex, err.message)
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [currentEpisode, currentResolvedOutcome, outcomeSignalErrors, repoId]);

  useEffect(() => {
    if (selectedEpisode !== null) return;
    const head = filteredEpisodes[0];
    if (head) setSelectedEpisode(head.episodeIndex);
  }, [selectedEpisode, filteredEpisodes, setSelectedEpisode]);

  // -- Cameras (same resolution as OutcomeReview, from the lifecycle spec) -----
  const cameraKeys = useMemo(() => {
    if (!currentEpisode) return [];
    const all = orderCameraKeys(explorerCameraKeys(Object.keys(currentEpisode.perCamera)));
    const roles = taskSpec?.review_camera_roles;
    if (roles == null || roles.length === 0) return all;
    const keysByRole = taskSpec!.camera_keys_by_role;
    const selected = roles
      .map((role) => all.find((key) => cameraRoleForVideoKey(key, keysByRole) === role))
      .filter((key): key is string => key !== undefined);
    return selected.length > 0 ? selected : all;
  }, [currentEpisode, taskSpec]);
  const primaryKey = useMemo(
    () => (cameraKeys.length > 0 ? selectPrimaryCameraKey(cameraKeys) : ""),
    [cameraKeys]
  );
  const storedFrameHW = useMemo<[number, number] | null>(
    () =>
      taskSpec != null
        ? [Number(taskSpec.stored_frame_hw[0]), Number(taskSpec.stored_frame_hw[1])]
        : null,
    [taskSpec]
  );
  const cropByCameraKey = useMemo<Record<string, CropBox> | null>(() => {
    if (taskSpec == null) return null;
    const keysByRole = taskSpec.camera_keys_by_role;
    const map: Record<string, CropBox> = {};
    for (const key of cameraKeys) {
      const role = cameraRoleForVideoKey(key, keysByRole);
      const box = role !== null ? taskSpec.crop_boxes[role] : undefined;
      if (box !== undefined) map[key] = box.map(Number) as CropBox;
    }
    return map;
  }, [taskSpec, cameraKeys]);


  // -- Working state ------------------------------------------------------------
  const [pending, setPending] = useState<StageLabelRow | null>(null);
  const [frame, setFrame] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [viewerDrift, setViewerDrift] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  // Browser cannot verify seek landings (no requestVideoFrameCallback):
  // committed verdicts are blocked — marks would be unverified gold times.
  const [unverifiable, setUnverifiable] = useState(false);
  // A failed background draft save must persist (episode-tagged), not be
  // wiped by the next episode's reset like actionError is.
  const [draftError, setDraftError] = useState<string | null>(null);
  // What the reviewer was actually SHOWN at prefill time — a mid-session
  // prefill re-publish must not silently repoint prefill_pushed_at/duration.
  const [shownPrefill, setShownPrefill] = useState<{
    pushedAt: number;
    durationS: number | null;
  } | null>(null);
  // The form was seeded from a SUCCESS outcome decision (top rung + success
  // final state + failure mode none) — surfaced as a chip so the reviewer
  // knows why those fields arrived pre-set.
  const [inheritedSuccess, setInheritedSuccess] = useState(false);

  // The blind flag on saved rows is an attestation about the SESSION, not the
  // toggle's momentary position: once unblinded, rows stop claiming blind.
  const everUnblindedRef = useRef(false);
  useEffect(() => {
    if (!blind) everUnblindedRef.current = true;
  }, [blind]);
  const controlsRef = useRef<ViewerControls | null>(null);
  const prefilledFor = useRef<number | null>(null);

  // Selection/schema change: immediately clear the previous episode's state.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- imperative reset of
       working state on selection change, not derived render state. */
    setPending(null);
    setFrame(0);
    setDirty(false);
    setViewerDrift(null);
    setActionError(null);
    setInheritedSuccess(false);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [selectedEpisode, taxonomyVersion]);

  // Prefill precedence: own latest row > pipeline prediction > empty; a
  // SUCCESS outcome decision then overlays the deterministic triple (top rung,
  // success final state, failure mode none) — timings stay manual.
  useEffect(() => {
    if (selectedEpisode === null || spec === null) return;
    // Both Convex sources must settle before prefilling (undefined = loading).
    if (reviews === undefined || prefillRows === undefined || viewer === undefined) return;
    // The outcome gate must settle too: the prefill depends on the decision.
    if (!outcomeGateReady) return;
    const resolved = resolveOutcome(selectedEpisode);
    if (resolved === null) return; // gated — the notice card renders instead
    if (
      resolved.source === "detected" &&
      resolved.outcome === null &&
      !outcomeSignalErrors.has(selectedEpisode)
    ) {
      return; // keep-as-is decision, signals still loading
    }
    if (prefilledFor.current === selectedEpisode && pending !== null) return;
    prefilledFor.current = selectedEpisode;
    const own = ownReviewByEpisode.get(selectedEpisode);
    const prefill = prefillByEpisode.get(selectedEpisode);
    /* eslint-disable react-hooks/set-state-in-effect -- the prefill is an
       imperative one-shot load of working state once async sources settle
       (guarded by prefilledFor), same pattern as OutcomeReview's prefill. */
    const loaded = own?.label ? { ...own.label } : prefill ? { ...prefill.label } : {};
    // Success inheritance: the human outcome decision outranks the pipeline
    // prediction on the triple, but never the reviewer's own saved row.
    const inherit = own === undefined && resolved.outcome === "success";
    if (inherit) {
      loaded[spec.stage_field] = spec.ladder.success_level;
      loaded[spec.final_state_field] = spec.success_final_state;
      loaded[spec.failure_mode_field] = "none";
    }
    setPending(loaded);
    setInheritedSuccess(inherit);
    setShownPrefill(
      prefill ? { pushedAt: prefill.pushedAt, durationS: prefill.episodeDurationS } : null
    );
    setDirty(false);
    setActionError(null);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [
    selectedEpisode,
    spec,
    reviews,
    prefillRows,
    viewer,
    outcomeGateReady,
    resolveOutcome,
    outcomeSignalErrors,
    ownReviewByEpisode,
    prefillByEpisode,
    pending,
  ]);

  // Duration for time-bounds: what was SHOWN at prefill time; for episodes the
  // pipeline never covered, the raw recording length is still a hard upper
  // bound (lenient — it includes the reset tail — but it catches a typed 999).
  const episodeDurationS =
    shownPrefill?.durationS ??
    (spec && currentEpisode ? currentEpisode.rawLength / spec.fps : null);

  const violations = useMemo(
    () => (spec && pending ? validateStageLabel(spec, pending, episodeDurationS) : []),
    [spec, pending, episodeDurationS]
  );

  const edit = useCallback((patch: StageLabelRow) => {
    setPending((prev) => {
      const next = { ...(prev ?? {}) };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) delete next[key];
        else next[key] = value;
      }
      return next;
    });
    setDirty(true);
    setActionError(null);
  }, []);

  const jumpToFrame = useCallback((next: number) => {
    controlsRef.current?.pause();
    setFrame(next);
  }, []);

  const seekTime = useCallback(
    (timeS: number) => {
      if (!currentEpisode || !spec) return;
      jumpToFrame(clamp(Math.round(timeS * spec.fps), 0, currentEpisode.rawLength - 1));
    },
    [currentEpisode, spec, jumpToFrame]
  );

  const stepFrame = useCallback(
    (delta: number) => {
      if (!currentEpisode) return;
      controlsRef.current?.pause();
      setFrame((prev) => clamp(prev + delta, 0, currentEpisode.rawLength - 1));
    },
    [currentEpisode]
  );

  // C1 (red-team): a mark taken while the displayed frame is unverified/
  // drifted becomes a wrong gold timestamp that survives after the drift
  // banner clears — refuse the mark itself, not just the later verdict.
  const markFrame = useCallback((): number | null => {
    if (viewerDrift !== null) {
      setActionError(
        "Frame drift detected — re-seek (arrow keys) until the banner clears before marking."
      );
      return null;
    }
    return controlsRef.current?.pause() ?? frame;
  }, [frame, viewerDrift]);

  // -- Save flow ------------------------------------------------------------------
  const doSave = useCallback(
    async (
      episodeIndex: number,
      status: string,
      label: StageLabelRow | null,
      { isDraft = false }: { isDraft?: boolean } = {}
    ): Promise<boolean> => {
      if (!spec || !task) return false;
      try {
        await saveReview({
          task,
          dataset_repo: repoId,
          episode_index: BigInt(episodeIndex),
          taxonomy_version: spec.taxonomy_version,
          status,
          label: label ?? undefined,
          prefill_pushed_at: shownPrefill?.pushedAt,
          blind: blind && !everUnblindedRef.current,
          episode_duration_s: episodeDurationS ?? undefined,
        });
        return true;
      } catch (err) {
        const message = `Episode ${episodeIndex}: ${(err as Error).message}`;
        if (isDraft) setDraftError(message);
        else setActionError(message);
        return false;
      }
    },
    [spec, task, saveReview, repoId, shownPrefill, blind, episodeDurationS]
  );

  const advance = useCallback(
    (fromIndex: number) => {
      const position = filteredEpisodes.findIndex(
        (episode) => episode.episodeIndex === fromIndex
      );
      if (position === -1) return;
      const next = filteredEpisodes[position + 1];
      if (next) setSelectedEpisode(next.episodeIndex);
    },
    [filteredEpisodes, setSelectedEpisode]
  );

  const verdict = useCallback(
    async (status: "confirmed" | "uncertain") => {
      if (selectedEpisode === null || saving || !spec) return;
      if (!outcomeGateReady || resolveOutcome(selectedEpisode) === null) {
        setActionError(
          `Episode ${selectedEpisode} has no outcome decision yet — the outcome ` +
            "review flow must run before stage labeling."
        );
        return;
      }
      if (prefilledFor.current !== selectedEpisode || pending === null) {
        setActionError(`Episode ${selectedEpisode} is still loading — wait for the prefill.`);
        return;
      }
      if (viewerDrift !== null) {
        setActionError(
          `Video/frame-counter drift detected (${viewerDrift}) — re-seek before a verdict; ` +
            "event times derive from the displayed frame."
        );
        return;
      }
      if (status !== "uncertain" && unverifiable) {
        setActionError(
          "This browser cannot verify seek landings (no requestVideoFrameCallback) — " +
            "committed verdicts need Chrome/Edge; you may still save as uncertain."
        );
        return;
      }
      if (status !== "uncertain" && cameraKeys.length === 0) {
        setActionError(
          "No reviewable camera streams — a committed verdict needs the video; " +
            "save as uncertain instead."
        );
        return;
      }
      // ALL verdicts are validator-gated (uncertain included — matching the
      // cv2 UI, which cleared review_status on a violating row). The escape
      // hatch for "I cannot make this consistent" is the draft autosave.
      if (violations.length > 0 && status !== "uncertain") {
        setActionError(
          `Cannot ${status}: ${violations.length} consistency violation(s) — fix them or save as uncertain.`
        );
        return;
      }
      setSaving(true);
      setActionError(null);
      const ok = await doSave(selectedEpisode, status, pending);
      setSaving(false);
      if (ok) {
        setDirty(false);
        advance(selectedEpisode);
      }
    },
    [
      selectedEpisode,
      saving,
      spec,
      outcomeGateReady,
      resolveOutcome,
      pending,
      viewerDrift,
      unverifiable,
      cameraKeys,
      violations,
      doSave,
      advance,
    ]
  );

  // Navigation with unsaved edits drafts them (lossless; drafts collapse
  // server-side, so this cannot grow the table unboundedly). Two exceptions:
  // while a verdict save is in flight navigation is refused entirely, and
  // edits over the reviewer's own COMMITTED verdict are discarded with a
  // notice — a stray keypress must not demote a committed row to a draft
  // (the server rejects such drafts too).
  const navigateTo = useCallback(
    (episodeIndex: number) => {
      if (saving) return;
      if (dirty && pending !== null && selectedEpisode !== null) {
        const own = ownReviewByEpisode.get(selectedEpisode);
        if (own && (own.status === "confirmed" || own.status === "corrected")) {
          setDraftError(
            `Episode ${selectedEpisode}: unsaved edits over your ${own.status} review were ` +
              "discarded — committed verdicts change only by re-confirming (c)."
          );
        } else {
          void doSave(selectedEpisode, "draft", pending, { isDraft: true });
        }
      }
      setSelectedEpisode(episodeIndex);
    },
    [saving, dirty, pending, selectedEpisode, ownReviewByEpisode, doSave, setSelectedEpisode]
  );

  // -- Keyboard ----------------------------------------------------------------
  function handleKey(event: KeyboardEvent) {
    if (isTypingTarget(event)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key;

    if (showHelp && (key === "Escape" || key === "q" || key === "?")) {
      event.preventDefault();
      setShowHelp(false);
      return;
    }
    if (key === "Escape" || key === "q") {
      event.preventDefault();
      onExit();
      return;
    }
    if (key === "?") {
      event.preventDefault();
      setShowHelp(true);
      return;
    }
    if (!currentEpisode || !spec) return;

    if (/^[0-9]$/.test(key)) {
      event.preventDefault();
      // A keystroke before the prefill lands would seed pending with a bare
      // stage and permanently suppress the prefill (its guard sees a non-null
      // pending) — the reviewer would label from a blank form unknowingly.
      if (pending === null) return;
      const stage = parseInt(key, 10);
      if (stage > spec.ladder.max_stage) {
        setActionError(`S${stage} is beyond this ladder (max S${spec.ladder.max_stage}).`);
      } else {
        edit({ [spec.stage_field]: stage });
      }
      return;
    }

    switch (key) {
      case "ArrowLeft":
        event.preventDefault();
        stepFrame(event.shiftKey ? -10 : -1);
        return;
      case "ArrowRight":
        event.preventDefault();
        stepFrame(event.shiftKey ? 10 : 1);
        return;
      case "[":
        event.preventDefault();
        stepFrame(-30);
        return;
      case "]":
        event.preventDefault();
        stepFrame(30);
        return;
      case "Home":
        event.preventDefault();
        jumpToFrame(0);
        return;
      case "End":
        event.preventDefault();
        jumpToFrame(currentEpisode.rawLength - 1);
        return;
      case " ":
        event.preventDefault();
        controlsRef.current?.togglePlay();
        return;
      case "-":
      case "=": {
        event.preventDefault();
        if (pending === null) return; // same prefill-suppression guard as digits
        const current =
          typeof pending[spec.stage_field] === "number"
            ? (pending[spec.stage_field] as number)
            : null;
        if (current === null) {
          setActionError("No stage set yet — pick a rung (0-9 or the buttons) first.");
          return;
        }
        const next = clamp(current + (key === "=" ? 1 : -1), 0, spec.ladder.max_stage);
        edit({ [spec.stage_field]: next });
        return;
      }
      case "e":
        event.preventDefault();
        setShowEvidence((show) => !show);
        return;
      case "c":
        event.preventDefault();
        void verdict("confirmed");
        return;
      case "u":
        event.preventDefault();
        void verdict("uncertain");
        return;
      case "n": {
        event.preventDefault();
        const position = filteredEpisodes.findIndex(
          (episode) => episode.episodeIndex === currentEpisode.episodeIndex
        );
        const next = position === -1 ? undefined : filteredEpisodes[position + 1];
        if (next) navigateTo(next.episodeIndex);
        else setActionError("Already at the last episode in the queue.");
        return;
      }
      case "p":
      case "b": {
        event.preventDefault();
        if (saving) return;
        const position = filteredEpisodes.findIndex(
          (episode) => episode.episodeIndex === currentEpisode.episodeIndex
        );
        if (position === -1) {
          setActionError("This episode is not in the current queue; pick one from the list.");
          return;
        }
        const previous = filteredEpisodes[position - 1];
        if (previous) navigateTo(previous.episodeIndex);
        else setActionError("Already at the first episode in the queue.");
        return;
      }
      default:
        return;
    }
  }
  useWindowKeydown(handleKey);

  // Stage timeline markers: the policy-phase end (episodes keep recording
  // through the physical reset; times beyond it are invalid) + set event times.
  const renderTimelineOverlays = useCallback(
    (pct: (value: number) => string) => {
      if (!spec || !currentEpisode) return null;
      const policyEnd =
        episodeDurationS !== null ? Math.round(episodeDurationS * spec.fps) : null;
      return (
        <>
          {policyEnd !== null && policyEnd < currentEpisode.rawLength && (
            <div
              className="absolute top-0 bottom-0 bg-warm-300/50"
              style={{
                left: pct(policyEnd),
                right: 0,
                backgroundImage:
                  "repeating-linear-gradient(45deg, rgba(138,127,114,0.3) 0 5px, transparent 5px 10px)",
              }}
              title={`policy phase ends at frame ${policyEnd} (reset tail beyond)`}
            />
          )}
          {spec.time_fields.map((tf) => {
            const t = pending && typeof pending[tf] === "number" ? (pending[tf] as number) : null;
            if (t === null) return null;
            const dotFrame = Math.min(
              Math.round(t * spec.fps),
              currentEpisode.rawLength - 1
            );
            return (
              <div
                key={tf}
                className="absolute bottom-1 w-2 h-2 rounded-full bg-teal"
                style={{ left: pct(dotFrame), transform: "translateX(-50%)" }}
                title={`${tf} = ${t}s`}
              />
            );
          })}
        </>
      );
    },
    [spec, currentEpisode, episodeDurationS, pending]
  );

  // -- Gates --------------------------------------------------------------------
  if (!viewer?.isEditor) {
    return (
      <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8">
        <button
          onClick={onExit}
          className="text-xs text-ink-muted hover:text-teal mb-4 cursor-pointer"
        >
          &larr; Back to explorer
        </button>
        <p className="font-body text-ink-muted text-center">
          {viewer === undefined
            ? "Checking permissions…"
            : "Stage review is limited to allowlisted editors. Sign in with an editor account."}
        </p>
      </div>
    );
  }
  if (task && specRows !== undefined && specRows.length === 0) {
    return (
      <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8">
        <button
          onClick={onExit}
          className="text-xs text-ink-muted hover:text-teal mb-4 cursor-pointer"
        >
          &larr; Back to explorer
        </button>
        <p className="font-body text-ink-muted text-center">
          No stage-label spec is exported for task {task} — run
          sir.tools.export_arena_task_specs first.
        </p>
      </div>
    );
  }
  if (specResult.error !== null) {
    return (
      <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8">
        <button
          onClick={onExit}
          className="text-xs text-ink-muted hover:text-teal mb-4 cursor-pointer"
        >
          &larr; Back to explorer
        </button>
        <div className="rounded-lg border border-coral/30 bg-coral-light px-4 py-3 text-sm text-coral font-mono">
          Stage spec for {task}@{specRow?.taxonomy_version} is malformed — re-run the
          exporter: {specResult.error}
        </div>
      </div>
    );
  }
  if (!task || spec === null) {
    return (
      <div className="bg-white rounded-2xl border border-warm-200 shadow-sm p-8 text-center text-ink-muted font-body">
        {task ? "Loading stage spec…" : "This dataset has no task — stage review needs one."}
      </div>
    );
  }

  const currentOwn = selectedEpisode !== null ? ownReviewByEpisode.get(selectedEpisode) : undefined;
  // Blinded double-labeling: ANOTHER reviewer's stage decision in the ledger
  // would anchor this reviewer far more directly than a prefill — filter
  // stage-kind events not authored by the signed-in reviewer. Outcome events
  // stay (outcome is legitimate stage evidence, e.g. success <=> top rung).
  const fullChain = selectedEpisode !== null ? (historyByEpisode.get(selectedEpisode) ?? []) : [];
  const currentChain = fullChain.filter(
    (event) => event.label_kind !== "stage" || event.source.agent === viewer?.username
  );

  return (
    <div className="bg-white rounded-2xl border border-warm-200 shadow-sm overflow-hidden">
      {showHelp && (
        <HelpOverlay
          title="Stage review shortcuts"
          keys={HELP_KEYS}
          onClose={() => setShowHelp(false)}
        />
      )}

      {/* Header */}
      <div className="px-6 py-4 border-b border-warm-100 bg-warm-50 flex items-center justify-between gap-4">
        <div>
          <button
            onClick={onExit}
            className="text-xs text-ink-muted hover:text-teal cursor-pointer"
          >
            &larr; Back to explorer
          </button>
          <h2 className="font-display text-xl text-ink mt-1">Stage review</h2>
          <p className="text-xs text-ink-muted font-mono mt-0.5">
            {repoId} · {task} · S0–S{spec.ladder.max_stage}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {specRows && specRows.length > 1 && (
            <select
              value={spec.taxonomy_version}
              onChange={(e) => {
                setSchemaParam(e.target.value === liveRow?.taxonomy_version ? "" : e.target.value);
                e.currentTarget.blur();
              }}
              className="rounded-lg border border-warm-200 bg-white px-2 py-1 text-xs font-mono text-ink cursor-pointer"
              title="Taxonomy (schema) version — candidates coexist with the live one"
            >
              {specRows.map((row) => (
                <option key={row.taxonomy_version} value={row.taxonomy_version}>
                  {row.taxonomy_version}
                  {row.live ? " (live)" : " (candidate)"}
                </option>
              ))}
            </select>
          )}
          {!specRow?.live && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gold-light text-gold">
              candidate taxonomy
            </span>
          )}
          <button
            onClick={() => setBlindParam(blind ? "0" : "1")}
            className={`px-2 py-1 rounded-lg text-xs font-medium cursor-pointer ${
              blind
                ? "bg-teal/10 text-teal border border-teal/40"
                : "bg-coral-light text-coral border border-coral/40"
            }`}
            title="Blind mode hides (and never fetches) policy/arm identity — the protocol forbids it from influencing labels"
          >
            {blind ? "blind" : "⚠ unblinded"}
          </button>
          <span className="text-xs font-mono text-ink-muted">
            {dirty
              ? "unsaved edits"
              : currentOwn
                ? `${currentOwn.status} ✓`
                : "no review yet"}
          </span>
          <button
            onClick={() => setShowHelp(true)}
            className="w-7 h-7 rounded-full border border-warm-200 text-ink-muted hover:text-teal hover:border-teal text-sm cursor-pointer"
            title="Keyboard shortcuts"
          >
            ?
          </button>
        </div>
      </div>

      {loadError && (
        <div className="mx-6 mt-4 rounded-lg border border-coral/30 bg-coral-light px-4 py-3 text-sm text-coral font-mono">
          Failed to load episode metadata: {loadError}
        </div>
      )}
      {draftError && (
        <div className="mx-6 mt-4 rounded-lg border border-coral/30 bg-coral-light px-4 py-3 text-xs text-coral font-mono flex items-start justify-between gap-3">
          <span>{draftError}</span>
          <button
            onClick={() => setDraftError(null)}
            className="shrink-0 underline cursor-pointer"
          >
            dismiss
          </button>
        </div>
      )}
      {schemaFellBack && (
        <div className="mx-6 mt-4 rounded-lg border border-gold/40 bg-gold-light px-4 py-3 text-xs text-ink font-mono">
          Unknown taxonomy version "{schemaParam}" in the URL — showing the live
          taxonomy instead.
        </div>
      )}
      {historyError && (
        <div className="mx-6 mt-4 rounded-lg border border-gold/40 bg-gold-light px-4 py-3 text-xs text-ink font-mono">
          Label-history ledger failed to load (provenance hidden, reviewing
          unaffected): {historyError}
        </div>
      )}
      {ledgerError && !blind && (
        <div className="mx-6 mt-4 rounded-lg border border-coral/30 bg-coral-light px-4 py-3 text-xs text-coral font-mono">
          arm filter unavailable — ledger parse failed: {ledgerError}
        </div>
      )}
      {appliedError && (
        <div className="mx-6 mt-4 rounded-lg border border-coral/30 bg-coral-light px-4 py-3 text-xs text-coral font-mono">
          Failed to load the applied outcome-edit record — episodes whose only
          outcome decision lives there stay gated until it loads: {appliedError}
        </div>
      )}
      {awaitingOutcome.length > 0 && (
        <div className="mx-6 mt-4 rounded-lg border border-gold/40 bg-gold-light px-4 py-3 text-xs text-ink font-mono flex items-center justify-between gap-3">
          <span>
            {awaitingOutcome.length} episode(s) have no outcome decision yet and
            are hidden from the stage queue — outcome review runs first (ep{" "}
            {awaitingOutcome.slice(0, 8).join(", ")}
            {awaitingOutcome.length > 8 ? ", …" : ""}).
          </span>
          <button
            onClick={onOpenOutcomeReview}
            className="shrink-0 px-2 py-1 rounded-lg text-xs font-medium bg-white border border-gold text-gold hover:bg-gold/10 cursor-pointer"
          >
            Open outcome review &rarr;
          </button>
        </div>
      )}

      <div
        className={`grid gap-0 ${
          showEvidence ? "grid-cols-[240px_minmax(0,1fr)_300px]" : "grid-cols-[240px_minmax(0,1fr)]"
        }`}
      >
        {/* Queue */}
        <div className="border-r border-warm-100 p-4 flex flex-col gap-2 max-h-[85vh]">
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as StatusFilter);
              e.currentTarget.blur();
            }}
            className="w-full rounded-lg border border-warm-200 bg-white px-2 py-1.5 text-xs font-body text-ink cursor-pointer"
          >
            <option value="unreviewed">Unreviewed (+ drafts)</option>
            <option value="draft">Drafts</option>
            <option value="confirmed">Confirmed</option>
            <option value="corrected">Corrected (legacy)</option>
            <option value="uncertain">Uncertain (mine)</option>
            <option value="adjudicate">Needs adjudication (others&apos; uncertain)</option>
            <option value="all">All</option>
          </select>
          <div className="flex gap-2">
            <select
              value={flagFilter}
              onChange={(e) => {
                setFlagFilter(e.target.value);
                e.currentTarget.blur();
              }}
              className="flex-1 rounded-lg border border-warm-200 bg-white px-2 py-1.5 text-xs font-body text-ink cursor-pointer"
              title="Review-reason flags from the labeling pipeline"
            >
              <option value="all">All flags</option>
              <option value="flagged">Flagged</option>
              <option value="unflagged">Unflagged</option>
            </select>
            <select
              value={confFilter}
              onChange={(e) => {
                setConfFilter(e.target.value);
                e.currentTarget.blur();
              }}
              className="flex-1 rounded-lg border border-warm-200 bg-white px-2 py-1.5 text-xs font-body text-ink cursor-pointer"
            >
              <option value="all">All conf</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
          {!blind && armOptions.length > 0 && (
            <select
              value={armFilter}
              onChange={(e) => {
                setArmFilter(e.target.value);
                e.currentTarget.blur();
              }}
              className="w-full rounded-lg border border-warm-200 bg-white px-2 py-1.5 text-xs font-body text-ink cursor-pointer"
            >
              <option value="all">All arms</option>
              {armOptions.map((arm) => (
                <option key={arm} value={arm}>
                  {arm}
                </option>
              ))}
            </select>
          )}
          <div className="text-[11px] font-mono text-ink-muted">
            {Number(reviews?.num_confirmed ?? 0) + Number(reviews?.num_corrected ?? 0)} committed ·{" "}
            {prefillByEpisode.size} predictions · {filteredEpisodes.length} in queue
            {awaitingOutcome.length > 0 && ` · ${awaitingOutcome.length} outcome-gated`}
          </div>
          <div className="flex-1 overflow-y-auto space-y-1.5 pr-1">
            {episodes === null && !loadError && (
              <div className="flex items-center gap-2 text-xs text-ink-muted">
                <div className="w-4 h-4 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
                Loading episodes…
              </div>
            )}
            {episodes !== null && !outcomeGateReady && (
              <div className="flex items-center gap-2 text-xs text-ink-muted">
                <div className="w-4 h-4 border-2 border-teal/30 border-t-teal rounded-full animate-spin" />
                Checking outcome-review coverage…
              </div>
            )}
            {filteredEpisodes.map((episode) => {
              const prefill = prefillByEpisode.get(episode.episodeIndex);
              const own = ownReviewByEpisode.get(episode.episodeIndex);
              const stage = prefill?.label[spec.stage_field];
              const flags = flagCount(episode.episodeIndex);
              const outcome = resolveOutcome(episode.episodeIndex)?.outcome ?? null;
              return (
                <button
                  key={episode.episodeIndex}
                  onClick={() => navigateTo(episode.episodeIndex)}
                  className={`w-full text-left px-3 py-2 rounded-lg border transition-all cursor-pointer ${
                    selectedEpisode === episode.episodeIndex
                      ? "bg-teal/10 border-teal shadow-sm"
                      : "bg-white border-warm-200 hover:border-warm-300"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-medium text-ink">
                      Ep {episode.episodeIndex}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {prefill?.confidence && (
                        <span
                          className={`w-2 h-2 rounded-full ${
                            CONFIDENCE_DOT[prefill.confidence] ?? "bg-warm-300"
                          }`}
                          title={`${prefill.confidence} confidence`}
                        />
                      )}
                      {outcome !== null && (
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            OUTCOME_CHIP[outcome] ?? "bg-warm-100 text-ink-muted"
                          }`}
                          title={`outcome decision: ${outcome}`}
                        >
                          {outcome[0]}
                        </span>
                      )}
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-warm-100 text-ink">
                        {stage != null ? `S${stage}` : "—"}
                      </span>
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-1">
                    <span className="text-[10px] font-mono text-ink-muted truncate">
                      {flags > 0 ? `⚑ ${flags}` : ""}
                      {!blind && ledgerArms?.get(episode.episodeIndex)
                        ? ` · ${ledgerArms.get(episode.episodeIndex)}`
                        : ""}
                    </span>
                    {statusFilter === "adjudicate" ? (
                      <span className="text-[10px] font-mono text-gold">
                        ?{" "}
                        {(otherReviewsByEpisode.get(episode.episodeIndex) ?? [])
                          .filter((r) => r.status === "uncertain")
                          .map((r) => r.reviewer)
                          .join(", ")}
                      </span>
                    ) : own ? (
                      <span
                        className={`text-[10px] font-mono ${
                          own.status === "confirmed" || own.status === "corrected"
                            ? "text-teal"
                            : "text-ink-muted"
                        }`}
                        title={`${own.reviewer} · ${formatClock(own.savedAt)}`}
                      >
                        {STATUS_GLYPH[own.status] ?? ""} {own.status}
                      </span>
                    ) : (
                      <span className="text-[10px] font-mono text-ink-muted/60">unreviewed</span>
                    )}
                  </div>
                </button>
              );
            })}
            {episodes !== null && outcomeGateReady && filteredEpisodes.length === 0 && (
              <div className="text-xs text-ink-muted font-body">
                {awaitingOutcome.length === episodes.length && episodes.length > 0
                  ? "Every episode is awaiting outcome review — run it first."
                  : "No episodes match this filter."}
              </div>
            )}
          </div>
        </div>

        {/* Viewer + form */}
        <div className="p-5">
          {currentEpisode === null ? (
            <div className="py-16 text-center text-ink-muted font-body">
              Select an episode from the queue to review it.
            </div>
          ) : currentResolvedOutcome === null ? (
            // Outcome gate: this episode has never been through the outcome
            // editor flow — stage labeling is blocked until it has.
            <div className="py-16 text-center font-body">
              <p className="text-ink">
                Episode {currentEpisode.episodeIndex} has no outcome decision yet.
              </p>
              <p className="mt-1 text-sm text-ink-muted">
                The outcome review flow must run before stage labeling — a
                successful outcome then pre-fills the stage form automatically.
              </p>
              <button
                onClick={onOpenOutcomeReview}
                className="mt-4 px-4 py-1.5 rounded-lg text-xs font-medium bg-teal text-white hover:bg-teal/90 cursor-pointer"
              >
                Open outcome review &rarr;
              </button>
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3 mb-3">
                <span className="font-display text-lg text-ink">
                  Episode {currentEpisode.episodeIndex}
                </span>
                {pending === null && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-mono bg-warm-100 text-ink-muted animate-pulse">
                    loading label…
                  </span>
                )}
                {currentResolvedOutcome !== undefined &&
                  (currentResolvedOutcome.outcome !== null ? (
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                        OUTCOME_CHIP[currentResolvedOutcome.outcome] ??
                        "bg-warm-100 text-ink-muted"
                      }`}
                      title={`outcome decision (source: ${currentResolvedOutcome.source})`}
                    >
                      outcome {currentResolvedOutcome.outcome}
                    </span>
                  ) : currentOutcomeSignalError === null ? (
                    <span className="px-2 py-0.5 rounded-full text-xs font-mono bg-warm-100 text-ink-muted animate-pulse">
                      resolving outcome…
                    </span>
                  ) : null)}
                {inheritedSuccess && spec && (
                  <span
                    className="px-2 py-0.5 rounded-full text-xs font-medium bg-teal/10 text-teal"
                    title="Stage, final state, and failure mode were seeded from the SUCCESS outcome decision — mark the event timings, then confirm."
                  >
                    S{spec.ladder.success_level} inherited from outcome
                  </span>
                )}
                {currentOwn && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-teal/10 text-teal">
                    your {currentOwn.status} · {formatClock(currentOwn.savedAt)}
                  </span>
                )}
                {currentPrefill && !currentOwn && (
                  <span className="px-2 py-0.5 rounded-full text-xs font-mono bg-warm-100 text-ink-muted">
                    prefilled from {currentPrefill.pipeline.name}@{currentPrefill.pipeline.version}
                  </span>
                )}
                {episodeDurationS !== null && (
                  <span className="text-[11px] font-mono text-ink-muted">
                    policy {episodeDurationS.toFixed(1)}s / raw {currentEpisode.rawLength}f
                  </span>
                )}
                <div className="flex-1" />
                <button
                  onClick={() => setShowEvidence((show) => !show)}
                  className="px-2 py-1 rounded-lg text-xs font-medium border border-warm-200 text-ink-muted hover:border-warm-300 cursor-pointer"
                >
                  {showEvidence ? "hide evidence" : "model evidence"}
                  <span className="ml-1 font-mono text-[10px] opacity-60">e</span>
                </button>
              </div>

              {currentOutcomeSignalError !== null && (
                <div className="mb-3 rounded-lg border border-gold/40 bg-gold-light px-3 py-2 text-xs text-ink font-mono">
                  This keep-as-is outcome could not be resolved from frame
                  signals — labeling proceeds without the success prefill:{" "}
                  {currentOutcomeSignalError}
                </div>
              )}
              {actionError && (
                <div className="mb-3 rounded-lg border border-coral/30 bg-coral-light px-3 py-2 text-xs text-coral font-mono">
                  {actionError}
                </div>
              )}

              {cameraKeys.length === 0 ? (
                <div className="rounded-lg border border-coral/30 bg-coral-light px-4 py-3 text-sm text-coral font-mono">
                  Episode {currentEpisode.episodeIndex} exposes no reviewable camera
                  streams.
                </div>
              ) : (
                <ReviewViewer
                  datasetId={repoId}
                  episode={currentEpisode}
                  cameraKeys={cameraKeys}
                  primaryKey={primaryKey}
                  fps={spec.fps}
                  frame={frame}
                  onFrame={setFrame}
                  lastValidFrame={null}
                  controlsRef={controlsRef}
                  cropByCameraKey={cropByCameraKey}
                  storedFrameHW={storedFrameHW}
                  onDrift={setViewerDrift}
                  onUnverifiable={setUnverifiable}
                  renderTimelineOverlays={renderTimelineOverlays}
                />
              )}

              {pending !== null && (
                <StageLabelForm
                  spec={spec}
                  row={pending}
                  violations={violations}
                  frame={frame}
                  markFrame={markFrame}
                  markDisabled={viewerDrift !== null}
                  onEdit={edit}
                  onSeekTime={seekTime}
                  disabled={saving}
                />
              )}

              {statusFilter === "adjudicate" &&
                selectedEpisode !== null &&
                (otherReviewsByEpisode.get(selectedEpisode) ?? []).map((other) => (
                  <div
                    key={other.reviewer}
                    className="mt-3 rounded-lg border border-gold/40 bg-gold-light px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-ink">
                      <span className="font-medium">
                        {other.reviewer}: {other.status}
                      </span>
                      <span className="text-ink-muted">{formatClock(other.savedAt)}</span>
                      {other.label && spec && (
                        <span className="text-ink-muted">
                          S{String(other.label[spec.stage_field] ?? "?")} ·{" "}
                          {String(other.label[spec.failure_mode_field] ?? "—")} →{" "}
                          {String(other.label[spec.final_state_field] ?? "—")}
                        </span>
                      )}
                      <div className="flex-1" />
                      {other.label && (
                        <button
                          onClick={() => {
                            setPending({ ...other.label });
                            setDirty(true);
                          }}
                          className="px-2 py-0.5 rounded text-[10px] font-mono bg-white border border-gold text-gold hover:bg-gold/10 cursor-pointer"
                          title={`load ${other.reviewer}'s label into the form as your starting point`}
                        >
                          load their label
                        </button>
                      )}
                    </div>
                    {typeof other.label?.notes === "string" && other.label.notes && (
                      <p className="mt-1 text-[11px] font-body text-ink whitespace-pre-wrap">
                        {other.label.notes}
                      </p>
                    )}
                  </div>
                ))}

              <LabelHistoryPanel
                chain={currentChain}
                rawLength={currentEpisode.rawLength}
                onSeek={jumpToFrame}
              />

              {/* Verdict bar */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  disabled={saving}
                  onClick={() => void verdict("uncertain")}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium border border-warm-200 text-ink-muted hover:border-warm-300 cursor-pointer"
                >
                  uncertain
                  <span className="ml-1.5 font-mono text-[10px] opacity-60">u</span>
                </button>
                <div className="flex-1" />
                <button
                  disabled={saving}
                  onClick={() => void verdict("confirmed")}
                  className={`px-4 py-1.5 rounded-lg text-xs font-medium ${
                    saving
                      ? "bg-warm-100 text-ink-muted/50 cursor-not-allowed"
                      : "bg-teal text-white hover:bg-teal/90 cursor-pointer"
                  }`}
                >
                  confirm — fully annotated
                  <span className="ml-1.5 font-mono text-[10px] opacity-70">c</span>
                </button>
              </div>
            </>
          )}
        </div>

        {/* Evidence rail */}
        {showEvidence && (
          <div className="border-l border-warm-100 p-4 max-h-[85vh] overflow-y-auto">
            <div className="text-[10px] font-mono uppercase tracking-wide text-ink-muted mb-2">
              Model evidence
            </div>
            <EvidencePanel spec={spec} prefill={currentPrefill} onSeekTime={seekTime} />
          </div>
        )}
      </div>
    </div>
  );
}
