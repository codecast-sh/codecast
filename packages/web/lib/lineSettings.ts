// The line settings page's model (plan pl-838): what each value of a
// project's line profile controls, where it came from, how an edit typed on
// the page becomes a daemon edit of `.codecast/line.toml`, how that edit
// paints the store row ahead of the daemon, and whether the viewer can edit
// at all. Pure, so the page, the store slice and the tests share one copy.
import {
  LINE_PROFILE_DEFAULTS,
  LINE_PROFILE_REL_PATH,
  lineProfileNotes,
  type LineFinderInput,
  type LineProfileEdit,
  type LineValueSource,
  type PublishedLineProfile,
} from "@codecast/shared/contracts/lineProfile";
import { deviceDisplayName } from "@codecast/shared/contracts";

export type LineFieldKind = "text" | "int" | "list";

export type LineField = {
  /** The dotted key the loader and the daemon edit name. */
  key: string;
  label: string;
  kind: LineFieldKind;
  /** One plain line: what the value controls. */
  what: string;
  unit?: string;
  placeholder?: string;
};

export type LineSection = { id: "listens" | "holds" | "checks" | "limits"; title: string; what: string; fields: LineField[] };

/** The profile's sections in reading order. Finders (Listens to) render their own rows. */
export const LINE_SECTIONS: LineSection[] = [
  { id: "listens", title: "Listens to", what: "The finders that file signals into this line, and when each last spoke.", fields: [] },
  {
    id: "holds",
    title: "Holds work to",
    what: "What the review station reads before it passes a change.",
    fields: [
      { key: "principles", label: "Principles", kind: "list", what: "This project's own principles files, read beside the shared set.", placeholder: "docs/principles.md" },
      { key: "prompting", label: "Prompting standard", kind: "text", what: "The standard a change to a prompt is held to.", placeholder: LINE_PROFILE_DEFAULTS.prompting },
    ],
  },
  {
    id: "checks",
    title: "Checks a change",
    what: "The commands each station runs on a change before it reaches you.",
    fields: [
      { key: "commands.check", label: "check", kind: "text", what: "Typecheck and tests, run at the check station.", placeholder: LINE_PROFILE_DEFAULTS.commands.check },
      { key: "commands.prove", label: "prove", kind: "text", what: "Reproduces the cause before the fix, at the prove station.", placeholder: "bun test path/to/repro.test.ts" },
      { key: "commands.eval", label: "eval", kind: "text", what: "Grades a prompt change against frozen cases, at the eval station.", placeholder: "./evals check" },
      { key: "commands.ship", label: "ship", kind: "text", what: "Lands an accepted change.", placeholder: "git push" },
    ],
  },
  {
    id: "limits",
    title: "Limits",
    what: "How big a change may be, how long a shipped one is watched, and how many cards may wait on you.",
    fields: [
      { key: "size_budget", label: "Size budget", kind: "int", unit: "lines", what: "A change larger than this is split before it builds." },
      { key: "watch_days", label: "Watch", kind: "int", unit: "days", what: "A shipped cause stays watched this long; a repeat of its signal reopens it." },
      { key: "caps.cards", label: "Cards", kind: "int", unit: "open", what: "The line starts no new build while this many cards wait on you." },
    ],
  },
];

export const LINE_FIELDS: LineField[] = LINE_SECTIONS.flatMap((s) => s.fields);

type Facts = Partial<PublishedLineProfile> | null | undefined;

const getPath = (obj: any, key: string) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
function setPath(obj: any, key: string, value: unknown) {
  const parts = key.split(".");
  let o = obj;
  for (const p of parts.slice(0, -1)) o = o[p] ??= {};
  o[parts[parts.length - 1]] = value;
}

/** A row published before the whole profile was (LP3 finders only) carries no values. */
export const hasProfileFacts = (lp: Facts) => !!lp && lp.commands !== undefined;

/** The value the line runs with: the row's, else (an older row) the default. */
export function lineValue(lp: Facts, key: string): string | number | string[] | null {
  const own = getPath(lp, key);
  return (own === undefined ? getPath(LINE_PROFILE_DEFAULTS, key) : own) ?? null;
}

/** Where the value came from; null when the row predates sources. */
export const lineSource = (lp: Facts, key: string): LineValueSource | null => lp?.sources?.[key] ?? null;

/** The value as the inline editor shows it. */
export function fieldText(field: LineField, value: unknown): string {
  if (value == null) return "";
  if (field.kind === "list") return (value as string[]).join("\n");
  return String(value);
}

/**
 * What a typed value becomes: the edit to send, nothing (unchanged), or why it
 * is refused before it leaves the page. Clearing a field puts it back to its
 * default, which is what removing the key from the file does.
 */
export function editForField(field: LineField, text: string, lp: Facts): { edit: LineProfileEdit | null } | { error: string } {
  const trimmed = text.trim();
  const current = lineValue(lp, field.key);
  // Clearing a value the file sets puts back the default; a default is already that.
  if (!trimmed) return { edit: lineSource(lp, field.key) === "file" ? { op: "remove", key: field.key } : null };
  if (field.kind === "int") {
    if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) return { error: "A whole number, 1 or more" };
    const n = Number(trimmed);
    return { edit: n === current ? null : { op: "set", key: field.key, value: n } };
  }
  if (field.kind === "list") {
    const items = trimmed.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
    const same = Array.isArray(current) && current.length === items.length && current.every((x, i) => x === items[i]);
    return { edit: same ? null : { op: "set", key: field.key, value: items } };
  }
  if (/[\u0000-\u0008\u000b-\u001f]/.test(trimmed)) return { error: "Control characters cannot go in the file" };
  return { edit: trimmed === current ? null : { op: "set", key: field.key, value: trimmed } };
}

