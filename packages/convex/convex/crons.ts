import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("recover pending sync delivery", { minutes: 1 }, (internal as any).syncOutbox.recover, {});

// Read Expo push receipts, where a revoked APNs key shows (pushReceipts.ts).
crons.interval("check push receipts", { minutes: 30 }, (internal as any).pushReceipts.sweep, {});

// The session lifecycle trail keeps 60 days (conversationEvents.ts).
crons.interval("prune conversation events", { hours: 6 }, (internal as any).conversationEvents.prune, {});

// Summarize hosted conversations' history past the replayed window
// (assistant/longHistory.ts): bounded by its own deadline and spend caps.
// Keep agent-review problem scores current: every 6 hours a batch of the
// problems with no score or a newer finding, under a $2 daily cap
// (problemScores.ts). The 15-minute tick collects a batch soon after it ends.
crons.interval("score agent-review problems", { minutes: 15 }, internal.problemScores.tick, {});
// Group the findings that came in while grouping could not compare them (the budget refused, or the embedding failed):
// they wait held instead of opening a problem each (findingRegroup.ts).
crons.interval("group findings grouping refused", { minutes: 10 }, internal.findingRegroup.groupAwaiting, {});
// A problem under a live flow's bar that got no new finding in the bar's days closes; a new one reopens it (sd-1700).
crons.interval("close quiet problems under a live flow bar", { hours: 6 }, internal.liveFlowQuiet.sweepAll, {});

crons.interval("summarize long assistant conversations", { minutes: 10 }, internal.assistant.longHistory.compress, {});

crons.interval(
  "fill short titles for tasks and plans",
  { minutes: 2 },
  internal.titleGeneration.fillShortTitles,
  {}
);

crons.interval(
  "process github comment webhooks",
  { minutes: 1 },
  internal.githubWebhooks.processCommentWebhooks,
  { limit: 50 }
);

// Fit the tokens-per-percent rate against the slot that just closed. Runs on
// the slot boundary, because a run that straddles two slots has no closed one
// to read (usageCalibration.ts).
crons.interval(
  "sample usage calibration",
  { minutes: 20 },
  internal.usageCalibration.sample,
  {}
);

// The area watch (docs/architecture/org-staffing.md S29): read each watched
// workspace's health, remember every area's status, and tell the Head of
// People once per episode about a change that lasted two passes.
crons.interval(
  "watch org areas",
  { hours: 6 },
  internal.orgWatch.sweep,
  {}
);

// Knowledge handoffs (org-staffing.md S32): one past its deadline closes with
// what was written, and a retire that waited on it runs.
crons.interval(
  "close org handoffs past deadline",
  { minutes: 15 },
  internal.orgHandoff.sweep,
  {}
);

// Changes editions (docs/proposals/changes-page.md 7.7): days of the last
// three with commits and no final edition, for teams with Changes on, are
// marked dirty, and rebuilds that died are scheduled again.
crons.interval(
  "reconcile changes days",
  { hours: 6 },
  internal.changesSchedule.reconcile,
  {}
);

crons.interval(
  "reclaim stale agent tasks",
  { minutes: 5 },
  internal.agentTasks.reclaimStaleTasks
);

// Decision stacks with an auto default policy: answer advisory members whose
// deadline passed (decisionStacks.applyAutoDefaultsCore).
crons.interval(
  "apply decision stack auto defaults",
  { minutes: 5 },
  internal.decisionStacks.applyAutoDefaults,
  {}
);

crons.interval(
  "reconcile cloud wake requests",
  { seconds: 60 },
  (internal as any).cloudWake.reconcile,
  {}
);

crons.interval(
  "dispatch due cloud triggers",
  { seconds: 60 },
  internal.agentTasks.dispatchCloudTriggers,
  {}
);

crons.interval(
  "retry stuck pending messages",
  // Backstop only — the daemon drives live delivery via getPendingMessages. 30s was
  // needlessly aggressive and (with the old full-table scan) drove a scheduler
  // pileup. 60s keeps just-idle messages responsive while halving revive churn.
  { seconds: 60 },
  internal.pendingMessages.retryStuckMessages
);

