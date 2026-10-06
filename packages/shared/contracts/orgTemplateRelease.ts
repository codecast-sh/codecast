// What a template release changes, and what that means for the roles hired
// from it (docs/architecture/org-hire.md, As built 2026-10-06). Pure, so the
// server (publish, the role page's update offer, the note a role hears when
// its release moves), the CLI and the tests read one definition.
//
// A release is classified by diffing its manifest against the release before
// it, never by trusting its author: content (files only), structure
// (routines, inputs, setup, evidence, ledgers, scoreboard, anything else in the
// manifest) or authority (caps, authority, routine modes, the line, the role's
// name and handle). The class sets the smallest version bump publish accepts.

import { compareVersions, type OrgTemplate } from "./orgTemplateManifest";

export type ReleaseClass = "content" | "structure" | "authority";
export const RELEASE_CLASSES: ReleaseClass[] = ["content", "structure", "authority"];
export type VersionBump = "major" | "minor" | "patch" | "none";
/** The smallest bump each class needs. */
export const REQUIRED_BUMP: Record<ReleaseClass, Exclude<VersionBump, "none">> = { content: "patch", structure: "minor", authority: "major" };
const BUMP_RANK: Record<VersionBump, number> = { none: 0, patch: 1, minor: 2, major: 3 };

/** What the Update card names. Ids are the manifest's (routine, setup, evidence and ledger ids; input and scoreboard keys). */
export type ReleaseChanges = {
  routines_added: string[]; routines_removed: string[];
  routines_recadenced: { id: string; from: string; to: string }[];
  inputs_added: string[]; inputs_removed: string[];
  setup_added: string[]; setup_removed: string[];
  evidence_changed: string[]; ledgers_changed: string[]; scoreboard_changed: string[];
  /** Human words, e.g. "caps.tokens_per_day 200000 -> 400000". */
  authority_changed: string[];
};
export type ReleaseClassification = { class: ReleaseClass; changes: ReleaseChanges };

/** Key-order independent equality, for manifest values (plain JSON). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as object).sort().filter((k) => (value as any)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const show = (value: unknown) => (value === undefined ? "none" : typeof value === "string" ? value : canonical(value));

function keyed<T extends Record<string, any>>(prev: T[] | undefined, next: T[] | undefined, key: keyof T, ignore: string[] = []) {
  const before = new Map((prev ?? []).map((item) => [String(item[key]), item]));
  const after = new Map((next ?? []).map((item) => [String(item[key]), item]));
  const strip = (item: T) => Object.fromEntries(Object.entries(item).filter(([k]) => !ignore.includes(k)));
  return {
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)),
    changed: [...after].filter(([id, item]) => before.has(id) && !same(strip(before.get(id)!), strip(item))).map(([id]) => id),
  };
}
const union = (...lists: string[][]) => [...new Set(lists.flat())];

const EMPTY: OrgTemplate = { schemaVersion: 2, id: "", version: "0.0.0", name: "", description: "", role: { name: "", handle: "", charter: "", caps: { hands_per_day: 0, wakes_per_day: 0, tokens_per_day: 0 } }, routines: [] };

/**
 * The classification plus the plain words for each change that set its
 * class: what publish names when it refuses a bump.
 */
