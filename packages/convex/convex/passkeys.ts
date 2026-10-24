// Passkeys and presence grants (docs/architecture/vault.md "Ask first").
//
// An agent driving the person's own signed-in browser presses buttons the
// server cannot tell from the person's. The actions that would open a guarded
// secret to it (revealing an Ask first secret, approving an Ask first read,
// switching Ask first off) and the passkeys themselves (adding a second,
// removing one) need a passkey assertion, which takes Touch ID, Face ID or a
// security key and which no script produces.
//
// presenceBegin files a single-use challenge for one action on one target;
// presenceFinish verifies an assertion of one of that user's passkeys and
// turns it into a grant that the gate (lib/presence.ts) uses up. Finishing
// needs no codecast session, only the challenge id and the assertion, so the
// desktop app and the phone hand the ceremony to the web origin's /confirm
// page and watch the challenge (`challenge`) until it is granted.
//
// Enrollment runs the same way. The first passkey needs no grant, since there
// is nothing to assert with yet; the person is emailed and it shows in their
// list. Every later one needs an add_passkey grant.
//
// Verification runs in actions (WebAuthn crypto is async web crypto); the
// mutation after it re-reads the challenge, so a challenge is used once
// however many finishes race.

import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { isoBase64URL } from "@simplewebauthn/server/helpers";
import { action, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { consumePresence, presenceRefusal } from "./lib/presence";
import { heldKeysFor } from "./lib/accessKeys";
import { siteUrl, webOrigins } from "./lib/siteUrl";
import {
  PRESENCE_ACTIONS,
  PRESENCE_TTL_MS,
  type PasskeyMeta,
  type PresenceAction,
  type PresenceChallengeState,
} from "@codecast/shared/contracts/secrets";

const actionValidator = v.union(...PRESENCE_ACTIONS.map((a) => v.literal(a)));

// ES256 and RS256: every platform authenticator and security key signs with one of them.
const ALGORITHMS = [-7, -257];
const MAX_NAME = 60;
const MAX_PASSKEYS = 20;

// ── Relying party ────────────────────────────────────────────────────────────

/** The relying party an origin's passkeys belong to: the web host, which its subdomains (local.codecast.sh) share. */
export function rpIdFor(origin: string): string {
  const host = new URL(origin).hostname;
  const site = new URL(siteUrl()).hostname;
  return host === site || host.endsWith(`.${site}`) ? site : host;
}

/** The origin a ceremony runs on: the caller's own when it is one of the web's, else the web's (a desktop or phone handing off). */
function ceremonyOrigin(origin?: string): string {
  return origin && webOrigins().has(origin) ? origin : siteUrl();
}

/** Every web origin whose passkeys answer to this relying party. */
const originsFor = (rpId: string) => [...webOrigins()].filter((o) => rpIdFor(o) === rpId);

// ── Reads ────────────────────────────────────────────────────────────────────

async function passkeysOf(ctx: any, userId: Id<"users">): Promise<Doc<"passkeys">[]> {
  return await ctx.db.query("passkeys").withIndex("by_user", (q: any) => q.eq("user_id", userId)).collect();
}

/** The signed-in person's passkeys, newest first. Never the public key. */
export const list = query({
  args: {},
  handler: async (ctx): Promise<PasskeyMeta[]> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const rows = await passkeysOf(ctx, userId);
    return rows
      .sort((a, b) => b.created_at - a.created_at)
      .map((r) => ({ _id: String(r._id), name: r.name, created_at: r.created_at, last_used_at: r.last_used_at }));
  },
});

/** The WebAuthn options a pending challenge's ceremony runs with, rebuilt from the row so the /confirm page can fetch them by id. */
async function optionsFor(ctx: any, row: Doc<"passkey_challenges">) {
  const passkeys = (await passkeysOf(ctx, row.user_id)).filter((p) => p.rp_id === row.rp_id);
  const credentials = passkeys.map((p) => ({ id: p.credential_id, transports: p.transports }));
  const challenge = isoBase64URL.toBuffer(row.challenge);
  const timeout = PRESENCE_TTL_MS;
  if (row.purpose === "presence") {
    return await generateAuthenticationOptions({ rpID: row.rp_id, allowCredentials: credentials, challenge, timeout, userVerification: "required" });
  }
  const user = await ctx.db.get(row.user_id);
  return await generateRegistrationOptions({
    rpName: "Codecast",
    rpID: row.rp_id,
    userName: user?.email ?? user?.name ?? String(row.user_id),
    userDisplayName: user?.name ?? user?.email ?? "",
    userID: new TextEncoder().encode(String(row.user_id)),
    challenge,
    timeout,
    attestationType: "none",
    excludeCredentials: credentials,
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    supportedAlgorithmIDs: ALGORITHMS,
  });
}

