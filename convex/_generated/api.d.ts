/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as datasets from "../datasets.js";
import type * as elo from "../elo.js";
import type * as eloHistory from "../eloHistory.js";
import type * as evalSessions from "../evalSessions.js";
import type * as pairings from "../pairings.js";
import type * as policies from "../policies.js";
import type * as recommendations from "../recommendations.js";
import type * as roundResults from "../roundResults.js";
import type * as seed from "../seed.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  datasets: typeof datasets;
  elo: typeof elo;
  eloHistory: typeof eloHistory;
  evalSessions: typeof evalSessions;
  pairings: typeof pairings;
  policies: typeof policies;
  recommendations: typeof recommendations;
  roundResults: typeof roundResults;
  seed: typeof seed;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
