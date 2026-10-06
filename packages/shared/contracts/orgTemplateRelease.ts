// What a template release changes, and what that means for the roles hired
// from it (docs/architecture/org-hire.md, As built 2026-10-06). Pure, so the
// server (publish, the role page's update offer, the note a role hears when
// its release moves), the CLI and the tests read one definition.
//
// A release is classified by diffing its manifest against the release before
// it, never by trusting its author: content (files only), structure
// (routines, inputs, setup, evidence, ledgers, scoreboard) or authority (caps,
// authority, routine modes, the line, the role's name and handle). The class
// sets the smallest version bump publish accepts.

import { compareVersions, type OrgTemplate, type TemplateRoutine } from "./orgTemplateManifest";

export type ReleaseClass = "content" | "structure" | "authority";
export const RELEASE_CLASSES: ReleaseClass[] = ["content", "structure", "authority"];
export type VersionBump = "major" | "minor" | "patch" | "none";
/** The smallest bump each class needs. */
export const REQUIRED_BUMP: Record<ReleaseClass, Exclude<VersionBump, "none">> = { content: "patch", structure: "minor", authority: "major" };
const BUMP_RANK: Record<VersionBump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

export type Keyed<T> = { added: T[]; removed: T[]; changed: string[] };
export type ReleaseChanges = {
  routines: Keyed<{ id: string; title: string; every: string }> & { recadenced: Array<{ id: string; title: string; before: string; after: string }>; mode: Array<{ id: string; title: string; before: string; after: string }> };
  inputs: Keyed<{ key: string; label: string; kind: string; required: boolean }>;
  setup: Keyed<{ id: string; title: string; who: "human" | "role" }>;
  evidence: Keyed<{ id: string; title: string }>;
  ledgers: Keyed<{ id: string; title: string }>;
  scoreboard: Keyed<{ key: string; label: string }>;
  authority: Keyed<{ id: string; label: string; kind: string }>;
  /** Role fields that changed: caps, name, handle, line (authority); avatar, tenure, charter (structure). */
  role: string[];
  /** Other manifest fields that changed: name, description, learn, instance_file, schemaVersion. */
  other: string[];
};
export type ReleaseClassification = { class: ReleaseClass; changes: ReleaseChanges; /** Each change that set the class, in plain words: what publish names when it refuses a bump. */ why: string[] };

/** Key-order independent equality, for manifest values (plain JSON). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as object).sort().filter((k) => (value as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

function keyed<T extends Record<string, any>, O>(prev: T[] | undefined, next: T[] | undefined, key: keyof T, view: (item: T) => O, ignore: string[] = []): Keyed<O> {
  const before = new Map((prev ?? []).map((item) => [String(item[key]), item]));
  const after = new Map((next ?? []).map((item) => [String(item[key]), item]));
  const strip = (item: T) => Object.fromEntries(Object.entries(item).filter(([k]) => !ignore.includes(k)));
  return {
    added: [...after].filter(([id]) => !before.has(id)).map(([, item]) => view(item)),
    removed: [...before].filter(([id]) => !after.has(id)).map(([, item]) => view(item)),
    changed: [...after].filter(([id, item]) => before.has(id) && !same(strip(before.get(id)!), strip(item))).map(([id]) => id),
  };
}

const EMPTY: OrgTemplate = { schemaVersion: 2, id: "", version: "0.0.0", name: "", description: "", role: { name: "", handle: "", charter: "", caps: { hands_per_day: 0, wakes_per_day: 0, tokens_per_day: 0 } }, routines: [] };

/**
 * Classify `next` against `prev`, the release before it by version. The first
 * release (no `prev`) is structure: everything it declares is new.
 */
