# Policy Arena

A leaderboard web app for comparing robot policies via ELO ratings derived from head-to-head evaluations.

## Tech Stack

- React + TypeScript
- Vite (build tool)
- Tailwind CSS v4 (via `@tailwindcss/vite` plugin)
- Bun (package manager / runtime)

## Project Structure

- `src/App.tsx` — Main app component with leaderboard UI
- `src/index.css` — Tailwind imports and custom theme (colors, fonts, animations)
- Mock data is currently hardcoded in `App.tsx`

## Design

- Light theme with warm cream background, white card surfaces
- Fonts: DM Serif Display (headings), DM Sans (body), JetBrains Mono (numbers)
- Custom color palette defined in `@theme` block in `index.css`

## Commands

- `bun run dev` — Start dev server
- `bun run build` — Production build
- `bun run lint` — ESLint
