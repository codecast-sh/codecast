import { afterAll, test, expect, mock, spyOn } from "bun:test";
// The bar's right side is the one place the marketing site knows the visitor
// is signed in. Both states render here, with the local-first auth read mocked.
import { renderToStaticMarkup } from "react-dom/server";
import * as localAuth from "@/lib/localAuth";
let signedIn = false;
const authSpy = spyOn(localAuth, "useLocalAuth").mockImplementation(() => signedIn);
afterAll(() => authSpy.mockRestore());
mock.module("next/link", () => ({ default: (p: any) => <a href={p.href}>{p.children}</a> }));
// The same mock the chip test installs: bun shares module mocks across files in one run, so the two must agree.
mock.module("@/lib/repoTransport", () => ({ publicRepoUrl: (repository: string, kind: string) => `https://convex.test/cli/public/repo/${repository}/${kind}`, usePublicRepoRead: () => ({ data: undefined, missing: false, pending: false, ready: false, error: undefined }) }));
const { MarketingNav } = await import("./MarketingNav");
test("signed out shows sign in + get started", () => {
  const html = renderToStaticMarkup(<MarketingNav active="/" />);
  expect(html).toContain("Sign in"); expect(html).toContain("Get started"); expect(html).not.toContain("Open app");
  expect(html).toContain('href="/download"');
});
test("signed in shows open app", () => {
  signedIn = true;
  const html = renderToStaticMarkup(<MarketingNav active="/" />);
  expect(html).toContain("Open app"); expect(html).not.toContain("Sign in");
});
test("the GitHub chip links into codecast's own repository page, never out to github.com", () => {
  const html = renderToStaticMarkup(<MarketingNav active="/" />);
  expect(html).toContain('href="/r/codecast-sh/codecast/sessions"');
  expect(html).not.toContain("github.com");
});
