// RoleAvatar resolves whatever a role row carries to one of the 24 files:
// a known key draws that key, a handle draws its stable default, and the
// picture fills the box the caller sized. Mount test in a real DOM so the
// <img> attributes callers rely on (alt for screen readers, data-avatar for
// tests and styling hooks) are checked as rendered, not as JSX.
import assert from "node:assert/strict";
import { test } from "bun:test";

test("RoleAvatar draws a known key, defaults a handle, and fills its box", async () => {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node"]) {
    (globalThis as Record<string, unknown>)[key] = (dom.window as unknown as Record<string, unknown>)[key];
  }
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { RoleAvatar } = await import("./index");
  const { AVATAR_ART, AVATAR_URLS } = await import("../../../lib/orgAvatars");
  const { AVATAR_KEYS, defaultAvatarFor } = await import("@codecast/shared/contracts/orgAvatars");

  const host = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      React.createElement(React.Fragment, null,
        React.createElement(RoleAvatar, { avatar: "owl", size: 32, title: "Infra lead" }),
        React.createElement(RoleAvatar, { avatar: "chief-of-staff" }),
        React.createElement(RoleAvatar, { avatar: "not-a-key" }),
      ),
    );
  });
  const imgs = [...host.querySelectorAll("img[data-avatar]")] as HTMLImageElement[];
  assert.equal(imgs.length, 3);
  assert.equal(imgs[0].dataset.avatar, "owl");
  assert.equal(imgs[0].getAttribute("alt"), "Infra lead");
  assert.equal(imgs[0].src.endsWith(AVATAR_URLS.owl) || imgs[0].src.includes("owl"), true);
  assert.equal((imgs[0].parentElement as HTMLElement).style.width, "32px");
  assert.equal(imgs[1].dataset.avatar, defaultAvatarFor("chief-of-staff"));
  assert.equal(imgs[1].getAttribute("alt"), imgs[1].dataset.avatar!.replace(/^./, (c) => c.toUpperCase()));
  assert.equal((imgs[1].parentElement as HTMLElement).style.width, "20px");
  assert.equal(imgs[2].dataset.avatar, defaultAvatarFor("not-a-key"));
  assert.deepEqual(Object.keys(AVATAR_ART).sort(), [...AVATAR_KEYS].sort());
  await act(async () => root.unmount());
}, 60_000); // jsdom's cold import alone can pass 5 s on a loaded machine
