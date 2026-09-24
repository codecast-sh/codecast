// Public entrypoint inventory for the security coverage matrix (plan 008,
// step 4). Walks every Convex module, finds each exported function and HTTP
// route, and records what the handler's source says about who may call it:
// the authentication it performs, the resource judge it consults, whether a
// quota or a revocation check is visible, and which tests call it. A row it
// cannot classify is "unresolved", never "safe".
//
// The classification is lexical: it reads helper names out of the handler
// body. That is enough to rank where a human must look and to keep the
// matrix honest, and it is deliberately not a proof. The negative handler
// tests are the proof for the cells that carry one.
//
//   bun scripts/security-inventory.ts            # from packages/convex
//   bun scripts/security-inventory.ts --check    # exit 1 if the inventory on disk is stale
//
// Output: plans/security-entrypoint-inventory.json and .md at the repo root.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const CONVEX_DIR = resolve(import.meta.dir, "../convex");
const REPO = resolve(import.meta.dir, "../../..");
const OUT_JSON = join(REPO, "plans/security-entrypoint-inventory.json");
const OUT_MD = join(REPO, "plans/security-entrypoint-inventory.md");

// Function constructors. Public ones answer an unauthenticated network caller;
// internal ones are reachable only from other functions. Wrappers defined in
// the tree are listed with what they wrap and what they enforce themselves.
const PUBLIC_CTORS: Record<string, { kind: "query" | "mutation" | "action" | "httpAction"; enforces?: string[] }> = {
  query: { kind: "query" },
  mutation: { kind: "mutation" },
  action: { kind: "action" },
  httpAction: { kind: "httpAction" },
  // agentTasks.ts: verifyApiToken / getAuthUserId + getManageableTask.
  cliTaskAction: { kind: "mutation", enforces: ["verifyApiToken", "getManageableTask"] },
  webTaskAction: { kind: "mutation", enforces: ["getAuthUserId", "getManageableTask"] },
  // repos.ts: both wrap mutation/query and resolve the caller through requireCaller.
  ensureAction: { kind: "mutation", enforces: ["requireCaller"] },
  readAction: { kind: "query", enforces: ["requireCaller"] },
};
const INTERNAL_CTORS = new Set(["internalQuery", "internalMutation", "internalAction", "rawInternalMutation"]);

// Signals read out of a handler body. Each list is a name that, when it
// appears as a call, tells us something about the trust boundary.
const AUTH = [
  "getAuthUserId", "requireUser", "requireAuth", "requireCaller", "requireWorkspaceCaller", "authenticateExecutionDaemon",
  "verifyApiToken", "createDataContext", "requireTeamMembership", "requireTeamAdmin", "requireRole", "requireAdmin", "checkScope",
  "requireHuman", "requireViewer", "requireIdentity", "getViewerId", "currentUserId", "requireSessionCommandTarget",
  "getAuthenticatedUserId", "getAuthenticatedUserIdReadOnly", "requireUserOrToken", "requireCliUser", "caller", "authUser",
  "requireConversationExecution", "requireTeamForWrite", "resolveTeamForRead", "requireCallerUser", "callerUserId", "requireCliCaller",
  "requireDaemon", "requireDevice", "requireRunner", "requireAuthenticatedUser", "requireAuthUserId", "requireUserId",
  "setSystemConfig", "buildWebDocList", "listHiddenSessionsLite", "pullRequestVerb", "operationToken", "requireRepoAccess",
];
const JUDGE = [
  "canAccessChannel", "canAccessComment", "canAccessCommit", "canAccessConversation", "canAccessDoc", "canAccessInitiative",
  "canAccessPlan", "canAccessProject", "canAccessPullRequest", "canAccessResourceForUser", "canAccessTask", "canAccess",
  "checkConversationAccess", "requireAccessibleConversation", "requireAccessibleDoc", "requireAccessibleInitiative",
  "requireAccessiblePlan", "requireAccessibleProject", "requireAccessiblePullRequest", "requireAccessibleTask",
  "requireTeamMembership", "requireTeamAdmin", "requireRole", "requireSameWorkspace", "requireWorkspaceMatch",
  "requireSessionCommandTarget", "createDataContext", "scopedFetch", "getManageableTask", "requireInstallationRevoker",
  "verifyInstallerControlsInstallation", "requireInitiative", "requireWorkspaceFeature", "requireTeamFeature", "checkScope",
  "assertOwner", "assertMember", "assertTeamMember", "requireOwner", "requireConversationOwner", "requireMembership",
  "isTeamMember", "isMember", "hasTeamAccess", "userCanAccess", "accessibleTeamIds", "viewerTeamIds", "canSee", "canView", "canEdit", "canManage",
  "canOwnerOrTeamAccess", "requireOwnComment", "requireConversation", "senderOrOwnerCanAct", "userCanAdminAnchor", "visibleAnchorsForUser",
  "accessibleStack", "requireConversationExecution", "resolveTeamForRead", "requireTeamForWrite", "assignConversationToBucketForUser",
  "requireOwnedConversation", "requireOwned", "ownedBy", "requireStackOwner", "requireDecisionOwner", "requireDoc", "requireTask", "requirePlan",
  "requireProject", "requireBucket", "requireChannelMember", "requireDmMember", "requireCallMember", "requireAnchorAdmin", "requireAnchorAccess",
  "requireDeviceOwner", "requireInstallationOwner", "requireIntegrationOwner", "requireRepoAccess", "requireAccessibleRepo", "requireAccessibleCommit",
  "readableDecision", "requireAccess", "pullRequestVerb", "operationToken", "getManageableTask",
];