function stateOf(row: Doc<"passkey_challenges">, now: number): PresenceChallengeState["status"] {
  if (row.status === "used") return "used";
  return row.expires_at <= now ? "expired" : row.status;
}

/**
 * One challenge by id, for the client waiting on it and for the /confirm
 * page, which may have no codecast session: the id is the capability. While
 * pending it carries the ceremony's options; it never carries a key.
 */
export const challenge = query({
  args: { challenge_id: v.string() },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("passkey_challenges", args.challenge_id);
    const row = id ? await ctx.db.get(id) : null;
    if (!row) return null;
    const status = stateOf(row, Date.now());
    return {
      purpose: row.purpose,
      status,
      action: row.action,
      label: row.label,
      expires_at: row.expires_at,
      ...(status === "pending" ? { options: await optionsFor(ctx, row) } : {}),
    };
  },
});

// ── Challenges ───────────────────────────────────────────────────────────────

/** What a presence challenge confirms, in a few words, and that the target is the asker's to act on; or why it is not. */
async function presenceSubject(ctx: any, userId: Id<"users">, action: PresenceAction, target: string): Promise<{ label?: string } | { error: string }> {
  const missing = { error: "Nothing to confirm: it was removed, or it is not yours" };
  if (action === "add_passkey") return target === String(userId) ? {} : missing;
  if (action === "reveal" || action === "ask_first_off") {
    const id = ctx.db.normalizeId("secrets", target);
    const row = id ? await ctx.db.get(id) : null;
    return row && (await heldKeysFor(ctx, userId)).has(row.workspace) ? { label: row.name } : missing;
  }
  if (action === "approve") {
    const id = ctx.db.normalizeId("session_decisions", target);
    const row = id ? await ctx.db.get(id) : null;
    return row && String(row.user_id) === String(userId) ? { label: row.question } : missing;
  }
  const id = ctx.db.normalizeId("passkeys", target);
  const row = id ? await ctx.db.get(id) : null;
  return row && String(row.user_id) === String(userId) ? { label: row.name } : missing;
}

export const openChallenge = internalMutation({
  args: {
    user_id: v.id("users"),
    purpose: v.union(v.literal("register"), v.literal("presence")),
    action: v.optional(actionValidator),
    target: v.optional(v.string()),
    challenge: v.string(),
    rp_id: v.string(),
  },
  handler: async (ctx, args) => {
    const passkeys = await passkeysOf(ctx, args.user_id);
    let label: string | undefined;
    if (args.purpose === "register") {
      if (passkeys.length >= MAX_PASSKEYS) return { error: `You have ${MAX_PASSKEYS} passkeys: remove one in Settings first` };
      // A second passkey is one more way to confirm as this person, so adding it takes the first.
      if (passkeys.length) {
        const refusal = await presenceRefusal(ctx, args.user_id, "add_passkey", String(args.user_id));
        if (refusal) return { error: refusal };
      }
    } else {
      if (!passkeys.some((p) => p.rp_id === args.rp_id)) return { error: "Set up Touch ID first: you have no passkey here yet", needs_passkey: true };
      const subject = await presenceSubject(ctx, args.user_id, args.action!, args.target!);
      if ("error" in subject) return subject;
      label = subject.label;
    }
    const now = Date.now();
    const id = await ctx.db.insert("passkey_challenges", {
      user_id: args.user_id,
      purpose: args.purpose,
      action: args.action,
      target: args.target,
      label,
      challenge: args.challenge,
      rp_id: args.rp_id,
      status: "pending",
      created_at: now,
      expires_at: now + PRESENCE_TTL_MS,
    });
    const row = (await ctx.db.get(id))!;
    return { challenge_id: String(id), options: await optionsFor(ctx, row), expires_at: row.expires_at };
  },
});

const freshChallenge = () => isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Start enrolling a passkey for the signed-in person. `origin` is the page
 * running the ceremony (the web passes its own; a desktop or phone handing
 * off omits it and the web's /confirm page runs it). A second passkey needs
 * an add_passkey grant first.
 */
export const registrationBegin = action({
  args: { origin: v.optional(v.string()) },
  handler: async (ctx, args): Promise<any> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Sign in to codecast to set up Touch ID" };
    return await ctx.runMutation(internal.passkeys.openChallenge, {
      user_id: userId,
      purpose: "register",
      challenge: freshChallenge(),
      rp_id: rpIdFor(ceremonyOrigin(args.origin)),
    });
  },
});

/**
 * Ask for the signed-in person's presence for one action on one target (the
 * secret, the decision or the passkey; add_passkey needs none, it is the
 * person themselves). Answers the challenge id and the options navigator.credentials.get
 * takes, or `needs_passkey` when there is no passkey to assert with yet.
 */
