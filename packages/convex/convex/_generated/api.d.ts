/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as apiTokens from "../apiTokens.js";
import type * as auth from "../auth.js";
import type * as cleanup from "../cleanup.js";
import type * as conversations from "../conversations.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as messages from "../messages.js";
import type * as rateLimit from "../rateLimit.js";
import type * as syncCursors from "../syncCursors.js";
import type * as teams from "../teams.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  apiTokens: typeof apiTokens;
  auth: typeof auth;
  cleanup: typeof cleanup;
  conversations: typeof conversations;
  health: typeof health;
  http: typeof http;
  messages: typeof messages;
  rateLimit: typeof rateLimit;
  syncCursors: typeof syncCursors;
  teams: typeof teams;
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