crons.interval(
  "check daemon health",
  { minutes: 5 },
  internal.daemonLogs.checkDaemonHealth
);

// Separate entry from "check daemon health" so a failure in one alert never
// stops the other. The 5 minute cadence is also this alert's debounce.
// Pending permissions on a machine that stopped beating can never be answered;
// expiring them keeps Needs Input honest. Its own entry, like the freeze alert.
crons.interval(
  "expire offline device permissions",
  { minutes: 5 },
  internal.permissions.expireOfflinePermissions
);

crons.interval(
  "check daemon loop freeze",
  { minutes: 5 },
  internal.daemonLogs.checkDeviceLoopFreeze
);

crons.interval(
  // pending_permissions was never pruned — resolved rows matter for ~5 min and
  // the daemon cancels its own after ~1h, so drop the leftovers hourly to keep
  // the table (and every reader's scan) small.
  "prune resolved pending_permissions",
  { hours: 1 },
  internal.permissions.prunePendingPermissions
);

crons.interval(
  "prune expired ip_rate_limits windows",
  { hours: 1 },
  internal.ipRateLimit.pruneIpRateLimits
);

crons.interval(
  "prune stale remote terminal frames",
  { hours: 6 },
  internal.terminalStream.pruneStaleFrames
);

crons.interval(
  "refresh plan timestamps from session insights",
  { hours: 6 },
  internal.taskMining.refreshPlanTimestamps
);

crons.interval(
  "reap stale managed sessions",
  { minutes: 10 },
  internal.managedSessions.reapStaleManagedSessions,
  {}
);

crons.interval(
  // Recent-window content-search mirror (searchMirror.ts, ct-37627): walks
  // messages forward by _creationTime — backfill, tail sync, and window GC in
  // one step. Content search cuts over to the mirror automatically once the
  // cursor is fresh (see fetchMessageSearchPool).
  // batch 1200 = the max per tick, not the steady load: caught up, a tick
  // scans only the new tail (usually <100 rows). The headroom exists so the
  // cron re-drives its own backfill after any outage without a client loop.
  // 1200 (not more) keeps a full batch under the ~4096 ops/transaction
  // ceiling together with searchMirror's MAX_UPSERTS_PER_RUN break.
  "advance search mirror",
  { seconds: 15 },
  internal.searchMirror.advance,
  { batch: 1200 }
);

crons.interval(
  // Kicks off the retention drain; pruneOldLogs self-reschedules to chew through
  // the ~9.5M-row backlog, then settles into trimming rows past the 3-day window.
  "prune old daemon logs",
  { minutes: 30 },
  internal.daemonLogs.pruneOldLogs,
  {}
);

crons.interval(
  // Sweeps abandoned "New Session" rows (quick-create pre-warms a conversation
  // per summon; abandoning it strands an empty row). Rolling 2h band just past
  // the 24h grace cutoff — see cleanup.gcEmptyConversations.
  "gc abandoned empty conversations",
  { hours: 1 },
  internal.cleanup.gcEmptyConversations,
  {}
);

crons.interval(
  // Expired `cast auth` relay deposits (browser couldn't reach the CLI and the
  // CLI never claimed). Revokes the orphaned token along with the row.
  "sweep expired cli auth relays",
  { minutes: 15 },
  internal.cliAuth.sweepExpired,
  {}
);

crons.interval(
  // A cause whose watch after ship ended with no new signal closes as
  // resolved (the-line-end-to-end.md LE12). One empty index read while
  // nothing is in watch.
  "close quiet watches",
  { hours: 1 },
  internal.signals.sweepWatches,
  {}
);

crons.interval(
  // A judge's finding marked wrong waits for its project's line to diagnose
  // it (learning-loop.md LL11): the sweep starts waiting diagnoses while the
  // line is on and retries one whose run ended without an answer. Two empty
  // index reads while nothing waits.
  "diagnose wrong findings",
  { minutes: 5 },
  (internal as any).judgeReview.sweep,
  {}
);

crons.interval(
  // A deferred review finding past its due date and still open files one
  // signal (fingerprint promise:<id>), so the line reopens or files the work
  // through its normal path. Stamped once per finding; never fires twice.
  "overdue promises",
  { hours: 1 },
  internal.reviewNotes.sweepOverduePromises,
  {}
);