// An action has no db and authenticates by asking a query. The query it asks
// is the judge; a call to an internal query whose name says as much, or to a
// public query that authenticates itself, counts as delegated auth.
const DELEGATED = /ctx\.runQuery\(\s*(?:internal|internalApi|api)(?:\s+as\s+any\))?\.[A-Za-z0-9_]+\.(?:[A-Za-z0-9_]*(?:auth|Auth|actor|Actor|caller|Caller|user|User|owner|Owner|resolve|Resolve|token|Token|access|Access|panel|Panel|target|Target|identity|Identity|context|Context|scope|Scope|webGet|getConversation|getCurrentUser|getUserTeams)[A-Za-z0-9_]*)\b/;

// Rows a human read on 2026-09-23 and classified by hand, with the reason.
// The lexical pass cannot see through a module-local helper or a design
// decision; this table is where that reading lives, and it is reviewed again
// whenever the row's handler changes (the line number is recorded for that).
const MANUAL: Record<string, { authClass: Row["authClass"]; reason: string }> = {
  "health.check": { authClass: "anonymous", reason: "liveness probe by design; returns a constant" },
  "usageCalibration.get": { authClass: "anonymous", reason: "one global calibration number by design; no per-user data" },
  "systemConfig.getMinCliVersion": { authClass: "anonymous", reason: "fleet floor is public by design; clients read it before they can sign in" },
  "systemConfig.getMinDesktopVersion": { authClass: "anonymous", reason: "fleet floor is public by design" },
  "teams.getUserByGithubId": { authClass: "anonymous", reason: "projects to public profile fields by design; note team_id is disclosed (open cell)" },
  "users.getPublicProfile": { authClass: "anonymous", reason: "gated on public_profile_enabled" },
  "users.getPublicActivityHeatmap": { authClass: "anonymous", reason: "gated on public_profile_enabled and hide_activity" },
  "users.getPublicActivityPunchcard": { authClass: "anonymous", reason: "gated on public_profile_enabled and hide_activity" },
  "users.getUserActivity": { authClass: "anonymous", reason: "gated on public_profile_enabled and hide_activity" },
  "users.getUserStats": { authClass: "anonymous", reason: "gated on public_profile_enabled and hide_activity" },
  "users.getUserByUsername": { authClass: "authenticated", reason: "anonymous callers gated on public_profile_enabled since 2026-09-23 (securityEntrypoints.test.ts)" },
  "artifacts.getShared": { authClass: "token", reason: "published page read by slug capability by design (plan 006 owns the publishing surface)" },
  "repoPublicHttp.preflight": { authClass: "anonymous", reason: "CORS preflight; no data" },
  "artifactsHttp.corsPreflight": { authClass: "anonymous", reason: "CORS preflight; no data" },
  "artifactsHttp.serve": { authClass: "token", reason: "published page by slug plus k/e capability tokens by design (plan 006)" },
  "artifactsHttp.view": { authClass: "token", reason: "view counter behind slug and gate tokens, rate limited (plan 006)" },
  "artifactsHttp.unlock": { authClass: "token", reason: "password unlock, rate limited (plan 006)" },
  "artifactsHttp.emailUnlock": { authClass: "token", reason: "email gate, rate limited (plan 006)" },
  "artifactsHttp.identity": { authClass: "token", reason: "commenter identity by token, rate limited (plan 006)" },
  "artifactsHttp.comment": { authClass: "token", reason: "viewer comments by slug and gate tokens, rate limited (plan 006)" },
  "artifactsHttp.edit": { authClass: "token", reason: "edit key capability (plan 006)" },
  "artifactsHttp.manage": { authClass: "token", reason: "owner_key capability (plan 006)" },
  "artifactsHttp.rollback": { authClass: "token", reason: "api_token via resolveTargetForCLI (plan 006)" },
  "artifacts.recordView": { authClass: "token", reason: "slug plus gate tokens, rate limited (plan 006)" },
  "artifacts.deliverPendingComments": { authClass: "token", reason: "owner_key capability (plan 006)" },
  "googleOAuth.callback": { authClass: "token", reason: "signed OAuth state (plan 005 owns integrations)" },
  "oauthConnectors.callback": { authClass: "token", reason: "signed OAuth state (plan 005)" },
  "calls.mintAccessToken": { authClass: "authenticated", reason: "internal.calls.authForToken authenticates and judges room membership" },
  "transcripts.mintAsrToken": { authClass: "authenticated", reason: "internal.transcripts.authForAsr authenticates and judges room membership" },
  "chat.markThreadRead": { authClass: "authenticated", reason: "delegates to api.threads.markRead which calls requireCaller" },
  "commits.syncAllMyRepositories": { authClass: "authenticated", reason: "internal.commits.getUserGitHubToken reads the caller's own token from ctx.auth" },
  "sessionInsights.backfillTimelines": { authClass: "authenticated", reason: "getCurrentUser; scoped to the caller's own insights" },
  "teams.syncGithubOrg": { authClass: "authenticated", reason: "getCurrentUser must equal requesting_user_id" },
};

