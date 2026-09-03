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
import type * as analytics from "../analytics.js";
import type * as anchors from "../anchors.js";
import type * as apiTokens from "../apiTokens.js";
import type * as apnsVoip from "../apnsVoip.js";
import type * as appConnections from "../appConnections.js";
import type * as artifactPages from "../artifactPages.js";
import type * as artifacts from "../artifacts.js";
import type * as artifactsHttp from "../artifactsHttp.js";
import type * as auth from "../auth.js";
import type * as blame from "../blame.js";
import type * as blameCore from "../blameCore.js";
import type * as bookmarkViewWrites from "../bookmarkViewWrites.js";
import type * as bookmarks from "../bookmarks.js";
import type * as buckets from "../buckets.js";
import type * as callChat from "../callChat.js";
import type * as callRooms from "../callRooms.js";
import type * as calls from "../calls.js";
import type * as capabilities from "../capabilities.js";
import type * as capabilitiesSchema from "../capabilitiesSchema.js";
import type * as capabilityBindings from "../capabilityBindings.js";
import type * as capabilityCatalog from "../capabilityCatalog.js";
import type * as capabilityState from "../capabilityState.js";
import type * as ccAccountsShared from "../ccAccountsShared.js";
import type * as changeFeed from "../changeFeed.js";
import type * as changeLog from "../changeLog.js";
import type * as chat from "../chat.js";
import type * as chatAccess from "../chatAccess.js";
import type * as chatText from "../chatText.js";
import type * as chatTyping from "../chatTyping.js";
import type * as cleanup from "../cleanup.js";
import type * as cliAuth from "../cliAuth.js";
import type * as client_state from "../client_state.js";
import type * as cloud from "../cloud.js";
import type * as collab from "../collab.js";
import type * as commentViewWrites from "../commentViewWrites.js";
import type * as comments from "../comments.js";
import type * as commits from "../commits.js";
import type * as composerSuggestions from "../composerSuggestions.js";
import type * as conversationLinks from "../conversationLinks.js";
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
import type * as dormancy from "../dormancy.js";
import type * as emails_digest from "../emails/digest.js";
import type * as emails_render from "../emails/render.js";
import type * as emails_send from "../emails/send.js";
import type * as emails_templates from "../emails/templates.js";
import type * as entities from "../entities.js";
import type * as executionBindings from "../executionBindings.js";
import type * as favoriteViewWrites from "../favoriteViewWrites.js";
import type * as feedPagination from "../feedPagination.js";
import type * as fileChanges_applyPatchParser from "../fileChanges/applyPatchParser.js";
import type * as fileChanges_extractor from "../fileChanges/extractor.js";
import type * as fileChanges_patchParser from "../fileChanges/patchParser.js";
import type * as fileChanges_unifiedDiffParser from "../fileChanges/unifiedDiffParser.js";
import type * as fileTouches from "../fileTouches.js";
import type * as forkCopy from "../forkCopy.js";
import type * as functions from "../functions.js";
import type * as gitEvents from "../gitEvents.js";
import type * as githubApi from "../githubApi.js";
import type * as githubApp from "../githubApp.js";
import type * as githubWebhooks from "../githubWebhooks.js";
import type * as googleOAuth from "../googleOAuth.js";
import type * as googleOAuthSchema from "../googleOAuthSchema.js";
import type * as health from "../health.js";
import type * as heartbeatBacklog from "../heartbeatBacklog.js";
import type * as http from "../http.js";
import type * as idleSummary from "../idleSummary.js";
import type * as images from "../images.js";
import type * as inboxFilters from "../inboxFilters.js";
import type * as inboxProjection from "../inboxProjection.js";
import type * as ipRateLimit from "../ipRateLimit.js";
import type * as issueSync from "../issueSync.js";
import type * as issueSyncSchema from "../issueSyncSchema.js";
import type * as lib_access from "../lib/access.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_commentSessionInfo from "../lib/commentSessionInfo.js";
import type * as lib_docSnapshot from "../lib/docSnapshot.js";
import type * as lib_gitRefs from "../lib/gitRefs.js";
import type * as lib_liveSessions from "../lib/liveSessions.js";
import type * as lib_openTasksValidator from "../lib/openTasksValidator.js";
import type * as lib_sanitize from "../lib/sanitize.js";
import type * as lib_userSend from "../lib/userSend.js";
import type * as lib_viewWriters from "../lib/viewWriters.js";
import type * as localFirstCommands from "../localFirstCommands.js";
import type * as localViewRevisions from "../localViewRevisions.js";
import type * as loopState from "../loopState.js";
import type * as managedSessions from "../managedSessions.js";
import type * as messageFeed from "../messageFeed.js";
import type * as messageViewContracts from "../messageViewContracts.js";
import type * as messages from "../messages.js";
import type * as migrations from "../migrations.js";
import type * as notificationRouter from "../notificationRouter.js";
import type * as notifications from "../notifications.js";
import type * as oauthConnectors from "../oauthConnectors.js";
import type * as oauthConnectorsSchema from "../oauthConnectorsSchema.js";
import type * as orchestrationEvents from "../orchestrationEvents.js";
import type * as patterns from "../patterns.js";
import type * as pendingMessageWrites from "../pendingMessageWrites.js";
import type * as pendingMessages from "../pendingMessages.js";
import type * as permissions from "../permissions.js";
import type * as plans from "../plans.js";
import type * as prShepherd from "../prShepherd.js";
import type * as presenceState from "../presenceState.js";
import type * as principalViewRevisions from "../principalViewRevisions.js";
import type * as privacy from "../privacy.js";
import type * as progressEvents from "../progressEvents.js";
import type * as projectPaths from "../projectPaths.js";
import type * as projectUpdates from "../projectUpdates.js";
import type * as projects from "../projects.js";
import type * as publicComments from "../publicComments.js";
import type * as pull_requests from "../pull_requests.js";
import type * as pushRouter from "../pushRouter.js";
import type * as rateLimit from "../rateLimit.js";
import type * as redact from "../redact.js";
import type * as reviews from "../reviews.js";
import type * as savedViews from "../savedViews.js";
import type * as searchCore from "../searchCore.js";
import type * as searchMirror from "../searchMirror.js";
import type * as sendBackfill from "../sendBackfill.js";
import type * as sessionDecisions from "../sessionDecisions.js";
import type * as sessionImages from "../sessionImages.js";
import type * as sessionInitiator from "../sessionInitiator.js";
import type * as sessionInsights from "../sessionInsights.js";
import type * as sessionOwners from "../sessionOwners.js";
import type * as sessionOwnership from "../sessionOwnership.js";
import type * as sessionThreads from "../sessionThreads.js";
import type * as slack from "../slack.js";
import type * as smallViewContracts from "../smallViewContracts.js";
import type * as spawn from "../spawn.js";
import type * as storyMode from "../storyMode.js";
import type * as syncCursors from "../syncCursors.js";
import type * as syncLog from "../syncLog.js";
import type * as syncLogPrune from "../syncLogPrune.js";
import type * as systemConfig from "../systemConfig.js";
import type * as taskMining from "../taskMining.js";
import type * as tasks from "../tasks.js";
import type * as teamActivity from "../teamActivity.js";
import type * as teamFeatures from "../teamFeatures.js";
import type * as teamScopeSweep from "../teamScopeSweep.js";
import type * as teams from "../teams.js";
import type * as terminalStream from "../terminalStream.js";
import type * as testDb from "../testDb.js";
import type * as threadMembershipSweep from "../threadMembershipSweep.js";
import type * as threadReads from "../threadReads.js";
import type * as threads from "../threads.js";
import type * as titleGeneration from "../titleGeneration.js";
import type * as transcripts from "../transcripts.js";
import type * as userMessagesFilter from "../userMessagesFilter.js";
import type * as users from "../users.js";
import type * as vaultMirror from "../vaultMirror.js";
import type * as verification from "../verification.js";
import type * as webDocsPagination from "../webDocsPagination.js";
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
  analytics: typeof analytics;
  anchors: typeof anchors;
  apiTokens: typeof apiTokens;
  apnsVoip: typeof apnsVoip;
  appConnections: typeof appConnections;
  artifactPages: typeof artifactPages;
  artifacts: typeof artifacts;
  artifactsHttp: typeof artifactsHttp;
  auth: typeof auth;
  blame: typeof blame;
  blameCore: typeof blameCore;
  bookmarkViewWrites: typeof bookmarkViewWrites;
  bookmarks: typeof bookmarks;
  buckets: typeof buckets;
  callChat: typeof callChat;
  callRooms: typeof callRooms;
  calls: typeof calls;
  capabilities: typeof capabilities;
  capabilitiesSchema: typeof capabilitiesSchema;
  capabilityBindings: typeof capabilityBindings;
  capabilityCatalog: typeof capabilityCatalog;
  capabilityState: typeof capabilityState;
  ccAccountsShared: typeof ccAccountsShared;
  changeFeed: typeof changeFeed;
  changeLog: typeof changeLog;
  chat: typeof chat;
  chatAccess: typeof chatAccess;
  chatText: typeof chatText;
  chatTyping: typeof chatTyping;
  cleanup: typeof cleanup;
  cliAuth: typeof cliAuth;
  client_state: typeof client_state;
  cloud: typeof cloud;
  collab: typeof collab;
  commentViewWrites: typeof commentViewWrites;
  comments: typeof comments;
  commits: typeof commits;
  composerSuggestions: typeof composerSuggestions;
  conversationLinks: typeof conversationLinks;
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
  dormancy: typeof dormancy;
  "emails/digest": typeof emails_digest;
  "emails/render": typeof emails_render;
  "emails/send": typeof emails_send;
  "emails/templates": typeof emails_templates;
  entities: typeof entities;
  executionBindings: typeof executionBindings;
  favoriteViewWrites: typeof favoriteViewWrites;
  feedPagination: typeof feedPagination;
  "fileChanges/applyPatchParser": typeof fileChanges_applyPatchParser;
  "fileChanges/extractor": typeof fileChanges_extractor;
  "fileChanges/patchParser": typeof fileChanges_patchParser;
  "fileChanges/unifiedDiffParser": typeof fileChanges_unifiedDiffParser;
  fileTouches: typeof fileTouches;
  forkCopy: typeof forkCopy;
  functions: typeof functions;
  gitEvents: typeof gitEvents;
  githubApi: typeof githubApi;
  githubApp: typeof githubApp;
  githubWebhooks: typeof githubWebhooks;
  googleOAuth: typeof googleOAuth;
  googleOAuthSchema: typeof googleOAuthSchema;
  health: typeof health;
  heartbeatBacklog: typeof heartbeatBacklog;
  http: typeof http;
  idleSummary: typeof idleSummary;
  images: typeof images;
  inboxFilters: typeof inboxFilters;
  inboxProjection: typeof inboxProjection;
  ipRateLimit: typeof ipRateLimit;
  issueSync: typeof issueSync;
  issueSyncSchema: typeof issueSyncSchema;
  "lib/access": typeof lib_access;
  "lib/auth": typeof lib_auth;
  "lib/commentSessionInfo": typeof lib_commentSessionInfo;
  "lib/docSnapshot": typeof lib_docSnapshot;
  "lib/gitRefs": typeof lib_gitRefs;
  "lib/liveSessions": typeof lib_liveSessions;
  "lib/openTasksValidator": typeof lib_openTasksValidator;
  "lib/sanitize": typeof lib_sanitize;
  "lib/userSend": typeof lib_userSend;
  "lib/viewWriters": typeof lib_viewWriters;
  localFirstCommands: typeof localFirstCommands;
  localViewRevisions: typeof localViewRevisions;
  loopState: typeof loopState;
  managedSessions: typeof managedSessions;
  messageFeed: typeof messageFeed;
  messageViewContracts: typeof messageViewContracts;
  messages: typeof messages;
  migrations: typeof migrations;
  notificationRouter: typeof notificationRouter;
  notifications: typeof notifications;
  oauthConnectors: typeof oauthConnectors;
  oauthConnectorsSchema: typeof oauthConnectorsSchema;
  orchestrationEvents: typeof orchestrationEvents;
  patterns: typeof patterns;
  pendingMessageWrites: typeof pendingMessageWrites;
  pendingMessages: typeof pendingMessages;
  permissions: typeof permissions;
  plans: typeof plans;
  prShepherd: typeof prShepherd;
  presenceState: typeof presenceState;
  principalViewRevisions: typeof principalViewRevisions;
  privacy: typeof privacy;
  progressEvents: typeof progressEvents;
  projectPaths: typeof projectPaths;
  projectUpdates: typeof projectUpdates;
  projects: typeof projects;
  publicComments: typeof publicComments;
  pull_requests: typeof pull_requests;
  pushRouter: typeof pushRouter;
  rateLimit: typeof rateLimit;
  redact: typeof redact;
  reviews: typeof reviews;
  savedViews: typeof savedViews;
  searchCore: typeof searchCore;
  searchMirror: typeof searchMirror;
  sendBackfill: typeof sendBackfill;
  sessionDecisions: typeof sessionDecisions;
  sessionImages: typeof sessionImages;
  sessionInitiator: typeof sessionInitiator;
  sessionInsights: typeof sessionInsights;
  sessionOwners: typeof sessionOwners;
  sessionOwnership: typeof sessionOwnership;
  sessionThreads: typeof sessionThreads;
  slack: typeof slack;
  smallViewContracts: typeof smallViewContracts;
  spawn: typeof spawn;
  storyMode: typeof storyMode;
  syncCursors: typeof syncCursors;
  syncLog: typeof syncLog;
  syncLogPrune: typeof syncLogPrune;
  systemConfig: typeof systemConfig;
  taskMining: typeof taskMining;
  tasks: typeof tasks;
  teamActivity: typeof teamActivity;
  teamFeatures: typeof teamFeatures;
  teamScopeSweep: typeof teamScopeSweep;
  teams: typeof teams;
  terminalStream: typeof terminalStream;
  testDb: typeof testDb;
  threadMembershipSweep: typeof threadMembershipSweep;
  threadReads: typeof threadReads;
  threads: typeof threads;
  titleGeneration: typeof titleGeneration;
  transcripts: typeof transcripts;
  userMessagesFilter: typeof userMessagesFilter;
  users: typeof users;
  vaultMirror: typeof vaultMirror;
  verification: typeof verification;
  webDocsPagination: typeof webDocsPagination;
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
