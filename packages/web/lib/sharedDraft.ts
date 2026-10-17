// A session's composer as one shared buffer: while two or more people have
// the same conversation's composer open, their boxes hold the same text and
// every keystroke lands in both, the way a shared doc does.
//
// The buffer is a plain text ProseMirror doc (doc > text*) synced over the
// same step log the document editor uses (docSync.getSteps / submitSteps),
// under the composer's presence id `compose:<conversationId>`, which that
// backend already accepts and gates on conversation access. A text position
// in the doc IS the textarea offset, so a step maps a caret without any
// translation. This module is the pure half: the schema, the edit a textarea
// change makes, and what a box holds when it joins a shared draft.
import { Schema, type Node as PMNode } from "@tiptap/pm/model";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { Step } from "@tiptap/pm/transform";
import { collab, getVersion, receiveTransaction, sendableSteps } from "prosemirror-collab";

export const sharedDraftSchema = new Schema({ nodes: { doc: { content: "text*" }, text: {} } });

export function docText(doc: PMNode): string {
  return doc.textContent;
}

export function docFromText(text: string): PMNode {
  return sharedDraftSchema.node("doc", null, text ? [sharedDraftSchema.text(text)] : []);
}

export function docFromJSON(json: unknown): PMNode {
  try {
    return sharedDraftSchema.nodeFromJSON(json);
  } catch {
    return docFromText("");
  }
}

export function createSharedDraftState(doc: PMNode, version: number, clientID: string): EditorState {
  return EditorState.create({ schema: sharedDraftSchema, doc, plugins: [collab({ version, clientID })] });
}

/**
 * The one replacement that turns `before` into `after`: the common prefix and
 * suffix stay, the middle is replaced. `caret` (the selection end after the
 * change) settles the ambiguity of a repeated character, so typing "a" into
 * "aa" is recorded where the caret is, which is what another person's caret
 * maps through.
 */
export function textEdit(before: string, after: string, caret?: number): { from: number; to: number; insert: string } | null {
  if (before === after) return null;
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  if (caret != null) prefix = Math.max(0, Math.min(prefix, caret - Math.max(0, after.length - before.length)));
  let suffix = 0;
  while (
    suffix < max - prefix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) suffix++;
  return { from: prefix, to: before.length - suffix, insert: after.slice(prefix, after.length - suffix) };
}

/** Apply a textarea change to the shared doc, or null when the text already matches. */
export function editTransaction(state: EditorState, after: string, caret?: number): Transaction | null {
  const edit = textEdit(docText(state.doc), after, caret);
  if (!edit) return null;
  const tr = state.tr;
  if (edit.insert) tr.replaceWith(edit.from, edit.to, sharedDraftSchema.text(edit.insert));
  else tr.delete(edit.from, edit.to);
  return tr;
}

export type JoinPlan = "keep" | "adopt" | "replace" | "append";

/**
 * What a box does with its own words when it joins a shared draft that holds
 * `shared`.
 *
 * keep: they already agree. adopt: my box is empty (or the draft already
 * holds my words), take the draft. replace: the draft is a leftover from an
 * earlier sitting and nobody is in it now, so the owner's box, the newest
 * copy, becomes the draft. append: someone is writing in the draft right now,
 * or I am not the owner, so my words go under theirs; nothing anyone typed
 * is dropped.
 */
export function joinPlan(shared: string, local: string, opts: { seed: boolean; othersLive: boolean }): JoinPlan {
  if (shared === local) return "keep";
  if (!local.trim() || shared.includes(local.trim())) return "adopt";
  if (!shared.trim()) return "replace";
  if (opts.seed && !opts.othersLive) return "replace";
  return "append";
}

export function joinedText(shared: string, local: string, plan: JoinPlan): string {
  switch (plan) {
    case "keep":
    case "adopt":
      return shared;
    case "replace":
      return local;
    case "append":
      return `${shared.replace(/\s+$/, "")}\n\n${local.trim()}`;
  }
}

/** Client ids carry their author, so a received step says who typed it. */
export function sharedClientId(userId: string): string {
  return `${userId}~${Math.random().toString(36).slice(2, 10)}`;
}

export function authorOfClientId(clientId: string | number): string {
  return String(clientId).split("~")[0];
}

/** Snapshot the draft this often (in steps), so a joining box loads one row and a short tail. */
export const SHARED_DRAFT_SNAPSHOT_EVERY = 100;

// ── The sync session ─────────────────────────────────────────────────────────

type ClientIds = (string | number)[];

/** The step log, as docSync serves it. */
export type SharedDraftServer = {
  snapshot(id: string): Promise<{ content: string | null; version?: number }>;
  steps(id: string, version: number): Promise<{ steps: string[]; clientIds: ClientIds; version: number }>;
  submit(id: string, version: number, clientId: string, steps: string[]): Promise<{ status: "synced" } | { status: "needs-rebase"; steps: string[]; clientIds: ClientIds }>;
  saveSnapshot(id: string, version: number, content: string): Promise<unknown>;
};