const TOKEN = ["verifyApiToken", "secretMatches", "verifyLinearSignature", "verifyState", "verifyStateWith", "presentToken", "share_token", "invite_code", "timingSafeEqual", "verifySignature", "hmac", "webhook_secret", "bearer"];
const QUOTA = ["checkRateLimit", "rateLimit", "rate_limit", "quota", "MAX_", "limit"];
const REVOCATION = ["revoked", "revoked_at", "is_revoked", "disabled", "removed_at", "left_at", "deleted_at", "is_active", "expires_at", "expired"];

interface Row {
  id: string; // api path, "module.name" or "dir/module.name"
  module: string;
  name: string;
  ctor: string;
  kind: "query" | "mutation" | "action" | "httpAction" | "internal";
  exposure: "public" | "internal";
  authClass: "internal" | "authenticated" | "token" | "anonymous" | "mixed";
  auth: string[];
  judges: string[];
  tokens: string[];
  quota: string[];
  revocation: string[];
  takesIds: string[];
  readsCtxAuth: boolean;
  status: "resolved" | "unresolved";
  risk: "high" | "medium" | "low" | "none";
  reason: string;
  testedBy: string[];
  routes: Array<{ method: string; path: string }>;
  line: number;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (entry === "_generated" || entry === "node_modules") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !entry.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** From an opening "(" index, return the index just past its matching ")",
 *  skipping strings, template literals, regex-free comments. Good enough for
 *  handler bodies; a mismatch only widens or narrows one row's text. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") { i = src.indexOf("\n", i); if (i < 0) return src.length; continue; }
    if (c === "/" && next === "*") { i = src.indexOf("*/", i + 2); if (i < 0) return src.length; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; }
      i++;
      continue;
    }
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return src.length;
}

