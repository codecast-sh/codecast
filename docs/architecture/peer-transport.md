# Peer transport: direct links between one owner's machines over Tailscale

Status: in progress (2026-11-11). Builds on `packages/cli/src/cloud/tailnet.ts`
(cloud hosts) and `packages/cli/src/folderSync.ts` (relay folder fetch).

## Problem

Every feature that moves data between two of a person's machines goes through
Convex: a folder archive through storage, a transcript rebuilt from the export,
pane frames through `terminal_frames`. That is slow for large data, capped (the
folder relay refuses past 300 MB), costs storage and bandwidth, and loses what
Convex never stored (tool results, the session folder). Cloud hosts already
dial their tailnet IP; two laptops never talk to each other at all.

## Decision

When both machines are on the same running tailnet, data flows **directly**
between them through a **grant**: a short-lived, single-use listener on the
source machine's tailnet IP. Everything else keeps the relay. Nothing requires
sshd, Tailscale SSH, keys, or any setup beyond Tailscale running on both
machines.

Rejected:
- **ssh/rsync to the peer.** Tailscale SSH is not available in the macOS GUI
  build, and macOS Remote Login is off on most laptops. It would be "direct"
  for almost nobody.
- **Exposing the daemon's loopback server on the tailnet.** It serves a shell,
  the vault and the file browser behind one bearer token. Never.
- **Embedding tsnet / a codecast control plane.** Running a network product.

## Grant protocol

1. **Ask (relay).** The requester sends the request through Convex as today
   (`export_folder`, `export_session`, ...), adding its own tailnet identity
   `{ ip, name }` read from its local `tailscale status`.
2. **Decide (source).** The source opens a grant only when all hold:
   its tailscaled is `Running`; its `tailscale status` shows a peer at exactly
   `requester.ip` with `DNSName === requester.name`, `Online`; the request
   came through the owner's own Convex command queue (so the requester is one
   of the owner's devices). Otherwise it answers through the relay as before.
3. **Grant.** The source binds an HTTP server to **its own tailnet IPv4 only**
   (never 0.0.0.0, never loopback), port 0, and answers the command with
   `{ direct: { ip, name, port, token } }`. The token is 32 random bytes,
   single use, bound to one payload. The listener:
   - accepts connections only from `requester.ip`, drops everything else;
   - serves exactly one `GET /grant/<token>` (constant-time compare), then
     closes; a wrong token closes the listener (no guessing loop);
   - closes after `GRANT_TTL_MS` (120 s) with no connection, and after the
     stream ends.
4. **Pull (direct).** The requester re-validates the source with its own
   `tailscale status` (peer at `ip` named `name`, online) before dialing
   `http://<ip>:<port>/grant/<token>`, then streams the body. Any failure
   (connect refused, timeout, short stream, bad archive) falls back to the
   relay path in the same attempt, and the reason is logged.

Trust summary: Convex authorizes *which* machines may ask (same owner); the
tailnet authenticates *where* bytes go (WireGuard keys behind the IP/name);
the token binds one request to one stream. "Same tailnet" alone never grants
anything (shared and company tailnets).

## Payloads

| Payload | Command | Direct body | Relay fallback |
|---|---|---|---|
| Session folder | `export_folder` | streamed `tar.gz` of the same include list (gitignored files and `.env*` excluded), no 300 MB cap (sanity cap 20 GB) | storage archive (300 MB) |
| Session transcript | `export_session` | streamed `tar.gz` of the agent's real transcript file(s) and session folder | regenerate from the Convex export |

Later (not in this pass): terminal and browser-watch tunnels between laptops
(a grant that proxies one WebSocket to the source's loopback server), and
`git fetch` of wip refs from a peer.

## Discovery and UI

- The heartbeat reports `tailnet: { ip, name, tailnet }` (tailnet = MagicDNS
  suffix) only when it changes; stored on `devices`, projected only to the
  owner (`listDevices`), never to teammates.
- Settings → Machines shows each machine's Tailscale state, and for the
  machine you are on, which of your other machines it can reach directly
  ("Direct" when both report the same tailnet and the peer is online,
  otherwise "Relayed" with the reason).
- A user setting `direct_links` (default on) turns grants off; a source with
  it off always answers through the relay.

## Code map

- `packages/shared/contracts/peerTransport.ts` — pure: `PeerTailnet` type,
  `samePeerTailnet`, `peerLinkState(self, peer, now)` for the UI.
- `packages/cli/src/peer/grant.ts` — the grant listener (source side).
- `packages/cli/src/peer/pull.ts` — validate + dial + stream (requester side).
- `packages/cli/src/cloud/tailnet.ts` — `localTailnet` gains an async variant
  so hot paths never `spawnSync`; `selfTailnet(status)`, `peerOnline(status, record)`.
- `packages/cli/src/folderSync.ts` — direct-first, relay fallback.
- `packages/convex/convex/folderSync.ts` — passes requester tailnet through.
