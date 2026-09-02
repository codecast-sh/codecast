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
// The relay itself lives in @platform/auth/convex; the builders come from
// ./functions so the change-feed wrapper still applies to the mutations.
import { mutation, internalMutation, query } from "./functions";
import { makeCliAuthFunctions } from "@platform/auth/convex";
import type { RegisteredMutation, RegisteredQuery } from "convex/server";

export {
  CLI_AUTH_TTL_MS,
  claimCliAuthRequest,
  claimDesktopAuthExchange,
  sweepExpiredCliAuthRequests,
} from "@platform/auth/convex";

// The wire contract, stated once — see the same note in apiTokens.ts. Without
// it these land as `any` and `api.cliAuth.*` stops existing.
type CliAuthFunctions = {
  deposit: RegisteredMutation<
    "public",
    { nonce: string; token: string; device_name: string },
    Promise<void>
  >;
  claim: RegisteredMutation<
    "internal",
    { nonce: string },
    Promise<{ user_id: string; auth_token: string } | null>
  >;
  pendingDeposit: RegisteredQuery<"public", { nonce: string }, Promise<boolean>>;
  claimForDesktop: RegisteredMutation<
    "internal",
    { nonce: string },
    Promise<{ userId: string } | null>
  >;
  sweepExpired: RegisteredMutation<"internal", Record<string, never>, Promise<number>>;
};

export const {
  deposit,
  claim,
  pendingDeposit,
  claimForDesktop,
  sweepExpired,
}: CliAuthFunctions = makeCliAuthFunctions({ mutation, internalMutation, query });
