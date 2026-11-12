// The pure rules of a published page: size limits, its address, the line diff
// for ?diff=A..B, the access summary a row shows, and the refusal a team-gated
// page gives. Leaf module, so the page routes (artifactsHttp, mounted by
// http.ts) and sessionDecisions read them without loading artifacts.ts, which
// reaches the big import cycle (ct-92432).
import type { Doc } from "../_generated/dataModel";
import { siteUrl } from "./siteUrl";

/** A page's files together. */
export const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024;
export const MAX_ARTIFACT_MB = MAX_ARTIFACT_BYTES / 1024 / 1024;
/** The html document itself: serving reads it whole into a 64 MB heap to inject the page's scripts. */
export const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_DOCUMENT_MB = MAX_DOCUMENT_BYTES / 1024 / 1024;

export function artifactUrl(slug: string): string {
  return `${siteUrl()}/a/${slug}`;
}

// ---------------------------------------------------------------------------
// Line diff (for the ?diff=A..B page). Common prefix/suffix trim + LCS over
// the middle, hard-capped so a pathological pair can't blow the action budget.
// ---------------------------------------------------------------------------

export type DiffOp = { t: "eq" | "add" | "del"; line: string };

const DIFF_MAX_LINES = 3000;

export function lineDiff(aText: string, bText: string): { ops: DiffOp[]; truncated: boolean } {
  let a = aText.split("\n");
  let b = bText.split("\n");
  let truncated = false;
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    a = a.slice(0, DIFF_MAX_LINES);
    b = b.slice(0, DIFF_MAX_LINES);
    truncated = true;
  }
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  // LCS table over the middle segment only.
  const n = midA.length;
  const m = midB.length;
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ t: "eq", line: a[i] });
  if (n * m > 4_000_000) {
    // Too dissimilar/large for LCS — degrade to wholesale replace.
    for (const line of midA) ops.push({ t: "del", line });
    for (const line of midB) ops.push({ t: "add", line });
  } else if (n || m) {
    const dp: Uint32Array[] = [];
    for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0,
      j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ t: "eq", line: midA[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ t: "del", line: midA[i] });
        i++;
      } else {
        ops.push({ t: "add", line: midB[j] });
        j++;
      }
    }
    while (i < n) ops.push({ t: "del", line: midA[i++] });
    while (j < m) ops.push({ t: "add", line: midB[j++] });
  }
  for (let i = endA; i < a.length; i++) ops.push({ t: "eq", line: a[i] });
  return { ops, truncated };
}

export function accessSummary(a: Doc<"artifacts">) {
  return {
    team_only: !!a.team_gate,
    has_password: !!a.password_hash,
    email_gate: !!a.email_gate,
    expires_at: a.expires_at ?? null,
    edit_mode: a.edit_mode ?? "owner",
    show_session: !a.hide_session,
    comments_enabled: !a.comments_disabled,
  };
}

/** The refusal for an access change a team-gated page cannot take, else null. */
export function teamGateRefusal(teamName: string, set: { edit_mode?: string }): string | null {
  if (set.edit_mode === "link") {
    return `${teamName} marks this page's data as regulated, so it is for the team's signed-in members only and cannot get a public edit link.`;
  }
  return null;
}
