import { describe, expect, test } from "bun:test";
import { composerPresenceEnabled, presenceMember, typingRows } from "../CollabComposer";

const row = (user_id: string, user_name: string, draft_text?: string) => ({ user_id, user_name, user_color: "#000", draft_text });

describe("composer presence rules", () => {
  test("presence mounts on every real conversation, private or shared, and never on an optimistic stub", () => {
    expect(composerPresenceEnabled({ _id: "jx7abcdefghijklmnopqrstuvwxyz012" })).toBe(true);
    expect(composerPresenceEnabled({ _id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" })).toBe(false);
    expect(composerPresenceEnabled(null)).toBe(false);
  });

  test("only rows with words count as typing; whitespace is silence", () => {
    const present = [row("a", "Ann", "hello"), row("b", "Bob", "   "), row("c", "Cy")];
    expect(typingRows(present).map((r) => r.user_id)).toEqual(["a"]);
    expect(typingRows([])).toEqual([]);
  });

  test("a typing teammate wears their roster face; a share link guest keeps the name the row carries", () => {
    const roster = [{ _id: "a", name: "Ann Lee", image: "https://x/ann.png" }];
    expect(presenceMember(row("a", "Ann", "hi"), roster)).toBe(roster[0]);
    expect(presenceMember(row("g", "Guest", "hi"), roster)).toEqual({ _id: "g", name: "Guest" });
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { CollabPresenceBar } from "../CollabComposer";

describe("composer presence line", () => {
  test("a teammate typing: the typing strip, their name, and their words", () => {
    const html = renderToStaticMarkup(<CollabPresenceBar present={[row("a", "Ann Lee", "use the existing hook")]} showHere={false} />);
    expect(html).toContain('data-sv-composer-presence="typing"');
    expect(html).toContain("Ann Lee is typing");
    expect(html).toContain("use the existing hook");
    expect(html).toContain("grid-rows-[1fr]");
  });

  test("a teammate merely present on a team session: the line stays folded, nothing announced", () => {
    const html = renderToStaticMarkup(<CollabPresenceBar present={[row("a", "Ann Lee")]} showHere={false} />);
    expect(html).toContain('data-sv-composer-presence="off"');
    expect(html).toContain("grid-rows-[0fr]");
    expect(html).not.toContain("is here");
  });

  test("a share link guest merely present: the line opens with who is here", () => {
    const html = renderToStaticMarkup(<CollabPresenceBar present={[row("g", "Guest"), row("h", "Hal")]} showHere />);
    expect(html).toContain('data-sv-composer-presence="here"');
    expect(html).toContain("are here");
  });
});
