// The line settings page's model (plan pl-838): what each value of a
// project's line profile controls, where it came from, how an edit typed on
// the page becomes a daemon edit of `.codecast/line.toml`, how that edit
// paints the store row ahead of the daemon, and whether the viewer can edit
// at all. Pure, so the page, the store slice and the tests share one copy.
import {
  CAPS_KEYS,
  COMMAND_KEYS,
  LINE_PROFILE_DEFAULTS,
  LINE_PROFILE_REL_PATH,
  LINE_VALUE_KINDS,
  isLineStationEdit,
  parseLineValue,
  type LineValueKind,
  lineProfileNotes,
  type LineFinderInput,
  type LineProfileEdit,
  type LineValueSource,
  type PublishedLineProfile,
} from "@codecast/shared/contracts/lineProfile";
import { DAEMON_COMMAND_TTL_MS, deviceDisplayName, humanizeConvexError } from "@codecast/shared/contracts";
import { lineProjectParam, paintStationEdits } from "./line/lineStations";
import { SHIPPED_LINE } from "./line/shippedLine.generated";
import { DISPATCH_REFUSED } from "./sessionCommands";

export type LineFieldKind = LineValueKind;

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
/** A field as written below; its kind comes from the shared key table. */
type FieldDecl = Omit<LineField, "kind">;

type FieldWords = Pick<LineField, "what" | "placeholder" | "unit">;

/** What each command does, one per shared command key (a new key fails to compile until it is said here). */
const COMMAND_FIELDS: Record<(typeof COMMAND_KEYS)[number], FieldWords & { label: string }> = {
  check: { label: "Check", what: "Typecheck and tests, run at the check station.", placeholder: LINE_PROFILE_DEFAULTS.commands.check ?? undefined },
  prove: { label: "Reproduce", what: "Reproduces the cause before the fix, at the prove station.", placeholder: "bun test path/to/repro.test.ts" },
  eval: { label: "Eval", what: "Grades a prompt change against frozen cases, at the eval station.", placeholder: "./evals check" },
  ship: { label: "Ship", what: "Lands an accepted change.", placeholder: "git push" },
};

/** What each cap holds, one per shared caps key. */
const CAPS_FIELDS: Record<(typeof CAPS_KEYS)[number], FieldWords & { label: string }> = {
  cards: { label: "Cards", unit: "open", what: "The line starts no new build while this many cards wait on you." },
};

/** The sections as written; LINE_SECTIONS below adds each field's kind. Finders (Listens to) render their own rows. */
const SECTION_DECLS: Array<Omit<LineSection, "fields"> & { fields: FieldDecl[] }> = [
  { id: "listens", title: "Listens to", what: "Finders: the automatic sources that file problems into this line, like an error tracker or the evals, and when each last filed.", fields: [] },
  {
    id: "holds",
    title: "Holds work to",
    what: "What the review station reads before it passes a change.",
    fields: [
      { key: "principles", label: "Principles", what: "This project's own principles files, read beside the shared set.", placeholder: "docs/principles.md" },
      { key: "prompting", label: "Prompting standard", what: "The standard a change to a prompt is held to.", placeholder: LINE_PROFILE_DEFAULTS.prompting },
    ],
  },
  {
    id: "checks",
    title: "Checks a change",
    what: "The commands each station runs on a change before it reaches you.",
    fields: COMMAND_KEYS.map((k) => ({ key: `commands.${k}`, ...COMMAND_FIELDS[k] })),
  },
  {
    id: "limits",
    title: "Limits",
    what: "How big a change may be, how long a shipped one is watched, and how many cards may wait on you.",
    fields: [
      { key: "size_budget", label: "Size budget", unit: "lines", what: "A change larger than this is split before it builds." },
      { key: "watch_days", label: "Watch", unit: "days", what: "A shipped cause stays watched this long; a repeat of its signal reopens it." },
      ...CAPS_KEYS.map((k) => ({ key: `caps.${k}`, ...CAPS_FIELDS[k] })),
    ],
  },
];

/** The profile's sections in reading order, each field's kind read from the shared key table. */
export const LINE_SECTIONS: LineSection[] = SECTION_DECLS.map((s) => ({ ...s, fields: s.fields.map((f) => ({ ...f, kind: LINE_VALUE_KINDS[f.key] })) }));
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
  const parsed = parseLineValue(field.key, trimmed);
  if ("error" in parsed) return parsed;
  const v = parsed.value;
  const same = Array.isArray(v) ? Array.isArray(current) && current.length === v.length && current.every((x, i) => x === v[i]) : v === current;
  return { edit: same ? null : { op: "set", key: field.key, value: v } };
}

/** The dotted keys an edit touches, for its pending state and a refusal's restore. */
export const editKey = (e: LineProfileEdit) =>
  e.op === "set" || e.op === "remove" ? e.key
  : isLineStationEdit(e) ? `stations.${e.station}`
  : `finders.${e.op === "set_finder" ? e.finder.id : e.id}`;