export function classifyRelease(prev: OrgTemplate | null, next: OrgTemplate): ReleaseClassification {
  const p = prev ?? EMPTY;
  const routine = (r: TemplateRoutine) => ({ id: r.id, title: r.title, every: r.every });
  const routines = keyed(p.routines, next.routines, "id", routine, ["every", "mode"]);
  const before = new Map(p.routines.map((r) => [r.id, r]));
  const both = next.routines.filter((r) => before.has(r.id));
  const changes: ReleaseChanges = {
    routines: {
      ...routines,
      recadenced: both.filter((r) => before.get(r.id)!.every !== r.every).map((r) => ({ id: r.id, title: r.title, before: before.get(r.id)!.every, after: r.every })),
      mode: both.filter((r) => (before.get(r.id)!.mode ?? "propose") !== (r.mode ?? "propose")).map((r) => ({ id: r.id, title: r.title, before: before.get(r.id)!.mode ?? "propose", after: r.mode ?? "propose" })),
    },
    inputs: keyed(p.inputs, next.inputs, "key", (i) => ({ key: i.key, label: i.label, kind: i.kind, required: !!i.required })),
    setup: keyed(p.setup, next.setup, "id", (s) => ({ id: s.id, title: s.title, who: s.who })),
    evidence: keyed(p.evidence, next.evidence, "id", (e) => ({ id: e.id, title: e.title })),
    ledgers: keyed(p.ledgers, next.ledgers, "id", (l) => ({ id: l.id, title: l.title })),
    scoreboard: keyed(p.scoreboard, next.scoreboard, "key", (s) => ({ key: s.key, label: s.label })),
    authority: keyed(p.authority, next.authority, "id", (a) => ({ id: a.id, label: a.label, kind: a.kind })),
    role: (["caps", "name", "handle", "line", "avatar", "tenure", "charter"] as const).filter((k) => !same(p.role[k], next.role[k])),
    other: (["name", "description", "learn", "instance_file", "schemaVersion"] as const).filter((k) => !same(p[k], next[k])),
  };
  if (!prev) return { class: "structure", changes, why: ["the first release"] };

  const authority: string[] = [];
  for (const k of changes.role.filter((k) => ["caps", "name", "handle", "line"].includes(k))) authority.push(`role ${k} changed`);
  for (const a of changes.authority.added) authority.push(`authority ${a.id} added`);
  for (const a of changes.authority.removed) authority.push(`authority ${a.id} removed`);
  for (const id of changes.authority.changed) authority.push(`authority ${id} changed`);
  for (const m of changes.routines.mode) authority.push(`routine ${m.id} mode ${m.before} → ${m.after}`);
  if (authority.length) return { class: "authority", changes, why: authority };

  const structure: string[] = [];
  const list = (what: string, k: Keyed<any>, id: (x: any) => string) => {
    for (const x of k.added) structure.push(`${what} ${id(x)} added`);
    for (const x of k.removed) structure.push(`${what} ${id(x)} removed`);
    for (const x of k.changed) structure.push(`${what} ${x} changed`);
  };
  list("routine", changes.routines, (r) => r.id);
  for (const r of changes.routines.recadenced) structure.push(`routine ${r.id} every ${r.before} → ${r.after}`);
  list("input", changes.inputs, (i) => i.key);
  list("setup", changes.setup, (s) => s.id);
  list("evidence", changes.evidence, (e) => e.id);
  list("ledger", changes.ledgers, (l) => l.id);
  list("scoreboard", changes.scoreboard, (s) => s.key);
  for (const k of changes.role) structure.push(`role ${k} changed`);
  for (const k of changes.other) structure.push(`${k} changed`);
  if (structure.length) return { class: "structure", changes, why: structure };
  return { class: "content", changes, why: ["only files changed: the manifest is the same but for its version"] };
}

/** How `next` moves from `prev`: which of major, minor or patch it raises, or none when it is not newer. */
export function versionBump(prev: string, next: string): VersionBump {
  if (compareVersions(next, prev) <= 0) return "none";
  const [a, b] = [prev.split(".").map(Number), next.split(".").map(Number)];
  return b[0]! > a[0]! ? "major" : b[1]! > a[1]! ? "minor" : "patch";
}
export function bumpVersion(version: string, bump: Exclude<VersionBump, "none">): string {
  const [major, minor, patch] = version.split(".").map(Number) as [number, number, number];
  return bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}