function hits(body: string, names: string[]): string[] {
  const found: string[] = [];
  for (const n of names) {
    const re = /^[A-Za-z_]/.test(n) ? new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`) : new RegExp(n);
    if (re.test(body)) found.push(n);
  }
  return found;
}

function lineOf(src: string, idx: number): number {
  return src.slice(0, idx).split("\n").length;
}

const files = walk(CONVEX_DIR);
const rows: Row[] = [];
const decl = /export const ([A-Za-z0-9_]+)\s*=\s*([A-Za-z0-9_]+)\s*\(/g;

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const module = relative(CONVEX_DIR, file).replace(/\.ts$/, "");
  decl.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src))) {
    const [, name, ctor] = m;
    const isPublic = ctor in PUBLIC_CTORS;
    const isInternal = INTERNAL_CTORS.has(ctor);
    if (!isPublic && !isInternal) continue;
    const open = m.index + m[0].length - 1;
    const end = matchParen(src, open);
    const body = src.slice(open, end);
    const enforced = isPublic ? PUBLIC_CTORS[ctor].enforces ?? [] : [];
    const auth = [...new Set([...hits(body, AUTH), ...enforced.filter((e) => AUTH.includes(e))])];
    const judges = [...new Set([...hits(body, JUDGE), ...enforced.filter((e) => JUDGE.includes(e))])];
    const tokens = hits(body, TOKEN);
    const quota = hits(body, QUOTA);
    const revocation = hits(body, REVOCATION);
    const readsCtxAuth = /\bctx\.auth\b/.test(body);
    const takesIds = [...body.matchAll(/v\.id\("([a-z_]+)"\)/g)].map((x) => x[1]);
    const kind = isInternal ? "internal" : PUBLIC_CTORS[ctor].kind;

    const id = `${module}.${name}`;
    const manual = MANUAL[id];
    const delegated = !isInternal && (kind === "action" || kind === "httpAction") && DELEGATED.test(body);
    let authClass: Row["authClass"];
    if (isInternal) authClass = "internal";
    else if (manual) authClass = manual.authClass;
    else if (auth.length && tokens.length) authClass = "mixed";
    else if (auth.length || readsCtxAuth || delegated) authClass = "authenticated";
    else if (tokens.length) authClass = "token";
    else authClass = "anonymous";
    if (delegated && !judges.length) judges.push("(delegated to an authenticating query)");
    // An ownership comparison written inline is a judge too: the row is
    // loaded by id and its owner field compared to the caller before the
    // write. Recorded as such so the reader knows it is a comparison, not a
    // shared helper, and looks at the line.
    const INLINE_OWNERSHIP = /\.(user_id|owner_id|created_by|creator_id|author_id|runner_user_id|host_user_id|requested_by|assignee|from_user_id|to_user_id|sender_id|subject_user_id)\s*(?:!==|===|!=|==)\s*|throw new Error\(["'`](Not authorized|Not authorised|Forbidden|Access denied|Not your |Not the owner|Only the (?:owner|author|sender|host)|Unauthorized: not)/;
    if (!isInternal && (auth.length || readsCtxAuth) && !judges.length && INLINE_OWNERSHIP.test(body)) judges.push("(inline ownership comparison)");
    if (manual) judges.push(`(manual review 2026-09-23: ${manual.reason})`);

    let status: Row["status"] = "resolved";
    let risk: Row["risk"] = "none";
    let reason = "";
    if (isInternal) {
      reason = "internal: reachable only from other functions";
    } else if (manual) {
      status = manual.authClass === "anonymous" || manual.authClass === "token" ? "resolved" : (judges.length > 1 || !takesIds.length ? "resolved" : "unresolved");
      risk = status === "resolved" ? "low" : "medium";
      reason = manual.reason;
    } else if (authClass === "anonymous") {
      status = "unresolved";
      risk = kind === "query" ? "medium" : "high";
      reason = "no authentication or token check visible in the handler";
    } else if (authClass === "token") {
      status = takesIds.length ? "unresolved" : "resolved";
      risk = takesIds.length ? "medium" : "low";
      reason = takesIds.length ? "token authenticated but takes ids without a visible resource judge" : "token authenticated";
    } else if (judges.length === 0 && takesIds.length > 0) {
      status = "unresolved";
      risk = kind === "query" ? "medium" : "high";
      reason = `authenticated caller, takes ids for ${[...new Set(takesIds)].join(",")} with no visible resource judge`;
    } else if (judges.length === 0) {
      risk = "low";
      reason = "authenticated caller; no ids taken, scoped by the caller's own identity or workspace";
    } else {
      reason = `judged by ${judges.slice(0, 4).join(", ")}`;
    }

    rows.push({
      id, module, name, ctor, kind, exposure: isInternal ? "internal" : "public", authClass,
      auth, judges, tokens, quota, revocation, takesIds: [...new Set(takesIds)], readsCtxAuth, status, risk, reason, testedBy: [],
      routes: [], line: lineOf(src, m.index),
    });
  }
}

