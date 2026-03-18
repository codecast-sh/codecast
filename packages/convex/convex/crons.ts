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
  { seconds: 30 },
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

export default crons;
