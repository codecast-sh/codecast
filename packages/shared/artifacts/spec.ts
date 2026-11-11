// How a product (Boards, Sheets, Data) plugs into the artifact layer. A
// product defines ONE ArtifactSpec in its own file under shared/artifacts and
// lists it in registry.ts. The spec is pure (no I/O), so the server, the web
// page and the CLI all run the same code: the server checks kinds, the CLI
// renders `read` and runs the product's verbs, the web seeds new docs.
import type { ArtifactElement, ArtifactOp, ArtifactPosition } from "./core";

export const ARTIFACT_DOC_TYPES = ["board", "sheet", "dashboard"] as const;
export type ArtifactType = (typeof ARTIFACT_DOC_TYPES)[number];

export function isArtifactDocType(t: unknown): t is ArtifactType {
  return typeof t === "string" && (ARTIFACT_DOC_TYPES as readonly string[]).includes(t);
}

/** What a spec reads: the visible elements (deleted ones left out), keyed and in key order. */
export type ArtifactView = {
  type: ArtifactType;
  title: string;
  elements: ArtifactElement[];
  get(key: string): ArtifactElement | undefined;
};

export function artifactView(type: ArtifactType, title: string, elements: ArtifactElement[]): ArtifactView {
  const sorted = [...elements].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const byKey = new Map(sorted.map((e) => [e.key, e]));
  return { type, title, elements: sorted, get: (k) => byKey.get(k) };
}

/** The result of a product verb: the ops to write and where the agent's cursor lands. */
export type VerbResult = { ops: ArtifactOp[]; position?: ArtifactPosition; status?: string };

/**
 * A product CLI verb: `cast <cli> <verb> <doc> [args...]`. Pure: it reads the
 * current view and its arguments (and stdin, when `stdin` is set) and returns
 * ops. Throw an Error with a usage message on bad input.
 */
export type ArtifactVerb = {
  summary: string;
  usage: string;
  stdin?: boolean;
  run(view: ArtifactView, args: string[], stdin?: string): VerbResult;
};

export type ArtifactSpec = {
  type: ArtifactType;
  /** Doc-type label ("Board"). */
  label: string;
  /** The CLI group: `cast board`, `cast sheet`, `cast data`. */
  cli: string;
  /** Every element kind this product writes. The server refuses any other kind. */
  kinds: readonly string[];
  /** A compact text form of the artifact an agent can reason over (`cast <cli> read`). */
  describe(view: ArtifactView): string;
  /** Where an agent's cursor goes after it writes these keys. */
  presenceFor?(view: ArtifactView, keys: string[]): ArtifactPosition | undefined;
  /** Elements a new artifact starts with. */
  seed?(): ArtifactOp[];
  /** Product verbs beyond the shared ones (create, read, apply, history, ...). */
  verbs?: Record<string, ArtifactVerb>;
  /**
   * Verbs that need the server (run a query, list sources). The CLI posts to
   * /cli/live/remote; the server runs `action` (an internal action name such
   * as "dataQueries:cliQuery") with {user_id, actor, actor_name, doc_id?,
   * args, stdin?}, which returns {text?, json?}.
   */
  remote?: Record<string, { summary: string; usage: string; stdin?: boolean; needsDoc?: boolean; action: string }>;
  /** Lines appended to `cast <cli> --help` and to the brief an asked agent gets: how to write this product well. */
  agentGuide: string;
};

/** Short, stable, URL-safe element id for a new element: `<prefix>_<8 chars>`. */
export function newElementKey(prefix: string): string {
  const alphabet = "abcdefghijkmnopqrstuvwxyz23456789";
  let s = "";
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${prefix}_${s}`;
}

/** Fields formatted for a describe line: `x=10 y=20 text="Lock pricing"`. Skips the given names. */
export function formatFields(el: ArtifactElement, skip: readonly string[] = []): string {
  const omit = new Set(["key", "kind", "rev", "by", "at", ...skip]);
  return Object.entries(el)
    .filter(([f, val]) => !omit.has(f) && val !== undefined)
    .map(([f, val]) => `${f}=${typeof val === "string" ? JSON.stringify(val) : JSON.stringify(val)}`)
    .join(" ");
}
