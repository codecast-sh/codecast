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