/** Null when the bump is big enough for the class; else the refusal publish raises, naming the change that forced the class. */
export function bumpRefusal(templateId: string, prevVersion: string | null, next: OrgTemplate, c: ReleaseClassification): string | null {
  if (!prevVersion) return null;
  const need = REQUIRED_BUMP[c.class], got = versionBump(prevVersion, next.version);
  if (BUMP_RANK[got] >= BUMP_RANK[need]) return null;
  const shown = c.why.slice(0, 5).join("; ") + (c.why.length > 5 ? `; and ${c.why.length - 5} more` : "");
  return `${templateId}@${next.version} is a ${c.class} release (${shown}), so it needs a ${need} version bump over ${prevVersion}; ${next.version} is ${got === "none" ? "not newer" : `a ${got} bump`}. Publish it as ${bumpVersion(prevVersion, need)} or later.`;
}

export type ReleaseLike = { version: string; digest: string; status: string; manifest: OrgTemplate; changelog?: string | null; class?: ReleaseClass; changes?: ReleaseChanges; why?: string[]; yanked?: { reason: string; at: number } | null };
/** The release just below `version` by version order, or null for the first. */
export function previousRelease<R extends { version: string }>(releases: R[], version: string): R | null {
  return releases.filter((r) => compareVersions(r.version, version) < 0).sort((a, b) => compareVersions(a.version, b.version)).at(-1) ?? null;
}
/** Every release with its class: the stored one, else computed against the release before it (releases published before classification). */
export function withClasses<R extends ReleaseLike>(releases: R[]): Array<R & ReleaseClassification> {
  return releases.map((r) => {
    if (r.class && r.changes && r.why) return r as R & ReleaseClassification;
    return { ...r, ...classifyRelease(previousRelease(releases, r.version)?.manifest ?? null, r.manifest) };
  });
}

/**
 * A changelog as its `## <version>` sections. A changelog with no version
 * headings is one section, filed under `fallback` (the release it came with).
 */
export function changelogSections(text: string | null | undefined, fallback?: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!text?.trim()) return out;
  const parts = text.split(/^##\s+v?(\d+\.\d+\.\d+)\b.*$/m);
  if (parts.length === 1) { if (fallback) out.set(fallback, text.trim()); return out; }
  for (let i = 1; i < parts.length; i += 2) if (!out.has(parts[i]!)) out.set(parts[i]!, parts[i + 1]!.trim());
  return out;
}
export type ChangelogSection = { version: string; class: ReleaseClass; changelog: string | null; yanked: string | null };
/**
 * The changelog of every release after `from` up to and including `to`, oldest
 * first (for a rollback, `to` is older: the releases being undone, newest
 * first). Each version's words come from the newest changelog that has a
 * section for it, else from its own release's changelog.
 */
export function changelogBetween(releases: ReleaseLike[], from: string, to: string): ChangelogSection[] {
  const forward = compareVersions(to, from) >= 0;
  const [lo, hi] = forward ? [from, to] : [to, from];
  const classed = withClasses(releases);
  const span = classed.filter((r) => compareVersions(r.version, lo) > 0 && compareVersions(r.version, hi) <= 0).sort((a, b) => compareVersions(a.version, b.version));
  const newestFirst = [...classed].sort((a, b) => compareVersions(b.version, a.version)).map((r) => changelogSections(r.changelog, r.version));
  const rows = span.map((r) => ({ version: r.version, class: r.class, changelog: newestFirst.map((s) => s.get(r.version)).find(Boolean) ?? r.changelog?.trim() ?? null, yanked: r.yanked?.reason ?? null }));
  return forward ? rows : rows.reverse();
}

export type UpdatePolicy = "manual" | "canary" | "stable";
export type UpdateOffer = {
  /** The release offered, or null. */
  to: ReleaseLike | null;
  /** The instance's own release was yanked; the offer replaces it (usually an older release). */
  yanked: string | null;
  rollback: boolean;
  /** Newer non-yanked, non-draft releases than the instance's. */
  behind: number;
};
/**
 * What the role page offers an instance (sd-424: every change waits for a
 * person's click). A stable instance is offered the newest stable release
 * above its own. An instance whose release was yanked, under any policy, is
 * offered the newest good release (stable first, else canary), marked as a
 * rollback when that is older. Drafts and yanked releases are never offered.
 */
