// Server-mediated half of `cast auth`, for CLIs the browser can't reach.
//
// The primary auth path has the browser POST the freshly minted token to the
// CLI's localhost listener. That assumes browser and CLI share a machine —
// false for SSH'd boxes (e.g. a headless mac mini), where the loopback POST
// lands on the user's laptop and fails. When that happens the web page
// deposits the token here instead, keyed by a hash of the CLI's one-time
// nonce, and the CLI (which polls /cli/claim-auth alongside its localhost
// wait) claims it. Rows are single-use and short-lived: deleted on claim,
// or swept — with their orphaned api_token revoked — after CLI_AUTH_TTL_MS.
//
// Registered requests. The nonce rides in the sign-in URL, so on its own it
// proves nothing: anyone can open /auth/cli with a nonce of their choosing and
// send the link to a signed-in user. A current CLI therefore registers its
// request first (POST /cli/auth-request) with the hash of a verifier that
// never leaves the CLI. For a registered nonce:
//   - the Authorize page shows the device, network and start time the server
//     recorded at registration (requestInfo), never URL text;
//   - a deposit is accepted once, and only within CLI_AUTH_REQUEST_TTL_MS;
//   - the relay hands the token only to a claim carrying the verifier, so a
//     leaked URL (history, referrer, replay) cannot collect it;
//   - the desktop exchange refuses it, since that path carries no verifier.
// Unregistered nonces are the legacy path: CLIs released before registration
// and the desktop app's sign-in (@platform/auth/web useProviderSignIn) still
// use it. It keeps working and logs "[cliAuth] legacy" on every use; see the
// report on F51 for what retiring it takes.
//
// The relay itself lives in @platform/auth/convex; the builders come from
// ./functions so the change-feed wrapper still applies to the mutations.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, internalMutation, query } from "./functions";
import {
  claimCliAuthRequest,
  claimDesktopAuthExchange,
  createCliAuthDefinitions,
  sweepExpiredCliAuthRequests,
} from "@platform/auth/convex";
import { hashToken } from "./apiTokens";

export {
  CLI_AUTH_TTL_MS,
  claimCliAuthRequest,
  claimDesktopAuthExchange,
  sweepExpiredCliAuthRequests,
} from "@platform/auth/convex";

/** How long a registered request can be authorized. The CLI waits 5 minutes. */
export const CLI_AUTH_REQUEST_TTL_MS = 6 * 60 * 1000;

const HEX = /^[0-9a-f]+$/;

type Db = { db: any };

async function findRegistration(ctx: Db, nonce: string) {
  const nonceHash = await hashToken(nonce);
  return await ctx.db
    .query("cli_auth_registrations")
    .withIndex("by_nonce_hash", (q: any) => q.eq("nonce_hash", nonceHash))
    .first();
}

export type CliAuthRegistration = {
  nonce: string;
  verifier_hash: string;
  device_name: string;
  device_id?: string;
  ip: string;
  country?: string;
  user_agent?: string;
};

/** Exported for tests. Records a CLI's sign-in request; false when the input is malformed or the nonce is taken. */
export async function registerCliAuthRequest(
  ctx: Db,
  req: CliAuthRegistration,
  now: number = Date.now(),
): Promise<boolean> {
  if (req.nonce.length < 32 || req.nonce.length > 128 || !HEX.test(req.nonce)) return false;
  if (req.verifier_hash.length !== 64 || !HEX.test(req.verifier_hash)) return false;
  // One registration per nonce: a second one could swap the verifier.
  if (await findRegistration(ctx, req.nonce)) return false;
  await ctx.db.insert("cli_auth_registrations", {
    nonce_hash: await hashToken(req.nonce),
    verifier_hash: req.verifier_hash,
    device_name: req.device_name.slice(0, 100) || "CLI Device",
    ...(req.device_id ? { device_id: req.device_id.slice(0, 200) } : {}),
    ip: req.ip.slice(0, 64),
    ...(req.country ? { country: req.country.slice(0, 8) } : {}),
    ...(req.user_agent ? { user_agent: req.user_agent.slice(0, 200) } : {}),
    created_at: now,
  });
  return true;
}

const relay = createCliAuthDefinitions();
const depositArgs = { nonce: v.string(), token: v.string(), device_name: v.string() };
type DepositArgs = { nonce: string; token: string; device_name: string };

/**
 * Exported for tests. Gate in front of the package deposit: a registered nonce
 * takes one fresh deposit, labelled with the registered device name. An
 * unregistered nonce is the legacy path and is logged.
 */
