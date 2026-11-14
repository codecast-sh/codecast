# cast computer on the laptop, from a cloud host

Task ct-94271, plan pl-1034. Status: built (round 2); end to end green (round 3, 2026-11-14).
Grant model decided by the person (2026-11-14): per host until revoked, `--session`
for a narrower grant, all apps, a daily first-use notice.

A session on a cloud host can run `cast computer` only against that host's own
desktop. This design lets it drive the person's laptop apps, once the person
has allowed it. It reuses the route `cast browser` already uses to reach the
laptop's Chrome and adds no new tunnel, port or discovery.

## What already exists (the browser route)

- **Transport.** The laptop daemon holds one ssh connection to each managed,
  unshared cloud host that is up (`cloud/browserLink.ts`, `BrowserLinks`). That
  connection carries a reverse forward of the laptop's bridge port:
  `-R 127.0.0.1:<port>:127.0.0.1:<port>`. The host's loopback port then reaches
  the laptop's bridge host (`cast browser bridge-host`, `browser/bridge/host.ts`).
- **Discovery.** Over the same connection the laptop writes
  `~/.codecast/browser/laptop-link.json` on the host: the port, a token minted
  for that host alone, the host's registry id and the laptop's name
  (`bridge/laptopLink.ts`). The file goes away when the connection ends.
  Which laptop is this person's is answered by the link itself: only the
  person's own laptop daemon manages the host (`hosts.json` on the laptop), and
  a host shared with teammates never gets a link.
- **Auth.** The laptop keeps only the sha256 of each host token in
  `bridge.json` (`bridge/hostClients.ts`). Before presenting the token, the
  host proves the bridge holds it (`/healthz?client=<id>&nonce=` answers an
  HMAC keyed on the hash). The bridge re-reads the records on every auth, and a
  sweep closes a revoked host's live sockets. A host token reaches a small
  allowlist of routes (`HOST_CLIENT_ROUTES`) and a namespaced session
  (`host:<id>:<session>`).
- **Choosing.** Every `cast browser` call on a remote device probes the link
  inside 1.5 s (`probeLaptopLink`) and falls back to the host's own Chrome,
  printing one line when the choice changes (`switchNotice`).

**Which laptop.** Each laptop forwards its bridge to its own host port,
derived from its device id (`linkHostPort`: 42000 + sha256(device) mod 8000),
and writes its own link file, `~/.codecast/browser/laptop-links/<device>.json`
(with `device` and `owner`, the user id it is signed in as). Before this, every
laptop bound the bridge's own port number (41729) on the host, so a second
laptop could never link. Each link also writes the legacy
`laptop-link.json` (last writer wins) for a host whose cast predates the
directory, and on close removes each file only if it is still its own. On the
host, links whose owner differs from the host's own user are ignored. `cast
browser` uses the newest link, so one laptop behaves exactly as before.

**A bug found on the way.** `daemon.ts` started `BrowserLinks` twice (two copies
of the same block). Each instance kept its own map of live links under one pid,
so the second opened a duplicate link to every host every few minutes. It
failed on the port the first held ("remote port forwarding failed for listen
port 41729", 27 times a host on MacBook-Pro-2), and each try minted a token
that replaced the live link's. The duplicate is removed and
`cloud/browserLink.guard.test.ts` keeps it at one.

The `/term/forward` route (`terminal/terminalServer.ts`, `cloud/hostForward.ts`)
goes the other way: the web, through the laptop, reaches a server on the host.
It is not the direction this feature needs, so it is not reused.

## Transport

A new WebSocket face on the bridge host: `ws://127.0.0.1:<port>/computer`. Same
port, same reverse forward, same token, same `/healthz` proof. No new ssh
connection or forward.

- **One socket per CLI process.** The host's `cast computer` opens it on the
  first request and keeps it for the life of the process. A `batch` of verbs
  runs over one socket. Nothing reconnects per call.
- **Framing.** The bridge transport sent every frame as text, Buffers
  included; `BridgeSocket.send(data, { binary: true })` now sends a binary
  frame, and every existing caller keeps text. Text frames carry the same JSON request/response objects the
  helper speaks today (`{id, method, params}` → `{id, ok, result|error}`),
  minus the helper token: the bridge supplies that itself.
- **Screenshots travel as bytes.** When a result carries a screenshot, the
  bridge sends one binary frame (a 4-byte request id, then the image bytes)
  before the JSON result, and the JSON's `screenshot` has no `data`, only
  `format`, size, scale, `bytes: <length>` and `contentType`. The host CLI writes the bytes
  into its own `screenshotDir()` (0600, the same 24 h sweep) and fills
  `screenshot.path`, so `--json` output looks exactly as it does locally. The
  helper's own format is whatever the screenshots stream (jx78ftd) lands: if
  the helper writes a file, the bridge reads that file and deletes it; if it
  still returns base64, the bridge decodes it once on the laptop. Either way
  no base64 crosses the tunnel.
