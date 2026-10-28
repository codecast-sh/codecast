// Installing kit skills, commands and subagents (docs/architecture/team-kit.md).
//
// Paths come from the item's kind and name only, never from the archive:
//   skill     ~/.agents/skills/<name>/...  plus a link ~/.claude/skills/<name>
//             (Codex and Cursor read ~/.agents/skills themselves; Claude Code
//             reaches it only through a link, agentClients.ts)
//   command   ~/.claude/commands/<name>.md
//   subagent  ~/.claude/agents/<name>.md
//
// Ownership is the ledger at ~/.codecast/capabilities/kit-files.json: every
// path this installer wrote, per slug. A target that exists and is not in the
// ledger belongs to someone else, and the whole item is a conflict: nothing of
// it is written, nothing of the other file is touched. Removal deletes exactly
// the ledger's paths, then the directories it emptied, never further up than
// the allowed root.
//
// plan and apply are driver.ts's ops; this module only decides which ops.

import * as fs from "fs";
import * as path from "path";
import { localAgentClient } from "@codecast/shared/contracts";
import { atomicWriteFile } from "../atomicWrite.js";
import { allowedRoots, apply, contentEqual, realTarget, type ApplyOutcome, type DriverLedger, type PlannedOp } from "./driver.js";
import { sharedSkillDir } from "./skills.js";
import type { StoreFile } from "./contentStore.js";

export type KitFileKind = "skill" | "command" | "subagent";

/** One enabled, consented, fetched version. */
export interface KitInstallItem {
  slug: string;
  kind: KitFileKind;
  name: string;
  hash: string;
  files: StoreFile[];
}

/* ==========================================================================
 * The ledger
 * ========================================================================== */

export function kitLedgerPath(home: string): string {
  return path.join(home, ".codecast", "capabilities", "kit-files.json");
}

export function readKitLedger(home: string): DriverLedger {
  try {
    const parsed = JSON.parse(fs.readFileSync(kitLedgerPath(home), "utf-8"));
    if (parsed && typeof parsed.files === "object" && parsed.files) return { files: parsed.files };
  } catch {
    // absent or torn: an empty ledger owns nothing, which is the safe reading
  }
  return { files: {} };
}

export function writeKitLedger(home: string, ledger: DriverLedger): void {
  fs.mkdirSync(path.dirname(kitLedgerPath(home)), { recursive: true });
  atomicWriteFile(kitLedgerPath(home), JSON.stringify({ files: ledger.files }, null, 2) + "\n", { mode: 0o600 });
}

/* ==========================================================================
 * Targets
 * ========================================================================== */

interface Target {
  abs: string;
  content?: string;
  /** Set for a file whose bytes are not UTF-8 text: written and compared raw. */
  bytes?: Buffer;
  mode?: number;
  /** A symlink to this directory instead of a file. */
  linkTo?: string;
}

function expandHome(p: string, home: string): string {
  return p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

/** Bytes that survive a UTF-8 decode unchanged are text; anything else (an
 *  image, a font, an archive) must reach the disk as the bytes themselves. */
function asTarget(abs: string, f: StoreFile, mode: number): Target {
  const text = f.bytes.toString("utf-8");
  return Buffer.from(text, "utf-8").equals(f.bytes) ? { abs, content: text, mode } : { abs, content: "", bytes: f.bytes, mode };
}

function claudeDir(slot: "skillsDir" | "agentsDir", home: string, fallback: string): string {
  const user = localAgentClient("claude").agentFileTargets?.[slot]?.user;
  return expandHome(user ?? fallback, home);
}

export function kitTargets(home: string, item: KitInstallItem): Target[] {
  if (item.kind === "skill") {
    const dir = sharedSkillDir(item.name, home);
    return [
      ...item.files.map((f) => asTarget(path.join(dir, ...f.path.split("/")), f, f.executable ? 0o755 : 0o644)),
      { abs: path.join(claudeDir("skillsDir", home, "~/.claude/skills"), item.name), linkTo: dir },
    ];
  }
  const main = item.files.find((f) => f.path === `${item.name}.md`) ?? item.files[0];
  const dir = item.kind === "command" ? path.join(home, ".claude", "commands") : claudeDir("agentsDir", home, "~/.claude/agents");
  return main ? [asTarget(path.join(dir, `${item.name}.md`), main, 0o644)] : [];
}

/* ==========================================================================
 * plan
 * ========================================================================== */

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Removal order: deepest first, so a directory's files go before it. */
function removals(slug: string, paths: string[]): PlannedOp[] {
  return [...paths]
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length || (a < b ? 1 : -1))
    .map((p) => ({ op: "remove" as const, path: p, slug }));
}

