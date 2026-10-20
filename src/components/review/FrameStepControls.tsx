import { useState } from "react";
import { MAX_FRAME_STEP, parseFrameStep, type FrameStepSizes } from "./frameStepSizes";

function StepInput({ label, title, value, onCommit }: {
  label: string; title: string; value: number; onCommit: (n: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const invalid = text !== null && parseFrameStep(text) === null;
  const commit = () => {
    if (text === null) return;
    const n = parseFrameStep(text);
    if (n !== null) onCommit(n);
    setText(null);
  };
  return (
    <label className="flex items-center gap-1" title={title}>
      <span className="font-mono">{label}</span>
      <input
        aria-label={title}
        inputMode="numeric"
        value={text ?? String(value)}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") { commit(); event.currentTarget.blur(); }
          if (event.key === "Escape") { setText(null); event.currentTarget.blur(); }
        }}
        className={`w-10 px-1 py-0.5 rounded border text-center font-mono text-xs bg-white ${
          invalid ? "border-coral text-coral" : "border-warm-200"
        }`}
      />
    </label>
  );
}

/** Header control for the ←/→ and [/] frame-step sizes. */
export function FrameStepControls({ sizes, onChange }: {
  sizes: FrameStepSizes; onChange: (patch: Partial<FrameStepSizes>) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-ink-muted" title="Frames skipped per key press (saved in this browser)">
      <span>step</span>
      <StepInput label="←→" title={`Frames per ←/→ press (1–${MAX_FRAME_STEP})`} value={sizes.arrow}
        onCommit={(arrow) => onChange({ arrow })} />
      <StepInput label="[ ]" title={`Frames per [/] press (1–${MAX_FRAME_STEP})`} value={sizes.bracket}
        onCommit={(bracket) => onChange({ bracket })} />
    </div>
  );
}
