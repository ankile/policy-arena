import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import ComparisonReview from "./ComparisonReview";
import { validateBundle, type ComparisonBundle } from "./labelComparison";
import source from "./data/label-comparison-source.json";
import "../src/index.css";

function App() {
  const [bundle, setBundle] = useState<ComparisonBundle | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(source.url, { signal: controller.signal });
        if (!response.ok)
          throw new Error(`Comparison download failed (${response.status}).`);
        const buffer = await response.arrayBuffer();
        const hash = [
          ...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
        ]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        if (hash !== source.sha256)
          throw new Error(
            "Comparison checksum mismatch; refusing to display changed evidence.",
          );
        const data = validateBundle(
          JSON.parse(new TextDecoder().decode(buffer)),
        );
        if (data.comparison_sha256 !== source.comparison_sha256)
          throw new Error("Wrong evaluation baseline.");
        if (!controller.signal.aborted) setBundle(data);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    void load();
    return () => controller.abort();
  }, []);
  if (error)
    return (
      <main className="comparison-shell">
        <h1>Comparison unavailable</h1>
        <p role="alert">{error}</p>
        <button onClick={() => location.reload()}>Retry</button>
      </main>
    );
  return bundle ? (
    <ComparisonReview bundle={bundle} />
  ) : (
    <main className="comparison-shell">
      <h1>Your labels vs Gemini</h1>
      <p role="status">Loading and verifying the 60-episode snapshot…</p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