export type SharedDraftEvents = {
  /** The draft changed under the box: show `next`, mapping a caret through `map`. */
  text(next: string, map: (pos: number) => number): void;
  /** The version this box has caught up to; the live subscription follows it. */
  version(v: number): void;
  /** Someone else's keystrokes just landed. */
  remoteEdit(userId: string): void;
};

const parseSteps = (steps: string[]) => steps.map((s) => Step.fromJSON(sharedDraftSchema, JSON.parse(s)));

/**
 * One box's connection to a shared draft: load it, fold this box's words in
 * (joinPlan), then send local edits and take remote ones. Every server answer
 * says which version its steps start at, and steps this box already holds are
 * skipped, so the live subscription and a submit's own answer can both carry
 * the same steps without applying them twice.
 */
export class SharedDraftSession {
  state: EditorState | null = null;
  private inflight = false;
  private closed = false;
  private snapshotAt = 0;

  constructor(
    private readonly id: string,
    private readonly clientId: string,
    private readonly server: SharedDraftServer,
    private readonly on: SharedDraftEvents,
  ) {}

  get text(): string | null {
    return this.state ? docText(this.state.doc) : null;
  }

  get version(): number | null {
    return this.state ? getVersion(this.state) : null;
  }

  /** Load the draft and fold `local()` in. Resolves with what the box now holds, or null when closed first. */
  async join(local: () => string, opts: { seed: boolean; othersLive: () => boolean }): Promise<string | null> {
    const snap = await this.server.snapshot(this.id);
    let state = createSharedDraftState(
      snap.content ? docFromJSON(JSON.parse(snap.content)) : docFromText(""),
      snap.content ? snap.version ?? 0 : 0,
      this.clientId,
    );
    this.snapshotAt = getVersion(state);
    for (let page = 0; page < 50; page++) {
      const r = await this.server.steps(this.id, getVersion(state));
      if (this.closed) return null;
      if (r.steps.length === 0) break;
      state = state.apply(receiveTransaction(state, parseSteps(r.steps), r.clientIds));
    }
    if (this.closed) return null;
    const shared = docText(state.doc);
    const mine = local();
    const target = joinedText(shared, mine, joinPlan(shared, mine, { seed: opts.seed, othersLive: opts.othersLive() }));
    const tr = editTransaction(state, target);
    this.state = tr ? state.apply(tr) : state;
    this.on.version(getVersion(this.state));
    void this.flush();
    return target;
  }

  /** The box's text changed (typing, a paste, a send that emptied it). */
  edit(text: string, caret?: number): void {
    if (!this.state) return;
    const tr = editTransaction(this.state, text, caret);
    if (!tr) return;
    this.state = this.state.apply(tr);
    void this.flush();
  }

  /** Steps from the server starting at version `from`. */
  receive(from: number, steps: string[], clientIds: ClientIds): void {
    const state = this.state;
    if (!state) return;
    const skip = getVersion(state) - from;
    if (skip < 0 || skip >= steps.length) return;
    const ids = clientIds.slice(skip);
    const tr = receiveTransaction(state, parseSteps(steps.slice(skip)), ids, { mapSelectionBackward: true });
    this.state = state.apply(tr);
    const before = docText(state.doc);
    const after = docText(this.state.doc);
    if (before !== after) this.on.text(after, (pos) => tr.mapping.map(Math.min(pos, before.length), -1));
    for (const id of ids) if (String(id) !== this.clientId) this.on.remoteEdit(authorOfClientId(id));
    this.on.version(getVersion(this.state));
  }

  async flush(): Promise<void> {
    if (!this.state || this.inflight || this.closed) return;
    const send = sendableSteps(this.state);
    if (!send) return;
    this.inflight = true;
    let retryIn = 0;
    try {
      const res = await this.server.submit(this.id, send.version, String(send.clientID), send.steps.map((s) => JSON.stringify(s.toJSON())));
      if (res.status === "needs-rebase") {
        this.receive(send.version, res.steps, res.clientIds);
      } else if (this.state) {
        // Confirm our own steps (and anything that landed just before them).
        const r = await this.server.steps(this.id, getVersion(this.state));
        this.receive(r.version - r.steps.length, r.steps, r.clientIds);
        this.maybeSnapshot();
      }
    } catch {
      retryIn = 1000;
    } finally {
      this.inflight = false;
    }
    if (this.state && !this.closed && sendableSteps(this.state)) {
      if (retryIn) setTimeout(() => void this.flush(), retryIn);
      else await this.flush();
    }
  }

  private maybeSnapshot(): void {
    const state = this.state;
    if (!state || sendableSteps(state)) return;
    const v = getVersion(state);
    if (v - this.snapshotAt < SHARED_DRAFT_SNAPSHOT_EVERY) return;
    this.snapshotAt = v;
    void this.server.saveSnapshot(this.id, v, JSON.stringify(state.doc.toJSON())).catch(() => {});
  }

  close(): void {
    this.closed = true;
    this.state = null;
  }
}
