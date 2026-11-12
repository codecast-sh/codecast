// The GitHub App install callback (GET /api/github-app/callback): prove the
// person who came back from GitHub controls the installation, spend the
// install intent, and store the installation, all through internal.githubApp
// functions. It lives apart from githubApp.ts so http.ts can mount it without
// importing githubApp, which reaches githubWebhooks and the big import cycle
// (ct-92432). A test drives this real handler (githubApp.install.test.ts).
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { parseGithubAppInstallState, type AppConnectionScope } from "@codecast/shared/contracts";
import { sha256Hex } from "./hash";

export const GITHUB_API_BASE = "https://api.github.com";

/** The scope an installation row binds to, as the resolvers compare it. */
export function installationScopeKey(row: { team_id?: Id<"teams">; scope_user_id?: Id<"users"> }): string {
  return row.team_id ? `team:${row.team_id}` : row.scope_user_id ? `user:${row.scope_user_id}` : "none";
}

/** How far GitHub's clock may run behind ours when we compare creation times. */
const INSTALL_CLOCK_SKEW_MS = 60_000;

/**
 * With no user token to ask GitHub with, the intent is the only proof (sd-234).
 * The installation_id is still the caller's to write, so the intent may claim
 * only an installation GitHub created after the intent was minted, or update
 * one already linked to the intent's own workspace.
 */
async function intentAloneMayClaim(
  ctx: any,
  intent: { user_id: Id<"users">; scope: AppConnectionScope; team_id?: Id<"teams">; created_at: number },
  installation: { installation_id: number; created_at?: number },
): Promise<boolean> {
  if (installation.created_at !== undefined && installation.created_at >= intent.created_at - INSTALL_CLOCK_SKEW_MS) {
    return true;
  }
  const linked: string | null = await ctx.runQuery(internal.githubApp.linkedInstallationScope, {
    installation_id: installation.installation_id,
  });
  const own = installationScopeKey(
    intent.scope === "team" ? { team_id: intent.team_id } : { scope_user_id: intent.user_id },
  );
  return linked === own;
}

/* ==========================================================================
 * The install callback
 * ========================================================================== */

const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * Does the person who came back from GitHub actually control this
 * installation? The App's own credentials can read ANY installation of the
 * App, so fetching one proves nothing about the caller. GitHub's answer is the
 * user-token flow: the install redirect carries a `code` (the App requests
 * user authorization during installation), which exchanges for a token that
 * speaks for that GitHub user, and `GET /user/installations` lists only the
 * installations that user may administer.
 *
 * With no client pair configured there is no way to ask the question; the
 * callback then falls back to `intentAloneMayClaim`.
 */
export async function verifyInstallerControlsInstallation(
  installationId: number,
  code: string | null,
): Promise<{ ok: true; login?: string } | { ok: false; error: string }> {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, error: "install_verification_unconfigured" };
  if (!code) return { ok: false, error: "install_not_authorized" };

  const tokenResponse = await fetch(GITHUB_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    signal: AbortSignal.timeout(15_000),
  });
  const token = tokenResponse.ok ? (await tokenResponse.json().catch(() => null))?.access_token : null;
  if (typeof token !== "string" || !token) return { ok: false, error: "install_not_authorized" };

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  for (let page = 1; page <= 5; page++) {
    const response = await fetch(`${GITHUB_API_BASE}/user/installations?per_page=100&page=${page}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { ok: false, error: "install_verification_failed" };
    const data = await response.json().catch(() => null);
    const installations = Array.isArray(data?.installations) ? data.installations : [];
    const match = installations.find((i: any) => Number(i?.id) === installationId);
    if (match) return { ok: true, login: typeof match.account?.login === "string" ? match.account.login : undefined };
    if (installations.length < 100) break;
  }
  return { ok: false, error: "installer_does_not_control_installation" };
}

/** Where the callback sends the browser, with whatever it has to report. */
function installRedirect(query: string): Response {
  const site = process.env.SITE_URL || "https://codecast.sh";
  return new Response(null, {
    status: 302,
    headers: { Location: `${site}/settings/integrations/github-app${query}` },
  });
}

export async function installCallbackHandler(ctx: any, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const installationId = url.searchParams.get("installation_id");
  const setupAction = url.searchParams.get("setup_action");

  if (!installationId) return new Response("Missing installation_id", { status: 400 });
  if (setupAction !== "install" && setupAction !== "update") return installRedirect("");

  const nonce = parseGithubAppInstallState(url.searchParams.get("state"));
  if (!nonce) return installRedirect("?error=missing_intent");

  try {
    // Ownership before the intent is spent: a GitHub hiccup should cost the
    // caller a retry of the same link, not a new one.
    const proof = await verifyInstallerControlsInstallation(parseInt(installationId), url.searchParams.get("code"));
    const intentOnly = !proof.ok && proof.error === "install_verification_unconfigured";
    if (!proof.ok && !intentOnly) {
      console.warn("[github-app install] refused", { reason: proof.error, installation_id: installationId });
      return installRedirect(`?error=${proof.error}`);
    }

    const intent = await ctx.runMutation(internal.githubApp.consumeInstallIntent, {
      nonce_hash: await sha256Hex(nonce),
    });
    if (!intent.ok) {
      console.warn("[github-app install] refused", { reason: intent.error, installation_id: installationId });
      return installRedirect(`?error=${intent.error}`);
    }

    const installationDetails = await ctx.runAction(internal.githubApp.fetchInstallationDetails, {
      installation_id: parseInt(installationId),
    });
    if (intentOnly && !(await intentAloneMayClaim(ctx, intent, installationDetails))) {
      console.warn("[github-app install] refused", { reason: "install_not_fresh", installation_id: installationId });
      return installRedirect("?error=install_not_fresh");
    }

    await ctx.runMutation(internal.githubApp.storeInstallation, {
      team_id: intent.scope === "team" ? intent.team_id : undefined,
      scope_user_id: intent.scope === "personal" ? intent.user_id : undefined,
      installation_id: installationDetails.installation_id,
      account_login: installationDetails.account_login,
      account_type: installationDetails.account_type,
      account_id: installationDetails.account_id,
      repository_selection: installationDetails.repository_selection,
      repositories: installationDetails.repositories,
      installed_by_user_id: intent.user_id,
    });

    // The audit line, identifiers redacted: enough to trace a grant back to
    // the intent that authorised it, never enough to be one.
    console.log("[github-app install] bound", {
      outcome: "ok",
      scope: intent.scope,
      actor: String(intent.user_id).slice(0, 6),
      workspace: String(intent.team_id ?? intent.user_id).slice(0, 6),
      installation_id: installationDetails.installation_id,
      account_login: installationDetails.account_login,
      verified_login: proof.ok ? proof.login : undefined,
      proof: intentOnly ? "intent_only" : "user_token",
    });

    // The pull requests that already exist on the account arrive now, not
    // one webhook at a time as people happen to touch them.
    await ctx.scheduler.runAfter(0, internal.githubApp.backfillInstallationPulls, {
      installation_id: installationDetails.installation_id,
    });

    return installRedirect("?success=true");
  } catch (error) {
    console.error("Failed to process GitHub App installation:", error);
    return installRedirect("?error=installation_failed");
  }
}
