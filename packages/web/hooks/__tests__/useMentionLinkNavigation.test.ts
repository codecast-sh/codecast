import { describe, expect, it } from "bun:test";
import { resolveMentionClickNavigation } from "../useMentionLinkNavigation";

const base = {
  defaultPrevented: false,
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  target: null as string | null,
};

describe("resolveMentionClickNavigation", () => {
  it("routes a plain left-click on an internal mention href", () => {
    expect(resolveMentionClickNavigation({ ...base, href: "/team/abc123" })).toBe("/team/abc123");
    expect(resolveMentionClickNavigation({ ...base, href: "/tasks/xyz" })).toBe("/tasks/xyz");
  });

  it("ignores modified clicks so open-in-new-tab still works", () => {
    expect(resolveMentionClickNavigation({ ...base, href: "/team/abc", metaKey: true })).toBeNull();
    expect(resolveMentionClickNavigation({ ...base, href: "/team/abc", ctrlKey: true })).toBeNull();
    expect(resolveMentionClickNavigation({ ...base, href: "/team/abc", shiftKey: true })).toBeNull();
    expect(resolveMentionClickNavigation({ ...base, href: "/team/abc", altKey: true })).toBeNull();
  });

  it("ignores non-primary mouse buttons", () => {
    expect(resolveMentionClickNavigation({ ...base, href: "/team/abc", button: 1 })).toBeNull();
    expect(resolveMentionClickNavigation({ ...base, href: "/team/abc", button: 2 })).toBeNull();
  });

  it("ignores clicks already handled (defaultPrevented)", () => {
    expect(resolveMentionClickNavigation({ ...base, href: "/team/abc", defaultPrevented: true })).toBeNull();
  });

  it("leaves external links to the browser", () => {
    expect(resolveMentionClickNavigation({ ...base, href: "https://github.com/ashot" })).toBeNull();
    expect(resolveMentionClickNavigation({ ...base, href: "mailto:x@y.com" })).toBeNull();
    expect(resolveMentionClickNavigation({ ...base, href: "#anchor" })).toBeNull();
    expect(resolveMentionClickNavigation({ ...base, href: null })).toBeNull();
  });

  it("does not hijack target=_blank anchors", () => {
    expect(resolveMentionClickNavigation({ ...base, href: "/team/abc", target: "_blank" })).toBeNull();
  });
});
