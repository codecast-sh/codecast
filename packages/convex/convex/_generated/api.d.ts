/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as accountSwitch from "../accountSwitch.js";
import type * as admin_mergeUser from "../admin_mergeUser.js";
import type * as agentTasks from "../agentTasks.js";
import type * as anchors from "../anchors.js";
import type * as apiTokens from "../apiTokens.js";
import type * as auth from "../auth.js";
import type * as blame from "../blame.js";
import type * as blameCore from "../blameCore.js";
import type * as bookmarks from "../bookmarks.js";
import type * as buckets from "../buckets.js";
import type * as ccAccountsShared from "../ccAccountsShared.js";
import type * as changeFeed from "../changeFeed.js";
import type * as changeLog from "../changeLog.js";
import type * as cleanup from "../cleanup.js";
import type * as cliAuth from "../cliAuth.js";
import type * as client_state from "../client_state.js";
import type * as collab from "../collab.js";
import type * as comments from "../comments.js";
import type * as commits from "../commits.js";
import type * as conversationSessionLookup from "../conversationSessionLookup.js";
import type * as conversations from "../conversations.js";
import type * as counters from "../counters.js";
import type * as crons from "../crons.js";
import type * as daemonCommandUtils from "../daemonCommandUtils.js";
import type * as daemonLogs from "../daemonLogs.js";
import type * as data from "../data.js";
import type * as debugTmp from "../debugTmp.js";
import type * as decisions from "../decisions.js";
import type * as deviceRouting from "../deviceRouting.js";
import type * as deviceSettingsShared from "../deviceSettingsShared.js";
import type * as devices from "../devices.js";
import type * as dispatch from "../dispatch.js";
import type * as docExtraction from "../docExtraction.js";
import type * as docSync from "../docSync.js";
import type * as docs from "../docs.js";
import type * as feedPagination from "../feedPagination.js";
import type * as fileChanges_applyPatchParser from "../fileChanges/applyPatchParser.js";
import type * as fileChanges_extractor from "../fileChanges/extractor.js";
import type * as fileChanges_patchParser from "../fileChanges/patchParser.js";
import type * as fileChanges_unifiedDiffParser from "../fileChanges/unifiedDiffParser.js";
import type * as fileTouches from "../fileTouches.js";
import type * as forkCopy from "../forkCopy.js";
import type * as functions from "../functions.js";
import type * as githubApi from "../githubApi.js";
import type * as githubApp from "../githubApp.js";
import type * as githubWebhooks from "../githubWebhooks.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as idleSummary from "../idleSummary.js";
import type * as images from "../images.js";
import type * as inboxFilters from "../inboxFilters.js";
import type * as ipRateLimit from "../ipRateLimit.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_docSnapshot from "../lib/docSnapshot.js";
import type * as managedSessions from "../managedSessions.js";
import type * as messageFeed from "../messageFeed.js";
import type * as messages from "../messages.js";
import type * as migrations from "../migrations.js";
import type * as notificationRouter from "../notificationRouter.js";
import type * as notifications from "../notifications.js";
import type * as orchestrationEvents from "../orchestrationEvents.js";
import type * as patterns from "../patterns.js";
import type * as pendingMessages from "../pendingMessages.js";
import type * as permissions from "../permissions.js";
import type * as plans from "../plans.js";
import type * as privacy from "../privacy.js";
import type * as progressEvents from "../progressEvents.js";
import type * as projectPaths from "../projectPaths.js";
import type * as projects from "../projects.js";
import type * as publicComments from "../publicComments.js";
import type * as pull_requests from "../pull_requests.js";
import type * as rateLimit from "../rateLimit.js";
import type * as redact from "../redact.js";
import type * as reviews from "../reviews.js";
import type * as searchCore from "../searchCore.js";
import type * as sessionInsights from "../sessionInsights.js";
import type * as sessionOwnership from "../sessionOwnership.js";
import type * as sessionThreads from "../sessionThreads.js";
import type * as slack from "../slack.js";
import type * as spawn from "../spawn.js";
import type * as storyMode from "../storyMode.js";
import type * as syncCursors from "../syncCursors.js";
import type * as systemConfig from "../systemConfig.js";
import type * as taskMining from "../taskMining.js";
import type * as tasks from "../tasks.js";
import type * as teamActivity from "../teamActivity.js";
import type * as teams from "../teams.js";
import type * as testDb from "../testDb.js";
import type * as titleGeneration from "../titleGeneration.js";
import type * as userMessagesFilter from "../userMessagesFilter.js";
import type * as users from "../users.js";
import type * as workflow_runs from "../workflow_runs.js";
import type * as workflows from "../workflows.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  accountSwitch: typeof accountSwitch;
  admin_mergeUser: typeof admin_mergeUser;
  agentTasks: typeof agentTasks;
  anchors: typeof anchors;
  apiTokens: typeof apiTokens;
  auth: typeof auth;
  blame: typeof blame;
  blameCore: typeof blameCore;
  bookmarks: typeof bookmarks;
  buckets: typeof buckets;
  ccAccountsShared: typeof ccAccountsShared;
  changeFeed: typeof changeFeed;
  changeLog: typeof changeLog;
  cleanup: typeof cleanup;
  cliAuth: typeof cliAuth;
  client_state: typeof client_state;
  collab: typeof collab;
  comments: typeof comments;
  commits: typeof commits;
  conversationSessionLookup: typeof conversationSessionLookup;
  conversations: typeof conversations;
  counters: typeof counters;
  crons: typeof crons;
  daemonCommandUtils: typeof daemonCommandUtils;
  daemonLogs: typeof daemonLogs;
  data: typeof data;
  debugTmp: typeof debugTmp;
  decisions: typeof decisions;
  deviceRouting: typeof deviceRouting;
  deviceSettingsShared: typeof deviceSettingsShared;
  devices: typeof devices;
  dispatch: typeof dispatch;
  docExtraction: typeof docExtraction;
  docSync: typeof docSync;
  docs: typeof docs;
  feedPagination: typeof feedPagination;
  "fileChanges/applyPatchParser": typeof fileChanges_applyPatchParser;
  "fileChanges/extractor": typeof fileChanges_extractor;
  "fileChanges/patchParser": typeof fileChanges_patchParser;
  "fileChanges/unifiedDiffParser": typeof fileChanges_unifiedDiffParser;
  fileTouches: typeof fileTouches;
  forkCopy: typeof forkCopy;
  functions: typeof functions;
  githubApi: typeof githubApi;
  githubApp: typeof githubApp;
  githubWebhooks: typeof githubWebhooks;
  health: typeof health;
  http: typeof http;
  idleSummary: typeof idleSummary;
  images: typeof images;
  inboxFilters: typeof inboxFilters;
  ipRateLimit: typeof ipRateLimit;
  "lib/access": typeof lib_access;
  "lib/auth": typeof lib_auth;
  "lib/docSnapshot": typeof lib_docSnapshot;
  managedSessions: typeof managedSessions;
  messageFeed: typeof messageFeed;
  messages: typeof messages;
  migrations: typeof migrations;
  notificationRouter: typeof notificationRouter;
  notifications: typeof notifications;
  orchestrationEvents: typeof orchestrationEvents;
  patterns: typeof patterns;
  pendingMessages: typeof pendingMessages;
  permissions: typeof permissions;
  plans: typeof plans;
  privacy: typeof privacy;
  progressEvents: typeof progressEvents;
  projectPaths: typeof projectPaths;
  projects: typeof projects;
  publicComments: typeof publicComments;
  pull_requests: typeof pull_requests;
  rateLimit: typeof rateLimit;
  redact: typeof redact;
  reviews: typeof reviews;
  searchCore: typeof searchCore;
  sessionInsights: typeof sessionInsights;
  sessionOwnership: typeof sessionOwnership;
  sessionThreads: typeof sessionThreads;
  slack: typeof slack;
  spawn: typeof spawn;
  storyMode: typeof storyMode;
  syncCursors: typeof syncCursors;
  systemConfig: typeof systemConfig;
  taskMining: typeof taskMining;
  tasks: typeof tasks;
  teamActivity: typeof teamActivity;
  teams: typeof teams;
  testDb: typeof testDb;
  titleGeneration: typeof titleGeneration;
  userMessagesFilter: typeof userMessagesFilter;
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