/** The dotted keys an edit touches, for its pending state and a refusal's restore. */
export const editKey = (e: LineProfileEdit) => (e.op === "set" || e.op === "remove" ? e.key : `finders.${e.op === "set_finder" ? e.finder.id : e.id}`);

/**
 * Paint edits onto a profile row the way the loader will resolve them, so the
 * page shows the result before the daemon answers; the republish replaces the
 * row with the file's truth. Mutates (a store draft).
 */
export function applyLineEdits(lp: PublishedLineProfile, edits: LineProfileEdit[]): void {
  lp.sources ??= {};
  for (const e of edits) {
    if (e.op === "set") {
      setPath(lp, e.key, e.value);
      lp.sources[e.key] = "file";
    } else if (e.op === "remove") {
      setPath(lp, e.key, structuredClone(getPath(LINE_PROFILE_DEFAULTS, e.key) ?? null));
      lp.sources[e.key] = "default";
    } else if (e.op === "set_finder") {
      const { project: _project, ...decl } = e.finder;
      const at = lp.finders.findIndex((f) => f.id === decl.id);
      const row = { ...decl, kind: decl.kind === "any" ? "any" : ([] as string[]).concat(decl.kind) } as PublishedLineProfile["finders"][number];
      if (at >= 0) lp.finders[at] = row;
      else lp.finders.push(row);
      lp.sources.finders = "file";
    } else {
      lp.finders = lp.finders.filter((f) => f.id !== e.id);
    }
  }
  if (lp.commands) lp.notes = lineProfileNotes({ commands: lp.commands, project: lp.project ?? null });
}

/** Put back what a refused edit painted: each key it touched, from the row as it was. */
export function restoreLineKeys(lp: PublishedLineProfile, prior: PublishedLineProfile, keys: string[]): void {
  for (const key of keys) {
    if (key.startsWith("finders.")) {
      lp.finders = structuredClone(prior.finders);
      if (prior.sources?.finders) (lp.sources ??= {}).finders = prior.sources.finders;
      continue;
    }
    setPath(lp, key, structuredClone(getPath(prior, key)));
    if (prior.sources?.[key]) (lp.sources ??= {})[key] = prior.sources[key];
  }
  if (lp.commands) lp.notes = lineProfileNotes({ commands: lp.commands, project: lp.project ?? null });
}

/** What a station does while its command is unset, from the profile's notes. */
export function commandNote(lp: Facts, key: string): string | null {
  const k = key.replace(/^commands\./, "");
  const note = (lp?.notes ?? []).find((n) => n.startsWith(`no ${k} command:`));
  return note ? note.slice(note.indexOf(":") + 1).trim() : null;
}

/** A finder the page edits: the decl's fields as the file writes them. */
export function finderInput(f: PublishedLineProfile["finders"][number]): LineFinderInput {
  return { id: f.id, source: f.source, kind: f.kind, fingerprint: f.fingerprint, ...(f.runs ? { runs: f.runs } : {}) };
}

export type RosterDevice = { device_id: string; online: boolean; label?: string; hostname?: string; platform?: string };

export type LineWriteGate =
  | { writable: true; device: string; file: string }
  | { writable: false; reason: string; device: string | null; file: string };

/**
 * Whether the viewer can edit this line's file from here, and if not, why.
 * The edit runs on the daemon of the machine that published the profile, and
 * only the machine's owner can send it commands. A roster not yet loaded
 * stays writable: the server judges the send either way.
 */
export function lineWriteGate(lp: Facts, roster: RosterDevice[] | null): LineWriteGate {
  const file = lp?.file ?? LINE_PROFILE_REL_PATH;
  if (!lp) return { writable: false, device: null, file, reason: "No machine has published this line yet. Run cast line profile --publish in the project's checkout." };
  if (!lp.root || !lp.device_id || !hasProfileFacts(lp)) {
    return { writable: false, device: null, file, reason: "An older cast published this line, without the machine that holds the file. Run cast line profile --publish there with a current cast." };
  }
  if (!roster) return { writable: true, device: "the publishing machine", file };
  const device = roster.find((d) => d.device_id === lp.device_id);
  if (!device) return { writable: false, device: null, file, reason: "The file is on a teammate's machine. Its owner can edit it, here or in the file." };
  const name = deviceDisplayName(device as any);
  if (!device.online) return { writable: false, device: name, file, reason: `${name} is offline. Edits go through the machine that holds the checkout, so they wait until it is back.` };
  return { writable: true, device: name, file };
}

/** A daemon command's answer, as getCommandResult returns it. */
export type CommandAnswer = { executed_at?: number; result?: string; error?: string } | null | undefined;

export type EditOutcome =
  | { state: "waiting" }
  | { state: "saved"; note?: string }
  | { state: "refused"; message: string };

/** Read the daemon's answer to a line_profile_edit. */
export function editOutcome(answer: CommandAnswer): EditOutcome {
  if (!answer?.executed_at) return { state: "waiting" };
  if (answer.error) {
    if (/^Unknown command/.test(answer.error)) return { state: "refused", message: "That machine runs an older cast that cannot edit the line. Update it with cast update, then edit again." };
    return { state: "refused", message: answer.error.replace(/^.*?\.codecast\/line\.toml: /, "") };
  }
  try {
    const reply = JSON.parse(answer.result ?? "{}") as { changed?: boolean; published?: { ok: boolean; detail?: string } | null };
    if (reply.published && !reply.published.ok) return { state: "saved", note: `Written to the file, but the republish failed: ${reply.published.detail ?? "no detail"}` };
    return { state: "saved" };
  } catch {
    return { state: "saved" };
  }
}