- **Laptop end.** The bridge host holds one `ComputerClient` (the existing
  `computer/client.ts`) per remote socket and forwards each request to it. It
  is the helper's ordinary local client: it passes the helper's peer check
  because it runs as the installed cast binary, which is the binary the helper
  pins on its first handshake (`SocketHandshake.isAuthorizedPeer`). It may
  launch the helper the way any local `cast computer` does (the bridge host is
  a LaunchAgent in the person's GUI session). The helper socket is never
  forwarded and no remote byte reaches it unparsed: the bridge decodes each
  request, checks the method against an allowlist, and re-encodes it.
- **Method allowlist.** `listApps`, `listWindows`, `getAppState`, the action
  methods, and `capabilities`. Not `terminate`, not permission setup, not
  anything that raises the setup window. `--restore-window` is refused
  remotely in v1: a cloud session never pulls a window over the person's work
  (the browser's rule for host sockets, `raise: false`).

## Auth

Two checks, both on the laptop, both on every request rather than once per
socket:

1. **The caller is this person's host.** The upgrade presents the host token;
   `matchHostClient` maps it to a host id, as for CDP. The laptop's own
   machine token is refused on `/computer`: a local caller talks to the helper
   directly.
2. **The person granted that host (or that session) their apps.** Read from
   the laptop's `hosts.json` through the same re-read-on-change reader the
   bridge uses for host tokens, so a revoke binds on the next request. The
   revoke sweep that already cuts a revoked host's CDP sockets closes its
   `/computer` sockets too.

The host side proves the bridge before sending the token (the existing
`/healthz` proof), so the token is never shown to a squatter on the host port.

Session scoping: the upgrade carries `?session=<id>` from the host CLI's
environment. That id is only as trustworthy as the host: the laptop cannot
tell one process on the host from another. A session-scoped grant therefore
limits which agent is meant to use it, not what a hostile process on the host
could do. A host that is not trusted with the laptop should not be granted at
all, and a shared host never gets a link.

## Grant model (for the person to decide)

Default: no cloud host may drive the laptop's apps. The proposed grant:

- **Stored on the laptop**, on the host's entry in `~/.codecast/browser/hosts.json`:
  `laptopComputer: { grantedAt, scope: "host" | { sessions: string[] }, expiresAt? }`.
  It sits beside `laptopBrowser`, the browser's existing per-host switch.
  Nothing about it lives on the host or the server, so the host cannot grant
  itself.
- **Granted only by the person, on the laptop:**
  `cast computer remote grant --host <id> [--session <id>…] [--for <duration>] [--apps <app>…]`. The
  command refuses when it runs inside an agent session (`sessionIdFromEnv`) and
  prints the card an agent should raise instead, built with the existing
  `askToRun(..., RUN_ON_LAPTOP)`. In the app, the person presses Run on that
  card, and the laptop daemon runs the command as the person with the session
  env stripped (`run_cast`, `personEnv`). That is the "in the app" path. It
  goes through the existing decision card and needs no new backend.
- **Revocable in one step**, by anyone, from anywhere on the laptop:
  `cast computer remote revoke --host <id>`. Live sockets close within the sweep
  interval (seconds).
- **Visible.** `cast computer remote` on the laptop lists each host's grant and
  the last thing it did (from the bridge host log). The bridge host log
  records every remote verb: host, session, method, app. The first granted
  request from a host each day posts a macOS notification naming the revoke
  command.
- **Independent of the browser.** Today a host link opens only when the
  laptop's Chrome is paired, and `extension revoke --host` deletes the host's
  token. With this change the link opens when either the browser or the
  computer is allowed. Each face checks its own switch, and the token is
  deleted only when neither switch remains on.

Scope, expiry and an app list are separate entries in `GRANT_CHECKS`
(`computer/remoteGrant.ts`), so a change of mind moves one line.

## CLI surface

On the host:

```
cast computer get-app-state --on laptop --app TextEdit
cast computer click --on laptop --app TextEdit --element "Bold"
cast computer do --on laptop --app TextEdit - < steps
cast computer list-apps --on mbp-182          # several laptops linked: name or device id
```

`--on` is a flag on every verb that talks to a helper (the guidance guard reads
flags per verb), and `CAST_COMPUTER_ON=laptop` sets it for a whole session. It
matches `cast decide --run --on laptop`. Without it, a host session drives its
own desktop exactly as today, and nothing is chosen automatically. On a machine
that is not a remote device, `--on` is refused. `permissions` and `setup` never
run remotely.

On the laptop:

```
cast computer remote                                    # each host: apps, chrome, last activity
cast computer remote grant  --host <id> [--session <id>…] [--for 8h] [--apps …]
cast computer remote revoke --host <id>
```

## Failure messages

Each names what is missing and the one step that fixes it. All refusals carry the new code `remote_refused`, so the local setup card never appears under a laptop's problem.

| Situation | Message (host side) |
|---|---|
| `--on laptop` on a machine that is not a remote device | `--on laptop is for a cloud host; this machine is the laptop, drop --on` |
| No link file | `no laptop is linked to this host right now: the laptop is off, asleep or offline, or this host is shared with teammates` |
| Several laptops, `--on laptop` | `2 laptops are linked to this host: mbp-182 (8a1f02c4), mbp-2 (3d5c7f9b). Name one with --on <laptop name or device id>` |
| Link file, `/healthz` unreachable | `<laptop> is not reachable over its link (off, asleep or offline)` |
| Proof fails | `<laptop> refused this host's key (revoked there)`, plus the Run card to link again |
| Bridge too old (no `/computer`) | `<laptop> runs a cast too old to share its apps: cast devices update <laptop>` |
| No grant | `<laptop> has not let this host drive its apps. Ask your person:` plus the Run card for `cast computer remote grant --host <id>` on the laptop |
| Grant is session-scoped, different session | `<laptop> let session <x> on this host drive its apps, not this one`, plus the card |
| Grant expired | `this host's access to <laptop>'s apps expired <when>`, plus the card |
| Helper not granted on the laptop | `remote_refused`: `<laptop>'s computer helper lacks <accessibility/screen recording>: cast devices setup <laptop> computer --start` (existing command) |
| Helper busy | the existing `action_timeout` text, prefixed with the laptop's name |
| Revoked while a socket is open | `<laptop> revoked this host's access to its apps` (the laptop rechecks every 2 s) |
| Link dropped mid-process | `the link to <laptop> closed mid-command; nothing after <verb> ran` (no silent retry of an action) |

## Latency

Round 3, 2026-11-14: cloud host codecast-linux-mbp2-offload-2 (us-west-2) to
MacBook-Pro-2's helper, TextEdit at the back, one socket held, n=20 per verb
(`scripts/computer-remote-bench.ts`). Network RTT laptop to host: TCP connect
p50 138 ms. The laptop's load average was 18 to 40 during the runs, so the
p95s carry its noise. A background text area takes no click (macOS drops a
press on a background window, and the remote path never raises), so the
action measured is `set-value` (`--action set-value`).

| verb | local p50 / p95 | remote run 1 p50 / p95 | remote run 2 p50 / p95 |
|---|---|---|---|
| first call (connect + read) | 51 ms | 1017 ms | 582 ms |
| read, no screenshot | 9 / 20 ms | 202 / 509 ms | 239 / 5111 ms |
| read, with screenshot (646x418 PNG, 18 KB) | 48 / 118 ms | 246 / 378 ms | 265 / 1066 ms |
| set-value | 389 / 439 ms | 634 / 857 ms | 757 / 1726 ms |

The tunnel costs about 1.5 RTT per verb (190 to 370 ms here); the screenshot's
bytes add almost nothing over a plain read. A fresh TCP connection through the
forward (a bare `/healthz` with curl) costs p50 505 ms, which is why the client
holds one socket for its process.

## Backend

None required. Optional follow-up: report a laptop's grants in its device
heartbeat, so the app can list and revoke them on the device page. That would
be a Convex change landed from the main tree.

## Files

- `computer/remoteGrant.ts`: the grant, its checks, the method allowlist.
- `computer/remoteServe.ts`: the laptop end on the bridge's `/computer` face.
- `computer/remoteClient.ts`: the host end (`RemoteComputerClient`).
- `computer/remoteCommands.ts`: `cast computer remote [grant|revoke]`.
- `browser/bridge/host.ts`: the `/computer` upgrade, `hostAllowsBrowser`, and the wiring in `runBridgeHost`.
- `browser/bridge/laptopLink.ts`, `cloud/browserLink.ts`: per-laptop link files and ports, `proveLaptopBridge`.
- `browser/bridge/transport.ts`: binary frames on request.
- `scripts/computer-remote-bench.ts`: the round-trip measure.

## Tests

- `computer/remoteGrant.test.ts`: off by default, host and session scope, expiry, app list, method allowlist, no raise, the daily notice.
- `computer/remote.test.ts`: a real bridge host, socket and remote client against a fake helper. Covers refusal without a grant, one socket across requests, screenshots as binary frames (no base64 on the wire), a helper-written file streamed and removed, a revoke cutting a live socket, a revoked key, the machine token refused, a laptop-side grant error, and Chrome off with the apps on.
- `browser/bridge/hostClients.test.ts`: two laptops linking one host (distinct ports, both files live, one closing leaves the other), `--on` selection, owner filter, the legacy file.
- `cloud/browserLink.guard.test.ts`: one `BrowserLinks` per daemon.
