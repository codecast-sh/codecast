import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval(
  "process github comment webhooks",
  { minutes: 1 },
  internal.githubWebhooks.processCommentWebhooks,
  { limit: 50 }
);


export default crons;
