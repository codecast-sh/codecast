// Live artifacts (boards, sheets, dashboards): the element-keyed op model every
// client and the server share. An artifact is a docs row (doc_type board,
// sheet or dashboard) whose content is a set of ELEMENTS, each addressed by a
// string key the product chooses ("el_k3j2", "c:Sheet1!B2", "b_kpi1"). An
// element is a kind plus flat JSON fields. Writes are ops on one element:
//
//   put  create or replace the element whole
//   set  merge fields shallowly into it (a null removes the field)
//   del  delete it
//
// The server applies ops in arrival order and stamps each element write with
// a per-doc revision (`rev`), so the latest writer of a FIELD wins and every
// client converges on the server's order. Products never see revisions as a
// conflict to resolve: they write ops and read elements.

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Row fields the sync layer owns. A product's element fields never use these names. */
export const RESERVED_ELEMENT_FIELDS = ["_id", "doc_id", "layer", "key", "kind", "rev", "by", "at", "deleted", "dead"] as const;
export type ReservedElementField = (typeof RESERVED_ELEMENT_FIELDS)[number];
const RESERVED = new Set<string>(RESERVED_ELEMENT_FIELDS);

/** A product's element fields: any JSON, minus the reserved names. */
export type ElementFields = { [k: string]: Json | undefined } & { [K in ReservedElementField]?: never };

/** What every element carries: its key and kind, who wrote it last, and any JSON fields. */
export type ElementBase = {
  [field: string]: Json | undefined;
  key: string;
  kind: string;
  /** Server revision of the element's last write (0 for an unconfirmed local create). */
  rev: number;
  /** Actor of the last write: "u:<userId>" or "s:<conversationId>". */
  by?: string;
  at?: number;
};

/** One element as a product reads it: the base plus the product's own typed fields. */
export type ArtifactElement<F extends ElementFields = {}> = Omit<F, ReservedElementField> & ElementBase;

export type PutOp = { k: string; put: { kind: string } & Record<string, Json> };
export type SetOp = { k: string; set: Record<string, Json> };
export type DelOp = { k: string; del: true };
export type ArtifactOp = PutOp | SetOp | DelOp;

/** The layer a write lands in: the artifact itself, or its one pending draft. */
export type ArtifactLayer = "main" | "draft";

export const ARTIFACT_LIMITS = {
  /** Ops in one batch (one mutation). Clients split larger writes. */
  opsPerBatch: 400,
  /** Serialized size of one element's fields. */
  elementBytes: 32 * 1024,
  /** Serialized size of one batch (a transaction writes it twice: rows and the log). */
  batchBytes: 2 * 1024 * 1024,
  keyMax: 160,
} as const;

const KEY_RE = /^[A-Za-z0-9_:.!$\-/]+$/;

export function isValidElementKey(k: unknown): k is string {
  return typeof k === "string" && k.length > 0 && k.length <= ARTIFACT_LIMITS.keyMax && KEY_RE.test(k);
}

const utf8 = new TextEncoder();

/** A value's size as stored: its JSON in UTF-8 bytes. */
export function jsonBytes(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).length;
}

/** Why a batch cannot be written, or null when it can. Run by the server and by clients before sending. */
export function opsProblem(ops: readonly ArtifactOp[]): string | null {
  if (!Array.isArray(ops)) return "ops must be an array";
  if (ops.length > ARTIFACT_LIMITS.opsPerBatch) return `at most ${ARTIFACT_LIMITS.opsPerBatch} ops per batch`;
  if (jsonBytes(ops) > ARTIFACT_LIMITS.batchBytes) return `a batch is at most ${ARTIFACT_LIMITS.batchBytes} bytes; split it`;
  for (const op of ops as any[]) {
    if (!op || !isValidElementKey(op.k)) return `bad element key ${JSON.stringify(op?.k)}`;
    const body = "put" in op ? op.put : "set" in op ? op.set : null;
    if (body === null) {
      if (op.del !== true) return `op on ${op.k} needs put, set or del`;
      continue;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return `op on ${op.k}: fields must be an object`;
    if ("put" in op && (typeof op.put.kind !== "string" || !op.put.kind)) return `put on ${op.k} needs a kind`;
    for (const f of Object.keys(body)) {
      if (f === "kind" && "put" in op) continue;
      if (RESERVED.has(f)) return `field "${f}" on ${op.k} is reserved`;
    }
    if (jsonBytes(body) > ARTIFACT_LIMITS.elementBytes) return `element ${op.k} is over ${ARTIFACT_LIMITS.elementBytes} bytes`;
  }
  return null;
}

/** An element's stored state: kind + fields, or a tombstone. */
export type ElementState = { kind: string; fields: Record<string, Json>; deleted?: boolean };

/** Apply one op to an element's state. Pure; used by the server, the web store and the CLI. */
export function applyOp(prev: ElementState | undefined, op: ArtifactOp): ElementState {
  if ("del" in op) return { kind: prev?.kind ?? "deleted", fields: {}, deleted: true };
  if ("put" in op) {
    const { kind, ...fields } = op.put;
    return { kind, fields: stripNulls(fields) };
  }
  // A set on a missing or deleted element has nothing to merge into: it
  // resurrects nothing, so the op is a no-op there.
  if (!prev || prev.deleted) return prev ?? { kind: "deleted", fields: {}, deleted: true };
  const fields = { ...prev.fields };
  for (const [f, val] of Object.entries(op.set)) {
    if (val === null) delete fields[f];
    else fields[f] = val;
  }
  return { kind: prev.kind, fields };
}

function stripNulls(fields: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [f, val] of Object.entries(fields)) if (val !== null && val !== undefined) out[f] = val;
  return out;
}

