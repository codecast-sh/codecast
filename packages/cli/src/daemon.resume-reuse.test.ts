import { describe, expect, test } from "bun:test";
import { resumeReuseCandidates } from "./daemon.js";

// Regression coverage for the split-brain bug: a force-resume (resume_session
// command) of a session whose ORIGINAL started tmux (cc-<agent>-<convId>) is
// still alive used to spawn a parallel cc-resume- session, because the reuse
// probe only looked at the cached resume tmux and the resume-named session.
// resumeReuseCandidates must surface the started session as a reuse candidate.

describe("resumeReuseCandidates", () => {
  test("includes the started session between cached and resume-named", () => {
    expect(resumeReuseCandidates("cc-resume-abc", "cc-claude-conv123", "cc-resume-slug-abc"))
      .toEqual(["cc-resume-abc", "cc-claude-conv123", "cc-resume-slug-abc"]);
  });

  test("the bug case: no cached tmux, but a live started session exists — it is probed before spawning fresh", () => {
    const candidates = resumeReuseCandidates(undefined, "cc-claude-conv123", "cc-resume-slug-abc");
    expect(candidates).toEqual(["cc-claude-conv123", "cc-resume-slug-abc"]);
    // The started session is probed first, so an alive original is reused instead
    // of creating the resume-named session in parallel.
    expect(candidates[0]).toBe("cc-claude-conv123");
  });

  test("omits undefined cached and started entries", () => {
    expect(resumeReuseCandidates(undefined, undefined, "cc-resume-abc"))
      .toEqual(["cc-resume-abc"]);
  });

  test("de-duplicates when cached equals the started session", () => {
    expect(resumeReuseCandidates("cc-claude-conv123", "cc-claude-conv123", "cc-resume-abc"))
      .toEqual(["cc-claude-conv123", "cc-resume-abc"]);
  });

  test("de-duplicates when started equals the resume-named session", () => {
    expect(resumeReuseCandidates(undefined, "cc-resume-abc", "cc-resume-abc"))
      .toEqual(["cc-resume-abc"]);
  });

  test("de-duplicates when all three are identical", () => {
    expect(resumeReuseCandidates("cc-resume-abc", "cc-resume-abc", "cc-resume-abc"))
      .toEqual(["cc-resume-abc"]);
  });

  test("preserves cached-first priority", () => {
    const candidates = resumeReuseCandidates("cc-resume-cached", "cc-claude-conv123", "cc-resume-slug-abc");
    expect(candidates[0]).toBe("cc-resume-cached");
  });
});