export function explainRelease(prev: OrgTemplate | null, next: OrgTemplate): ReleaseClassification & { why: string[] } {
  const p = prev ?? EMPTY;
  const routines = keyed(p.routines, next.routines, "id", ["every", "mode"]);
  const inputs = keyed(p.inputs, next.inputs, "key"), setup = keyed(p.setup, next.setup, "id");
  const evidence = keyed(p.evidence, next.evidence, "id"), ledgers = keyed(p.ledgers, next.ledgers, "id"), scoreboard = keyed(p.scoreboard, next.scoreboard, "key");
  const before = new Map(p.routines.map((r) => [r.id, r]));
  const both = next.routines.filter((r) => before.has(r.id));

  // Each authority change in a person's words: the Update card shows these verbatim.
  const authority: string[] = [];
  const amount = (n: number | undefined) => (n === undefined ? "none" : n.toLocaleString("en-US"));
  const CAPS = { hands_per_day: "Daily hands limit", wakes_per_day: "Daily wake limit", tokens_per_day: "Daily token limit", cards: "Card limit" } as const;
  for (const [k, label] of Object.entries(CAPS) as [keyof typeof CAPS, string][]) if (p.role.caps[k] !== next.role.caps[k]) authority.push(`${label}: ${amount(p.role.caps[k])} to ${amount(next.role.caps[k])}`);
  if (p.role.name !== next.role.name) authority.push(`Role name: ${p.role.name} to ${next.role.name}`);
  if (p.role.handle !== next.role.handle) authority.push(`Handle: ${p.role.handle} to ${next.role.handle}`);
  if (p.role.line !== next.role.line) authority.push(`Line it runs: ${p.role.line ?? "none"} to ${next.role.line ?? "none"}`);
  const grants = keyed(p.authority, next.authority, "id");
  const grant = (m: OrgTemplate, id: string) => m.authority?.find((a) => a.id === id)?.label ?? id;
  for (const id of grants.added) authority.push(`New permission: ${grant(next, id)}`);
  for (const id of grants.removed) authority.push(`Permission removed: ${grant(p, id)}`);
  for (const id of grants.changed) authority.push(`Permission changed: ${grant(next, id)}`);
  for (const r of both) {
    const was = before.get(r.id)!.mode ?? "propose", now = r.mode ?? "propose";
    if (was !== now) authority.push(now === "apply" ? `${r.title} now acts on its own (it only proposed before)` : `${r.title} now only proposes (it acted on its own before)`);
  }

  const changes: ReleaseChanges = {
    routines_added: routines.added, routines_removed: routines.removed,
    routines_recadenced: both.filter((r) => before.get(r.id)!.every !== r.every).map((r) => ({ id: r.id, from: before.get(r.id)!.every, to: r.every })),
    inputs_added: inputs.added, inputs_removed: inputs.removed,
    setup_added: setup.added, setup_removed: setup.removed,
    evidence_changed: union(evidence.added, evidence.removed, evidence.changed),
    ledgers_changed: union(ledgers.added, ledgers.removed, ledgers.changed),
    scoreboard_changed: union(scoreboard.added, scoreboard.removed, scoreboard.changed),
    authority_changed: prev ? authority : [],
  };
  if (!prev) return { class: "structure", changes, why: ["the first release"] };
  if (authority.length) return { class: "authority", changes, why: authority };

  const structure: string[] = [
    ...routines.added.map((id) => `routine ${id} added`), ...routines.removed.map((id) => `routine ${id} removed`), ...routines.changed.map((id) => `routine ${id} changed`),
    ...changes.routines_recadenced.map((r) => `routine ${r.id} every ${r.from} -> ${r.to}`),
    ...inputs.added.map((k) => `input ${k} added`), ...inputs.removed.map((k) => `input ${k} removed`), ...inputs.changed.map((k) => `input ${k} changed`),
    ...setup.added.map((id) => `setup ${id} added`), ...setup.removed.map((id) => `setup ${id} removed`), ...setup.changed.map((id) => `setup ${id} changed`),
    ...changes.evidence_changed.map((id) => `evidence ${id} changed`), ...changes.ledgers_changed.map((id) => `ledger ${id} changed`), ...changes.scoreboard_changed.map((k) => `scoreboard ${k} changed`),
    ...(["avatar", "tenure", "charter"] as const).filter((k) => !same(p.role[k], next.role[k])).map((k) => `role.${k} changed`),
    ...(["name", "description", "learn", "instance_file", "schemaVersion"] as const).filter((k) => !same(p[k], next[k])).map((k) => `${k} changed`),
  ];
  if (structure.length) return { class: "structure", changes, why: structure };
  return { class: "content", changes, why: ["only files changed: the manifest is the same but for its version"] };
}
/** Classify `next` against `prev`, the release before it by version. The first release (no `prev`) is structure. */
export function classifyRelease(prev: OrgTemplate | null, next: OrgTemplate): ReleaseClassification {
  const { class: c, changes } = explainRelease(prev, next);
  return { class: c, changes };
}
const CLASS_RANK: Record<ReleaseClass, number> = { content: 0, structure: 1, authority: 2 };
/** Several consecutive releases as one jump: the widest class, every change merged (a re-cadence keeps its first `from` and last `to`). */
export function mergeClassifications(steps: ReleaseClassification[]): ReleaseClassification | null {
  if (!steps.length) return null;
  const out: ReleaseClassification = { class: "content", changes: { routines_added: [], routines_removed: [], routines_recadenced: [], inputs_added: [], inputs_removed: [], setup_added: [], setup_removed: [], evidence_changed: [], ledgers_changed: [], scoreboard_changed: [], authority_changed: [] } };
  for (const step of steps) {
    if (CLASS_RANK[step.class] > CLASS_RANK[out.class]) out.class = step.class;
    for (const [k, list] of Object.entries(step.changes) as [keyof ReleaseChanges, any[]][]) {
      if (k === "routines_recadenced") {
        for (const r of list as ReleaseChanges["routines_recadenced"]) {
          const seen = out.changes.routines_recadenced.find((x) => x.id === r.id);
          if (seen) seen.to = r.to; else out.changes.routines_recadenced.push({ ...r });
        }
      } else (out.changes[k] as string[]) = union(out.changes[k] as string[], list as string[]);
    }
  }
  return out;
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
/** Null when `next`'s bump over `prev` is big enough for its class; else the refusal publish raises, naming the change that forced the class. */
export function bumpRefusal(prev: OrgTemplate | null, next: OrgTemplate): string | null {
  if (!prev) return null;
  const c = explainRelease(prev, next);
  const need = REQUIRED_BUMP[c.class], got = versionBump(prev.version, next.version);
  if (BUMP_RANK[got] >= BUMP_RANK[need]) return null;
  const shown = c.why.slice(0, 5).join("; ") + (c.why.length > 5 ? `; and ${c.why.length - 5} more` : "");
  return `${next.id}@${next.version} is ${c.class === "authority" ? "an" : "a"} ${c.class} release (${shown}), so it needs a ${need} version bump over ${prev.version}; ${next.version} is ${got === "none" ? "not newer" : `a ${got} bump`}. Publish it as ${bumpVersion(prev.version, need)} or later.`;
}

export type ReleaseLike = { version: string; digest: string; status: string; manifest: OrgTemplate; changelog?: string | null; class?: ReleaseClass; changes?: ReleaseChanges; yanked?: { reason: string; at: number } | null };
/** The release just below `version` by version order, or null for the first. */
export function previousRelease<R extends { version: string }>(releases: R[], version: string): R | null {
  return releases.filter((r) => compareVersions(r.version, version) < 0).sort((a, b) => compareVersions(a.version, b.version)).at(-1) ?? null;
}
/** Every release with its class: the stored one, else computed against the release before it (releases published before classification). */
export function withClasses<R extends ReleaseLike>(releases: R[]): Array<R & ReleaseClassification> {
  // A row with no manifest (never true of a published release) has nothing to classify and is passed through.
  return releases.map((r) => ((r.class && r.changes) || !r.manifest ? (r as R & ReleaseClassification) : { ...r, ...classifyRelease(previousRelease(releases, r.version)?.manifest ?? null, r.manifest) }));
}

/** A changelog as its `## <version>` sections. One with no version headings is one section, filed under `fallback` (the release it came with). */
export function changelogSections(text: string | null | undefined, fallback?: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!text?.trim()) return out;
  const parts = text.split(/^##\s+v?(\d+\.\d+\.\d+)\b.*$/m);
  if (parts.length === 1) { if (fallback) out.set(fallback, text.trim()); return out; }
  for (let i = 1; i < parts.length; i += 2) if (!out.has(parts[i]!)) out.set(parts[i]!, parts[i + 1]!.trim());
  return out;
}
/** The releases strictly after the older of `a` and `b`, up to and including the newer, oldest first. */
function span<R extends { version: string }>(releases: R[], a: string, b: string): R[] {
  const [lo, hi] = compareVersions(a, b) <= 0 ? [a, b] : [b, a];
  return releases.filter((r) => compareVersions(r.version, lo) > 0 && compareVersions(r.version, hi) <= 0).sort((x, y) => compareVersions(x.version, y.version));
}
/**
 * The changelog of every release after the older of `from` and `to`, up to and
 * including the newer, newest first: for an update, what it brings; for a
 * rollback, what it undoes. Each version's words come from the newest
 * changelog that has a section for it, else its own release's changelog.
 */
export function changelogBetween(releases: ReleaseLike[], from: string, to: string): { version: string; text: string }[] {
  const sections = [...releases].sort((a, b) => compareVersions(b.version, a.version)).map((r) => changelogSections(r.changelog, r.version));
  return span(releases, from, to).reverse()
    .map((r) => ({ version: r.version, text: sections.map((s) => s.get(r.version)).find(Boolean) ?? r.changelog?.trim() ?? "" }))
    .filter((s) => s.text);
}

export type UpdatePolicy = "manual" | "canary" | "stable";
export type UpdateOffer = { to: ReleaseLike | null; /** The instance's own release was yanked, with its reason; `to` is the fallback. */ rollback: { reason: string } | null; /** Newer non-yanked, non-draft releases than the instance's. */ behind: number };
/**
 * What the role page offers an instance (sd-424: every change waits for a
 * person's click). A stable instance is offered the newest stable release
 * above its own. An instance whose release was yanked, under any policy, is
 * offered the newest good release (stable first, else canary) as a rollback.
 * Drafts and yanked releases are never offered.
 */
export function updateOffer(releases: ReleaseLike[], current: { version: string; digest: string }, policy: UpdatePolicy): UpdateOffer {
  const good = releases.filter((r) => !r.yanked && r.status !== "draft").sort((a, b) => compareVersions(a.version, b.version));
  const behind = good.filter((r) => compareVersions(r.version, current.version) > 0).length;
  const mine = releases.find((r) => r.version === current.version && r.digest === current.digest);
  if (mine?.yanked) {
    const to = good.filter((r) => r.status === "stable").at(-1) ?? good.at(-1) ?? null;
    return { to, rollback: to ? { reason: mine.yanked.reason } : null, behind };
  }
  const to = policy === "stable" ? good.filter((r) => r.status === "stable" && compareVersions(r.version, current.version) > 0).at(-1) ?? null : null;
  return { to, rollback: null, behind };
}
/**
 * What moving from `from` to `to` changes. Forward: the releases in between,
 * merged (widest class). Backward, a rollback: the direct diff of the two
 * manifests, since undoing a release is not the sum of the releases undone.
 */
export function jumpBetween(releases: ReleaseLike[], from: ReleaseLike, to: ReleaseLike): ReleaseClassification | null {
  if (compareVersions(to.version, from.version) < 0) return classifyRelease(from.manifest, to.manifest);
  return mergeClassifications(span(withClasses(releases), from.version, to.version));
}

export type UpdateNames = { routines: Record<string, { title: string; every: string }>; setup: Record<string, string>; inputs: Record<string, string> };
/**
 * What the Update card calls each routine, setup step and input by id: the
 * offered release's words, and for an item it removes, the instance's own.
 */
export function updateNames(offered: OrgTemplate, current?: OrgTemplate | null): UpdateNames {
  const of = (m: OrgTemplate | null | undefined): UpdateNames => ({
    routines: Object.fromEntries((m?.routines ?? []).map((r) => [r.id, { title: r.title, every: r.every }])),
    setup: Object.fromEntries((m?.setup ?? []).map((s) => [s.id, s.title])),
    inputs: Object.fromEntries((m?.inputs ?? []).map((i) => [i.key, i.label])),
  });
  const [was, now] = [of(current), of(offered)];
  return { routines: { ...was.routines, ...now.routines }, setup: { ...was.setup, ...now.setup }, inputs: { ...was.inputs, ...now.inputs } };
}

const listed = (words: string[]) => (words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`);
/** What a person must do after a release change, in the role page's words; empty when nothing. `next` names each item. */
export function personSteps(c: ReleaseChanges, next: OrgTemplate): string[] {
  const routine = (id: string) => next.routines.find((r) => r.id === id);
  const steps: string[] = [];
  for (const id of c.routines_added) steps.push(`Activate ${routine(id)?.title ?? id} (${routine(id)?.every}) from the role page: it arrived paused.`);
  for (const r of c.routines_recadenced) steps.push(`Resume ${routine(r.id)?.title ?? r.id} from the role page: its cadence moved from ${r.from} to ${r.to}, so it is paused for review.`);
  for (const id of c.setup_added) { const s = next.setup?.find((x) => x.id === id); if (s?.who === "human") steps.push(`Complete the new setup step "${s.title}" from the role page.`); }
  for (const key of c.inputs_added) { const i = next.inputs?.find((x) => x.key === key); if (i) steps.push(i.kind === "secret" ? `Bind the new secret ${i.label} from the role page.` : `Answer the new input ${i.label} (${i.key})${i.required ? "" : " if its default does not fit"}.`); }
  if (c.authority_changed.length) steps.push(`Decide the authority changes (${listed(c.authority_changed)}): they arrive only as a separate authority change, never with an update.`);
  return steps;
}

/**
 * What a role's standing session hears, once, when its instance moves to
 * another release: the versions, the class, the changelog in between, and
 * what a person must do, or that nothing is needed. Plain words, because it
 * arrives as a message and its conversation memory should stop contradicting
 * the release it now runs.
 */
export function releaseNote(o: { instance: string; template: string; from: string; next: OrgTemplate; classification: ReleaseClassification; changelogs: { version: string; text: string }[]; yanked?: string | null }): string {
  const c = o.classification.changes, to = o.next.version;
  const back = compareVersions(to, o.from) < 0;
  const title = (id: string) => o.next.routines.find((r) => r.id === id)?.title ?? id;
  const lines: string[] = [`${o.instance} now runs ${o.template} ${to}, ${back ? "back" : "up"} from ${o.from}${o.yanked ? ` (${o.from} was withdrawn: ${o.yanked})` : ""}. This is a ${o.classification.class} change${o.classification.class === "content" ? ": the charter, prompts or guides changed, the manifest did not" : ""}. Read your charter and routine instructions again before acting on what you remember of ${o.from}.`];
  const moved: string[] = [];
  if (c.routines_added.length) moved.push(`new routines ${listed(c.routines_added.map((id) => `${title(id)} (${o.next.routines.find((r) => r.id === id)?.every})`))}`);
  if (c.routines_removed.length) moved.push(`retired routines ${listed(c.routines_removed)}`);
  if (c.routines_recadenced.length) moved.push(`new cadences for ${listed(c.routines_recadenced.map((r) => `${title(r.id)} (${r.from} → ${r.to})`))}`);
  if (c.setup_added.length) moved.push(`new setup steps ${listed(c.setup_added.map((id) => { const s = o.next.setup?.find((x) => x.id === id); return s ? `"${s.title}"${s.who === "role" ? " (yours to do)" : ""}` : id; }))}`);
  if (c.evidence_changed.length) moved.push(`evidence checks ${listed(c.evidence_changed)}`);
  if (c.inputs_added.length) moved.push(`new inputs ${listed(c.inputs_added.map((k) => o.next.inputs?.find((i) => i.key === k)?.label ?? k))}`);
  if (moved.length) lines.push(`What moved: ${moved.join("; ")}.`);
  if (o.changelogs.length) {
    lines.push(back ? "What is undone:" : "Changelog:");
    for (const s of o.changelogs) lines.push(`### ${s.version}\n${s.text}`);
  }
  const steps = personSteps(c, o.next);
  lines.push(steps.length ? `A person must:\n${steps.map((s) => `- ${s}`).join("\n")}` : "Nobody needs to do anything for this change.");
  return lines.join("\n");
}
