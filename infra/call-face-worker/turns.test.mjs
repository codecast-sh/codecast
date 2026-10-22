// When the voice speaks, over the lines of real huddles: `node turns.test.mjs`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { nameMatchers, turnVerdict } from "./turns.mjs";

const named = nameMatchers(["Rufus", "Claude"]);
const room = { named, quiet: false, alone: false };

test("a room talking among itself never gets an answer", () => {
  // cl-158:545-570, after the voice had just spoken.
  for (const transcript of [
    "I can't hear you a shot.",
    "Can you hear me now?",
    "I was thinking about over the weekend how, like, it was almost better when we were just able to",
    "remember the deck from last week",
  ]) {
    assert.deepEqual(turnVerdict({ ...room, transcript }), { answer: false, quiet: false }, transcript);
  }
});

test("saying the name gets an answer, by either name, in any case", () => {
  for (const transcript of ["Hey Rufus, what did the session find?", "rufus", "claude can you check", "OK, RUFUS."]) {
    assert.equal(turnVerdict({ ...room, transcript }).answer, true, transcript);
  }
});

test("a name inside another word is not the name", () => {
  assert.equal(turnVerdict({ ...room, transcript: "Rufuses are dogs" }).answer, false);
  assert.equal(turnVerdict({ ...room, named: nameMatchers(["Ember"]), transcript: "remember that" }).answer, false);
});

test("a quiet holds until the name comes back, even alone", () => {
  assert.deepEqual(turnVerdict({ ...room, quiet: true, alone: true, transcript: "so what now" }), { answer: false, quiet: true });
  assert.deepEqual(turnVerdict({ ...room, quiet: true, transcript: "Rufus, you there?" }), { answer: true, quiet: false });
});

test("with one person in the call every line is for the voice", () => {
  assert.equal(turnVerdict({ ...room, alone: true, transcript: "what does this function do" }).answer, true);
});

test("an empty name list matches nothing", () => {
  assert.equal(turnVerdict({ ...room, named: nameMatchers(["", " "]), transcript: "anything" }).answer, false);
});
