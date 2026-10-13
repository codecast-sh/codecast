import { describe, expect, test } from "bun:test";
import { noLocalCheckoutBannerActionable } from "./daemon.js";

// The predicate gates a red "No local checkout for <remote> (recorded path X
// doesn't exist here). Clone it first." banner. It is consulted ONLY after every
// resolution attempt has already failed: no checkout at the recorded path, no
// git-remote match, and no convention/ancestor match via resolveLocalRepo. At
// that point a recorded path alone is a dead end — you can't recreate another
// machine's home dir, and "<unknown remote>" names nothing to clone — so only a
// real git remote earns the banner.
describe("noLocalCheckoutBannerActionable", () => {
  test("suppressed when there is no git remote (the dead-end cases)", () => {
    expect(noLocalCheckoutBannerActionable({ remote: null, recordedPath: undefined })).toBe(false);
    expect(noLocalCheckoutBannerActionable({ remote: undefined, recordedPath: null })).toBe(false);
    expect(noLocalCheckoutBannerActionable({ remote: "", recordedPath: "" })).toBe(false);
    // A foreign recorded path with no remote — the flashing-banner bug. The user
    // can't act on "clone <unknown remote>", so stay silent.
    expect(
      noLocalCheckoutBannerActionable({ remote: null, recordedPath: "/Users/m1/work/codecast/packages/cli" }),
    ).toBe(false);
    expect(
      noLocalCheckoutBannerActionable({ remote: "", recordedPath: "/Users/ec2-user/src/union-mobile/outreach" }),
    ).toBe(false);
  });

  test("actionable when we know the git remote to clone", () => {
    expect(
      noLocalCheckoutBannerActionable({ remote: "git@github.com:ashot/codecast.git", recordedPath: undefined }),
    ).toBe(true);
    expect(
      noLocalCheckoutBannerActionable({
        remote: "git@github.com:ashot/codecast.git",
        recordedPath: "/Users/ec2-user/work/codecast",
      }),
    ).toBe(true);
  });
});
