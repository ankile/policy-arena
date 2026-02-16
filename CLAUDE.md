# Policy Arena

A leaderboard web app for comparing robot policies via ELO ratings derived from head-to-head evaluations.

## CRITICAL: Convex Deployment

**We use a SINGLE Convex deployment for everything: `grandiose-rook-292` (dev).**

- All data (policies, eval sessions, ELO history, datasets) lives here
- The Vercel production site (policy-eval.ankile.com) points here
- Local development points here
- Python scripts should use this URL: `https://grandiose-rook-292.convex.cloud`

**NEVER use `npx convex deploy`** — that pushes to the prod deployment (`ideal-pig-506`) which we do NOT use.

Instead, to push schema/function changes:
```bash
npx convex dev --once    # pushes to dev (grandiose-rook-292) once, no watcher
```

After pushing Convex changes, redeploy the frontend:
```bash
npx vercel --prod
```

## Tech Stack

- React + TypeScript + Convex (backend)
- Vite (build tool)
- Tailwind CSS v4 (via `@tailwindcss/vite` plugin)
- Bun (package manager / runtime)
- Vercel (frontend hosting)

## Project Structure

- `src/App.tsx` — Main app with tabs: Leaderboard, Eval Sessions, Data Explorer
- `src/components/DataExplorer.tsx` — Browse registered datasets and view episodes
- `src/components/EvalSessions.tsx` — Eval session list and detail views
- `src/components/EpisodeViewer.tsx` — HuggingFace episode video viewer
- `src/components/PolicyDetail.tsx` — Expanded policy info and ELO history
- `src/lib/hf-api.ts` — HuggingFace Datasets API client
- `convex/schema.ts` — Database schema (policies, evalSessions, roundResults, eloHistory, datasets)
- `convex/datasets.ts` — Dataset register mutation and list query
- `convex/evalSessions.ts` — Eval session submission and ELO computation
- `python/policy_arena/` — Python client for submitting eval results and registering datasets
- `scripts/backfill_datasets.py` — One-off script to register existing datasets

## Design

- Light theme with warm cream background, white card surfaces
- Fonts: DM Serif Display (headings), DM Sans (body), JetBrains Mono (numbers)
- Custom color palette defined in `@theme` block in `index.css`

## Commands

- `bun run dev` — Start dev server
- `bun run build` — Production build
- `bun run lint` — ESLint
- `npx convex dev` — Start Convex dev watcher (hot-reload functions)
- `npx convex dev --once` — Push Convex changes once (use this instead of `npx convex deploy`)
- `npx vercel --prod` — Deploy frontend to Vercel
