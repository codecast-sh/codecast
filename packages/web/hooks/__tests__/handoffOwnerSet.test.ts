// A hand-off must file the thread under the person it NAMES. The core reads
// the LAST owner in the list as the session's new reporting parent
// (performReparentSession's `preferred`), so the order this builds is the
// whole contract — a Set that merely `add`s an existing member leaves them
// where they were and the line lands on someone else.
import { describe, expect, it } from "bun:test";
import { handoffOwnerSet } from "../useOwners";

const ME = "u-me";
const SAM = "u-sam";
const ADA = "u-ada";

describe("handoffOwnerSet (org-staffing.md S11)", () => {
  it("puts a NEW owner last and drops the person handing over", () => {
    expect(handoffOwnerSet([ME], SAM, ME)).toEqual([SAM]);
    expect(handoffOwnerSet([ME, ADA], SAM, ME)).toEqual([ADA, SAM]);
  });

  // The bug this pins: Ada is already a co-owner, so a plain `add` left her
  // first and the line went to whoever happened to be last.
  it("moves an EXISTING co-owner to the end so the line follows them", () => {
    expect(handoffOwnerSet([ADA, SAM], ADA, ME)).toEqual([SAM, ADA]);
    expect(handoffOwnerSet([ME, ADA, SAM], ADA, ME)).toEqual([SAM, ADA]);
  });

  it("keeps the sender when asked, still last for the named person", () => {
    expect(handoffOwnerSet([ME, SAM], ADA, ME, true)).toEqual([ME, SAM, ADA]);
    expect(handoffOwnerSet([ME, ADA], ADA, ME, true)).toEqual([ME, ADA]);
  });

  it("handing to yourself keeps you, and you are the parent", () => {
    expect(handoffOwnerSet([ME, SAM], ME, ME)).toEqual([SAM, ME]);
  });

  it("never duplicates and always ends with the named person", () => {
    for (const owners of [[], [ME], [ME, SAM], [SAM, ADA, ME]]) {
      const out = handoffOwnerSet(owners, ADA, ME);
      expect(new Set(out).size).toBe(out.length);
      expect(out[out.length - 1]).toBe(ADA);
    }
  });
});
