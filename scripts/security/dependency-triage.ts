// Dependency advisory triage (plan 008, step 3, PARENT-09). Reads `bun audit
// --json`, resolves every flagged package to the versions the lock actually
// holds and the workspaces that reach them (`bun why`), and joins a hand kept
// determination table so each advisory row carries: the resolved path, the
// deployment mode, whether untrusted input reaches the affected symbol, the
// decision, its evidence, and a review expiry. Rows with no determination are
// "untriaged", never "fine".
//
//   bun scripts/security/dependency-triage.ts             # writes plans/security-dependency-triage.json + .md
//   bun scripts/security/dependency-triage.ts --check     # exit 1 when a flagged package has no determination or one has expired
//
// Raw audit output is kept beside it (plans/security-dependency-audit.json)
// and never edited: the ledger is a reading of it, not a replacement.

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const OUT_JSON = join(REPO, "plans/security-dependency-triage.json");
const OUT_MD = join(REPO, "plans/security-dependency-triage.md");
const RAW = join(REPO, "plans/security-dependency-audit.json");

type Mode = "runtime-backend" | "runtime-web" | "runtime-cli" | "runtime-desktop" | "runtime-mobile" | "build-only" | "dev-only" | "test-only";
interface Determination {
  /** Which resolved versions this applies to; "*" for every resolved copy. */
  versions: string;
  modes: Mode[];
  /** The symbol or behaviour the advisory is about, as we use it (or do not). */
  symbol: string;
  untrustedInput: "yes" | "no" | "indirect";
  decision: "fixed" | "not-reachable" | "accepted-risk" | "fix-planned";
  evidence: string;
  owner: string;
  reviewBy: string; // ISO date; the determination expires and must be re-read
}