// HTTP routes: http.route({ path|pathPrefix, method, handler }) in http.ts.
const httpSrc = readFileSync(join(CONVEX_DIR, "http.ts"), "utf8");
const routeRe = /\.route\(\s*\{([\s\S]*?)\}\s*\)/g;
const routes: Array<{ method: string; path: string; handler: string }> = [];
let r: RegExpExecArray | null;
while ((r = routeRe.exec(httpSrc))) {
  const block = r[1];
  const path = /path(?:Prefix)?:\s*"([^"]+)"/.exec(block)?.[1] ?? "?";
  const method = /method:\s*"([A-Z]+)"/.exec(block)?.[1] ?? "?";
  const handler = /handler:\s*([A-Za-z0-9_.]+)/.exec(block)?.[1] ?? "(inline)";
  routes.push({ method, path, handler });
}
for (const route of routes) {
  const name = route.handler.split(".").pop()!;
  const row = rows.find((x) => x.name === name && x.kind === "httpAction") ?? rows.find((x) => x.name === name);
  if (row) row.routes.push({ method: route.method, path: route.path });
  else rows.push({
    id: `http:${route.method} ${route.path}`, module: "http", name: route.handler, ctor: "route", kind: "httpAction", exposure: "public",
    authClass: "anonymous", auth: [], judges: [], tokens: [], quota: [], revocation: [], takesIds: [], readsCtxAuth: false,
    status: "unresolved", risk: "high", reason: "route handler is inline or defined outside the export scan", testedBy: [],
    routes: [{ method: route.method, path: route.path }], line: 0,
  });
}