crons.interval(
  // pending_api_error flags older than the 48h revive window stop meaning
  // "current incident" — clear them so the blocked-sessions banner, badges,
  // and mass-revive selection never count weeks-dead casualties.
  "sweep stale api-error flags",
  { hours: 1 },
  internal.accountSwitch.sweepStaleApiErrorFlags,
  {}
);

crons.interval(
  // Slack dedup rows only need to outlive Slack's retry window (minutes); drop
  // anything older than a day so the table can't grow unbounded.
  "sweep slack dedup events",
  { hours: 6 },
  internal.slack.sweepSlackEvents,
  {}
);

// Slack mirror job ledger (slackSync): drop processed rows, requeue anything
// whose action was lost.
crons.interval(
  "sweep slack sync events",
  { hours: 1 },
  internal.slackSync.sweepSyncEvents,
  {}
);

crons.interval(
  // Who is in each mirrored Slack workspace. Without this the people table
  // only learns somebody when they speak, and a codecast mention of a quiet
  // teammate or an agent posts to Slack as plain text instead of paging them.
  "refresh slack workspace people",
  { hours: 24 },
  internal.slackSync.refreshAllWorkspacePeople,
  {}
);

crons.interval(
  // Capability rows for machines silent 90+ days: the daemon cannot clean up a
  // laptop that was wiped, so the server notices the silence instead.
  "sweep dead-device capability state",
  { hours: 24 },
  internal.capabilities.sweepCapabilityState,
  {}
);

crons.interval(
  // The capability audit trail keeps 90 days — enough for any incident that
  // will actually be investigated, short enough that it cannot become the db.
  "sweep capability events",
  { hours: 24 },
  internal.capabilities.sweepCapabilityEvents,
  {}
);

crons.interval(
  // The public MCP registry into the catalog cache, so the Library tab has
  // something to browse. Six hours: the registry moves slowly, and the cache
  // sweep drops anything not refreshed in 30 days.
  "refresh mcp registry catalog",
  { hours: 6 },
  internal.capabilities.refreshMcpRegistry,
  {}
);

crons.interval(
  // "While you were away" email digest: batches unseen mentions, comments,
  // chat and pending decisions for people who are away. Grace/cooldown live in
  // emails/digest.ts; the 10-minute tick only bounds detection latency.
  "email notification digest sweep",
  { minutes: 10 },
  internal.emails.digest.sweep,
  {}
);

crons.interval(
  // A live transcript whose room holds no fresh seat lease is an orphan
  // (scribe tab died, nobody rejoined). Ends it so the calls page stops
  // showing it as live and its summary generates.
  "end orphaned live transcripts",
  { minutes: 2 },
  internal.transcripts.sweepOrphanedLive,
  {}
);

crons.interval(
  // A guest let into a huddle is put out when it ends, when they leave and
  // when their page goes quiet, whether or not anybody's client is there to
  // say so, and LiveKit is made to agree (callGuests.sweepGuestRooms). Costs
  // one empty index read while nobody outside the team is in a call.
  "settle call guests",
  { minutes: 1 },
  internal.callGuests.sweepGuestRooms,
  {}
);

crons.interval(
  // Every call recording LiveKit is still writing has a loop polling it
  // (callRecordings.reconcileRun). An action that died mid-run would leave a
  // room reading "recording" forever; this restarts the loop of any run
  // nobody has looked at for a few minutes, and stops any egress filming
  // into the recordings bucket that no live recording tracks.
  "restart stalled call recording loops",
  { minutes: 2 },
  internal.callRecordings.sweepRecordings,
  {}
);

crons.interval(
  // Objects in the recordings bucket that no recording row accounts for (a
  // manifest LiveKit wrote, a delete that gave up, an upload that landed
  // after its run was deleted) go, so deleting a recording really deletes it.
  "sweep orphaned call recording objects",
  { hours: 24 },
  internal.callRecordings.sweepRecordingObjects,
  {}
);