// The reading. Every entry names what was checked, so a later reader can
// disagree with evidence rather than with a feeling.
const DETERMINATIONS: Record<string, Determination> = {
  ws: {
    versions: "8.21.3 (packages/cli), 8.18.0 (nested under convex@1.36.1), 8.20.0 (@expo/cli, ink), 7.5.10 (metro, react-devtools-core), 6.2.3 (react-native)",
    modes: ["runtime-cli", "dev-only"],
    symbol: "receiver fragment handling (GHSA-96hv-2xvq-fx4p): memory exhaustion from tiny fragments on a server socket",
    untrustedInput: "yes",
    decision: "fixed",
    evidence: "The CLI's own ws (bridge host, loopback WebSocket server for the extension and CDP clients) is 8.21.3 in package.json and bun.lock; the resolved import is asserted by packages/cli/src/browser/bridge/wsVersion.test.ts. The nested 8.18.0 under convex is the Convex client's outbound socket to our own backend, a client role the advisory does not cover, and it is pinned exactly by convex; it moves when convex does. The 8.20.0/7.x/6.x copies are expo, metro, react-native and ink dev tooling, never in a shipped bundle. Pre-auth bounds on the bridge (origin allow list, 256 KiB hello cap, 4 concurrent handshakes, hello timeout) landed in 30a74b510.",
    owner: "release owner (jx7f70q)",
    reviewBy: "2026-12-23",
  },
  "@auth/core": {
    versions: "0.37.4 (peer of @convex-dev/auth)",
    modes: ["runtime-backend"],
    symbol: "email normaliser (GHSA-7rqj-j65f-68wh) and getToken() bearer parsing (GHSA-xmf8-cvqr-rfgj)",
    untrustedInput: "indirect",
    decision: "fix-planned",
    evidence: "Convex Auth (@convex-dev/auth) is the consumer; our auth surface is GitHub, Apple and Google OAuth through @platform/auth (identity worker ct-53052), no email/magic link provider is configured, and getToken() is not called from our code. Upgrade rides the next @convex-dev/auth release that lifts the peer; tracked with the identity worker.",
    owner: "identity worker (ct-53052)",
    reviewBy: "2026-11-01",
  },
  hono: { versions: "resolved copies under @platform/auth and tooling", modes: ["dev-only"], symbol: "router / body parsing advisories", untrustedInput: "no", decision: "not-reachable", evidence: "No production entrypoint runs a hono server: the backend is Convex http.ts, the web is Vite static plus Convex; hono appears only through dev tooling and package test harnesses (bun why hono). Re-read if a hono route ever ships.", owner: "release owner", reviewBy: "2026-12-23" },
  "@hono/node-server": { versions: "resolved with hono", modes: ["dev-only"], symbol: "request handling", untrustedInput: "no", decision: "not-reachable", evidence: "same as hono", owner: "release owner", reviewBy: "2026-12-23" },
  dompurify: { versions: "see bun why dompurify", modes: ["runtime-web"], symbol: "sanitiser bypass (mXSS) advisories", untrustedInput: "yes", decision: "fix-planned", evidence: "Renderer sanitisation is owned by the content worker (ct-53054, plan 003): canvasSanitize / HtmlSnippet decide what the sanitiser sees. The resolved copy must be at or above the advisory's fixed version before the plan closes; that worker owns the bump and its browser verification.", owner: "content worker (ct-53054)", reviewBy: "2026-10-15" },
  "markdown-it": { versions: "see bun why markdown-it", modes: ["runtime-web"], symbol: "linkify / reference parsing", untrustedInput: "yes", decision: "fix-planned", evidence: "Markdown rendering of agent output is the content worker's surface (plan 003). Bump alongside dompurify with browser verification.", owner: "content worker (ct-53054)", reviewBy: "2026-10-15" },
  "linkify-it": { versions: "with markdown-it", modes: ["runtime-web"], symbol: "link detection", untrustedInput: "yes", decision: "fix-planned", evidence: "same as markdown-it", owner: "content worker (ct-53054)", reviewBy: "2026-10-15" },
  mermaid: { versions: "see bun why mermaid", modes: ["runtime-web"], symbol: "diagram rendering from untrusted text", untrustedInput: "yes", decision: "fix-planned", evidence: "Mermaid renders agent output inside the web app; plan 003 content worker owns the sink and the bump.", owner: "content worker (ct-53054)", reviewBy: "2026-10-15" },
  "highlight.js": { versions: "see bun why highlight.js", modes: ["runtime-web"], symbol: "ReDoS in language grammars", untrustedInput: "yes", decision: "accepted-risk", evidence: "Highlighting runs in the viewer's own browser tab on content the viewer chose to open; a pathological block stalls that tab only. No server side highlighting. Re-read if highlighting ever moves server side.", owner: "release owner", reviewBy: "2026-12-23" },
  prismjs: { versions: "see bun why prismjs", modes: ["runtime-web"], symbol: "ReDoS in language grammars", untrustedInput: "yes", decision: "accepted-risk", evidence: "same reasoning as highlight.js: client side only, viewer's own tab.", owner: "release owner", reviewBy: "2026-12-23" },
  "react-router": { versions: "7.14.2", modes: ["runtime-web"], symbol: "client routing: open redirect via a backslash in <Link>/useNavigate (fixed 7.18.0); the RSC, manifest and SSR advisories concern server paths we do not run", untrustedInput: "indirect", decision: "fix-planned", evidence: "The web app is a client rendered SPA (no SSR, no RSC, no server loaders), so the DoS, CSRF and deserializeErrors rows do not apply. The backslash open redirect does apply wherever a navigation target comes from data (share links, deep links). Bump to >=7.18.2 in the next web release; verify the tab shell's route adoption still holds (tab_shell_routing traps).", owner: "release owner (jx7f70q)", reviewBy: "2026-10-15" },
  undici: { versions: "see bun why undici", modes: ["dev-only", "build-only"], symbol: "fetch client advisories", untrustedInput: "no", decision: "not-reachable", evidence: "Runtime fetch is bun's own in the CLI and Convex's runtime on the backend; undici resolves only under node based tooling (electron-builder, expo, vite plugins).", owner: "release owner", reviewBy: "2026-12-23" },
  tar: { versions: "see bun why tar", modes: ["build-only"], symbol: "path traversal on extraction", untrustedInput: "no", decision: "not-reachable", evidence: "Only build tooling (electron-builder, expo prebuild) extracts archives it downloaded itself; no user supplied archive is ever extracted at runtime.", owner: "release owner", reviewBy: "2026-12-23" },
  tmp: { versions: "see bun why tmp", modes: ["build-only", "dev-only"], symbol: "symlink temp dir", untrustedInput: "no", decision: "not-reachable", evidence: "dev tooling only", owner: "release owner", reviewBy: "2026-12-23" },
  "form-data": { versions: "see bun why form-data", modes: ["dev-only"], symbol: "boundary randomness", untrustedInput: "no", decision: "not-reachable", evidence: "resolved under node tooling; runtime uploads use the platform FormData", owner: "release owner", reviewBy: "2026-12-23" },
  "ip-address": { versions: "see bun why ip-address", modes: ["build-only"], symbol: "IP parsing", untrustedInput: "no", decision: "not-reachable", evidence: "under electron-builder / socks tooling only", owner: "release owner", reviewBy: "2026-12-23" },
  uuid: { versions: "see bun why uuid", modes: ["dev-only"], symbol: "predictable v1 ids", untrustedInput: "no", decision: "not-reachable", evidence: "we use crypto.randomUUID / nanoid for identifiers; uuid resolves under tooling", owner: "release owner", reviewBy: "2026-12-23" },
  nanoid: { versions: "see bun why nanoid", modes: ["runtime-web", "runtime-backend"], symbol: "predictable ids when a non-integer size is passed", untrustedInput: "no", decision: "not-reachable", evidence: "no call site passes a caller controlled size; grep nanoid( in packages shows constant sizes only", owner: "release owner", reviewBy: "2026-12-23" },
  "shell-quote": { versions: "see bun why shell-quote", modes: ["dev-only"], symbol: "quote() injection", untrustedInput: "no", decision: "not-reachable", evidence: "dev tooling; the CLI never builds shell strings from untrusted data (update.ts moved to argv on 2026-09-23)", owner: "release owner", reviewBy: "2026-12-23" },
  "fast-uri": { versions: "see bun why fast-uri", modes: ["dev-only"], symbol: "URI parsing", untrustedInput: "no", decision: "not-reachable", evidence: "ajv tooling chain only", owner: "release owner", reviewBy: "2026-12-23" },
  protobufjs: { versions: "see bun why protobufjs", modes: ["dev-only"], symbol: "prototype pollution in reflection", untrustedInput: "no", decision: "not-reachable", evidence: "resolved under opentelemetry / tooling; no runtime protobuf decoding of untrusted bytes", owner: "release owner", reviewBy: "2026-12-23" },
  "image-size": { versions: "see bun why image-size", modes: ["build-only"], symbol: "malformed image DoS", untrustedInput: "no", decision: "not-reachable", evidence: "expo asset tooling only", owner: "release owner", reviewBy: "2026-12-23" },
  "js-yaml": { versions: "see bun why js-yaml", modes: ["build-only", "dev-only"], symbol: "prototype pollution on merge keys", untrustedInput: "no", decision: "not-reachable", evidence: "no runtime parsing of untrusted YAML; the desktop feed parser is our own line parser", owner: "release owner", reviewBy: "2026-12-23" },
  "@xmldom/xmldom": { versions: "see bun why @xmldom/xmldom", modes: ["build-only"], symbol: "XML parsing", untrustedInput: "no", decision: "not-reachable", evidence: "expo / plist tooling only", owner: "release owner", reviewBy: "2026-12-23" },
  "@tootallnate/once": { versions: "see bun why", modes: ["build-only"], symbol: "n/a", untrustedInput: "no", decision: "not-reachable", evidence: "electron-builder chain", owner: "release owner", reviewBy: "2026-12-23" },
  "app-builder-lib": { versions: "see bun why", modes: ["build-only"], symbol: "packaging", untrustedInput: "no", decision: "not-reachable", evidence: "electron-builder, build machine only", owner: "release owner", reviewBy: "2026-12-23" },
  "builder-util-runtime": { versions: "see bun why", modes: ["build-only"], symbol: "packaging", untrustedInput: "no", decision: "not-reachable", evidence: "electron-builder, build machine only", owner: "release owner", reviewBy: "2026-12-23" },
  "@babel/core": { versions: "see bun why", modes: ["build-only"], symbol: "compiler", untrustedInput: "no", decision: "not-reachable", evidence: "build time only", owner: "release owner", reviewBy: "2026-12-23" },
  "baseline-browser-mapping": { versions: "see bun why", modes: ["build-only"], symbol: "n/a", untrustedInput: "no", decision: "not-reachable", evidence: "browserslist tooling", owner: "release owner", reviewBy: "2026-12-23" },
  browserslist: { versions: "see bun why", modes: ["build-only"], symbol: "query ReDoS", untrustedInput: "no", decision: "not-reachable", evidence: "build time only", owner: "release owner", reviewBy: "2026-12-23" },
  "brace-expansion": { versions: "see bun why", modes: ["build-only", "dev-only"], symbol: "ReDoS", untrustedInput: "no", decision: "not-reachable", evidence: "glob tooling only", owner: "release owner", reviewBy: "2026-12-23" },
  "decode-uri-component": { versions: "see bun why", modes: ["build-only"], symbol: "DoS", untrustedInput: "no", decision: "not-reachable", evidence: "tooling only", owner: "release owner", reviewBy: "2026-12-23" },
  esbuild: { versions: "see bun why", modes: ["dev-only"], symbol: "dev server CORS (GHSA-67mh-4wv8-2f99)", untrustedInput: "no", decision: "accepted-risk", evidence: "the esbuild dev server is not what serves the app in dev (vite does), and never in prod; a developer's local port is the only exposure", owner: "release owner", reviewBy: "2026-12-23" },
  vite: { versions: "see bun why", modes: ["dev-only"], symbol: "dev server file access / websocket advisories", untrustedInput: "indirect", decision: "accepted-risk", evidence: "dev server on a developer machine bound to localhost:3200; production is a static build served by Railway. Local exposure only; the browser sandbox note in plan 004 covers the same machine boundary.", owner: "release owner", reviewBy: "2026-12-23" },
  postcss: { versions: "see bun why", modes: ["build-only"], symbol: "parser", untrustedInput: "no", decision: "not-reachable", evidence: "build time only", owner: "release owner", reviewBy: "2026-12-23" },
  "postcss-selector-parser": { versions: "see bun why", modes: ["build-only"], symbol: "parser", untrustedInput: "no", decision: "not-reachable", evidence: "build time only", owner: "release owner", reviewBy: "2026-12-23" },
  turbo: { versions: "see bun why", modes: ["dev-only"], symbol: "task runner", untrustedInput: "no", decision: "not-reachable", evidence: "repo task runner only", owner: "release owner", reviewBy: "2026-12-23" },
  "@opentelemetry/core": { versions: "see bun why", modes: ["dev-only"], symbol: "n/a", untrustedInput: "no", decision: "not-reachable", evidence: "tooling chain; no OTel exporter runs in shipped code", owner: "release owner", reviewBy: "2026-12-23" },
  "@tiptap/core": { versions: "see bun why", modes: ["runtime-web"], symbol: "editor HTML handling", untrustedInput: "indirect", decision: "fix-planned", evidence: "the composer is a tiptap editor; content it loads is the viewer's own draft, not another user's, so the exposure is self inflicted. Bump with the content worker's renderer pass.", owner: "content worker (ct-53054)", reviewBy: "2026-10-15" },
  fflate: { versions: "see bun why", modes: ["runtime-web", "dev-only"], symbol: "decompression bomb", untrustedInput: "indirect", decision: "accepted-risk", evidence: "used for client side unzip of artefacts the viewer chose; a bomb stalls the viewer's own tab. Re-read if fflate ever runs server side.", owner: "release owner", reviewBy: "2026-12-23" },
};

