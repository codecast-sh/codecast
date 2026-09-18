// The @-mention dropdown as rendered (docs/architecture/session-characters.md
// S3): a session that wears a character is offered as that person — its face
// and its name — and one nobody personified keeps the glyph and the title it
// always had.
import assert from "node:assert/strict";
import { beforeAll, test } from "bun:test";

let dom: { window: Window & typeof globalThis };
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;

beforeAll(async () => {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM("<!doctype html><html><body></body></html>") as never;
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "MutationObserver", "getComputedStyle"]) {
    (globalThis as Record<string, unknown>)[key] = (dom.window as unknown as Record<string, unknown>)[key];
  }
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ act } = await import("react"));
});

const ID = "k97xcyp74gaa0q43my0mpnvnsd8ekyj4";

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(node as never); });
  return host as unknown as HTMLElement;
}

test("a personified session is offered as its character: face, name, title behind it", async () => {
  const { MentionSuggestion } = await import("./MentionSuggestion");
  const host = await render(
    <MentionSuggestion
      item={{
        id: ID, type: "session", label: "Fixing the auth race",
        identity: { _id: ID, character_name: "Ember", character_avatar: "fox" },
      }}
    />,
  );
  assert.ok(host.querySelector("img[data-avatar=fox]"), "the character's face leads the row");
  assert.ok(host.textContent?.includes("Ember"), "the name is what the row reads as");
  assert.ok(host.textContent?.includes("Fixing the auth race"), "the title stays, one line down");
});

test("a session nobody personified keeps the glyph and the title", async () => {
  const { MentionSuggestion } = await import("./MentionSuggestion");
  const host = await render(
    <MentionSuggestion item={{ id: ID, type: "session", label: "Fixing the auth race", identity: { _id: ID } }} />,
  );
  assert.equal(host.querySelector("img[data-avatar]"), null, "no face without a character");
  assert.ok(host.textContent?.includes("Fixing the auth race"));
});
