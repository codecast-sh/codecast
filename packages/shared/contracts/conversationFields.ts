// ── The conversation field manifest ─────────────────────────────────────────
//
// One declaration per field, read by both sides. A conversation field earns an
// entry here as soon as more than one place has to agree about it, which in
// practice means every triage stamp: the same field name used to be repeated in
// the server's patch gate, the client's dispatch whitelist, the overlay's
// in-flight set, the ack twin map and the visibility bundle, with nothing
// tying the five together.
//
// The failure that pattern produces is silent in both directions. A field the
// client may WRITE but no projection SENDS is stored and invisible: prod
// accepts it (the conversations table runs with schemaValidation off, and the
// dispatch rail filters only immutable fields), the row moves optimistically,
// then the next payload arrives without it and the gesture appears to undo
// itself a second later. A field listed on one side's write allowlist and not
// the other's is dropped with no error at all.
//
// So the lists are derived from this object rather than restated. Adding a
// triage field is one entry; leaving it out of a projection is a test failure
// (contracts/__tests__/conversationFields.guard.test.ts) instead of a bug
// report a day later.
//
// What this does NOT solve: a client newer than the deployment still writes
// into a hole, because the manifest ships with the tree and the tree is not
// what prod is running. That needs a capability handshake, which is its own
// change.

export type ConversationFieldSpec = {
  /** A row projection carries it to clients. Guarded, not derived: the
   *  projections also emit derived and joined keys, so they stay hand-written
   *  and the guard test proves they carry every sendable field. */
  send?: boolean;
  /** The client's local-first sync rail may write it (the sessions
   *  dispatchTable in store/clientSyncRegistry.ts). */
  dispatch?: boolean;
  /** The explicit conversations.patchConversation mutation accepts it. */
  patch?: boolean;
  /** A triage stamp: an in-flight write to it makes the row overlay-affected,
   *  so the inbox holds the optimistic placement until the echo lands. */
  triage?: boolean;
  /** The enriched session field derived from this stamp, which the server
   *  currency-filters and which retires with this field's ack. */
  twin?: string;
  /** Part of the visibility bundle every row projection carries together
   *  (convex/inboxProjection.inboxVisibilityFields). */
  visibility?: boolean;
};

export const CONVERSATION_FIELDS = {
  // ── Triage stamps ────────────────────────────────────────────────────────
  inbox_dismissed_at: { send: true, dispatch: true, patch: true, triage: true, visibility: true },
  inbox_stashed_at: { send: true, dispatch: true, triage: true, visibility: true },
  inbox_stash_hidden: { send: true, dispatch: true, visibility: true },
  // Set by the kill path, never by the generic rail: the dispatch drops a
  // clear that is not itself an un-kill, so it is triage-tracked but not
  // dispatchable here.
  inbox_killed_at: { send: true, triage: true, visibility: true },
  inbox_pinned_at: { send: true, dispatch: true, patch: true, triage: true, twin: "is_pinned", visibility: true },
  inbox_snoozed_until: { send: true, dispatch: true, patch: true, triage: true, visibility: true },
  // Defer is the one stamp the client learns only through its twin: the row
  // carries is_deferred, currency-filtered by the server, and the raw stamp
  // stays behind. The rest verdict below deliberately does the opposite.
  inbox_deferred_at: { dispatch: true, patch: true, triage: true, twin: "is_deferred" },
  // The user's own rest verdict travels RAW as well as derived, because every
  // replica re-checks the stamp against updated_at itself (userRestOf) and two
  // replicas that re-derive from the same two numbers cannot disagree.
  inbox_rest: { send: true, dispatch: true, patch: true, triage: true },
  inbox_rest_at: { send: true, dispatch: true, patch: true, triage: true, twin: "user_rest" },

  // ── Plain fields the client may edit ─────────────────────────────────────
  title: { send: true, dispatch: true },
  is_favorite: { send: true, dispatch: true },
  // Per-user and delivered on its own path, so it is writable but never part
  // of the shared row.
  draft_message: { patch: true },
  project_path: { send: true, patch: true },
  git_root: { send: true, patch: true },
  agent_type: { send: true, patch: true },
} as const satisfies Record<string, ConversationFieldSpec>;

export type ConversationField = keyof typeof CONVERSATION_FIELDS;

const entries = Object.entries(CONVERSATION_FIELDS) as Array<[ConversationField, ConversationFieldSpec]>;
const withFlag = (flag: keyof ConversationFieldSpec): ConversationField[] =>
  entries.filter(([, spec]) => spec[flag]).map(([name]) => name);

/** Fields every row projection must carry to clients. */
export const SENDABLE_CONVERSATION_FIELDS = withFlag("send");

/** The client sync rail's write allowlist. */
export const DISPATCHABLE_CONVERSATION_FIELDS = withFlag("dispatch");

/** The explicit patchConversation mutation's write allowlist. */
export const PATCHABLE_CONVERSATION_FIELDS = withFlag("patch");

/** The visibility bundle carried as one unit by every projection. */
export const VISIBILITY_CONVERSATION_FIELDS = withFlag("visibility");

/** Stamp → the enriched twin that retires with its ack. */
export const CONVERSATION_FIELD_TWINS: Record<string, string> = Object.fromEntries(
  entries.filter(([, spec]) => spec.twin).map(([name, spec]) => [name, spec.twin as string]),
);

/** Every field whose in-flight write makes a row overlay-affected: the triage
 *  stamps and the twins the same gesture writes beside them. */
export const TRIAGE_CONVERSATION_FIELDS: string[] = entries
  .filter(([, spec]) => spec.triage)
  .flatMap(([name, spec]) => (spec.twin ? [name, spec.twin] : [name]));