/** Fold batches of ops over a state map, in order. */
export function foldOps(state: Map<string, ElementState>, ops: readonly ArtifactOp[]): Map<string, ElementState> {
  for (const op of ops) state.set(op.k, applyOp(state.get(op.k), op));
  return state;
}

/**
 * Merge a run of ops into the fewest ops with the same effect, preserving
 * the order of first touch. A drag that sets x/y sixty times a second, or a
 * typing run, becomes one op per element per flush.
 */
export function coalesceOps(ops: readonly ArtifactOp[]): ArtifactOp[] {
  const byKey = new Map<string, ArtifactOp>();
  for (const op of ops) {
    const prev = byKey.get(op.k);
    if (!prev || "del" in op || "put" in op) {
      byKey.delete(op.k);
      byKey.set(op.k, op);
      continue;
    }
    if ("del" in prev) continue; // set after del: no-op on a deleted element
    if ("put" in prev) {
      const merged = { ...prev.put } as Record<string, Json>;
      for (const [f, val] of Object.entries(op.set)) {
        if (val === null) delete merged[f];
        else merged[f] = val;
      }
      byKey.set(op.k, { k: op.k, put: merged as PutOp["put"] });
    } else {
      byKey.set(op.k, { k: op.k, set: { ...prev.set, ...op.set } });
    }
  }
  return [...byKey.values()];
}

/**
 * The ops that take `ops` back, given the state they were applied to. Used by
 * the shared undo stack: undo is just another write, so it syncs and
 * converges like any edit.
 */
export function invertOps(before: (key: string) => ElementState | undefined, ops: readonly ArtifactOp[]): ArtifactOp[] {
  const seen = new Set<string>();
  const inverse: ArtifactOp[] = [];
  for (const op of ops) {
    if (seen.has(op.k)) continue;
    seen.add(op.k);
    const prev = before(op.k);
    if (!prev || prev.deleted) {
      inverse.push({ k: op.k, del: true });
    } else if ("set" in op) {
      const restore: Record<string, Json> = {};
      // Every field any later op on this key touches, read from the before state.
      for (const later of ops) {
        if (later.k !== op.k || !("set" in later)) continue;
        for (const f of Object.keys(later.set)) restore[f] = prev.fields[f] ?? null;
      }
      if (ops.some((o) => o.k === op.k && !("set" in o))) inverse.push({ k: op.k, put: { kind: prev.kind, ...prev.fields } });
      else inverse.push({ k: op.k, set: restore });
    } else {
      inverse.push({ k: op.k, put: { kind: prev.kind, ...prev.fields } });
    }
  }
  return inverse.reverse();
}

/** The ops that turn `from` into `to` (restore, draft save). */
export function diffStates(from: Map<string, ElementState>, to: Map<string, ElementState>): ArtifactOp[] {
  const ops: ArtifactOp[] = [];
  for (const [k, next] of to) {
    if (next.deleted) {
      const cur = from.get(k);
      if (cur && !cur.deleted) ops.push({ k, del: true });
      continue;
    }
    const cur = from.get(k);
    if (cur && !cur.deleted && cur.kind === next.kind && sameJson(cur.fields, next.fields)) continue;
    ops.push({ k, put: { kind: next.kind, ...next.fields } });
  }
  for (const [k, cur] of from) if (!cur.deleted && !to.has(k)) ops.push({ k, del: true });
  return ops;
}

export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!sameJson((a as any)[k], (b as any)[k])) return false;
  return true;
}

