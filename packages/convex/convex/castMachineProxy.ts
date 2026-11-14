// The model route for pi on a cast machine (castMachines.ts). The machine
// holds only its own key (castm_…, written at first boot); this checks it and
// forwards the Anthropic Messages call with codecast's key, streaming the
// answer back. Our key never reaches a machine its person controls.
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { sha256Hex } from "./lib/awsSigV4";
import { forwardMessages } from "./lib/anthropic";

/** Under /cli/, the prefix the public host hands to HTTP actions. */
export const CAST_MODEL_PROXY_PATH = "/cli/cast/anthropic";
const ROUTES = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
const FORWARDED_REQUEST_HEADERS = ["content-type", "anthropic-version", "anthropic-beta", "accept"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "request-id", "retry-after", "cache-control"];

const deny = (status: number, message: string) =>
  new Response(JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : "api_error", message } }), {
    status, headers: { "content-type": "application/json" },
  });

export const castModelProxy = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const route = url.pathname.slice(CAST_MODEL_PROXY_PATH.length);
  if (!ROUTES.has(route)) return deny(404, "Not found");
  const key = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!key || !key.startsWith("castm_")) return deny(401, "Missing machine key");
  const machine = await ctx.runQuery(internal.castMachines.machineForProxyKey, { key_hash: await sha256Hex(key) });
  if (!machine) return deny(401, "Unknown machine key");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return deny(503, "No model key on this deployment");

  const headers = new Headers({ "x-api-key": apiKey });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const upstream = await forwardMessages(`${route}${url.search}`, headers, await request.arrayBuffer());
  const out = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
});
