/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentTasks from "../agentTasks.js";
import type * as apiTokens from "../apiTokens.js";
import type * as auth from "../auth.js";
import type * as bookmarks from "../bookmarks.js";
import type * as cleanup from "../cleanup.js";
import type * as client_state from "../client_state.js";
import type * as comments from "../comments.js";
import type * as commits from "../commits.js";
import type * as conversations from "../conversations.js";
import type * as counters from "../counters.js";
import type * as crons from "../crons.js";
import type * as daemonLogs from "../daemonLogs.js";
import type * as data from "../data.js";
import type * as decisions from "../decisions.js";
import type * as dispatch from "../dispatch.js";
import type * as docSync from "../docSync.js";
import type * as docs from "../docs.js";
import type * as embeddings from "../embeddings.js";
import type * as fileTouches from "../fileTouches.js";
import type * as githubApi from "../githubApi.js";
import type * as githubApp from "../githubApp.js";
import type * as githubWebhooks from "../githubWebhooks.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as idleSummary from "../idleSummary.js";
import type * as images from "../images.js";
import type * as managedSessions from "../managedSessions.js";
import type * as messages from "../messages.js";
import type * as migrations from "../migrations.js";
import type * as notifications from "../notifications.js";
import type * as orchestrationEvents from "../orchestrationEvents.js";
import type * as patterns from "../patterns.js";
import type * as pendingMessages from "../pendingMessages.js";
import type * as permissions from "../permissions.js";
import type * as plans from "../plans.js";
import type * as privacy from "../privacy.js";
import type * as progressEvents from "../progressEvents.js";
import type * as projects from "../projects.js";
import type * as publicComments from "../publicComments.js";
import type * as pull_requests from "../pull_requests.js";
import type * as rateLimit from "../rateLimit.js";
import type * as redact from "../redact.js";
import type * as reviews from "../reviews.js";
import type * as sessionInsights from "../sessionInsights.js";
import type * as syncCursors from "../syncCursors.js";
import type * as systemConfig from "../systemConfig.js";
import type * as taskMining from "../taskMining.js";
import type * as tasks from "../tasks.js";
import type * as teamActivity from "../teamActivity.js";
import type * as teams from "../teams.js";
import type * as titleGeneration from "../titleGeneration.js";
import type * as users from "../users.js";
import type * as workflow_runs from "../workflow_runs.js";
import type * as workflows from "../workflows.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentTasks: typeof agentTasks;
  apiTokens: typeof apiTokens;
  auth: typeof auth;
  bookmarks: typeof bookmarks;
  cleanup: typeof cleanup;
  client_state: typeof client_state;
  comments: typeof comments;
  commits: typeof commits;
  conversations: typeof conversations;
  counters: typeof counters;
  crons: typeof crons;
  daemonLogs: typeof daemonLogs;
  data: typeof data;
  decisions: typeof decisions;
  dispatch: typeof dispatch;
  docSync: typeof docSync;
  docs: typeof docs;
  embeddings: typeof embeddings;
  fileTouches: typeof fileTouches;
  githubApi: typeof githubApi;
  githubApp: typeof githubApp;
  githubWebhooks: typeof githubWebhooks;
  health: typeof health;
  http: typeof http;
  idleSummary: typeof idleSummary;
  images: typeof images;
  managedSessions: typeof managedSessions;
  messages: typeof messages;
  migrations: typeof migrations;
  notifications: typeof notifications;
  orchestrationEvents: typeof orchestrationEvents;
  patterns: typeof patterns;
  pendingMessages: typeof pendingMessages;
  permissions: typeof permissions;
  plans: typeof plans;
  privacy: typeof privacy;
  progressEvents: typeof progressEvents;
  projects: typeof projects;
  publicComments: typeof publicComments;
  pull_requests: typeof pull_requests;
  rateLimit: typeof rateLimit;
  redact: typeof redact;
  reviews: typeof reviews;
  sessionInsights: typeof sessionInsights;
  syncCursors: typeof syncCursors;
  systemConfig: typeof systemConfig;
  taskMining: typeof taskMining;
  tasks: typeof tasks;
  teamActivity: typeof teamActivity;
  teams: typeof teams;
  titleGeneration: typeof titleGeneration;
  users: typeof users;
  workflow_runs: typeof workflow_runs;
  workflows: typeof workflows;
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
