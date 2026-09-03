// Cross-runtime contract enums: pure 'as const' arrays + derived types that are
// the single source of truth shared by the Convex backend, the Node daemon, and
// the browser. PURE isomorphic data only — no Node or DOM APIs — so the Convex
// runtime can import them.
export * from "./agentStatus";
export * from "./openTasks";
export * from "./pendingStatus";
export * from "./daemonCommands";
export * from "./sshAttach";
export * from "./agentClients";
export * from "./executionBinding";
export * from "./modelOptions";
export * from "./workState";
export * from "./loopState";
export * from "./threadState";
export * from "./apiErrorBanner";
export * from "./deviceName";
export * from "./providerKeys";
export * from "./providerKeyCrypto";
export * from "./snippets";
export * from "./agentSwitch";
export * from "./teamFeatures";
export * from "./stableContext";
export * from "./vaultProtocol";
export * from "./vaultMirror";
export * from "./terminalStream";
export * from "./callRoomKeys";
export * from "./recordingAudio";
export * from "./callPush";
export * from "./transcriptChunk";
// The row a finished huddle leaves in its chat room or session: one formatter
// for the digest markdown and the <huddle-summary> wire tag, one parser back.
export * from "./huddleDigest";
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
// Machine-delivered message detection: web/mobile previews and the convex
// send classifier must agree on what a human-typed message is.
export * from "./machineMessages";
export * from "./mcpRegistry";
export * from "./usageLimits";
// The connectable-apps catalog (the /capabilities Apps tab): Convex answers
// connection state in this vocabulary and the web renders it, so both need the
// one definition. Deep paths do not resolve past the exports map — barrel only.
export * from "./appDescriptors";
// The cross-entity review queue row — one shape for "what is waiting on a
// human", fed by comment threads, page comments, and workflow gates alike.
// The inbox projection: the bucket alphabet, the ONE placement function the
// Convex overlay and the CLI inbox both call, the time-flip stamps and the
// order-independent digest every client compares against (sync-convergence C3, C8).
export * from "./inboxProjection";
export * from "./appSurfaces";
// How a pull request is named: one parser for the reference forms people type
// and one builder for the codecast page link, shared by the CLI, Convex and web.
export * from "./prRefs";
