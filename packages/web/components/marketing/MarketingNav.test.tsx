import { test, expect, mock } from "bun:test";
// The bar's right side is the one place the marketing site knows the visitor
// is signed in. Both states render here, with the local-first auth read mocked.
import { renderToStaticMarkup } from "react-dom/server";
let signedIn = false;
mock.module("@/lib/localAuth", () => ({ useLocalAuth: () => signedIn }));
mock.module("next/link", () => ({ default: (p: any) => <a href={p.href}>{p.children}</a> }));
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
