import { describe, expect, test } from "bun:test";
import { noLocalCheckoutBannerActionable } from "./daemon.js";

// Regression: the daemon stamped a red "No local checkout for <unknown remote>
// (recorded path unknown doesn't exist here). Clone it first." banner on remote
// sessions that carried NEITHER a git remote NOR a recorded cwd (e.g. a Codex run
// resumed from another host). That banner is a dead end — there's nothing named
// to clone and no path to point at — so the user can't act on it. The predicate
// gates the banner: it's only actionable when we can name what's missing.
describe("noLocalCheckoutBannerActionable", () => {
  test("suppressed when there is neither a remote nor a recorded path (the bug)", () => {
    expect(noLocalCheckoutBannerActionable({ remote: null, recordedPath: undefined })).toBe(false);
    expect(noLocalCheckoutBannerActionable({ remote: undefined, recordedPath: null })).toBe(false);
    expect(noLocalCheckoutBannerActionable({ remote: "", recordedPath: "" })).toBe(false);
  });

  test("actionable when we know the git remote to clone", () => {
    expect(
      noLocalCheckoutBannerActionable({ remote: "git@github.com:ashot/codecast.git", recordedPath: undefined }),
    ).toBe(true);
  });

  test("actionable when we have a concrete recorded path that just isn't here", () => {
    expect(
      noLocalCheckoutBannerActionable({ remote: null, recordedPath: "/Users/ec2-user/work/codecast" }),
    ).toBe(true);
  });

  test("actionable when we have both", () => {
    expect(
      noLocalCheckoutBannerActionable({
        remote: "git@github.com:ashot/codecast.git",
        recordedPath: "/Users/ec2-user/work/codecast",
      }),
    ).toBe(true);
  });
});