// bun audit exits 1 whenever it finds anything, so the exit code is not an error here.
const auditRun = spawnSync("bun", ["audit", "--json"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const auditText = (auditRun.stdout ?? "").trim() || "{}";
let audit: Record<string, Array<Record<string, unknown>>>;
try { audit = JSON.parse(auditText); } catch { audit = {}; }
writeFileSync(RAW, JSON.stringify(audit, null, 2) + "\n");

function why(pkg: string): string {
  try {
    return execSync(`bun why ${JSON.stringify(pkg)}`, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter((l) => !l.startsWith("[")).slice(0, 40).join("\n").trim();
  } catch { return "(bun why failed)"; }
}

const today = new Date().toISOString().slice(0, 10);
const packages = Object.keys(audit).sort();
const rows = packages.map((name) => {
  const advisories = audit[name] ?? [];
  const det = DETERMINATIONS[name];
  const tree = why(name);
  const resolved = [...new Set([...tree.matchAll(new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@([0-9][^\\s]*)`, "g"))].map((m) => m[1]))];
  const status = !det ? "untriaged" : det.reviewBy < today ? "expired" : det.decision;
  return {
    name, resolvedVersions: resolved, dependencyTree: tree,
    advisories: advisories.map((a) => ({ id: a.id, url: a.url, title: a.title, severity: a.severity, vulnerable_versions: a.vulnerable_versions })),
    determination: det ?? null, status,
  };
});
const summary = {
  generatedAt: new Date().toISOString(), bunVersion: execSync("bun --version", { encoding: "utf8" }).trim(),
  packages: rows.length, advisories: rows.reduce((n, r) => n + r.advisories.length, 0),
  bySeverity: Object.fromEntries(["critical", "high", "moderate", "low"].map((s) => [s, rows.reduce((n, r) => n + r.advisories.filter((a) => a.severity === s).length, 0)])),
  byStatus: Object.fromEntries(["fixed", "not-reachable", "accepted-risk", "fix-planned", "untriaged", "expired"].map((s) => [s, rows.filter((r) => r.status === s).length])),
};
const ledger = { summary, rows };
if (process.argv.includes("--check")) {
  const bad = rows.filter((r) => r.status === "untriaged" || r.status === "expired");
  if (bad.length) { console.error(`dependency triage: ${bad.map((r) => `${r.name} (${r.status})`).join(", ")}`); process.exit(1); }
  console.log("dependency triage: every flagged package has a live determination");
  process.exit(0);
}
writeFileSync(OUT_JSON, JSON.stringify(ledger, null, 2) + "\n");
const md = ["# Dependency advisory triage", "", `Generated ${summary.generatedAt} (bun ${summary.bunVersion}) by scripts/security/dependency-triage.ts from \`bun audit --json\`. A row's decision is a reading with evidence and an expiry; the raw audit output stays in plans/security-dependency-audit.json.`, "", `Packages: ${summary.packages}, advisories: ${summary.advisories}, by severity ${JSON.stringify(summary.bySeverity)}, by status ${JSON.stringify(summary.byStatus)}`, "", "| package | resolved | worst | decision | modes | untrusted input | owner | review by | evidence |", "|---|---|---|---|---|---|---|---|---|"];
const sevRank: Record<string, number> = { critical: 0, high: 1, moderate: 2, low: 3 };
for (const r of rows) {
  const worst = r.advisories.map((a) => String(a.severity)).sort((a, b) => (sevRank[a] ?? 9) - (sevRank[b] ?? 9))[0] ?? "";
  const d = r.determination;
  md.push(`| ${r.name} | ${r.resolvedVersions.join(", ")} | ${worst} | ${r.status} | ${d?.modes.join(", ") ?? ""} | ${d?.untrustedInput ?? ""} | ${d?.owner ?? ""} | ${d?.reviewBy ?? ""} | ${(d?.evidence ?? "").replace(/\|/g, "/")} |`);
}
writeFileSync(OUT_MD, md.join("\n") + "\n");
console.log(JSON.stringify(summary, null, 2));
