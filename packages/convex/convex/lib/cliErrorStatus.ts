import { argumentValidationProblem } from "@codecast/shared/contracts/convexErrors";

// The HTTP status for each structured failure code a mutation can raise (see
// chat.ts `chatFail`). Anything unmapped is a 500, which is what an unstructured
// throw already was. Shared by the CLI routes (http.ts cliRoute) and the
// ingest door (ingestHttp.ts), so one code answers one status everywhere.
export const CLI_ERROR_STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
};

/** What a CLI route (http.ts cliRoute) answers for a throw: its status and JSON body. */
export function cliErrorReply(error: unknown, path: string): { status: number; body: Record<string, unknown> } {
  // A ConvexError carries structured data ({ code, message, retryable }), and
  // flattening it to a string is what makes a caller unable to tell "wait and
  // retry" from "this will never be accepted". Pass the data through, with a
  // status that says the same thing, so an outbox decides without parsing prose.
  const data = (error as any)?.data;
  if (data && typeof data === "object" && typeof data.code === "string") {
    return { status: CLI_ERROR_STATUS[data.code] ?? 500, body: { ...data, error: data.message ?? data.code } };
  }
  const msg = error instanceof Error ? error.message : String(error);
  // A validator's refusal dumps every argument the call carried, the api token
  // and a secret's value with them: answer, and log, only what it says is wrong.
  const refused = argumentValidationProblem(msg);
  if (refused !== null) {
    console.warn(`${path}: arguments refused: ${refused}`);
    return {
      status: CLI_ERROR_STATUS.INVALID,
      body: { code: "INVALID", error: `The server did not accept this request (${refused || "its arguments do not match"}): update cast with \`cast update\`, or this server is behind your cast` },
    };
  }
  return { status: msg.includes("Unauthorized") ? 401 : 500, body: { error: msg } };
}