export const presenceBegin = action({
  args: { action: actionValidator, target: v.optional(v.string()), origin: v.optional(v.string()) },
  handler: async (ctx, args): Promise<any> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { error: "Sign in to codecast to confirm with Touch ID" };
    const target = args.action === "add_passkey" ? String(userId) : args.target;
    if (!target) return { error: "Name what to confirm: the secret, the decision or the passkey" };
    return await ctx.runMutation(internal.passkeys.openChallenge, {
      user_id: userId,
      purpose: "presence",
      action: args.action,
      target,
      challenge: freshChallenge(),
      rp_id: rpIdFor(ceremonyOrigin(args.origin)),
    });
  },
});

export const ceremony = internalQuery({
  args: { challenge_id: v.string(), credential_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("passkey_challenges", args.challenge_id);
    const row = id ? await ctx.db.get(id) : null;
    if (!row) return null;
    // Only a passkey of the person who asked answers their challenge.
    const passkey = args.credential_id
      ? await ctx.db.query("passkeys").withIndex("by_credential", (q) => q.eq("credential_id", args.credential_id!)).first()
      : null;
    return { row, passkey: passkey && String(passkey.user_id) === String(row.user_id) ? passkey : null };
  },
});

/** Why this challenge cannot take a ceremony now, or null. */
function closedReason(row: Doc<"passkey_challenges"> | undefined | null, purpose: Doc<"passkey_challenges">["purpose"], now: number): string | null {
  if (!row || row.purpose !== purpose) return "This confirmation is not open: start again";
  if (row.status !== "pending") return "This confirmation was already used: start again";
  if (row.expires_at <= now) return "This confirmation expired: start again";
  return null;
}

// ── Enrollment ───────────────────────────────────────────────────────────────

export const storePasskey = internalMutation({
  args: {
    challenge_id: v.id("passkey_challenges"),
    credential_id: v.string(),
    public_key: v.string(),
    counter: v.number(),
    transports: v.optional(v.array(v.string())),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = await ctx.db.get(args.challenge_id);
    const closed = closedReason(row, "register", now);
    if (closed) return { error: closed };
    await ctx.db.patch(row!._id, { status: "used" });
    const userId = row!.user_id;
    if (await ctx.db.query("passkeys").withIndex("by_credential", (q) => q.eq("credential_id", args.credential_id)).first()) {
      return { error: "This passkey is already set up" };
    }
    const existing = await passkeysOf(ctx, userId);
    if (existing.length) {
      const refusal = await consumePresence(ctx, userId, "add_passkey", String(userId));
      if (refusal) return { error: refusal };
    }
    const id = await ctx.db.insert("passkeys", {
      user_id: userId,
      credential_id: args.credential_id,
      public_key: args.public_key,
      counter: args.counter,
      transports: args.transports,
      rp_id: row!.rp_id,
      name: args.name,
      created_at: now,
    });
    // The first one went in with no grant, so the person hears of it wherever they read mail.
    const user = await ctx.db.get(userId);
    if (!existing.length && user?.email) {
      await ctx.scheduler.runAfter(0, internal.emails.send.sendPasskeyAdded, {
        email: user.email,
        passkey_name: args.name,
        added_at: now,
        settings_url: `${siteUrl()}/settings`,
      });
    }
    return { id: String(id), name: args.name, first: !existing.length };
  },
});

/**
 * Finish enrolling: verify the authenticator's registration response against
 * the challenge and store the credential. The challenge id authorises it, so
 * the /confirm page finishes a desktop's or phone's enrollment without a
 * codecast session; a signed-in caller must be the person who began it.
 */