// Which tests call each public function: api.<module>.<name>, anyApi.<module>.<name>,
// "<module>:<name>". One pass over the test files builds an index of every
// reference; each row then looks itself up instead of scanning every file.
const SKIP_DIRS = new Set(["node_modules", "_generated", ".git", "dist", "build", "out", "ios", "android", ".expo", ".vite", "coverage", ".codecast", "worktrees"]);
const testFiles: string[] = [];
(function walkTests(dir: string) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const p = join(dir, entry);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walkTests(p);
    else if (/\.test\.tsx?$/.test(entry)) testFiles.push(p);
  }
})(join(REPO, "packages"));
const refIndex = new Map<string, Set<string>>();
const refRe = /\b(?:api|anyApi)\.([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)|["']([A-Za-z0-9_/]+:[A-Za-z0-9_]+)["']/g;
for (const p of testFiles) {
  const rel = relative(REPO, p);
  const s = readFileSync(p, "utf8");
  let x: RegExpExecArray | null;
  refRe.lastIndex = 0;
  while ((x = refRe.exec(s))) {
    const key = x[1] ?? x[2]!;
    if (!refIndex.has(key)) refIndex.set(key, new Set());
    refIndex.get(key)!.add(rel);
  }
}
for (const row of rows) {
  if (row.exposure !== "public") continue;
  const dotted = row.module.replace(/\//g, ".") + "." + row.name;
  const colon = row.module + ":" + row.name;
  row.testedBy = [...new Set([...(refIndex.get(dotted) ?? []), ...(refIndex.get(colon) ?? [])])].sort();
}

rows.sort((a, b) => a.id.localeCompare(b.id));
const pub = rows.filter((x) => x.exposure === "public");
const summary = {
  generatedAt: new Date().toISOString(),
  files: files.length,
  functions: rows.length,
  public: pub.length,
  internal: rows.length - pub.length,
  byKind: Object.fromEntries(["query", "mutation", "action", "httpAction"].map((k) => [k, pub.filter((x) => x.kind === k).length])),
  byAuthClass: Object.fromEntries(["authenticated", "token", "mixed", "anonymous"].map((k) => [k, pub.filter((x) => x.authClass === k).length])),
  unresolved: pub.filter((x) => x.status === "unresolved").length,
  unresolvedByRisk: Object.fromEntries(["high", "medium", "low"].map((k) => [k, pub.filter((x) => x.status === "unresolved" && x.risk === k).length])),
  publicWithoutTests: pub.filter((x) => x.testedBy.length === 0).length,
  httpRoutes: routes.length,
};

// The permission matrix the plan names. Each role is a column; a cell is
// "judged" when the row's judge covers that role by construction, "tested"
// when a test names the function, "unresolved" otherwise. Internal rows have
// no cells: they are not callable by any role.
const ROLES = ["anonymous", "owner", "teammate", "admin", "other_team", "revoked_member", "share_guest", "wrong_table_id", "expired_or_wrong_purpose_token", "missing_device", "stale_runner"] as const;
function cell(row: Row, role: (typeof ROLES)[number]): "judged" | "tested" | "unresolved" | "n/a" {
  const tested = row.testedBy.length > 0;
  switch (role) {
    case "anonymous":
      return row.authClass === "anonymous" ? (tested ? "tested" : "unresolved") : "judged";
    case "owner":
      return row.status === "resolved" ? "judged" : tested ? "tested" : "unresolved";
    case "teammate":
    case "admin":
    case "other_team":
    case "revoked_member":
      if (row.authClass === "anonymous") return "unresolved";
      return row.judges.length ? "judged" : tested ? "tested" : row.takesIds.length ? "unresolved" : "n/a";
    case "share_guest":
      return row.tokens.some((t) => t === "share_token") ? (tested ? "tested" : "unresolved") : "n/a";
    case "wrong_table_id":
      return row.takesIds.length ? (row.judges.length ? "judged" : tested ? "tested" : "unresolved") : "n/a";
    case "expired_or_wrong_purpose_token":
      return row.tokens.length ? (row.revocation.length ? "judged" : tested ? "tested" : "unresolved") : "n/a";
    case "missing_device":
    case "stale_runner":
      return row.auth.includes("authenticateExecutionDaemon") || row.auth.includes("requireSessionCommandTarget")
        ? (tested ? "tested" : "unresolved")
        : "n/a";
  }
}
const matrix = pub.map((row) => ({ id: row.id, cells: Object.fromEntries(ROLES.map((role) => [role, cell(row, role)])) }));
const openCells = matrix.flatMap((m) => ROLES.filter((role) => m.cells[role] === "unresolved").map((role) => `${m.id} × ${role}`));

const inventory = { summary: { ...summary, openCells: openCells.length }, roles: ROLES, rows, matrix, openCells };
const json = JSON.stringify(inventory, null, 2) + "\n";

const md: string[] = [];
md.push("# Public entrypoint inventory", "", `Generated ${summary.generatedAt} by packages/convex/scripts/security-inventory.ts. Lexical classification of every exported Convex function and HTTP route; \"unresolved\" means no one has shown the boundary holds, never that it is safe.`, "");
md.push("| | count |", "|---|---|");
for (const [k, v] of Object.entries(summary)) md.push(`| ${k} | ${typeof v === "object" ? JSON.stringify(v) : v} |`);
md.push(`| openCells | ${openCells.length} |`, "");
md.push("## Unresolved public rows, highest risk first", "", "| risk | id | kind | auth | ids | reason | tests |", "|---|---|---|---|---|---|---|");
const order = { high: 0, medium: 1, low: 2, none: 3 };
for (const row of pub.filter((x) => x.status === "unresolved").sort((a, b) => order[a.risk] - order[b.risk] || a.id.localeCompare(b.id))) {
  md.push(`| ${row.risk} | ${row.id} | ${row.kind} | ${row.authClass} | ${row.takesIds.join(",")} | ${row.reason} | ${row.testedBy.length} |`);
}
md.push("", "## HTTP routes", "", "| method | path | handler | auth | status |", "|---|---|---|---|---|");
for (const row of pub.filter((x) => x.routes.length)) for (const rt of row.routes) md.push(`| ${rt.method} | ${rt.path} | ${row.id} | ${row.authClass} | ${row.status} |`);
const mdText = md.join("\n") + "\n";

if (process.argv.includes("--check")) {
  let stale = false;
  try {
    const prev = JSON.parse(readFileSync(OUT_JSON, "utf8"));
    const strip = (o: any) => JSON.stringify({ ...o, summary: { ...o.summary, generatedAt: undefined } });
    stale = strip(prev) !== strip(inventory);
  } catch { stale = true; }
  if (stale) { console.error("security inventory is stale: run bun scripts/security-inventory.ts"); process.exit(1); }
  console.log("security inventory is current");
} else {
  writeFileSync(OUT_JSON, json);
  writeFileSync(OUT_MD, mdText);
  console.log(JSON.stringify(inventory.summary, null, 2));
}
