import { afterAll, test, expect, mock, spyOn } from "bun:test";
// The bar's right side is the one place the marketing site knows the visitor
// is signed in. Both states render here, with the local-first auth read mocked.
// The auth buttons wait for the client (the prerender cannot know who is
// visiting), so the states are read from a real mount, not static markup.
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";
import * as localAuth from "@/lib/localAuth";
import { replaceGlobals } from "../../test-helpers/globals";
import { closeDomWindow } from "../../test-helpers/domGlobals";
let signedIn = false;
const authSpy = spyOn(localAuth, "useLocalAuth").mockImplementation(() => signedIn);
mock.module("next/link", () => ({ default: (p: any) => <a href={p.href}>{p.children}</a> }));
// The same mock the chip test installs: bun shares module mocks across files in one run, so the two must agree.
mock.module("@/lib/repoTransport", () => ({ publicRepoUrl: (repository: string, kind: string) => `https://convex.test/cli/public/repo/${repository}/${kind}`, usePublicRepoRead: () => ({ data: undefined, missing: false, pending: false, ready: false, error: undefined }) }));
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://codecast.test/", pretendToBeVisual: true });
const restoreGlobals = replaceGlobals({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true });
afterAll(() => {
  authSpy.mockRestore();
  closeDomWindow(dom);
  restoreGlobals();
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MarketingNav } = await import("./MarketingNav");

async function mounted(): Promise<string> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<MarketingNav active="/" />));
  const html = host.innerHTML;
  await act(async () => root.unmount());
  host.remove();
  return html;
}

test("the prerender holds the auth slot and names neither state", () => {
  const html = renderToStaticMarkup(<MarketingNav active="/" />);
  expect(html).not.toContain("Sign in"); expect(html).not.toContain("Get started"); expect(html).not.toContain("Open app");
});
test("signed out shows sign in + get started", async () => {
  signedIn = false;
  const html = await mounted();
  expect(html).toContain("Sign in"); expect(html).toContain("Get started"); expect(html).not.toContain("Open app");
  expect(html).toContain('href="/download"');
});
test("signed in shows open app", async () => {
  signedIn = true;
  const html = await mounted();
  expect(html).toContain("Open app"); expect(html).not.toContain("Sign in");
});
test("the GitHub chip links into codecast's own repository page, never out to github.com", () => {
  const html = renderToStaticMarkup(<MarketingNav active="/" />);
  expect(html).toContain('href="/r/codecast-sh/codecast/sessions"');
  expect(html).not.toContain("github.com");
});
