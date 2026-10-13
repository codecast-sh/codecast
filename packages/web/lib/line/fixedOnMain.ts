// A problem parked because main already carries its fix (lineInbox fixedOnMain):
// what a person checks before closing it. The run's note without the commit it
// names, and whether a recorded deploy carried it (its CI is lineFixChecks'). Pure,
// so a test reads it.

/** The park note past its "Already fixed on main by <sha>", which the facts say: no leading colon or bracket left, and no
 *  CI word the run wrote when it looked ("; CI run 38315388555 in progress, redeploy main once green"), which is stale by
 *  now and read live beside it. The whole note when nothing else is left. */
export function fixedNoteRest(note: string | null | undefined): string {
  const raw = note ?? "";
  const rest = raw
    .replace(/^\s*(?:already )?fixed on main (?:by|in|at) [0-9a-f]+\s*/i, "")
    .replace(/^\(([^)]*)\)/, "$1")
    .replace(/^[\s:;,.\-–—]+/, "")
    .replace(/[;,.]?\s*CI\b[^;]*$/i, "")
    .trim();
  return rest || raw.trim();
}

/** Short and full shas name the same commit when one starts with the other (7 characters at least). */
export const sameCommit = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && Math.min(a.length, b.length) >= 7 && (a.toLowerCase().startsWith(b.toLowerCase()) || b.toLowerCase().startsWith(a.toLowerCase()));

export type DeployFact = { at: number; sha: string | null; url: string | null };

/** The recorded deploy of the fix commit itself, the earliest; null when none names it. */
export function deployOfCommit(sha: string, deploys: ReadonlyArray<DeployFact>): DeployFact | null {
  return deploys.filter((d) => sameCommit(d.sha, sha)).sort((a, b) => a.at - b.at)[0] ?? null;
}

/** The newest recorded deploy with a commit, the one a later deploy check compares against. */
export function newestDeploy(deploys: ReadonlyArray<DeployFact>): DeployFact | null {
  return deploys.filter((d) => d.sha).sort((a, b) => b.at - a.at)[0] ?? null;
}

/** What lineFixChecks.fixCommitChecks answers, as far as the facts read it. */
export type FixCiRead = {
  state: string;
  failing: string[];
  running: string[];
  passed: number;
  url: string | null;
  named?: Array<{ name: string; ok: boolean | null; url: string | null }>;
};
export type FixCiFact = { key: string; k: string; v: string; tone?: "ok" | "bad" | "warn"; url?: string | null };

/** The test a CI problem names as failing ("Main CI red at ac5c98b: networkMutationAudit.test.ts fails"). */
export const failingTestOf = (text: string | null | undefined): string | null => /([\w.-]+\.(?:test|spec)\.[cm]?[jt]sx?)\b/.exec(text ?? "")?.[1] ?? null;

/** A finding's link to the CI run the problem came from (a GitHub Actions run), the checks the fix must clear. */
export const ciRunOf = (url: string | null | undefined): string | null => (url && /github\.com\/[^/]+\/[^/]+\/actions\/runs\/\d+/.test(url) ? url : null);

/** The fix commit's CI as facts: first whether what failed passes now (the test the problem names, read from the job
 *  it failed in), then every other check apart as "Other checks", since a red deploy elsewhere says nothing about the
 *  fix. With no failed run to answer for, one CI fact for the whole commit. */
export function fixCiFacts(ci: FixCiRead | null, test: string | null): FixCiFact[] {
  if (!ci) return [{ key: "ci", k: "CI", v: "Reading" }];
  const checks = ci.url ? `${ci.url}/checks` : null;
  const rest = (k: string): FixCiFact | null =>
    ci.state === "success" ? { key: "ci", k, v: `Green, ${ci.passed} passed`, tone: "ok", url: checks }
    : ci.state === "failure" ? { key: "ci", k, v: `Red: ${ci.failing.join(", ")}`, tone: ci.named?.length ? "warn" : "bad", url: checks }
    : ci.state === "pending" ? { key: "ci", k, v: `Running ${ci.running.length}`, tone: "warn", url: checks }
    : ci.state === "none" ? (ci.named?.length ? null : { key: "ci", k, v: "No checks ran" })
    : ci.named?.length ? null : { key: "ci", k, v: "Not readable here" };
  if (!ci.named?.length) return [rest("CI")].filter((f): f is FixCiFact => !!f);
  const one = ci.named.length === 1;
  const named = ci.named.map((n): FixCiFact => {
    const what = one && test ? test : n.name;
    return {
      key: `named:${n.name}`,
      k: one && test ? "Failing test" : "Failed check",
      v: n.ok === true ? `${what} passes` : n.ok === false ? `${what} still fails` : `${what} not run on this commit yet`,
      tone: n.ok === true ? "ok" : n.ok === false ? "bad" : "warn",
      url: n.url,
    };
  });
  return [...named, rest("Other checks")].filter((f): f is FixCiFact => !!f);
}

/** Whether closing as fixed is the act to lead with: what failed passes on the commit (else, with nothing named, all green). */
export const fixCiCleared = (ci: FixCiRead | null): boolean =>
  !!ci && (ci.named?.length ? ci.named.every((n) => n.ok === true) : ci.state === "success");

/** A change a finding says is not in production yet ("#3850 (e14601a557, ...) ... it is NOT in prod", "never deployed",
 *  "lands before the next deploy"): its pull request and commit, so the page can say whether that still holds. The
 *  first such in the findings, newest first; null when none says so. */
export function undeployedCited(rows: ReadonlyArray<{ title?: string | null; detail_md?: string | null; observed_at?: number; created_at: number }>): { pr: string | null; sha: string } | null {
  const NOT_LIVE = /\bnot (?:yet )?(?:in prod(?:uction)?|deployed|live)\b|\bnever (?:been )?deployed\b|\bbefore the next deploy\b|\bmust not (?:reach|ship|go)\b/i;
  for (const r of [...rows].sort((a, b) => (b.observed_at || b.created_at) - (a.observed_at || a.created_at))) {
    const text = `${r.title ?? ""}\n${r.detail_md ?? ""}`;
    if (!NOT_LIVE.test(text)) continue;
    const m = /(#\d{2,6})\s*\(`?([0-9a-f]{7,40})\b/.exec(text) ?? /\bcommit\s+`?([0-9a-f]{7,40})\b/i.exec(text);
    if (m) return m.length === 3 ? { pr: m[1], sha: m[2] } : { pr: null, sha: m[1] };
  }
  return null;
}