export async function gatedDeposit(
  ctx: Db,
  args: DepositArgs,
  deposit: (ctx: any, args: DepositArgs) => Promise<void>,
  now: number = Date.now(),
): Promise<void> {
  const reg = await findRegistration(ctx, args.nonce);
  if (!reg) {
    console.warn("[cliAuth] legacy deposit for an unregistered nonce", { device_name: args.device_name });
    return await deposit(ctx, args);
  }
  if (now - reg.created_at > CLI_AUTH_REQUEST_TTL_MS) throw new Error("This sign-in request expired");
  if (reg.authorized_at) throw new Error("This sign-in request was already used");
  await deposit(ctx, { ...args, device_name: reg.device_name });
  await ctx.db.patch(reg._id, { authorized_at: now });
}

/**
 * Exported for tests. A registered request is claimable only with its
 * verifier; a wrong or missing one reads as "not yet" and consumes nothing.
 */
export async function claimWithVerifier(
  ctx: Db,
  nonce: string,
  verifier: string | undefined,
  now: number = Date.now(),
): Promise<{ user_id: string; auth_token: string } | null> {
  const reg = await findRegistration(ctx, nonce);
  if (!reg) {
    const legacy = await claimCliAuthRequest(ctx, nonce, now);
    if (legacy) console.warn("[cliAuth] legacy claim for an unregistered nonce");
    return legacy;
  }
  if (!verifier || (await hashToken(verifier)) !== reg.verifier_hash) return null;
  const claimed = await claimCliAuthRequest(ctx, nonce, now);
  if (claimed) await ctx.db.delete(reg._id);
  return claimed;
}

/**
 * Exported for tests. The desktop exchange carries only the nonce, so it may
 * redeem legacy deposits alone; a registered CLI request needs its verifier.
 */
export async function desktopExchange(ctx: Db, nonce: string, now: number = Date.now()) {
  if (await findRegistration(ctx, nonce)) return null;
  const claimed = await claimDesktopAuthExchange(ctx, nonce, now);
  if (claimed) console.warn("[cliAuth] legacy desktop exchange");
  return claimed;
}

/** Exported for tests. Deletes registrations past any use. */
export async function sweepExpiredRegistrations(ctx: Db, now: number = Date.now()): Promise<number> {
  const expired = await ctx.db
    .query("cli_auth_registrations")
    .withIndex("by_created_at", (q: any) => q.lt("created_at", now - 2 * CLI_AUTH_REQUEST_TTL_MS))
    .take(100);
  for (const row of expired) await ctx.db.delete(row._id);
  return expired.length;
}

export const register = internalMutation({
  args: {
    nonce: v.string(),
    verifier_hash: v.string(),
    device_name: v.string(),
    device_id: v.optional(v.string()),
    ip: v.string(),
    country: v.optional(v.string()),
    user_agent: v.optional(v.string()),
  },
  handler: async (ctx, args) => registerCliAuthRequest(ctx, args),
});

export const deposit = mutation({
  args: depositArgs,
  handler: async (ctx, args): Promise<void> =>
    gatedDeposit(ctx, args, relay.mutations.deposit.handler),
});

export const claim = internalMutation({
  args: { nonce: v.string(), verifier: v.optional(v.string()) },
  handler: async (ctx, args) => claimWithVerifier(ctx, args.nonce, args.verifier),
});

export const claimForDesktop = internalMutation({
  args: { nonce: v.string() },
  handler: async (ctx, args) => desktopExchange(ctx, args.nonce),
});

// What the Authorize page shows about a request: the facts the server
// recorded when the CLI registered it. Null for a legacy (unregistered) nonce.
export const requestInfo = query({
  args: { nonce: v.string() },
  handler: async (ctx, args) => {
    if (!(await getAuthUserId(ctx))) return null;
    const reg = await findRegistration(ctx, args.nonce);
    if (!reg) return null;
    return {
      device_name: reg.device_name,
      ip: reg.ip,
      country: reg.country ?? null,
      created_at: reg.created_at,
      expires_at: reg.created_at + CLI_AUTH_REQUEST_TTL_MS,
      used: !!reg.authorized_at,
    };
  },
});

export const pendingDeposit = query(relay.queries.pendingDeposit);

export const sweepExpired = internalMutation({
  args: {},
  handler: async (ctx) =>
    (await sweepExpiredCliAuthRequests(ctx)) + (await sweepExpiredRegistrations(ctx)),
});