export function updateOffer(releases: ReleaseLike[], current: { version: string; digest: string }, policy: UpdatePolicy): UpdateOffer {
  const good = releases.filter((r) => !r.yanked && r.status !== "draft").sort((a, b) => compareVersions(a.version, b.version));
  const behind = good.filter((r) => compareVersions(r.version, current.version) > 0).length;
  const mine = releases.find((r) => r.version === current.version && r.digest === current.digest);
  if (mine?.yanked) {
    const to = good.filter((r) => r.status === "stable").at(-1) ?? good.at(-1) ?? null;
    return { to, yanked: mine.yanked.reason, rollback: !!to && compareVersions(to.version, current.version) < 0, behind };
  }
  const to = policy === "stable" ? good.filter((r) => r.status === "stable" && compareVersions(r.version, current.version) > 0).at(-1) ?? null : null;
  return { to, yanked: null, rollback: false, behind };
}

const listed = (words: string[]) => (words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);
/** What a person must do after a release change, in the role page's words; empty when nothing. */
export function personSteps(c: ReleaseChanges): string[] {
  const steps: string[] = [];
  for (const r of c.routines.added) steps.push(`Activate ${r.title} (${r.every}) from the role page: it arrived paused.`);
  for (const r of c.routines.recadenced) steps.push(`Resume ${r.title} from the role page: its cadence moved from ${r.before} to ${r.after}, so it is paused for review.`);
  for (const s of c.setup.added.filter((s) => s.who === "human")) steps.push(`Complete the new setup step "${s.title}" from the role page.`);
  for (const i of c.inputs.added) steps.push(i.kind === "secret" ? `Bind the new secret ${i.label} from the role page.` : `Answer the new input ${i.label} (${i.key})${i.required ? "" : " if its default does not fit"}.`);
  for (const a of c.authority.added) steps.push(`Decide the new authority ${a.label}: it arrives only as a separate authority change, never with an update.`);
  return steps;
}

/**
 * What a role's standing session hears, once, when its instance moves to
 * another release: the versions, the class, the changelog in between, and
 * what a person must do, or that nothing is needed. Plain words, because it
 * arrives as a message and its conversation memory should stop contradicting
 * the release it now runs.
 */
export function releaseNote(o: { instance: string; template: string; from: string; to: string; classification: ReleaseClassification; sections: ChangelogSection[]; yanked?: string | null }): string {
  const c = o.classification.changes;
  const back = compareVersions(o.to, o.from) < 0;
  const lines: string[] = [`${o.instance} now runs ${o.template} ${o.to}, ${back ? "back" : "up"} from ${o.from}${o.yanked ? ` (${o.from} was withdrawn: ${o.yanked})` : ""}. This is a ${o.classification.class} change${o.classification.class === "content" ? ": the charter, prompts or guides changed, the manifest did not" : ""}. Read your charter and routine instructions again before acting on what you remember of ${o.from}.`];
  const moved: string[] = [];
  if (c.routines.added.length) moved.push(`new routines ${listed(c.routines.added.map((r) => `${r.title} (${r.every})`))}`);
  if (c.routines.removed.length) moved.push(`retired routines ${listed(c.routines.removed.map((r) => r.title))}`);
  if (c.routines.recadenced.length) moved.push(`new cadences for ${listed(c.routines.recadenced.map((r) => `${r.title} (${r.before} → ${r.after})`))}`);
  if (c.setup.added.length) moved.push(`new setup steps ${listed(c.setup.added.map((s) => `"${s.title}"${s.who === "role" ? " (yours to do)" : ""}`))}`);
  if (c.evidence.added.length) moved.push(`new evidence checks ${listed(c.evidence.added.map((e) => e.title))}`);
  if (c.inputs.added.length) moved.push(`new inputs ${listed(c.inputs.added.map((i) => i.label))}`);
  if (moved.length) lines.push(`What moved: ${moved.join("; ")}.`);
  const shown = o.sections.filter((s) => s.changelog);
  if (shown.length) {
    lines.push(back ? "What is undone:" : "Changelog:");
    for (const s of shown) lines.push(`### ${s.version}${s.yanked ? " (withdrawn)" : ""}\n${s.changelog}`);
  }
  const steps = personSteps(c);
  lines.push(steps.length ? `A person must:\n${steps.map((s) => `- ${s}`).join("\n")}` : "Nobody needs to do anything for this change.");
  return lines.join("\n");
}
