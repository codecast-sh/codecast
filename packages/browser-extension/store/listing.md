# Chrome Web Store listing

Everything the developer dashboard asks for, so a submission is copy and paste.
Keep this file the source of truth: when the extension's behaviour or
permissions change, change the words here in the same commit.

## Store listing

**Name**: Codecast

**Summary** (132 characters max; this is also the manifest `description`, which the store caps at the same length):
Lets Codecast agents open and drive their own tabs in this Chrome, in one tab group, over a local token authenticated bridge.

**Category**: Developer Tools

**Language**: English

**Description**:

Codecast runs AI coding agents that sometimes need a web page behind your
logins: a dashboard to read, a form to fill, a UI change to verify. This
extension lets a session on this computer do that in your own Chrome instead
of a copied profile.

What it does

- A session opens its own tabs, all inside one tab group named Cast, and acts
  only on tabs it opened. Your tabs are never touched.
- A soft frame and a visible pointer show exactly what the agent is doing.
  Chrome also shows its own "started debugging this browser" notice; cancel
  it there and the agent lets go.
- The extension talks only to a bridge on 127.0.0.1 run by the Codecast CLI on
  the same computer. Nothing leaves your machine through this extension.

Pairing

Run `cast browser extension setup` in a terminal. It opens this extension's
options page with the pairing token filled in and asks for one click. The
token never crosses a network and is proven both ways, so a random program
on the port cannot drive your browser. Revoke everything with
`cast browser extension revoke`.

Requires the Codecast CLI (https://codecast.sh).

**Homepage**: https://codecast.sh

**Support**: https://github.com/codecast-sh/codecast/issues

**Privacy policy**: https://codecast.sh/privacy (section "Browser extension")

## Privacy practices

**Single purpose**: Let Codecast agent sessions running on this computer open
and drive their own tabs in the user's Chrome.

**Permission justifications**

- `debugger`: The whole function of the extension. A session's commands
  (navigate, click, type, read the page, screenshot) are Chrome DevTools
  Protocol commands, and `chrome.debugger` is the only extension API that
  executes them against a tab. It is attached only to tabs the extension
  itself created for a session, and detached when the session ends.
- `tabs`: Create the tabs a session works in, find them again, and close them
  when the session stops. The extension reads the URL and title only of tabs
  it created.
- `tabGroups`: Put every tab a session opens into one group named after the
  session, so the user always sees which tabs an agent holds.
- `storage`: Keep the pairing token and bridge port the user granted, so the
  extension reconnects after a restart without asking again.
- `alarms`: Wake the service worker to reconnect to the bridge when the CLI
  restarts it.

**Host permissions**: none. The extension connects only to `ws://127.0.0.1`.
It does not run content scripts and does not read pages the user opened.

**Remote code**: none. All code ships in the package.

**Data usage** (the dashboard's disclosure form):

- Personally identifiable information: not collected.
- Health, financial, authentication information: not collected.
- Personal communications, location, web history: not collected.
- User activity: not collected by the extension. Commands and their results
  flow between the local bridge and the tab the session opened; the extension
  stores none of it.
- Website content: read from tabs the session opened, on the session's
  request, and handed to the local bridge. Not stored, not sent elsewhere by
  the extension.

Certifications to tick: not sold to third parties; not used for purposes
unrelated to the single purpose; not used for creditworthiness or lending.

## Assets

- Icon 128×128: `icons/icon-128.png`.
- Screenshots (1280×800 JPEG, at least one, up to five) live in
  `store/screenshots/`: the options page connected, and a driven page wearing
  the Cast frame. Regenerate them with
  `SMOKE_STORE_SHOTS=packages/browser-extension/store/screenshots bun packages/browser-extension/smoke.mjs`,
  which captures them from the states the smoke builds.
- Promo tiles, both optional for an unlisted item, live in `store/promo/`:
  `small-promo-tile-440x280.png` and `marquee-promo-tile-1400x560.png`, 24-bit
  PNG. They are rendered from the HTML beside them (`render.ts`, comment at the
  top has the two commands); edit the HTML, not the PNG.

## Visibility

Start **Unlisted**: installable by anyone with the link, updated by Chrome
like any store item, not shown in search. Move to Public once the listing
has screenshots and the review has passed at least once.

## First submission (by hand, once)

1. Developer dashboard → New item → upload the zip from
   `bun packages/browser-extension/release.mjs --dry-run`.
2. Fill the listing and privacy tabs from this file; set visibility Unlisted.
3. Submit for review.
4. Package tab → **View public key**. Copy the key body into `manifest.json`
   `key` and set `BRIDGE_EXTENSION_ID` in
   `packages/cli/src/browser/bridge/protocol.ts` to the store's ID; the
   protocol test checks they agree. Set `BRIDGE_STORE_URL` there as well.
5. Every later release is the "Cut Chrome extension release" workflow.