export const registrationFinish = action({
  args: { challenge_id: v.string(), response: v.any(), name: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{ id: string; name: string; first: boolean } | { error: string }> => {
    const got = await ctx.runQuery(internal.passkeys.ceremony, { challenge_id: args.challenge_id });
    const closed = closedReason(got?.row, "register", Date.now());
    if (closed) return { error: closed };
    const row = got!.row;
    const caller = await getAuthUserId(ctx);
    if (caller && String(caller) !== String(row.user_id)) return { error: "This confirmation belongs to another account" };
    let verified;
    try {
      verified = await verifyRegistrationResponse({
        response: args.response,
        expectedChallenge: row.challenge,
        expectedOrigin: originsFor(row.rp_id),
        expectedRPID: row.rp_id,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALGORITHMS,
      });
    } catch (e) {
      return { error: `The passkey could not be verified: ${(e as Error).message}` };
    }
    if (!verified.verified) return { error: "The passkey could not be verified" };
    const { credential } = verified.registrationInfo;
    return await ctx.runMutation(internal.passkeys.storePasskey, {
      challenge_id: row._id,
      credential_id: credential.id,
      public_key: isoBase64URL.fromBuffer(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
      name: args.name?.trim().slice(0, MAX_NAME) || "Passkey",
    });
  },
});

// ── Presence ─────────────────────────────────────────────────────────────────

export const grantPresence = internalMutation({
  args: { challenge_id: v.id("passkey_challenges"), passkey_id: v.id("passkeys"), counter: v.number() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const row = await ctx.db.get(args.challenge_id);
    const closed = closedReason(row, "presence", now);
    if (closed) return { error: closed };
    const passkey = await ctx.db.get(args.passkey_id);
    if (!passkey || String(passkey.user_id) !== String(row!.user_id)) return { error: "This passkey is not set up for the account that asked" };
    // A signature count that fails to rise means the key was copied: an authenticator that counts never repeats one.
    if ((args.counter > 0 || passkey.counter > 0) && args.counter <= passkey.counter) {
      return { error: "This passkey's signature count went backwards, so it may have been copied: remove it in Settings and set up a new one" };
    }
    await ctx.db.patch(passkey._id, { counter: args.counter, last_used_at: now });
    const expires_at = now + PRESENCE_TTL_MS;
    await ctx.db.patch(row!._id, { status: "granted", expires_at });
    return { granted: true as const, action: row!.action!, expires_at };
  },
});

/**
 * Finish a presence challenge with an assertion. Needs no codecast session:
 * the challenge names its person, and only one of their passkeys verifies.
 * Granted, the gate for that one action on that one target passes once in
 * the next PRESENCE_TTL_MS.
 */
export const presenceFinish = action({
  args: { challenge_id: v.string(), response: v.any() },
  handler: async (ctx, args): Promise<{ granted: true; action: PresenceAction; expires_at: number } | { error: string }> => {
    const credentialId = typeof args.response?.id === "string" ? args.response.id : undefined;
    const got = await ctx.runQuery(internal.passkeys.ceremony, { challenge_id: args.challenge_id, credential_id: credentialId });
    const closed = closedReason(got?.row, "presence", Date.now());
    if (closed) return { error: closed };
    const { row, passkey } = got!;
    if (!passkey || passkey.rp_id !== row.rp_id) return { error: "This passkey is not set up for the account that asked" };
    let verified;
    try {
      verified = await verifyAuthenticationResponse({
        response: args.response,
        expectedChallenge: row.challenge,
        expectedOrigin: originsFor(row.rp_id),
        expectedRPID: row.rp_id,
        credential: { id: passkey.credential_id, publicKey: isoBase64URL.toBuffer(passkey.public_key), counter: passkey.counter, transports: passkey.transports as any },
        requireUserVerification: true,
      });
    } catch (e) {
      return { error: `The passkey could not be verified: ${(e as Error).message}` };
    }
    if (!verified.verified) return { error: "The passkey could not be verified" };
    return await ctx.runMutation(internal.passkeys.grantPresence, {
      challenge_id: row._id,
      passkey_id: passkey._id,
      counter: verified.authenticationInfo.newCounter,
    });
  },
});

// ── Managing ─────────────────────────────────────────────────────────────────

async function ownPasskey(ctx: any, ref: string): Promise<{ userId: Id<"users">; row: Doc<"passkeys"> } | { error: string }> {
  const userId = await getAuthUserId(ctx);
  if (!userId) return { error: "Sign in to codecast to manage passkeys" };
  const id = ctx.db.normalizeId("passkeys", ref);
  const row = id ? await ctx.db.get(id) : null;
  if (!row || String(row.user_id) !== String(userId)) return { error: "No such passkey" };
  return { userId, row };
}

export const rename = mutation({
  args: { id: v.string(), name: v.string() },
  handler: async (ctx, args) => {
    const got = await ownPasskey(ctx, args.id);
    if ("error" in got) return got;
    const name = args.name.trim().slice(0, MAX_NAME);
    if (!name) return { error: "Give the passkey a name" };
    await ctx.db.patch(got.row._id, { name });
    return { id: args.id, name };
  },
});

/** Remove one of the person's passkeys; takes a remove_passkey grant for it, asserted with any of their passkeys (itself included). */
export const remove = mutation({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const got = await ownPasskey(ctx, args.id);
    if ("error" in got) return got;
    const refusal = await consumePresence(ctx, got.userId, "remove_passkey", String(got.row._id));
    if (refusal) return { error: refusal };
    await ctx.db.delete(got.row._id);
    return { removed: true, id: args.id };
  },
});

/** Challenges and grants past their expiry, a batch at a time (crons.ts). */
export const purgeExpiredChallenges = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("passkey_challenges").withIndex("by_expires", (q) => q.lt("expires_at", Date.now())).take(500);
    for (const r of rows) await ctx.db.delete(r._id);
    return { deleted: rows.length };
  },
});
