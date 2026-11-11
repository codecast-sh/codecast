import { v } from "convex/values";
import { normalizePeerTailnet, samePeerTailnet } from "@codecast/shared/contracts/peerTransport";

export const tailnetValidator = v.object({
  ip: v.string(),
  name: v.string(),
  tailnet: v.optional(v.string()),
  ts_user_id: v.optional(v.string()),
  bindable: v.optional(v.boolean()),
});
type StoredTailnet = typeof tailnetValidator.type;

function storedTailnet(raw: unknown): StoredTailnet | undefined {
  const t = normalizePeerTailnet(raw);
  if (!t) return undefined;
  return {
    ip: t.ip,
    name: t.name,
    ...(t.tailnet ? { tailnet: t.tailnet } : {}),
    ...(t.ts_user_id ? { ts_user_id: t.ts_user_id } : {}),
    ...(t.bindable !== undefined ? { bindable: t.bindable } : {}),
  };
}

/** A raw beat body's tailnet, shaped to the validator so a malformed report never fails the beat. */
export function heartbeatTailnetArg(raw: unknown): StoredTailnet | null | undefined {
  return raw === null ? null : storedTailnet(raw);
}

/**
 * The devices.tailnet write for a beat's report: absent or malformed changes
 * nothing, null clears, and a value equal to the stored one writes nothing,
 * so it never defeats the device write throttle (deviceBeatChanged).
 */
export function heartbeatTailnetPatch(existing: StoredTailnet | undefined, reported: StoredTailnet | null | undefined): { tailnet?: StoredTailnet | undefined } {
  if (reported === undefined) return {};
  const next = reported === null ? undefined : storedTailnet(reported);
  if (reported !== null && !next) return {};
  return samePeerTailnet(normalizePeerTailnet(existing), normalizePeerTailnet(next)) ? {} : { tailnet: next };
}
