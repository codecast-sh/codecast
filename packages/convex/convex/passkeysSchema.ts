import { defineTable } from "convex/server";
import { v } from "convex/values";
import { PRESENCE_ACTIONS } from "@codecast/shared/contracts/secrets";

/**
 * Passkeys and the presence grants they earn (passkeys.ts, vault.md "Ask
 * first"). Both are a person's own rows, with no workspace: a passkey belongs
 * to a person, not to a team.
 */
export const passkeyTables = {
  // One WebAuthn credential per row. public_key is the COSE key, base64url;
  // counter is the authenticator's signature count, which only ever rises.
  passkeys: defineTable({
    user_id: v.id("users"),
    credential_id: v.string(),
    public_key: v.string(),
    counter: v.number(),
    transports: v.optional(v.array(v.string())),
    // The relying party it was made for (codecast.sh, localhost): an assertion is checked against it.
    rp_id: v.string(),
    name: v.string(),
    created_at: v.number(),
    last_used_at: v.optional(v.number()),
    // Set up with no grant (an account's first): it confirms nothing until
    // then, and can be removed with one press (passkeys.ts removableUnasked).
    probation_until: v.optional(v.number()),
  })
    .index("by_user", ["user_id"])
    .index("by_credential", ["credential_id"]),

  // A WebAuthn challenge, single use. `register` is a passkey enrollment
  // ceremony; `presence` asks for an assertion that, verified, turns the row
  // `granted` for one action on one target until expires_at, and the gate
  // that consumes it turns it `used`. expires_at is the ceremony's deadline
  // while pending and the grant's once granted; a cron purges past rows.
  // grant_hash is the SHA-256 of the secret presenceBegin handed its caller,
  // which the gate needs to spend the grant (lib/presence.ts). A register row
  // a second passkey began names the add_passkey grant it spent in
  // authorized_by; a first one has none and lands in probation.
  passkey_challenges: defineTable({
    user_id: v.id("users"),
    purpose: v.union(v.literal("register"), v.literal("presence")),
    action: v.optional(v.union(...PRESENCE_ACTIONS.map((a) => v.literal(a)))),
    target: v.optional(v.string()),
    label: v.optional(v.string()),
    challenge: v.string(),
    rp_id: v.string(),
    status: v.union(v.literal("pending"), v.literal("granted"), v.literal("used")),
    grant_hash: v.optional(v.string()),
    authorized_by: v.optional(v.id("passkey_challenges")),
    created_at: v.number(),
    expires_at: v.number(),
  }).index("by_expires", ["expires_at"]),
};