/**
 * Paint edits onto a profile row the way the loader will resolve them, so the
 * page shows the result before the daemon answers; the republish replaces the
 * row with the file's truth. Mutates (a store draft).
 */
export function applyLineEdits(lp: PublishedLineProfile, edits: LineProfileEdit[]): void {
  lp.sources ??= {};
  // Station edits paint the repo's line (LX5); the rest paint the profile.
  const stationEdits = edits.filter(isLineStationEdit);
  if (stationEdits.length) lp.line = paintStationEdits(lp.line, stationEdits, SHIPPED_LINE) ?? undefined;
  for (const e of edits) {
    if (isLineStationEdit(e)) continue;
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
  /** away: the roster has not heard from the machine lately. That flag runs
   *  stale under load, so the edit is still sent; it waits for the machine up
   *  to DAEMON_COMMAND_TTL_MS and is dropped, untouched, if it never answers. */
  | { writable: true; device: string; file: string; away?: boolean }
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
  if (lp.default === false) return { writable: false, device: null, file, reason: "Only this project's finders are declared, in another project's profile. Edit them in that project's file." };
  if (!roster) return { writable: true, device: "the publishing machine", file };
  const device = roster.find((d) => d.device_id === lp.device_id);
  if (!device) return { writable: false, device: null, file, reason: "The file is on a teammate's machine. Its owner can edit it, here or in the file." };
  const name = deviceDisplayName(device as any);
  return { writable: true, device: name, file, ...(device.online ? {} : { away: true }) };
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
    if (answer.error === "expired_ttl") return { state: "refused", message: `The machine did not pick the edit up within ${Math.round(DAEMON_COMMAND_TTL_MS / 60_000)} minutes, so it was dropped. Nothing reached the file.` };
    if (/^Unknown command/.test(answer.error)) return { state: "refused", message: "That machine runs an older cast that cannot edit the line. Update it with cast update, then edit again." };
    if (/unknown edit op "(set|reset)_station"/.test(answer.error)) return { state: "refused", message: "That machine runs an older cast that cannot edit the line's stations. Update it with cast update, then edit again." };
    return { state: "refused", message: answer.error.replace(/^.*?\.codecast\/line\.toml: /, "").replace(/^\[line(\.\w+)?\]\s*/, "") };
  }
  try {
    // published.ok is "pending" from a daemon that republishes after it
    // answers: the file is written, and the republished row follows.
    const reply = JSON.parse(answer.result ?? "{}") as { changed?: boolean; published?: { ok: boolean | "pending"; detail?: string } | null };
    if (reply.published?.ok === false) return { state: "saved", note: `Written to the file, but the republish failed: ${reply.published.detail ?? "no detail"}` };
    return { state: "saved" };
  } catch {
    return { state: "saved" };
  }
}

// ---------------------------------------------------------------- edits in flight

/**
 * An edit of a line's file, as the store holds it: a sessionCommands row the
 * editLineProfile action paints (store/lineSlice.ts), settled by the daemon's
 * answer and then by its report of the republish. The row is the edit's one
 * home; the profile the page shows is the server copy with every edit still
 * travelling laid over it (liveLineProfile), so nothing is painted into the
 * project row and nothing has to be taken back from it.
 */
export type LineEditRow = {
  _id: string;
  kind?: string;
  project_id?: string;
  edits?: LineProfileEdit[];
  keys?: string[];
  command_id?: string;
  requested_at: number;
  executed_at: number | null;
  result: string | null;
  error: string | null;
};

/** How long an edit waits on its machine before the page says it has not answered. */
export const LINE_EDIT_SLOW_MS = 30_000;
/** How long after the write the page keeps showing an edit while the republished copy is on its way. */
export const LINE_EDIT_REPUBLISH_MS = 3 * 60_000;

export type LineEditStatus =
  | { requestId: string; at: number; state: "sending" | "waiting" | "publishing"; slow: boolean }
  | { requestId: string; at: number; state: "saved"; note?: string }
  | { requestId: string; at: number; state: "refused"; message: string };

export const isLineEditRow = (row: { kind?: string } | null | undefined): row is LineEditRow => row?.kind === "line_edit";

