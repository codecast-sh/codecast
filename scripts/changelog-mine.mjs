#!/usr/bin/env node
/**
 * changelog-mine — surface the raw material for a changelog entry from git.
 *
 * The public changelog at /changelog (and the root CHANGELOG.md) is a *curated*
 * layer: prose written for humans, not raw commit subjects. This script keeps
 * that layer honest and easy to refresh — it pulls a period's real release
 * boundaries (version bumps) and clusters its feature/fix commits by area, so
 * you can see exactly what shipped and write or extend the matching entry in
 * `packages/web/app/(marketing)/changelog/changelogData.ts`.
 *
 * Usage:
 *   node scripts/changelog-mine.mjs                 # current calendar month
 *   node scripts/changelog-mine.mjs 2026-06         # a specific month
 *   node scripts/changelog-mine.mjs --since 2026-06-12   # since a date (inclusive)
 *   node scripts/changelog-mine.mjs 2026-04 2026-06 # an inclusive month range
 *
 * No dependencies — just git.
 */
import { execSync } from "node:child_process";

const git = (args) =>
  execSync(`git ${args}`, { cwd: process.cwd(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// ── parse args ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
let since, until, label;

const monthBounds = (ym) => {
  const [y, m] = ym.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { from: `${ym}-01`, to: next };
};

if (argv[0] === "--since") {
  since = argv[1];
  until = "now";
  label = `since ${since}`;
} else if (/^\d{4}-\d{2}$/.test(argv[0] || "") && /^\d{4}-\d{2}$/.test(argv[1] || "")) {
  since = monthBounds(argv[0]).from;
  until = monthBounds(argv[1]).to;
  label = `${argv[0]} … ${argv[1]}`;
} else if (/^\d{4}-\d{2}$/.test(argv[0] || "")) {
  const b = monthBounds(argv[0]);
  since = b.from;
  until = b.to;
  label = argv[0];
} else {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const b = monthBounds(ym);
  since = b.from;
  until = "now";
  label = `${ym} (current month)`;
}

const range = `--since=${since} ${until !== "now" ? `--until=${until}` : ""}`;

// ── collect commits ──────────────────────────────────────────────────────────
const raw = git(`log ${range} --reverse --no-merges --date=short --format=%ad%x1f%h%x1f%s`)
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    const [date, hash, subject] = l.split("\x1f");
    return { date, hash, subject };
  });

// ── releases (version bumps) ─────────────────────────────────────────────────
const releaseRe = /(bump version to|release v?|bump .*(dmg|download).* to)\s*v?([\d.]+)/i;
const releases = raw
  .map((c) => {
    const m = c.subject.match(releaseRe);
    if (!m) return null;
    const scope = (c.subject.match(/\((cli|electron|web|mobile|desktop)\)/i) || [])[1] || "?";
    return { date: c.date, scope: scope.toLowerCase(), version: m[3] };
  })
  .filter(Boolean);

const highest = {};
for (const r of releases) {
  const cur = highest[r.scope];
  if (!cur || cmpVer(r.version, cur.version) > 0) highest[r.scope] = r;
}
function cmpVer(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// ── cluster substantive commits by scope ─────────────────────────────────────
const NOISE = /(bump version|tsbuildinfo|^chore:|gitignore|prettier|eslint|lint|snapshot|wip|typo|^docs?:|^test:|^ci:|^build:|^style:|merge branch|bump .*(dmg|download))/i;
const TYPE_RE = /^(feat|fix|perf|refactor)(\(([^)]+)\))?(!)?:\s*(.*)$/;

const buckets = new Map();
let counted = 0;
for (const c of raw) {
  if (NOISE.test(c.subject)) continue;
  const m = c.subject.match(TYPE_RE);
  if (!m) continue;
  const type = m[1];
  if (type === "refactor") continue; // rarely user-facing
  const scope = (m[3] || "general").toLowerCase().split(/[,/]/)[0].trim();
  const text = m[5].trim();
  if (!buckets.has(scope)) buckets.set(scope, []);
  buckets.get(scope).push({ type, text, date: c.date, hash: c.hash });
  counted++;
}

const orderedScopes = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);

// ── print digest ─────────────────────────────────────────────────────────────
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

console.log("");
console.log(bold(`Changelog material — ${label}`));
console.log(dim(`${raw.length} commits, ${counted} substantive (feat/fix/perf)`));
console.log("");

console.log(bold("Releases in period:"));
if (releases.length === 0) {
  console.log("  (no version bumps)");
} else {
  const span = {};
  for (const r of releases) {
    span[r.scope] ||= { first: r, last: r };
    span[r.scope].last = r;
  }
  for (const [scope, s] of Object.entries(span)) {
    const range =
      s.first.version === s.last.version
        ? `v${s.last.version}`
        : `v${s.first.version} – v${s.last.version}`;
    console.log(`  ${scope.padEnd(9)} ${range}  ${dim(`(${s.first.date} … ${s.last.date})`)}`);
  }
}
console.log("");

console.log(bold("Work by area (most active first):"));
for (const [scope, items] of orderedScopes) {
  console.log("");
  console.log(`  ${bold(scope)} ${dim(`(${items.length})`)}`);
  for (const it of items) {
    const tag = it.type === "fix" ? "fix " : it.type === "perf" ? "perf" : "feat";
    console.log(`    ${dim(tag)} ${it.text}  ${dim(it.hash)}`);
  }
}
console.log("");
console.log(
  dim(
    "→ Now write/extend the entry in packages/web/app/(marketing)/changelog/changelogData.ts.\n" +
      "  Group these into a few topical sections, and say in plain language what each change does for the user."
  )
);
console.log("");
