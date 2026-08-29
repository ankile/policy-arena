/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as apply_frames from "../apply/frames.js";
import type * as apply_hf from "../apply/hf.js";
import type * as apply_labelHistory from "../apply/labelHistory.js";
import type * as apply_ledgers from "../apply/ledgers.js";
import type * as apply_parquetIO from "../apply/parquetIO.js";
import type * as apply_pipeline from "../apply/pipeline.js";
import type * as apply_progress from "../apply/progress.js";
import type * as apply_pyjson from "../apply/pyjson.js";
import type * as apply_results from "../apply/results.js";
import type * as apply_stats from "../apply/stats.js";
import type * as applyJobs from "../applyJobs.js";
import type * as applyWorker from "../applyWorker.js";
import type * as auth from "../auth.js";
import type * as bradleyTerry from "../bradleyTerry.js";
import type * as datasetStats from "../datasetStats.js";
import type * as datasetStatsLogic from "../datasetStatsLogic.js";
import type * as datasets from "../datasets.js";
import type * as evalSessions from "../evalSessions.js";
import type * as http from "../http.js";
import type * as machineAuth from "../machineAuth.js";
import type * as maintenance from "../maintenance.js";
import type * as operators from "../operators.js";
import type * as pairings from "../pairings.js";
import type * as policies from "../policies.js";
import type * as ratings from "../ratings.js";
import type * as recommendations from "../recommendations.js";
import type * as reviews from "../reviews.js";
import type * as roundResults from "../roundResults.js";
import type * as seed from "../seed.js";
import type * as stageConsistency from "../stageConsistency.js";
import type * as stageCoverage from "../stageCoverage.js";
import type * as stagePrefills from "../stagePrefills.js";
import type * as stageReviews from "../stageReviews.js";
import type * as stageTaskSpecs from "../stageTaskSpecs.js";
import type * as statusShared from "../statusShared.js";
import type * as statuses from "../statuses.js";
import type * as taskSpecs from "../taskSpecs.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  "apply/frames": typeof apply_frames;
  "apply/hf": typeof apply_hf;
  "apply/labelHistory": typeof apply_labelHistory;
  "apply/ledgers": typeof apply_ledgers;
  "apply/parquetIO": typeof apply_parquetIO;
  "apply/pipeline": typeof apply_pipeline;
  "apply/progress": typeof apply_progress;
  "apply/pyjson": typeof apply_pyjson;
  "apply/results": typeof apply_results;
  "apply/stats": typeof apply_stats;
  applyJobs: typeof applyJobs;
  applyWorker: typeof applyWorker;
  auth: typeof auth;
  bradleyTerry: typeof bradleyTerry;
  datasetStats: typeof datasetStats;
  datasetStatsLogic: typeof datasetStatsLogic;
  datasets: typeof datasets;
  evalSessions: typeof evalSessions;
  http: typeof http;
  machineAuth: typeof machineAuth;
  maintenance: typeof maintenance;
  operators: typeof operators;
  pairings: typeof pairings;
  policies: typeof policies;
  ratings: typeof ratings;
  recommendations: typeof recommendations;
  reviews: typeof reviews;
  roundResults: typeof roundResults;
  seed: typeof seed;
  stageConsistency: typeof stageConsistency;
  stageCoverage: typeof stageCoverage;
  stagePrefills: typeof stagePrefills;
  stageReviews: typeof stageReviews;
  stageTaskSpecs: typeof stageTaskSpecs;
  statusShared: typeof statusShared;
  statuses: typeof statuses;
  taskSpecs: typeof taskSpecs;
  users: typeof users;
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
