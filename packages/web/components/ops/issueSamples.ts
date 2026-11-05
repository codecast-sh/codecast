// Kept samples: the tag breakdown, the replay moment, and a stack as frame
// rows. No React, no store.
import { failureMessageKey, parseStackFrame } from "@codecast/shared/contracts/signalFingerprint";
import type { OpsSample } from "./opsTypes";
import { FAILURE_KEY } from "./issueFold";

// ── Samples: the tag breakdown and the replay moment ──

const PREFERRED_TAGS = ["browser", "os", "device", "environment", "release", "url", "user", "level", "runtime", "server_name"];

/** A sample's value for a tag key: its own fields first, then its tags. */
export function sampleTag(s: OpsSample, key: string, tags?: Record<string, unknown> | null): string | null {
  // A job's failure split filters the samples by what each said (jobFailureSplit).
  if (key === FAILURE_KEY) return failureMessageKey(s.message) || null;
  if (key === "environment") return s.environment ?? null;
  if (key === "release") return s.release ?? null;
  if (key === "level") return s.level ?? null;
  if (key === "user") return s.user?.email ?? s.user?.name ?? s.user?.id ?? null;
  if (key === "url") {
    if (!s.url) return null;
    try {
      const u = new URL(s.url);
      return `${u.host}${u.pathname}`;
    } catch {
      return s.url;
    }
  }
  const v = (tags ?? parseTags(s.tags_json))?.[key];
  return v === undefined || v === null || v === "" ? null : String(v);
}

export function parseTags(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** `distinct` is how many values the key took; a key where nearly every sample differs (`spread`) says nothing by its top values. */
export type TagFacet = { key: string; total: number; distinct: number; spread: boolean; values: { value: string; count: number; share: number }[] };

/**
 * Each tag key across the kept samples with its top values and their share,
 * the keys people triage by first. Only keys at least one sample carries.
 */
export function sampleFacets(samples: OpsSample[], topN = 4, maxKeys = 10): TagFacet[] {
  const byKey = new Map<string, Map<string, number>>();
  for (const s of samples) {
    const tags = parseTags(s.tags_json);
    const keys = new Set([...PREFERRED_TAGS, ...Object.keys(tags ?? {})]);
    for (const k of keys) {
      const v = sampleTag(s, k, tags);
      if (v === null) continue;
      const m = byKey.get(k) ?? new Map<string, number>();
      m.set(v, (m.get(v) ?? 0) + 1);
      byKey.set(k, m);
    }
  }
  const rank = (k: string) => (PREFERRED_TAGS.includes(k) ? PREFERRED_TAGS.indexOf(k) : PREFERRED_TAGS.length);
  return [...byKey]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .slice(0, maxKeys)
    .map(([key, m]) => {
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      const values = [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topN).map(([value, count]) => ({ value, count, share: count / total }));
      return { key, total, distinct: m.size, spread: total >= 4 && m.size >= total * 0.8, values };
    });
}

const firstLine = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const m = o.message ?? o.value ?? o.error ?? o.reason;
    if (typeof m === "string" && m.trim()) return [typeof o.type === "string" ? o.type : typeof o.name === "string" ? o.name : null, m.trim()].filter(Boolean).join(": ");
  }
  return null;
};

/**
 * The line that says what went wrong in a sample, as an exception's type and
 * value: the first of its context's errors, its exception or error, else its
 * own message when the title does not already say it. A title like "1
 * provider write(s) failed" keeps the cause in the context, and this is the
 * line a person and an agent both need first. Null when nothing adds to the title.
 */
export function exceptionValue(s: Pick<OpsSample, "message" | "context_json">, title: string): string | null {
  const ctx = parseTags(s.context_json);
  const fromCtx = ctx
    ? (Array.isArray(ctx.errors) && ctx.errors.length ? firstLine(ctx.errors[0]) : null) ?? firstLine(ctx.exception) ?? firstLine(ctx.error) ?? firstLine(ctx.cause)
    : null;
  const v = fromCtx ?? (s.message && s.message.trim() !== title.trim() ? s.message.trim() : null);
  return v && v !== title.trim() && !title.includes(v) ? v : null;
}

/** The distinct people the kept samples name: a floor on who an issue hit, where the group counts none. */
export function sampleUsers(samples: Pick<OpsSample, "user">[]): number {
  return new Set(samples.map((s) => s.user?.email ?? s.user?.id ?? s.user?.name).filter(Boolean)).size;
}

/**
 * Where in its replay a sample happened, on the replay's own clock (ms since
 * it started), clamped into the recording. Null when the replay's start is
 * unknown.
 */
export function replayOffset(sampleAt: number, replay: { started_at?: number | null; duration_ms?: number | null } | null | undefined): number | null {
  if (!replay?.started_at) return null;
  const t = Math.max(0, sampleAt - replay.started_at);
  return replay.duration_ms ? Math.min(t, replay.duration_ms) : t;
}

// ── A stack as frame rows ──

export type StackFrameRow = { type: "frame"; i: number; fn: string; file: string; line: number | null; col: number | null; raw: string; in_app: boolean; minified: boolean };
export type StackRow = { type: "message"; text: string } | StackFrameRow | { type: "library"; frames: StackFrameRow[] };

/**
 * A stack read as rows: message lines, the product's own frames one by one,
 * and runs of two or more library frames folded into one row in place, so
 * the order of the stack survives. A frame whose line number is past 10,000
 * or whose file sits under a dist or build folder reads as minified.
 */
export function stackRows(stack: string | undefined): StackRow[] {
  if (!stack) return [];
  const out: StackRow[] = [];
  let run: StackFrameRow[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ type: "library", frames: run });
    else out.push(...run);
    run = [];
  };
  let i = 0;
  for (const rawLine of stack.split("\n")) {
    if (!rawLine.trim()) continue;
    const f = parseStackFrame(rawLine);
    if (!f) {
      flush();
      out.push({ type: "message", text: rawLine.trim() });
      continue;
    }
    const pos = /:(\d+)(?::(\d+))?\)?$/.exec(f.loc);
    const line = pos ? Number(pos[1]) : null;
    const row: StackFrameRow = {
      type: "frame",
      i: i++,
      fn: f.fn || "<anonymous>",
      file: f.file,
      line,
      col: pos?.[2] ? Number(pos[2]) : null,
      raw: rawLine.trim(),
      in_app: f.in_app,
      minified: (line ?? 0) > 10_000 || /\/(dist|build|_next\/static)\/|\.min\.js/.test(f.file),
    };
    if (row.in_app) {
      flush();
      out.push(row);
    } else run.push(row);
  }
  flush();
  return out;
}

/** The frame a stack opens on: the first of the product's own, else the first frame. */
export function leadFrame(rows: StackRow[]): number | null {
  const frames = rows.flatMap((r) => (r.type === "frame" ? [r] : r.type === "library" ? r.frames : []));
  return (frames.find((f) => f.in_app) ?? frames[0])?.i ?? null;
}
