import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "process github comment webhooks",
  { minutes: 1 },
  internal.githubWebhooks.processCommentWebhooks,
  { limit: 50 }
);

crons.interval(
  "reclaim stale agent tasks",
  { minutes: 5 },
  internal.agentTasks.reclaimStaleTasks
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
  "backfill docs and tasks from sessions",
  { hours: 6 },
  internal.taskMining.backfillAllTeams
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

export default crons;
