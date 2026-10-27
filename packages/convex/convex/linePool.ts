// The line pool's operator tools (the-line-end-to-end.md LE6), run with packages/convex/run.sh: a device's line
// checkouts set by hand, and a hold that keeps a device's checkouts in the pool with no room.
import { internalMutation } from "./functions";
import { v } from "convex/values";
import { normalizeGitOrigin } from "@codecast/shared/contracts";
import { lineSlotsValidator } from "./lib/lineSlotsValidator";

async function deviceRow(ctx: any, device_id: string) {
  const rows = await ctx.db.query("devices").filter((q: any) => q.eq(q.field("device_id"), device_id)).collect();
  if (rows.length !== 1) throw new Error(`${rows.length} devices have device_id ${device_id}`);
  return rows[0];
}

/** Holds a device out of the line: its checkouts stay in the pool with no room, so no run starts or resumes there,
 *  whatever its heartbeat reports, until the hold is released (call again without `why`). For a machine that cannot
 *  finish a run and cannot be reached to change its own config: Cam's union-shared box had no Codex for the Review
 *  hand, so every run that reached Review there failed (2026-10-27, ct-74380). */
export const holdLine = internalMutation({
  args: { device_id: v.string(), why: v.optional(v.string()) },
  handler: async (ctx, { device_id, why }) => {
    const device = await deviceRow(ctx, device_id);
    const line_hold = why?.trim() ? { why: why.trim(), at: Date.now() } : undefined;
    await ctx.db.patch(device._id, { line_hold });
    return { device: device_id, hostname: device.hostname ?? null, line_hold: line_hold ?? null };
  },
});

/** Sets a device's line checkouts (lib/lineSlotsValidator) by hand, for a host whose daemon does not report them yet;
 *  the next heartbeat that carries line_slots replaces them. Origins are normalized the way the daemon's are. */
export const setLineSlots = internalMutation({
  args: { device_id: v.string(), line_slots: lineSlotsValidator },
  handler: async (ctx, { device_id, line_slots }) => {
    const device = await deviceRow(ctx, device_id);
    const slots = line_slots.map((s) => ({ ...s, ...(s.origin ? { origin: normalizeGitOrigin(s.origin) ?? s.origin } : {}) }));
    await ctx.db.patch(device._id, { line_slots: slots });
    return { device: device_id, user_id: device.user_id, line_slots: slots };
  },
});