/** Split ops into batches the server takes in one write: by count and by bytes. */
export function chunkOps(ops: readonly ArtifactOp[], size: number = ARTIFACT_LIMITS.opsPerBatch, bytes: number = ARTIFACT_LIMITS.batchBytes - 1024): ArtifactOp[][] {
  const out: ArtifactOp[][] = [];
  let cur: ArtifactOp[] = [];
  let curBytes = 2;
  for (const op of ops) {
    const n = jsonBytes(op) + 1;
    if (cur.length && (cur.length >= size || curBytes + n > bytes)) {
      out.push(cur);
      cur = [];
      curBytes = 2;
    }
    cur.push(op);
    curBytes += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** ElementState -> the flat element a product reads. */
export function toElement(key: string, s: ElementState, meta?: { rev?: number; by?: string; at?: number }): ArtifactElement {
  return { ...(s.fields as any), key, kind: s.kind, rev: meta?.rev ?? 0, by: meta?.by, at: meta?.at };
}

/** A flat element (or store row) -> ElementState. */
export function fromElement(el: Record<string, any>): ElementState {
  const fields: Record<string, Json> = {};
  for (const [f, val] of Object.entries(el)) if (!RESERVED.has(f) && val !== undefined) fields[f] = val as Json;
  return { kind: el.kind, fields, ...(el.deleted ? { deleted: true } : {}) };
}

// ── Presence ────────────────────────────────────────────────────────────────

/**
 * Where a participant is in the artifact. Each product fills the part that
 * fits it; renderers ignore the rest.
 */
export type ArtifactPosition = {
  /** Canvas point in board coordinates. */
  point?: { x: number; y: number };
  /** One sheet cell: "Sheet1!B2". */
  cell?: string;
  /** A sheet range: "Sheet1!A1:G10". An agent's write region. */
  range?: string;
  /** A dashboard block key. */
  block?: string;
  /** Any element, by key (a comment anchored to it, a board element). */
  key?: string;
};

export type ArtifactPresence = {
  /** "u:<userId>:<tab>" for a person's tab, "s:<conversationId>" for an agent session. */
  actor: string;
  kind: "person" | "agent";
  name: string;
  color: string;
  image?: string;
  /** The agent session, for an agent; links its tag to the session. */
  session_id?: string;
  session_short_id?: string;
  position?: ArtifactPosition;
  /** Element keys this participant has selected (or just wrote, for an agent). */
  selection?: string[];
  /** What it is doing, a few words: "editing", "writing B2:G10". */
  status?: string;
  updated_at: number;
};

/** How long presence counts as live: a person's tab beats every few seconds, an agent's writes are bursty. */
export const PRESENCE_TTL_MS = { person: 30_000, agent: 90_000 } as const;

export function isPresenceLive(p: Pick<ArtifactPresence, "kind" | "updated_at">, now: number): boolean {
  return now - p.updated_at < PRESENCE_TTL_MS[p.kind];
}

// ── Ask an agent ────────────────────────────────────────────────────────────

/** Where an ask goes: a new session in the artifact's project, or a live session. */
export type AskAgentTarget = { kind: "new"; agent?: string } | { kind: "session"; conversation_id: string };

export type AskAgentInput = {
  doc_id: string;
  prompt: string;
  selection?: string[];
  position?: ArtifactPosition;
  /** The comment pin this ask came from, so the agent can answer on it. */
  comment_key?: string;
  /** Write into the draft layer (Data's Design flow). */
  draft?: boolean;
  target: AskAgentTarget;
};

// No reds: a red cursor or outline next to an error (a #DIV/0! cell, a failed
// check) reads as part of it. Agents also skip yellow and orange, so an agent's
// write region never looks like a warning.
const PERSON_COLORS = ["#61afef", "#c678dd", "#98c379", "#56b6c2", "#e5c07b", "#d19a66"];
const AGENT_COLORS = ["#61afef", "#c678dd", "#56b6c2", "#98c379"];

/** A participant's color, stable for an id: the same person or session reads as the same color everywhere. */
export function presenceColor(seed: string, kind: "person" | "agent" = "person"): string {
  const palette = kind === "agent" ? AGENT_COLORS : PERSON_COLORS;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

/** Text color that reads on a participant's color: dark on light colors, white on dark ones. */
export function textOnColor(hex: string): string {
  const m = hex.replace("#", "").match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return "#ffffff";
  const lin = (c: string) => {
    const v = parseInt(c, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
  // Contrast against white vs near-black (#1b1f23, luminance ~0.014): pick the larger.
  return (1.05) / (l + 0.05) >= (l + 0.05) / 0.064 ? "#ffffff" : "#1b1f23";
}
