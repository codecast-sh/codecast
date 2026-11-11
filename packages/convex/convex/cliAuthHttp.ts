import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { clientIp, ipRateLimited } from "./lib/httpRateLimit";

// `cast auth` registers its sign-in request here before opening the browser:
// the nonce the URL will carry, the hash of a verifier that never leaves the
// CLI, and its device. The caller's network is recorded for the Authorize
// page (cliAuth.requestInfo). Called by the CLI only, so no CORS. Routed at
// POST /cli/auth-request (http.ts).
export const cliAuthRequest = httpAction(async (ctx, request) => {
  const limited = await ipRateLimited(ctx, request, "cli_auth_request", 30, 10 * 60 * 1000);
  if (limited) return limited;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON" });
  }
  const str = (x: unknown) => (typeof x === "string" ? x : undefined);
  const nonce = str(body?.nonce);
  const verifierHash = str(body?.verifier_hash);
  if (!nonce || !verifierHash) return json(400, { error: "Missing nonce or verifier_hash" });
  const country = request.headers.get("cf-ipcountry") ?? undefined;
  const userAgent = request.headers.get("user-agent") ?? undefined;
  const deviceId = str(body.device_id);
  const ok = await ctx.runMutation(internal.cliAuth.register, {
    nonce,
    verifier_hash: verifierHash,
    device_name: str(body.device_name) ?? "CLI Device",
    ...(deviceId ? { device_id: deviceId } : {}),
    ip: clientIp(request),
    ...(country ? { country } : {}),
    ...(userAgent ? { user_agent: userAgent } : {}),
  });
  return ok ? json(200, { ok: true }) : json(400, { error: "Invalid or duplicate request" });
});
