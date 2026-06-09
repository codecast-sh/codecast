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

export default crons;
