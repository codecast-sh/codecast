export const HIBERNATED_COPY = "hibernated, resumes on send";
export const PARKING_REQUESTED_COPY = "parking requested";

export function isHibernated(row: { agent_status?: string | null } | null | undefined): boolean {
  return row?.agent_status === "hibernated";
}

export type SessionCommandOutcome = { state: "pending" | "succeeded" | "skipped" | "failed"; message: string };

export function sessionCommandOutcome(row: { command?: string; result?: string | null; error?: string | null; executed_at?: number | null } | null | undefined): SessionCommandOutcome {
  if (!row?.executed_at) return { state: "pending", message: row?.command === "resume_session" ? "wake requested" : PARKING_REQUESTED_COPY };
  if (row.result?.startsWith("skipped_")) return { state: "skipped", message: row.error || row.result.slice(8).replaceAll("_", " ") };
  if (row.error) return { state: "failed", message: row.error };
  if (row.command === "hibernate_session" && row.result === "hibernated") return { state: "succeeded", message: HIBERNATED_COPY };
  if (row.command === "resume_session") {
    let result: any;
    try { result = JSON.parse(row.result || "null"); } catch { result = null; }
    if (result?.resumed === true) return { state: "succeeded", message: "resumed" };
  }
  return { state: "failed", message: row.result || "daemon did not confirm completion" };
}
