// The vault renders inline HTML, and the bytes come from arbitrary repositories
// the user may merely have cloned. So this file treats note content as hostile
// by default and asserts each attack renders INERT — the dangerous tag or
// attribute must be ABSENT from the output, not merely escaped-looking.
//
// These run against the real <VaultMarkdown>, not a reconstructed pipeline: the
// security property is the plugin ORDER inside that component (rehypeRaw parses,
// rehypeSanitize immediately cuts to VAULT_HTML_SCHEMA, everything after runs on
// an already-safe tree). A test that rebuilt the pipeline could pass while the
// shipping order was wrong.

import { test, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { VaultLinkContext, VaultMarkdown } from "../../../components/vault/VaultMarkdown";

const render = (md: string) => renderToStaticMarkup(<VaultMarkdown content={md} />);

/** [name, note content, patterns that must NOT appear in the output] */
const ATTACKS: [string, string, RegExp[]][] = [
  ["script tag", "<script>alert(1)</script>", [/<script/i]],
  ["img onerror", "<img src=x onerror=alert(1)>", [/onerror/i]],
  ["event handler in odd casing", '<img src=x OnErRoR="alert(1)">', [/onerror/i]],
  ["javascript: href", '<a href="javascript:alert(1)">x</a>', [/javascript:/i]],
  ["iframe", '<iframe src="https://evil.com"></iframe>', [/<iframe/i]],
  ["style clickjack overlay", '<div style="position:fixed;inset:0">x</div>', [/position:fixed/i]],
  ["credential-harvesting form", '<form action="https://evil.com"><input name="p"></form>', [/<form/i, /<input/i]],
  ["svg-wrapped script", "<svg><script>alert(1)</script></svg>", [/<script/i]],
  ["data:text/html href", '<a href="data:text/html,hi">x</a>', [/data:text\/html/i]],
  ["comment breakout", "<!-- --><script>alert(1)</script> -->", [/<script/i]],
  ["script nested in details", "<details><summary>s</summary><script>alert(1)</script></details>", [/<script/i]],
  ["object / embed", '<object data="x"></object><embed src="y">', [/<object/i, /<embed/i]],
  ["meta refresh redirect", '<meta http-equiv="refresh" content="0;url=https://evil.com">', [/<meta/i]],
  ["base tag hijack", '<base href="https://evil.com/">', [/<base/i]],
];

test("hostile HTML in a note renders inert", () => {
  const leaks: string[] = [];
  for (const [name, content, banned] of ATTACKS) {
    let out = "";
    try {
      out = render(content);
    } catch (e) {
      // A throw is also a failure: a note must never be able to crash the view.
      leaks.push(`${name}: threw ${String(e).slice(0, 80)}`);
      continue;
    }
    for (const re of banned) if (re.test(out)) leaks.push(`${name}: leaked ${re}`);
  }
  expect(leaks).toEqual([]);
});

test("the presentational HTML a README actually uses still renders", () => {
  // This is why the policy exists: every project vault lands on its README, and
  // most READMEs open with a centered logo.
  const out = render('<p align="center"><img src="docs/logo.png" alt="logo" width="120"></p>');
  expect(out).toContain("<p");
  expect(out).toMatch(/align="center"/);
});

// The daemon serves the vault's files from its own loopback origin, which is
// NOT the page origin — so without this the gate classified a note's own
// pictures as third-party and every image in every note rendered as "Remote
// image not loaded". Found by opening a README whose logo is repo-relative.
// The context is essential to this test: without a provider `assetUrl` never
// runs, the src stays relative, and the assertion passes for the wrong reason.
const DAEMON = "http://127.0.0.1:55555/vault/file?vault=v1&path=";
const withVault = (md: string) =>
  renderToStaticMarkup(
    <VaultLinkContext.Provider
      value={{
        resolve: () => ({ path: null, isAmbiguous: false }) as never,
        navigate: () => {},
        assetUrl: (p: string) => DAEMON + encodeURIComponent(p),
      }}
    >
      <VaultMarkdown content={md} />
    </VaultLinkContext.Provider>,
  );

test("a vault-resolved image is NOT hidden behind the third-party click gate", () => {
  const out = withVault("![logo](docs/logo.png)");
  expect(out).toContain(DAEMON.slice(0, 30)); // it really went through assetUrl
  expect(out).not.toContain("Remote image not loaded");
  expect(out).toMatch(/<img[^>]+127\.0\.0\.1/);
});

test("a genuinely third-party image is still gated inside a vault note", () => {
  const out = withVault("![badge](https://img.shields.io/badge/x.svg)");
  expect(out).toContain("Remote image not loaded");
  expect(out).not.toMatch(/<img[^>]+img\.shields\.io/);
});

test("an HTML <img> keeps the vault's own image handling", () => {
  // Not a bypass: HTML images route through VaultImage exactly as markdown ones
  // do, so vault-relative resolution and the third-party click gate both apply.
  const local = render('<img src="docs/logo.png" alt="logo">');
  expect(local).toContain("docs/logo.png");
  const remote = render('<img src="https://tracker.example.com/pixel.gif" alt="x">');
  expect(remote).not.toMatch(/<img[^>]+src="https:\/\/tracker\.example\.com/);
});

// `srcset` is the click gate's blind spot: a <source> fetches the instant it
// renders and there is no per-image reveal to hold it behind, so the policy
// drops the attribute and the element rather than gate them. <picture> stays,
// which is what keeps a theme-switching README logo showing its <img> fallback.
test("srcset cannot reopen the auto-fetch channel", () => {
  const onImg = render('<img src="docs/logo.png" srcset="https://tracker.example.com/px.gif 1x">');
  expect(onImg).not.toMatch(/srcset|tracker\.example\.com/i);

  const inPicture = render(
    '<picture><source srcset="https://tracker.example.com/px.gif"><img src="docs/logo.png" alt="l"></picture>',
  );
  expect(inPicture).not.toMatch(/<source|srcset|tracker\.example\.com/i);
  expect(inPicture).toContain("docs/logo.png"); // the fallback still renders
});

// `//evil.com` names a third-party host with no scheme, so a scheme allowlist
// has nothing to judge and waves it through. Browsers also fold `\` into `/`
// and strip leading control bytes, so all three spellings are the same attack.
test("authority-relative references are rejected in every spelling", () => {
  const forms = [
    '<a href="//evil.example/x">t</a>',
    '<a href="\\\\evil.example/x">t</a>',
    '<img src="//evil.example/px.gif">',
    "[t](//evil.example/x)", // the markdown form takes the urlTransform path
  ];
  for (const form of forms) expect(render(form)).not.toContain("evil.example");
});

// rehypeRaw re-parses the whole document through parse5 to resolve inline HTML.
// If that lost mdast positions, every checkbox in every note would write to the
// wrong source line — silently checking off someone else's task. taskSourceLine
// covers the arithmetic but renders WITHOUT the rehype chain, so this is the
// only place the shipping plugin order is held to it.
test("rehypeRaw does not shift the source line a checkbox writes back to", () => {
  const out = render(["# Chores", "", "- [ ] buy milk", "- [x] call back"].join("\n"));
  expect([...out.matchAll(/data-vault-task-line="(\d+)"/g)].map((m) => m[1])).toEqual(["3", "4"]);
});
