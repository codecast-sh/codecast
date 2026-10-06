import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("prune stale presence", { minutes: 1 }, internal.presence.prune, {});

export default crons;
