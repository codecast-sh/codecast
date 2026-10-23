import { v } from "convex/values";

// The line checkouts a device offers (the-line-end-to-end.md LE6): each a
// repository root on that machine, the checkout's normalized origin
// (normalizeGitOrigin), and how many line runs may work there at once. The
// daemon declares them from `line.checkouts` in ~/.codecast/config.json and
// reports them on the heartbeat when they change; an empty list takes the
// device out of the pool.
export const lineSlotsValidator = v.array(v.object({
  root: v.string(),
  origin: v.optional(v.string()),
  runs: v.number(),
}));