crons.cron(
  // Sync-log retention: delete actions past the 30d window and advance
  // per-scope floors (syncLogPrune.ts; the mutation self-continues in bounded
  // batches). Fixed cron, NOT interval: interval phase anchors to deploy time
  // and drifts, and this job's bulk deletes must stay clear of the nightly
  // backup window (~23:30–01:15 UTC — the documented backup IO collision
  // class). Hourly at :45 from 02:00–22:45 UTC; the 30d window easily absorbs
  // the nightly gap.
  "prune sync log actions",
  "45 2-22 * * *",
  internal.syncLogPrune.pruneSyncActions,
  {}
);

crons.interval(
  // Repository content we cached for the source and history pages. It is all
  // re-fetchable, so a week without a read means nobody wants it.
  "prune repository content cache",
  { hours: 12 },
  internal.repos.pruneRepoCache,
  {}
);

crons.interval(
  // Issue sync catch-up (issue-sync.md S6). Pulls every active source for
  // issues updated since its last sync, minus a 5 minute overlap, and applies
  // them through the same applyRemote path a webhook takes. This is both the
  // repair for a webhook that never arrived and the only retry an outbound
  // push gets — pushTask deliberately never retries in a loop (S5).
  "reconcile issue sync sources",
  { minutes: 15 },
  internal.issueSync.reconcileSources,
  {}
);

crons.interval(
  // A bulk-migration runner that died mid-row leaves its conversation fenced
  // (no daemon delivers). Lift stale fences so the session is served again
  // where it still lives; the row fails with a reason a human can act on.
  "reap stale session migrations",
  { minutes: 5 },
  (internal as any).sessionMigrations.reapStale,
  {}
);

// The line sweep (the-line.md L9): starts the top problems of every line whose
// start switch is on (learning-loop.md LL5, caps.line_on on the role that leads
// it), within its slots. Always registered; a line that is off starts nothing.
crons.interval("start the line for scoped tasks", { minutes: 2 }, (internal as any).orgLine.sweep, {});

// The deploy stage's role trigger (deploys.md DP4): a role holding a deploy
// grant asks for a deploy of its project's waiting fixes, within the grant's
// daily limit. Reads only roles with a live deploy grant.
crons.interval("deploy waiting fixes as the line's role", { minutes: 10 }, (internal as any).deploys.autoDeploy, {});

// Promotions a source's hourly cap held back (ingest.promoteDue): filed as the
// window has room, so a burst of new groups reaches the line late, never not at all.
crons.interval("file held-back promotions", { minutes: 10 }, (internal as any).ingest.promoteDue, {});

// A trial project that dispatches (lineTrial.dispatch) starts its own runs:
// the problems with the most live findings first, three at a time at most,
// under its spend cap. One empty index read when no trial dispatches.
crons.interval("dispatch trial runs", { minutes: 10 }, (internal as any).lineTrial.dispatchTick, {});

// Each trial run's price row (trial_run_prices), which the trial's
// spend sums: only live, recently ended or moved runs are priced again.
crons.interval("price trial runs", { minutes: 2 }, (internal as any).lineTrial.priceRunsTick, {});
// Per-day activity counters for the profile graph, the punchcard and the team
// charts (lib/activityDaily.ts). Each run re-rolls only the days still inside
// (or just outside) the live window, for the accounts active in them, so a day
// settles within an hour of leaving the window and a late transcript sync
// corrects the day it belongs to. One small transaction per (user, day).
crons.interval("roll up activity days", { hours: 1 }, internal.activityDays.sweep, {});

// The flow map's counts (flowMap.ts): per workspace with a live flow, findings
// per source and day (yesterday and today recounted), where each source's
// problems stand, and open event groups no problem took.
crons.interval("roll up the flow map", { hours: 1 }, (internal as any).flowMap.rollup, {});

// A problem whose title was written from findings that have all left it is
// renamed from the findings on it now (lineRetitle.ts). One index read per
// open problem; a rename is one cheap call on the team's grouping budget.
crons.interval("rename problems whose findings left", { minutes: 10 }, (internal as any).lineRetitle.sweep, {});

