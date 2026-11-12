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

1. **Ask (relay).** The requester calls `folderSync.requestFolderExport`
   with its own tailnet `{ ip, name }` (from its `tailscale status`) and
   `token_hash = sha256(S)` for a fresh 32-byte secret `S` it keeps. `S` never
   leaves the requester except over the direct connection.
2. **Path authority (Convex).** The path served is the conversation's own
   recorded folder (`project_path`, `git_root` or `worktree_path`); any other
   path is refused. Convex puts `direct: { requester, token_hash }` into the
   `export_folder` args only when the requester sent a tailnet and the source
   device has not turned direct links off. One live request per
   (conversation, path); a per-user rate limit.
3. **Decide (source).** The source grants only when all hold, else it answers
   through the relay in the same command:
   - its tailscaled is `Running` and its own tailnet IPv4 is on a local
     interface (not userspace networking);
   - its `tailscale status` shows a peer at exactly `requester.ip`, named
     `requester.name`, `Online`, not `ShareeNode`, with the **same Tailscale
     `UserID` as Self** (a company or shared tailnet is never enough);
   - the macOS application firewall is not set to block all incoming;
   - the folder plan fits the direct cap (2 GB; larger needs a confirm, later).
4. **Grant.** An HTTP listener bound to Self's tailnet IPv4 only, port 0,
   `maxConnections = 1`. Sockets whose remote address is not `requester.ip`
   (or local address not the grant IP) are destroyed before a byte is read.
   It serves one `GET /grant/<S>` where `sha256(S) === token_hash`
   (constant-time), streaming `tar -cz` of the plan; anything else gets 404
   and does not close the grant. Deadlines: connect within 60 s, idle 30 s,
   hard total. tar is killed when the socket closes. At most 2 live grants.
   The command answers `{ ok, direct: { ip, name, port }, bytes, files, path }`.
5. **Pull (direct).** The requester re-checks the source the same way
   (same UserID, online, at that ip/name), dials with a 5 s connect timeout
   and a 30 s idle timeout, and pipes the body into a hardened extract.
6. **Fallback.** Any direct failure re-requests from the same machine with
   `relay_only: true` (the relay cap still applies). The outcome of every
   attempt is recorded per machine pair (`peer_links`), which is what the UI
   shows.

Extraction (both paths) goes to a staging folder beside the destination with
`--no-same-owner --no-same-permissions`; then hardlinks, devices, fifos and
symlinks whose target leaves the folder are removed, `.git/hooks` is emptied
and `.git/config` loses `core.fsmonitor`, `core.hooksPath`, `core.sshCommand`,
`*.helper`, `include*` keys; then it is renamed into place. A destination must
be inside `$HOME`, not in a dot-folder at the top of home, not under
`~/Library`. The source refuses the same places and never packs files that
look like keys or credentials (`.env*`, `id_*`, `*.pem`, `*.key`, `*.p12`,
`.netrc`, `.npmrc`, `.pypirc`, `credentials*`).

## Payloads

| Payload | Command | Direct body | Relay fallback |
|---|---|---|---|
| Session folder | `export_folder` | streamed `tar.gz` of the include list, up to 2 GB | storage archive (300 MB) |
| Session transcript (new) | `export_session` | streamed `tar.gz` of the session's transcript file and session folder, resolved from the conversation's session id only | the same archive through storage; regeneration from the Convex export only when no source is online |

Later: terminal and browser-watch tunnels between laptops, `git fetch` of wip
refs from a peer, a confirm for folders over 2 GB.

## Discovery and UI

- The heartbeat reports `tailnet: { ip, name, tailnet, ts_user_id, bindable }`
  only when it changes; stored on `devices`, projected only to the owner.
- Each machine row in Settings → Machines has a Tailscale state with its
  action (install / sign in / different account) and an "Accept direct links"
  switch (`devices.direct_links_off`, enforced by Convex when it builds the
  request).
- Pair state comes from facts, not guesses: both on the same Tailscale user,
  the source bindable, and the last recorded transfer outcome (`peer_links`).
- While a folder or transcript moves, the conversation shows a progress row
  (asking / packing on X / receiving N of M / unpacking, Direct or Relay) with
  Cancel, where the restart status already appears.

## Code map

- `packages/shared/contracts/peerTransport.ts` — pure: `PeerTailnet` type,
  `samePeerTailnet`, `peerLinkState(self, peer, now)` for the UI.
- `packages/cli/src/peer/grant.ts` — the grant listener (source side).
- `packages/cli/src/peer/pull.ts` — validate + dial + stream (requester side).
- `packages/cli/src/cloud/tailnet.ts` — `localTailnet` gains an async variant
  so hot paths never `spawnSync`; `selfTailnet(status)`, `peerOnline(status, record)`.
- `packages/cli/src/folderSync.ts` — direct-first, relay fallback.
- `packages/convex/convex/folderSync.ts` — passes requester tailnet through.