/** Where a person's skill directory goes when they choose the kit's copy:
 *  outside every skills dir, so no client keeps loading it as a second skill
 *  of the same name. */
export function kitAsideRoot(home: string): string {
  return path.join(home, ".codecast", "capabilities", "aside");
}

/**
 * The new name for something moved out of the way, `<name>.mine-<yyyymmddhhmm>`
 * in local time with a counter when taken. A skill (an entry directly inside
 * a skills dir) moves to kitAsideRoot; a command or subagent file, or a file
 * inside a skill folder, is renamed beside itself, where its new name no
 * longer ends in `.md` and nothing loads it.
 */
export function asideName(p: string, now: Date, home: string, skillsDirs: readonly string[]): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}`;
  const dir = skillsDirs.includes(path.dirname(p)) ? kitAsideRoot(home) : path.dirname(p);
  const base = path.join(dir, `${path.basename(p)}.mine-${stamp}`);
  let candidate = base;
  for (let n = 2; lstatOrNull(candidate); n++) candidate = `${base}-${n}`;
  return candidate;
}

export interface PlanKitOptions {
  /** Slugs whose owner chose the kit's copy for the version being installed:
   *  what stands in the way is moved aside instead of reported. */
  adopt?: ReadonlySet<string>;
  /** The clock that names a moved-aside path. */
  now?: Date;
}

/**
 * The ops that make the kit files on this machine match `items`.
 * `hold` names slugs still wanted whose version could not be resolved this
 * pass (fetch failed, waiting on consent): their files stay exactly as they are.
 */
export function planKit(home: string, items: KitInstallItem[], ledger: DriverLedger, hold: string[] = [], opts: PlanKitOptions = {}): PlannedOp[] {
  const roots = allowedRoots(home).map(realOrSelf);
  const inRoots = (abs: string) => roots.some((r) => abs.startsWith(r + path.sep));
  const ops: PlannedOp[] = [];

  for (const item of items) {
    const mine = new Set((ledger.files[item.slug] ?? []).map(realTarget));
    const targets = kitTargets(home, item).map((t) => ({ ...t, abs: realTarget(t.abs), linkTo: t.linkTo && realTarget(t.linkTo) }));
    const conflicts: PlannedOp[] = [];
    const conflict = (reason: string, detail: string) => conflicts.push({ op: "conflict", slug: item.slug, reason, detail });
    // What stands in the way: someone else's file, or their whole skill
    // directory when none of it is ours.
    const blockers = new Set<string>();
    const skillDir = item.kind === "skill" ? realTarget(sharedSkillDir(item.name, home)) : undefined;
    const dirOwned = !!skillDir && [...mine].some((p) => p.startsWith(skillDir + path.sep));
    const notOurs = (p: string) => `${p} exists and codecast did not write it; rename or remove it to install ${item.kind} ${item.name}`;

    for (const t of targets) {
      if (!inRoots(t.abs)) {
        conflict("path_outside_roots", `${t.abs} is outside every allowed root`);
        continue;
      }
      const st = lstatOrNull(t.abs);
      if (!st || mine.has(t.abs)) continue;
      // A link that already points at our own content dir is ours in effect.
      if (t.linkTo && st.isSymbolicLink() && realOrSelf(t.abs) === realOrSelf(t.linkTo)) continue;
      blockers.add(skillDir && !dirOwned && t.abs.startsWith(skillDir + path.sep) ? skillDir : t.abs);
    }
    if (skillDir && !dirOwned && lstatOrNull(skillDir)) blockers.add(skillDir);

    const adopting = opts.adopt?.has(item.slug) ?? false;
    if (!adopting) for (const b of blockers) conflict("not_ours", notOurs(b));
    if (conflicts.length) {
      ops.push(...conflicts);
      continue;
    }
    // Adopted: the person's copy is renamed, never deleted, and the paths it
    // held are planned as empty.
    const now = opts.now ?? new Date();
    const skillsDirs = [realTarget(path.dirname(sharedSkillDir(item.name, home))), realTarget(claudeDir("skillsDir", home, "~/.claude/skills"))];
    const taken = new Set<string>();
    for (const b of blockers) {
      // Two blockers with one name (both skills dirs hold "deploy") must not
      // be planned onto the same aside path.
      let to = asideName(b, now, home, skillsDirs);
      for (let n = 2; taken.has(to); n++) to = `${asideName(b, now, home, skillsDirs)}-${n}`;
      taken.add(to);
      ops.push({ op: "move_aside", path: b, to, slug: item.slug });
    }
    const gone = (p: string) => [...blockers].some((b) => p === b || p.startsWith(b + path.sep));
    const lstatHere = (p: string) => (gone(p) ? null : lstatOrNull(p));

    const wanted = new Set<string>();
    for (const t of targets) {
      wanted.add(t.abs);
      const st = lstatHere(t.abs);
      if (t.linkTo) {
        const right = st?.isSymbolicLink() && realOrSelf(t.abs) === realOrSelf(t.linkTo);
        if (!right || !mine.has(t.abs)) ops.push({ op: "symlink", path: t.abs, target: t.linkTo, slug: item.slug });
        continue;
      }
      let existing: Buffer | undefined;
      try {
        existing = st ? fs.readFileSync(t.abs) : undefined;
      } catch {
        existing = undefined;
      }
      const same = existing !== undefined && (t.bytes ? existing.equals(t.bytes) : contentEqual(existing.toString("utf-8"), t.content!, t.abs));
      const execOk = !st || ((st.mode & 0o111) !== 0) === ((t.mode! & 0o111) !== 0);
      if (same && execOk && mine.has(t.abs)) continue;
      ops.push({ op: "write_file", path: t.abs, content: t.content!, ...(t.bytes ? { bytes: t.bytes } : {}), mode: t.mode, slug: item.slug });
    }
    // A file the previous version had and this one does not.
    ops.push(...removals(item.slug, [...mine].filter((p) => !wanted.has(p))));
  }

  const keep = new Set([...items.map((i) => i.slug), ...hold]);
  for (const [slug, paths] of Object.entries(ledger.files)) {
    if (!keep.has(slug)) ops.push(...removals(slug, paths.map(realTarget)));
  }
  return ops;
}

/* ==========================================================================
 * apply
 * ========================================================================== */

/** driver.apply, then the directories removal emptied, up to the root. */
export function applyKit(home: string, ops: PlannedOp[], ledger: DriverLedger): ApplyOutcome {
  // A file whose exec bit must drop is rewritten fresh: the harness writer
  // keeps an existing file's mode.
  for (const op of ops) {
    if (op.op === "write_file" && op.mode !== undefined && (op.mode & 0o111) === 0) {
      try {
        if ((fs.statSync(op.path).mode & 0o111) !== 0) fs.chmodSync(op.path, op.mode);
      } catch {
        // absent: the write creates it with op.mode
      }
    }
  }
  const outcome = apply(ops, ledger);
  const roots = new Set(allowedRoots(home).map(realOrSelf));
  for (const removed of ops.filter((o) => o.op === "remove")) {
    let dir = path.dirname(removed.path);
    while (!roots.has(dir) && [...roots].some((r) => dir.startsWith(r + path.sep))) {
      try {
        if (fs.readdirSync(dir).length > 0) break;
        fs.rmdirSync(dir);
      } catch {
        // already gone: keep climbing, the parent may now be empty
      }
      dir = path.dirname(dir);
    }
  }
  return outcome;
}