crons.interval(
  // A new cause names its goal, category, risk and readiness before the line
  // can rank and admit it (the-line-end-to-end.md LE5).
  "ground new causes",
  { minutes: 2 },
  (internal as any).lineGround.sweep,
  {}
);

crons.interval(
  // A person who reports to a role hears once a day at most that a high
  // priority goal of theirs has stalled (org-roles-run-work.md R6).
  "tell people about stalled goals",
  { hours: 1 },
  (internal as any).orgGoals.sweep,
  {}
);

crons.cron(
  // External data upkeep (external-data.md X3): a source's *_today counters
  // start the day at zero, and groups drop bucket hours past the 72 hour
  // window. A batch already resets its own source's counters on a new UTC
  // day, so this only zeros quiet sources, and runs clear of the nightly
  // backup window (see "prune sync log actions").
  "reset ingest counters and buckets",
  "15 2 * * *",
  internal.ingest.dailyUpkeep,
  {}
);

crons.cron(
  // Moments (learning-loop.md LL7): a kept body past 30 days is gone from R2,
  // and a moment no extractor took, or one that failed, goes after 30 days.
  "prune moments",
  "35 2 * * *",
  internal.moments.prune,
  {}
);

crons.interval(
  // Event samples older than 30 days (external-data.md X3, X11).
  "prune old event samples",
  { hours: 6 },
  internal.ingest.pruneSamples,
  {}
);

crons.interval(
  // Watched metrics (external-data.md X7): claims the watches whose interval
  // is up and polls each in its own action. The minute is the finest a watch
  // may ask for (METRIC_WATCH_LIMITS.interval_min_ms).
  "poll metric watches",
  { minutes: 1 },
  internal.metrics.pollDue,
  {}
);

crons.interval(
  // App connector watches (external-data.md X8): each source whose watch
  // interval is up polls the watched reader in its own action. Five minutes
  // is the finest a manifest's `every` may ask for (APP_LIMITS.min_watch_ms).
  "poll app connector watches",
  { minutes: 5 },
  internal.sources.app.pollWatches,
  {}
);

crons.interval(
  // App connector manifests a day old refetch even when nobody calls (X8).
  "refresh app connector manifests",
  { hours: 24 },
  internal.sources.app.refreshManifests,
  {}
);

crons.interval(
  // Sentry sources mirror their unresolved issues (external-data.md X7). One
  // action per active source; the webhook, when set up, only removes the lag.
  "poll sentry sources",
  { minutes: 2 },
  internal.sources.sentry.schedulePolls,
  {}
);

crons.interval(
  // A vendor source's recording import (X5): a run whose page chain died
  // continues, and a finished one follows the recordings that arrived since.
  "tend replay imports",
  { minutes: 15 },
  internal.sources.replayBackfill.tend,
  {}
);

crons.interval(
  // Vendor webhook delivery ids past any retry window (X2).
  "prune webhook deliveries",
  { hours: 24 },
  internal.ingest.pruneWebhookDeliveries,
  {}
);

crons.interval(
  // Stored GitHub deliveries past 7 days, read by nothing (sd-1079, ct-60898).
  // A run pages through the backlog itself, 200 rows every 5 s; hourly so a
  // chain a failed page stopped starts again soon.
  "prune github webhook events",
  { hours: 1 },
  internal.githubWebhooks.pruneWebhookEvents,
  {}
);

crons.interval(
  // Vault: previous secret values past their 7 days of restore (secrets.ts).
  "purge expired secret versions",
  { hours: 6 },
  internal.secrets.purgeExpiredVersions,
  {}
);

crons.interval(
  // Passkey challenges and presence grants past their 2 minutes (passkeys.ts).
  "purge expired passkey challenges",
  { hours: 1 },
  internal.passkeys.purgeExpiredChallenges,
  {}
);

crons.interval(
  // The hosted assistant's wallet: give back holds that ended turns leaked,
  // including holds whose turn row was deleted, which the lease cannot see.
  "reconcile wallet holds",
  { hours: 1 },
  internal.wallet.reconcile,
  {}
);

// A role hired while its drawing failed (no model credit) gets drawn later.
crons.interval("redraw recent roles without an icon", { hours: 6 }, internal.roleIcons.redrawMissing, {});

export default crons;
