import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

crons.interval("prune stale presence", { minutes: 1 }, internal.presence.prune, {});
crons.interval("prune lapsed rate counters", { hours: 1 }, internal.limits.prune, {});
crons.interval("prune old daily totals", { hours: 1 }, internal.tallies.prune, {});

export default crons;
