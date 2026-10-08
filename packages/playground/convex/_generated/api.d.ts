/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as activity from "../activity.js";
import type * as apps from "../apps.js";
import type * as builder_agent from "../builder/agent.js";
import type * as builder_draft from "../builder/draft.js";
import type * as builder_model from "../builder/model.js";
import type * as builder_queue from "../builder/queue.js";
import type * as builder_rules from "../builder/rules.js";
import type * as builder_run from "../builder/run.js";
import type * as builder_triage from "../builder/triage.js";
import type * as builds from "../builds.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as lib_appData from "../lib/appData.js";
import type * as lib_bootCatcher from "../lib/bootCatcher.js";
import type * as lib_entryPage from "../lib/entryPage.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_files from "../lib/files.js";
import type * as lib_identity from "../lib/identity.js";
import type * as lib_limits from "../lib/limits.js";
import type * as lib_presence from "../lib/presence.js";
import type * as lib_proof from "../lib/proof.js";
import type * as lib_rateLimit from "../lib/rateLimit.js";
import type * as lib_room from "../lib/room.js";
import type * as lib_runPaths from "../lib/runPaths.js";
import type * as lib_runtime from "../lib/runtime.js";
import type * as lib_seed from "../lib/seed.js";
import type * as lib_slugs from "../lib/slugs.js";
import type * as lib_text from "../lib/text.js";
import type * as lib_transpile from "../lib/transpile.js";
import type * as lib_unfurl from "../lib/unfurl.js";
import type * as lib_versions from "../lib/versions.js";
import type * as limits from "../limits.js";
import type * as messages from "../messages.js";
import type * as model from "../model.js";
import type * as presence from "../presence.js";
import type * as prompts from "../prompts.js";
import type * as reports from "../reports.js";
import type * as runtime from "../runtime.js";
import type * as stills from "../stills.js";
import type * as tallies from "../tallies.js";
import type * as validators from "../validators.js";
import type * as versions from "../versions.js";
import type * as visitors from "../visitors.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  activity: typeof activity;
  apps: typeof apps;
  "builder/agent": typeof builder_agent;
  "builder/draft": typeof builder_draft;
  "builder/model": typeof builder_model;
  "builder/queue": typeof builder_queue;
  "builder/rules": typeof builder_rules;
  "builder/run": typeof builder_run;
  "builder/triage": typeof builder_triage;
  builds: typeof builds;
  crons: typeof crons;
  http: typeof http;
  "lib/appData": typeof lib_appData;
  "lib/bootCatcher": typeof lib_bootCatcher;
  "lib/entryPage": typeof lib_entryPage;
  "lib/errors": typeof lib_errors;
  "lib/files": typeof lib_files;
  "lib/identity": typeof lib_identity;
  "lib/limits": typeof lib_limits;
  "lib/presence": typeof lib_presence;
  "lib/proof": typeof lib_proof;
  "lib/rateLimit": typeof lib_rateLimit;
  "lib/room": typeof lib_room;
  "lib/runPaths": typeof lib_runPaths;
  "lib/runtime": typeof lib_runtime;
  "lib/seed": typeof lib_seed;
  "lib/slugs": typeof lib_slugs;
  "lib/text": typeof lib_text;
  "lib/transpile": typeof lib_transpile;
  "lib/unfurl": typeof lib_unfurl;
  "lib/versions": typeof lib_versions;
  limits: typeof limits;
  messages: typeof messages;
  model: typeof model;
  presence: typeof presence;
  prompts: typeof prompts;
  reports: typeof reports;
  runtime: typeof runtime;
  stills: typeof stills;
  tallies: typeof tallies;
  validators: typeof validators;
  versions: typeof versions;
  visitors: typeof visitors;
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
