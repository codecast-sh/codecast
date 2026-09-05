import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONVERSATION_FIELD_TWINS,
  DISPATCHABLE_CONVERSATION_FIELDS,
  PATCHABLE_CONVERSATION_FIELDS,
  SENDABLE_CONVERSATION_FIELDS,
  TRIAGE_CONVERSATION_FIELDS,
  VISIBILITY_CONVERSATION_FIELDS,
} from "@codecast/shared/contracts";

// The manifest (contracts/conversationFields) is the single declaration of what
// a conversation field is for. Two things have to stay true for it to be worth
// anything, and neither is expressible in the type system.
//
// FIRST: the row projections are hand-written literals, because they emit
// derived and joined keys next to the document's own. So the manifest cannot
// generate them, and a field can be written by the client while no projection
// sends it back. That combination is silent in production — the conversations
// table runs with schemaValidation off, so prod stores the field and every read
// omits it, and the gesture appears to undo itself a second later. This test is
// what makes that omission loud.
//
// SECOND: the derived lists must equal what the hand-written ones held, or the
// refactor that introduced the manifest changed behaviour. The expected values
// below are those literals, kept verbatim.

const source = (file: string) => readFileSync(join(import.meta.dir, file), "utf8");

/** A top-level function, from its declaration to the closing brace in column
 *  zero, with comments stripped so a mention in prose never counts as a field.
 *  Sliced rather than brace-matched: these signatures carry inline object types
 *  AND object return types, both of which fool a naive first-brace scan. */
function functionBody(src: string, declaration: string): string {
  const at = src.indexOf(declaration);
  expect(at, `${declaration} not found`).toBeGreaterThan(-1);
  // A line that is exactly "}", so the "})" that closes an inline parameter
  // type never reads as the end of the function.
  const end = src.indexOf("\n}\n", at);
  expect(end, `${declaration} has no top-level end`).toBeGreaterThan(at);
  return src.slice(at, end).replace(/\/\/[^\n]*/g, "");
}

const carries = (body: string, field: string) => new RegExp(`\\b${field}\\s*:`).test(body);

describe("conversation field manifest", () => {
  // Both ROW projections, not the liveness bundle: deriveLivenessAt carries the
  // three stamps that give a row a clock deadline (dismissed, stashed, snoozed)
  // as INPUTS to deriveLiveAt, and a rest verdict has no deadline of its own —
  // it expires when activity moves updated_at, which is an event, not a time.
  const rowProjections = [
    ["enrichInboxSessionRow", functionBody(source("conversations.ts"), "async function enrichInboxSessionRow")],
    ["buildSubagentChildRow", functionBody(source("conversations.ts"), "function buildSubagentChildRow")],
  ] as const;

  // Favorite membership belongs to the conversation's runner principal, not to
  // a child row, so the child projection leaves it out on purpose.
  const CHILD_ROW_EXEMPT = new Set(["is_favorite"]);

  for (const [name, body] of rowProjections) {
    test(`${name} carries every sendable field`, () => {
      const exempt = name === "buildSubagentChildRow" ? CHILD_ROW_EXEMPT : new Set<string>();
      const missing = SENDABLE_CONVERSATION_FIELDS.filter((f) => !exempt.has(f) && !carries(body, f));
      expect(missing).toEqual([]);
    });
  }

  test("a stamp's derived twin travels with it", () => {
    const [, main] = rowProjections[0];
    for (const twin of Object.values(CONVERSATION_FIELD_TWINS)) {
      expect(carries(main, twin), `${twin} missing from enrichInboxSessionRow`).toBe(true);
    }
  });

  test("inboxVisibilityFields covers exactly the visibility bundle", () => {
    const body = functionBody(source("inboxProjection.ts"), "export function inboxVisibilityFields");
    const emitted = [...body.matchAll(/^\s{4}([a-z_]+):/gm)].map((m) => m[1]);
    expect(emitted.sort()).toEqual([...VISIBILITY_CONVERSATION_FIELDS].sort());
  });

  test("the derived allowlists still equal the literals they replaced", () => {
    expect([...PATCHABLE_CONVERSATION_FIELDS].sort()).toEqual([
      "agent_type", "draft_message", "git_root", "inbox_deferred_at", "inbox_dismissed_at",
      "inbox_pinned_at", "inbox_rest", "inbox_rest_at", "inbox_snoozed_until", "project_path",
    ]);
    expect([...DISPATCHABLE_CONVERSATION_FIELDS].sort()).toEqual([
      "inbox_deferred_at", "inbox_dismissed_at", "inbox_pinned_at", "inbox_rest", "inbox_rest_at",
      "inbox_snoozed_until", "inbox_stash_hidden", "inbox_stashed_at", "is_favorite", "title",
    ]);
    expect([...TRIAGE_CONVERSATION_FIELDS].sort()).toEqual([
      "inbox_deferred_at", "inbox_dismissed_at", "inbox_killed_at", "inbox_pinned_at", "inbox_rest",
      "inbox_rest_at", "inbox_snoozed_until", "inbox_stashed_at", "is_deferred", "is_pinned", "user_rest",
    ]);
    expect(CONVERSATION_FIELD_TWINS).toEqual({
      inbox_pinned_at: "is_pinned",
      inbox_deferred_at: "is_deferred",
      inbox_rest_at: "user_rest",
    });
  });

  test("every dispatchable field is also sendable, or its twin is", () => {
    // The rule that would have caught today's bug at the source: a field the
    // client may WRITE has to come back somehow, either raw or through a twin.
    const sendable = new Set<string>(SENDABLE_CONVERSATION_FIELDS);
    const writeOnly = DISPATCHABLE_CONVERSATION_FIELDS.filter(
      // A twin counts as the field coming back: the projection carries it
      // instead of the raw stamp, which the twin test above proves.
      (f) => !sendable.has(f) && !CONVERSATION_FIELD_TWINS[f],
    );
    expect(writeOnly).toEqual([]);
  });
});
