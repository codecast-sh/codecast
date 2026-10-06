/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as apps from "../apps.js";
import type * as builder_draft from "../builder/draft.js";
import type * as builder_queue from "../builder/queue.js";
import type * as builder_rules from "../builder/rules.js";
import type * as builder_run from "../builder/run.js";
import type * as builder_triage from "../builder/triage.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as lib_appData from "../lib/appData.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_files from "../lib/files.js";
import type * as lib_identity from "../lib/identity.js";
import type * as lib_limits from "../lib/limits.js";
import type * as lib_presence from "../lib/presence.js";
import type * as lib_rateLimit from "../lib/rateLimit.js";
import type * as lib_room from "../lib/room.js";
import type * as lib_runPaths from "../lib/runPaths.js";
import type * as lib_runtime from "../lib/runtime.js";
import type * as lib_seed from "../lib/seed.js";
import type * as lib_slugs from "../lib/slugs.js";
import type * as lib_transpile from "../lib/transpile.js";
import type * as lib_versions from "../lib/versions.js";
import type * as limits from "../limits.js";
import type * as messages from "../messages.js";
import type * as model from "../model.js";
import type * as presence from "../presence.js";
import type * as prompts from "../prompts.js";
import type * as runtime from "../runtime.js";
import type * as validators from "../validators.js";
import type * as versions from "../versions.js";
import type * as visitors from "../visitors.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  apps: typeof apps;
  "builder/draft": typeof builder_draft;
  "builder/queue": typeof builder_queue;
  "builder/rules": typeof builder_rules;
  "builder/run": typeof builder_run;
  "builder/triage": typeof builder_triage;
  crons: typeof crons;
  http: typeof http;
  "lib/appData": typeof lib_appData;
  "lib/errors": typeof lib_errors;
  "lib/files": typeof lib_files;
  "lib/identity": typeof lib_identity;
  "lib/limits": typeof lib_limits;
  "lib/presence": typeof lib_presence;
  "lib/rateLimit": typeof lib_rateLimit;
  "lib/room": typeof lib_room;
  "lib/runPaths": typeof lib_runPaths;
  "lib/runtime": typeof lib_runtime;
  "lib/seed": typeof lib_seed;
  "lib/slugs": typeof lib_slugs;
  "lib/transpile": typeof lib_transpile;
  "lib/versions": typeof lib_versions;
  limits: typeof limits;
  messages: typeof messages;
  model: typeof model;
  presence: typeof presence;
  prompts: typeof prompts;
  runtime: typeof runtime;
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
