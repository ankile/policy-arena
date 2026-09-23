# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## Public Mulligan release

The public build mounts the same `src/App.tsx` and browsing components as the
internal Arena. `src/lib/arenaClient.ts` is the data boundary: the regular build
uses Convex, while `vite.release.config.ts` substitutes the frozen read-only
provider in `src/release/client.ts`. Do not introduce a second release app.

The release disables authentication, editing, task status management and the
Labeling Lab. Leaderboard filters, policy drilldowns, evaluation sessions,
joined sessions, pairings, episode playback and dataset browsing remain shared.
The release's policy-detail panel also links simulation seed evidence. Simulation
policies have no invented paired games. Routing headlines report task progress;
paired Arena ratings continue to use full success. All dataset reads are pinned.

Prepare an export directory containing the verified `release.json`, `ui.json`,
and catalog/provenance files listed in `scripts/package_release.ts`. The UI
snapshot contains only selected session dates, dataset identities and scoped
per-repository annotation coverage. It excludes operator identities, mutable
result overrides, task-wide aggregates and draft review contents.

```sh
bun scripts/export_release_ui.ts RELEASE_JSON OUTPUT_UI_JSON CONVEX_URL
bun scripts/verify_release_data.ts RELEASE_JSON UI_JSON
bun run package:release RELEASE_JSON
uv tool run --from playwright python scripts/verify_release_browser.py URL /tmp/arena-browser-check
```

The build fails on unverified release data, missing catalog assets, a mismatched
UI snapshot or an internal backend URL. The browser check covers the original
screens, selected result values, pinned videos, simulation evidence, mobile
layout and absence of backend traffic and write requests. Outputs go under
`/tmp/mulligan-arena-build` unless `MULLIGAN_RELEASE_OUTPUT` is set.
