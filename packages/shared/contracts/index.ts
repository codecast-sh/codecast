// Cross-runtime contract enums: pure 'as const' arrays + derived types that are
// the single source of truth shared by the Convex backend, the Node daemon, and
// the browser. PURE isomorphic data only — no Node or DOM APIs — so the Convex
// runtime can import them.
export * from "./agentStatus";
export * from "./openTasks";
export * from "./pendingStatus";
export * from "./daemonCommands";
export * from "./agentClients";
export * from "./executionBinding";
export * from "./modelOptions";
export * from "./workState";
export * from "./threadState";
export * from "./apiErrorBanner";
export * from "./providerKeys";
export * from "./providerKeyCrypto";
export * from "./snippets";
export * from "./teamFeatures";
export * from "./stableContext";
export * from "./vaultProtocol";
export * from "./vaultMirror";
export * from "./terminalStream";
export * from "./callRoomKeys";
export * from "./callPush";
export * from "./transcriptChunk";
export * from "./convexErrors";
// Without these two lines every consumer reinvents the capability vocabulary:
// convex copied the constants, the web store reached in by relative path, and
// the web UI and the CLI each declared their own scope and kind unions. Four
// workarounds for one missing export.
export * from "./capabilities";
export * from "./capabilityResolver";
// The fleet comparison — one row per capability, one cell per machine. Here for
// the same reason: the CLI, the browser and Convex all render this grid, and
// while it lived in the CLI the other two could only reimplement it.
export * from "./fleetDiff";
export * from "./capabilityScopes";
export * from "./sanitizeText";
export * from "./mcpRegistry";
export * from "./usageLimits";
// The connectable-apps catalog (the /capabilities Apps tab): Convex answers
// connection state in this vocabulary and the web renders it, so both need the
// one definition. Deep paths do not resolve past the exports map — barrel only.
export * from "./appDescriptors";
// The cross-entity review queue row — one shape for "what is waiting on a
// human", fed by comment threads, page comments, and workflow gates alike.