/** Where one edit is: on its way, with the machine, republishing, done, or refused. */
export function lineEditStatus(row: LineEditRow, lp: Facts, now: number): LineEditStatus {
  const base = { requestId: row._id };
  if (row.error || row.result === DISPATCH_REFUSED) {
    // A server refusal carries the client's error text; a daemon's is its own message.
    const error = row.result === DISPATCH_REFUSED ? humanizeConvexError(row.error, "The edit was refused") : row.error ?? "The edit was refused";
    const out = editOutcome({ executed_at: row.executed_at ?? now, error });
    return { ...base, at: row.executed_at ?? row.requested_at, state: "refused", message: out.state === "refused" ? out.message : "The edit was refused" };
  }
  if (!row.executed_at) {
    return { ...base, at: row.requested_at, state: row.command_id ? "waiting" : "sending", slow: now - row.requested_at > LINE_EDIT_SLOW_MS };
  }
  const at = row.executed_at;
  let reply: { changed?: boolean; published?: { ok: boolean | "pending"; detail?: string } | null } = {};
  try { reply = JSON.parse(row.result ?? "{}"); } catch {}
  if (reply.changed === false) return { ...base, at, state: "saved" };
  if (reply.published?.ok === false) return { ...base, at, state: "saved", note: `Written to the file, but the republish failed: ${reply.published.detail ?? "no detail"}. This page shows the last published copy until the next publish.` };
  // The republished copy is stamped after the write, so a row published since
  // the answer already says what the file says.
  if ((lp?.published_at ?? 0) >= at) return { ...base, at, state: "saved" };
  if (now - at > LINE_EDIT_REPUBLISH_MS) return { ...base, at, state: "saved", note: "Written to the file. The republished copy has not arrived, so this page still shows the last one." };
  return { ...base, at, state: "publishing", slow: false };
}

const travelling = (s: LineEditStatus) => s.state === "sending" || s.state === "waiting" || s.state === "publishing";

/** One project's edit rows, oldest first. */
export function lineEditRows(rows: Record<string, unknown> | null | undefined, projectId: string | null | undefined): LineEditRow[] {
  if (!projectId) return [];
  return Object.values(rows ?? {})
    .filter((r): r is LineEditRow => isLineEditRow(r as LineEditRow) && (r as LineEditRow).project_id === projectId)
    .sort((a, b) => a.requested_at - b.requested_at);
}

/**
 * The profile as the page shows it: the published copy, with the edits still
 * on their way applied in the order they were made. The same object when
 * nothing is travelling.
 */
export function liveLineProfile<P extends PublishedLineProfile | null | undefined>(lp: P, rows: LineEditRow[], now: number): P {
  if (!lp) return lp;
  const open = rows.filter((r) => r.edits?.length && travelling(lineEditStatus(r, lp, now)));
  if (open.length === 0) return lp;
  const next = structuredClone(lp) as PublishedLineProfile;
  for (const r of open) applyLineEdits(next, r.edits!);
  return next as P;
}

/** What the page says beside each value: the newest edit that touched its key. */
export function lineEditStates(rows: LineEditRow[], lp: Facts, now: number): Record<string, LineEditStatus> {
  const out: Record<string, LineEditStatus> = {};
  for (const r of rows) {
    const s = lineEditStatus(r, lp, now);
    for (const k of r.keys ?? (r.edits ?? []).map(editKey)) out[k] = s;
  }
  return out;
}

// ---------------------------------------------------------------- links in

/** Where a link into the settings page lands: a profile section or the stations. */
export type LineSettingsSection = LineSection["id"] | "stations";
export const LINE_SETTINGS_SECTIONS: readonly LineSettingsSection[] = [...LINE_SECTIONS.map((s) => s.id), "stations"];

export type LineSettingsTarget = {
  /** The project: its row (addressed by lineProjectParam), or the `?project=` value itself. */
  project?: { _id: string; short_id?: string | null } | string | null;
  section?: LineSettingsSection | null;
  /** A station of the line graph (a node id); it implies the Stations section. */
  station?: string | null;
};

/** The one address of the settings page, for every link into it. */
export function lineSettingsHref(t: LineSettingsTarget = {}): string {
  const q = new URLSearchParams();
  const project = typeof t.project === "string" ? t.project : t.project ? lineProjectParam(t.project) : null;
  if (project) q.set("project", project);
  const section = t.station ? "stations" : t.section;
  if (section) q.set("section", section);
  if (t.station) q.set("station", t.station);
  const s = q.toString();
  return s ? `/line/settings?${s}` : "/line/settings";
}

/** A project's Line tab (the-line-model.md LM7): its flow, sources, stations and versions. */
export function lineTabHref(project: string | { _id: string }): string {
  return `/projects/${typeof project === "string" ? project : project._id}?tab=line`;
}

/** What a link into the page asks for, from its search params. An unknown section is ignored. */
export function lineSettingsTarget(search: { get(key: string): string | null } | null | undefined): { section: LineSettingsSection | null; station: string | null } {
  const station = search?.get("station") || null;
  const asked = search?.get("section") as LineSettingsSection | null | undefined;
  const section = station ? "stations" : asked && LINE_SETTINGS_SECTIONS.includes(asked) ? asked : null;
  return { section, station };
}

/** The setting that fills each station of the Line page when it is empty:
 *  what feeds it, said as the thing to set. Keyed by the page's station key. */
export const LINE_STATION_SETTINGS: Record<string, { section: LineSettingsSection; say: string }> = {
  sense: { section: "listens", say: "Set what this line listens to" },
  causes: { section: "listens", say: "Set what this line listens to" },
  build: { section: "stations", say: "See who runs this line" },
  awaiting: { section: "checks", say: "Set the checks a change passes" },
  watching: { section: "limits", say: "Set how long a shipped change is watched" },
  closed: { section: "checks", say: "Set how a change ships" },
};
