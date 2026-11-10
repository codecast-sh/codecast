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
  only on tabs it opened or tabs you lend it from the toolbar popup. Take any
  tab back from the same popup.
- When a page needs you (a sign-in, a 2FA code), the agent hands it over: a
  small card on the page says what to do and waits for your click.
- A soft frame and a visible pointer show exactly what the agent is doing.
  Chrome also shows its own "started debugging this browser" notice; cancel
  it there and the agent lets go.
- The extension talks only to a bridge on 127.0.0.1 run by the Codecast CLI on
  the same computer. Nothing leaves your machine through this extension.

Pairing

Run `cast browser extension setup` in a terminal. It opens this extension's
options page with a one-time pairing code filled in and asks for one click.
The code and the key it is exchanged for never cross a network and are proven
both ways, so a random program on the port cannot drive your browser. Revoke
everything with `cast browser extension revoke`.

Requires the Codecast CLI (https://codecast.sh).

**Homepage**: https://codecast.sh

**Support**: https://github.com/codecast-sh/codecast/issues

**Privacy policy**: https://codecast.sh/privacy (section "Browser extension")

## Privacy practices

**Single purpose**: Let Codecast agent sessions running on this computer open
and drive their own tabs in the user's Chrome.

**Permission justifications**

Each entry says what `background.js` does with the permission; keep them in
step with `manifest.json`.

- `debugger`: The whole function of the extension. A session's commands
  (navigate, click, type, read the page, screenshot) are Chrome DevTools
  Protocol commands, and `chrome.debugger` is the only extension API that
  executes them against a tab. It attaches to a tab only when the local
  bridge names it: a tab the extension created for a session, a tab such a
  tab's page opened, or a tab the user lent from the toolbar popup or named
  on the command line. It refuses a tab the user took back. It detaches when
  the session ends, when the bridge disconnects, and when the user presses
  Cancel on Chrome's notice. While any tab is attached it also holds a
  session on its own service worker, which stops Chrome ending the worker in
  the middle of a command. The frame and pointer drawn on a driven page are
  injected through this session, and that script also sets one
  `sessionStorage` key (`codecast-agent-tab`) and fires one DOM event
  (`cast:driven`) so codecast's own pages know an agent holds the tab.
- `tabs`: Create the tabs a session works in, group, move, activate and close
  them, and close agent tabs nobody drove for 30 minutes. The extension
  reports the URL and title of every open tab in this profile, and each
  change to them, to the local bridge host, which uses the list to tell agent
  tabs from the user's and shows a session only its own. It closes a tab
  when the bridge asks (a session closing its tab); on its own it closes only
  idle tabs it created.
- `tabGroups`: Put every agent tab into one group named Cast, so the user
  always sees which tabs an agent holds, and move a tab the user opened
  inside that group back out. A group the user made is never changed.
- `storage`: In local storage: the bridge port and this profile's pairing
  (its key, a one-time code until it is used, and the shared token of an
  older CLI), a random profile id, the user's choice of where agent tabs
  open, the last 24 connection log lines, and the ids and URLs of tabs the
  extension created for agents, so a reload can tell them from the user's.
  In session storage, cleared when Chrome quits: which tabs and groups are
  the agents', which the user lent or took back, the text of a pending
  handoff, when each agent tab was last driven, and the id of the agents'
  own window when the user chose one.
- `offscreen`: One hidden page that messages the service worker every 20
  seconds so Chrome keeps the worker, and its process, running while the
  bridge is connected. Without it Chrome ends the worker after 30 idle
  seconds and starves its process on a busy machine, and agent commands
  time out. The page holds no content and reads nothing.
- `alarms`: Wake the service worker every 30 seconds to reconnect to the
  bridge when the CLI restarts it, and once a minute to expire handoffs and
  close idle agent tabs.
- `scripting`: Inject `page.js`, a file in the package, into the top frame
  of a tab an agent is driving or has handed to the user, and into no other
  tab. While an agent drives the tab the script removes elements other
  extensions injected into that page (password manager overlays, extension
  frames), because they make Chrome refuse debugger commands. While an agent
  waits on the user it removes nothing and draws the handoff card, whose
  Continue button accepts only a real click.
- `webNavigation`: Learn which tab opened a new tab, so a popup an agent's
  page opened joins the agent's tabs and the user gets their own tab back in
  front; and learn when an agent tab's top frame navigated, so `page.js` is
  put back in the new document. Navigation URLs are not read or stored.

**Host permissions**: `<all_urls>`. `chrome.scripting.executeScript` needs
host access to the page it injects into, an agent can be sent to any site,
and no user gesture is present to grant `activeTab`. The access is used only
to inject `page.js` into the tabs described under `scripting`; the extension
never injects into a tab no agent holds. Network requests
go only to the bridge on `127.0.0.1` (`ws://127.0.0.1:<port>/ext`, and
`http://127.0.0.1:<port>/healthz` to read the host's protocol number). The
extension's own pages load no remote resource.

**Content scripts**: none declared in the manifest. `page.js` is injected
on demand as above and runs in the extension's isolated world.

**Web accessible resources**: `options.html`, to `file:` pages only. Setup
opens a local file that forwards to the options page with the pairing code
in the URL fragment; a code the extension does not already hold waits for
the user's click.

**Remote code**: none. All code ships in the package.

**Data usage** (the dashboard's disclosure form):

- Personally identifiable information: not collected.
- Health, financial, authentication information: not collected.
- Personal communications, location: not collected.
- Web history: the URL and title of each open tab are handed to the local
  bridge on this computer. The extension stores only the URLs of tabs it
  created for agents, and sends nothing off the machine.
- User activity: not collected by the extension. Commands and their results
  flow between the local bridge and the tab the session holds; the extension
  stores none of it.
- Website content: read from tabs a session holds, on the session's
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

## Published listing

[Codecast on the Chrome Web Store](https://chromewebstore.google.com/detail/codecast/odfpgkdaibmjhhnbndgbjlhdbciciifd)

Upload updates to this existing item; creating a new
item would change the ID and break CLI pairing. The manifest holds this
listing's public key for development loads, and
`packages/shared/contracts/browserExtension.ts` holds the ID and store URL.

Later releases use the "Cut Chrome extension release" workflow. For a manual
upload, build with `bun packages/browser-extension/release.mjs --dry-run`,
then upload that ZIP to this item's Package tab and submit for review. After
a manual release, update the source manifest version to the accepted version
so the next release increments it instead of uploading the same version again.
