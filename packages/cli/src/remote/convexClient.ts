/**
 * A Convex client, its api_token and the generated api, from the local config.
 *
 * A leaf on purpose. `cast git-credential` runs on every fetch and every push
 * on a cloud host, and it reaches Convex through here: the fast path in
 * fastPath.ts loads this module and nothing else of remote/cli.ts, whose own
 * graph is the whole remote move flow. remote/cli.ts re-exports it, so every
 * other caller keeps the one import it already had.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { defaultConfigDir } from "../config/configDir.js";
import { bearerFromStored } from "../bearerToken.js";

export async function convexClient(opts: { timeoutMs?: number } = {}): Promise<{ client: any; token: string; api: any }> {
  const cfgPath = path.join(defaultConfigDir(), "config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  const token = cfg.auth_token ? bearerFromStored(cfg.auth_token) : cfg.auth_token;
  const { ConvexHttpClient } = await import("convex/browser");
  const apiMod: any = await import("../../../convex/convex/_generated/api.js" as any);
  const { timeoutMs } = opts;
  const client = new ConvexHttpClient(cfg.convex_url, timeoutMs
    ? { fetch: (url: any, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }) }
    : undefined);
  return { client, token, api: apiMod.api };
}

/**
 * A new token bound to `deviceId`, minted by a bound credential: this
 * machine's own unless `apiToken` (a presentation, `<secret>.<its device>`)
 * names another. Host provisioning mints the host's token this way, and a
 * machine whose device id moved mints its own with the token it carried over.
 * `timeoutMs` aborts a request the server never answers.
 */
export async function mintTokenForDevice(
  deviceId: string,
  label: string,
  opts: { apiToken?: string; timeoutMs?: number } = {},
): Promise<string> {
  const { client, token, api } = await convexClient({ timeoutMs: opts.timeoutMs });
  const apiToken = opts.apiToken;
  const minted = await client.mutation(api.apiTokens.mintForDevice, { api_token: apiToken ?? token, device_id: deviceId, label });
  return minted.token as string;
}
