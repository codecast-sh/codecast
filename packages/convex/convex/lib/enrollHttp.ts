// POST /cli/enroll: a managed device enrolls with its enrollment token. The
// route only parses the body and runs internal.managedDevices.enroll, so it
// lives apart from managedDevices.ts, whose team writes reach the big import
// cycle; http.ts mounts it without loading that module (ct-92432).
import { httpAction } from "../_generated/server";
import { internal } from "../_generated/api";
import type { EnrollRequest, EnrollResponse } from "@codecast/shared/contracts";

export const ENROLL_PATH = "/cli/enroll";

/** POST /cli/enroll (EnrollRequest → EnrollResponse). No api token yet: the
 *  enrollment token is the credential, so neither it nor the body is logged. */
export const enrollHttp = httpAction(async (ctx, request) => {
  const respond = (body: EnrollResponse, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  let body: Partial<EnrollRequest>;
  try {
    body = await request.json();
  } catch {
    return respond({ ok: false, error: "Invalid JSON" }, 400);
  }
  const str = (x: unknown) => (typeof x === "string" ? x : undefined);
  const token = str(body?.enrollment_token);
  const deviceId = str(body?.device_id);
  if (!token || !deviceId) return respond({ ok: false, error: "Missing enrollment_token or device_id" }, 400);
  const result: EnrollResponse = await ctx.runMutation(internal.managedDevices.enroll, {
    enrollment_token: token,
    device_id: deviceId,
    email: str(body.email),
    hostname: str(body.hostname),
    platform: str(body.platform),
  });
  return respond(result, result.ok ? 200 : 403);
});
