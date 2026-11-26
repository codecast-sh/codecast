// The personal flow's Check station (templates/personal.cast, flows.md FL4):
// runs the commands Find check read from the project's docs, each in the
// change's tree, and says what they did. Green only when every command exited
// 0; Skipped only when Find check said the docs name no check. A command that
// would run outside the tree (a directory outside it, a `cd` out of it, the
// person's checkout named by path) is never run: the whole answer is refused,
// since a check of the person's checkout says nothing about the change.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "../proc.js";

export type CheckCommand = { run: string; cwd: string; source: string };
export type CheckResult = CheckCommand & { exit: number; tail: string };
export type CheckReport = { outcome: "pass" | "fail" | "skipped"; note: string; results: CheckResult[] };

// The end of each command's output the report carries; the whole of it stays in its log.
const TAIL_LINES = 40;
const TAIL_CHARS = 3000;

/** Find check's pinned answer, or why it cannot be read. */
export function readCheckSpec(text: string): { outcome: "found" | "skipped"; note: string; commands: CheckCommand[] } | string {
  let spec: any;
  try { spec = JSON.parse(text); } catch { return "Find check's answer is not JSON"; }
  if (!spec || typeof spec !== "object" || (spec.outcome !== "found" && spec.outcome !== "skipped")) return "Find check's answer says neither found nor skipped";
  const commands = (Array.isArray(spec.commands) ? spec.commands : [])
    .filter((c: any) => c && typeof c.run === "string" && c.run.trim())
    .map((c: any) => ({ run: c.run.trim(), cwd: typeof c.cwd === "string" && c.cwd.trim() ? c.cwd.trim() : ".", source: typeof c.source === "string" ? c.source : "" }));
  return { outcome: spec.outcome, note: typeof spec.note === "string" ? spec.note : "", commands };
}

const inside = (tree: string, p: string) => { const r = path.relative(tree, p); return r === "" || (!r.startsWith("..") && !path.isAbsolute(r)); };

/** Where a command runs, under the change's tree; null when its directory is not a relative path inside the tree. */
export function commandDir(tree: string, cwd: string): string | null {
  if (path.isAbsolute(cwd) || cwd.startsWith("~")) return null;
  const at = path.resolve(tree, cwd);
  return inside(tree, at) ? at : null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `p` as a whole path in a command: not the start of a longer name (app is not app2), and not inside one. */
const pathIn = (p: string) => new RegExp(`(?<![\\w.-])${escapeRe(p)}(?=$|[/\\s'"\`;&|)}])`);

/**
 * Why a command must not run in the tree, or null when it may: it names the person's checkout by path (`~`, `$HOME`,
 * `${HOME}` and `"$HOME"` read as the home directory; the tree itself sits under the checkout, and is fine to name), or
 * it `cd`s or `pushd`es anywhere but a directory inside the tree, a quoted `bash -c "cd .."` included.
 */
export function commandEscapes(run: string, tree: string, at: string, checkout: string | null): string | null {
  const home = os.homedir();
  const norm = run.replace(/"\$\{?HOME\}?"|\$\{HOME\}|\$HOME\b|(?<=^|[\s=:'"(])~(?=\/|$|[\s'"])/g, home);
  if (checkout && pathIn(checkout).test(norm.split(tree).join(""))) return `it names the person's checkout, ${checkout}`;
  for (const m of norm.matchAll(/(?:^|[;&|({\s"'`])(?:cd|pushd)(?=$|[\s;&|)'"`$])([^;&|)\n]*)/g)) {
    const words = m[1].trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^["']+|["']+$/g, ""));
    const to = words.find((w) => w === "-" || !/^-[-A-Za-z@]*$/.test(w)) ?? "";
    const where = !to || to === "-" || /^[~$`]/.test(to) ? null : path.resolve(at, to);
    if (!where || !inside(tree, where)) return `it changes directory to ${to || "the home directory"}, outside the change's tree`;
  }
  return null;
}

function tailOf(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  const tail = lines.slice(-TAIL_LINES).join("\n");
  return tail.length > TAIL_CHARS ? tail.slice(tail.length - TAIL_CHARS) : tail;
}

/** Run the check in `tree`, leave check.json and each command's log (check-<n>.log) in `dir`, and return the report. */
export function runCheck(opts: { spec: string; tree: string; dir: string }): CheckReport | string {
  const spec = readCheckSpec(opts.spec);
  if (typeof spec === "string") return spec;
  fs.mkdirSync(opts.dir, { recursive: true });
  let report: CheckReport;
  if (spec.outcome === "skipped") {
    report = { outcome: "skipped", note: spec.note || "Find check found no documented check", results: [] };
  } else {
    if (!spec.commands.length) return "Find check said it found the check but named no command to run";
    const common = spawnSync("git", ["-C", opts.tree, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf-8" });
    const checkout = common.status === 0 ? path.dirname(String(common.stdout).trim()) : null;
    const dirs: string[] = [];
    for (const c of spec.commands) {
      const at = commandDir(opts.tree, c.cwd);
      const why = at === null ? `its directory ${c.cwd} is not inside the change's tree` : commandEscapes(c.run, opts.tree, at, checkout);
      if (why) return `Refused to run \`${c.run}\`${c.source ? ` (${c.source})` : ""}: ${why}. Find check gives commands that run inside the change's tree.`;
      dirs.push(at!);
    }
    const results = spec.commands.map((c, i): CheckResult => {
      const log = path.join(opts.dir, `check-${i + 1}.log`);
      const at = dirs[i];
      if (!fs.existsSync(at)) {
        fs.writeFileSync(log, `no directory ${at}\n`);
        return { ...c, exit: 127, tail: `no directory ${at}` };
      }
      const fd = fs.openSync(log, "w");
      try {
        const r = spawnSync("bash", ["-c", c.run], { cwd: at, stdio: ["ignore", fd, fd] });
        return { ...c, exit: r.status ?? 1, tail: "" };
      } finally {
        fs.closeSync(fd);
      }
    }).map((r, i) => ({ ...r, tail: r.tail || tailOf(fs.readFileSync(path.join(opts.dir, `check-${i + 1}.log`), "utf-8")) }));
    const failed = results.filter((r) => r.exit !== 0);
    const each = results.map((r) => `${r.run} ${r.exit === 0 ? "passed" : `exited ${r.exit}`}${r.source ? ` (${r.source})` : ""}`).join(" · ");
    report = { outcome: failed.length ? "fail" : "pass", note: each, results };
  }
  fs.writeFileSync(path.join(opts.dir, "check.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
