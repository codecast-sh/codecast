// What the Codex Cloud tests share: the recorded wham payloads
// (__fixtures__/codexCloud, real answers scrubbed), a Codex login on a fixed
// clock, and a fetch over the wham API.
import * as fs from "fs";
import * as path from "path";
import { fakeCloudFetch, type FakeCloudCall } from "./cloudFetch.js";

const FIXTURES = path.join(import.meta.dir, "..", "__fixtures__", "codexCloud");

/** A recorded payload by file name. */
export const codexFixture = <T = any>(name: string): T => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** A JWT with the claims given (unsigned: codecast only reads its own machine's file). */
export function jwt(claims: Record<string, unknown>): string {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

/** A ChatGPT Codex login (auth.json) on a Pro plan whose access token expires at `expSeconds`; `extra`: more top-level fields. */
export function codexAuthJson(expSeconds: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    ...extra,
    tokens: {
      access_token: jwt({ exp: expSeconds }),
      refresh_token: "rt",
      account_id: "acct-1",
      id_token: jwt({ email: "person@example.com", "https://api.openai.com/auth": { chatgpt_plan_type: "pro" } }),
    },
  });
}

/** The tests' clock, and a login valid for an hour past it. */
export const CODEX_NOW = 1_790_724_000_000;
export const CODEX_VALID = codexAuthJson(CODEX_NOW / 1000 + 3600);

/**
 * A fetch over the wham API: routes by method and path, every call recorded.
 * Routes are read at call time, so a test swaps one between polls; an
 * unrouted call answers the API's own 404 for an unknown task.
 */
export function whamFetch(routes: Record<string, (call: FakeCloudCall) => Response>): { fetchImpl: typeof fetch; calls: FakeCloudCall[] } {
  const calls: FakeCloudCall[] = [];
  const fetchImpl = fakeCloudFetch(routes, {
    calls,
    stripPrefix: "/backend-api/wham",
    missing: () => new Response(JSON.stringify({ detail: "Invalid task ID" }), { status: 404 }),
  });
  return { fetchImpl, calls };
}
