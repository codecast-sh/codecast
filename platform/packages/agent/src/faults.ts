// Which model call failures are the provider's, read from the error text a
// run stops with. Pure, so an app can classify a stored error later (a turn
// row's `error`) as well as a live one.

/**
 * Why a provider could not serve a call, or null when the failure is not the
 * provider's (a bad request, a cancelled run, a tool's error).
 *
 * - `billing`: the account behind the key has no credit or quota left.
 * - `auth`: the key is missing, wrong or not allowed this model.
 * - `unavailable`: the provider is overloaded, rate limiting the account, or
 *   unreachable, after the SDK's own retries.
 *
 * The first two never clear by retrying the same call soon, so a caller moves
 * to another provider at once rather than retrying. All three are worth
 * moving to another provider for, and none is the person's doing.
 */
export type ProviderFault = "billing" | "auth" | "unavailable";

const BILLING = /credit balance is too low|insufficient[_ ]quota|exceeded your current quota|billing|payment required|\b402\b/i;
const AUTH = /authentication_error|permission_error|invalid x-api-key|invalid api key|incorrect api key|no api key for provider|\b401\b|\b403\b/i;
const UNAVAILABLE = /overloaded|rate[_ ]limit|\b429\b|\b5(?:00|02|03|04|29)\b|connection error|fetch failed|econnreset|econnrefused|etimedout|socket hang up|timed out/i;

export function providerFault(error: string | null | undefined): ProviderFault | null {
  if (!error) return null;
  if (BILLING.test(error)) return "billing";
  if (AUTH.test(error)) return "auth";
  if (UNAVAILABLE.test(error)) return "unavailable";
  return null;
}
