import type { Id } from "./_generated/dataModel";
import { ownDevice } from "./devices";
import { isTeamAdmin } from "./privacy";

// The name and icon a person sees for a machine, set in Settings > Devices.
// Web-set only: the daemon's heartbeat rewrites `label` and never these
// fields, so a rename stored on `label` would last until the next beat. The
// web paints the roster row through its setDeviceAppearance store action and
// this runs as that action's dispatch side effect.

const DISPLAY_NAME_MAX = 64;
const DEVICE_ICON = /^[a-z0-9-]{1,32}$/;
const DEVICE_ICON_COLOR = /^[a-z]{1,16}$/;

/** A name typed in Settings. Collapse whitespace, cap at the same 64 the CLI
 *  uses for device_label, and treat a blank as cleared. */
export function sanitizeDeviceDisplayName(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, DISPLAY_NAME_MAX);
  return cleaned || null;
}

/** An icon token, or null when the field is cleared. A non-empty value that
 *  is not a token is a typo, so it throws instead of being stored. The web
 *  offers the team-icon list; anything else falls back to the platform glyph
 *  at render time, which is why the server does not import that list. */
export function sanitizeDeviceIcon(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  if (!DEVICE_ICON.test(cleaned)) throw new Error("Pick an icon from the list");
  return cleaned;
}

export function sanitizeDeviceIconColor(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned) return null;
  if (!DEVICE_ICON_COLOR.test(cleaned)) throw new Error("Pick a color from the list");
  return cleaned;
}

export type DeviceAppearanceChange = { display_name?: string; icon?: string; icon_color?: string };

/** Each field is optional; an omitted one is left alone, and an empty string
 *  clears it. Clearing the icon clears its color too. An agent box belongs to
 *  a bot account, and an admin of the bot's team names it, the same way they
 *  set its SSH host (ownerUserId). */
export async function performSetDeviceAppearance(
  ctx: { db: any },
  userId: Id<"users">,
  deviceId: string,
  change: DeviceAppearanceChange,
  ownerUserId?: Id<"users">,
) {
  const ownerId = ownerUserId ?? userId;
  if (ownerId.toString() !== userId.toString()) {
    const owner = await ctx.db.get(ownerId);
    if (!owner?.is_bot || !owner.team_id || !(await isTeamAdmin(ctx as any, userId, owner.team_id))) {
      throw new Error("Only an admin of the bot's team can name an agent box");
    }
  }
  const device = await ownDevice(ctx, ownerId, deviceId);
  if (!device) throw new Error("Unknown device");

  const patch: { display_name?: string; icon?: string; icon_color?: string } = {};
  if (change.display_name !== undefined) {
    patch.display_name = sanitizeDeviceDisplayName(change.display_name) ?? undefined;
  }
  let iconCleared = false;
  if (change.icon !== undefined) {
    const icon = sanitizeDeviceIcon(change.icon);
    patch.icon = icon ?? undefined;
    iconCleared = !icon;
    if (iconCleared) patch.icon_color = undefined;
  }
  if (change.icon_color !== undefined && !iconCleared) {
    const hasIcon = patch.icon ?? device.icon;
    if (hasIcon) patch.icon_color = sanitizeDeviceIconColor(change.icon_color) ?? undefined;
  }
  await ctx.db.patch(device._id, patch);
}
