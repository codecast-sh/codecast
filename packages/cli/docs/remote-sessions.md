# Remote Sessions: Move to Mac

Move a live Claude Code session to a remote Scaleway Mac mini and back.
The remote Mac is "just another device" — same daemon, same JSONL sync,
same web visibility. The session continues on the Mac exactly where it
left off, including conversation history, working tree, and browser substrate.

## Quick start

```bash
# Move a session to the Mac (worktree-only)
cast remote move <sessionId>

# Web-inject a message (daemon auto-delivers to the Mac session)
# → just send it from codecast.sh like normal

# Bring it back
cast remote back <sessionId>

# One-shot prompt on the remote (without full move)
cast remote push <sessionId>          # transfer worktree + transcript
cast remote run  <sessionId> "msg"    # drive via print mode
cast remote pull <sessionId>          # bring changes back
```

## Commands

| Command | What it does |
|---|---|
| `cast remote hosts` | List this device + registered remote Macs |
| `cast remote push <sid>` | Transfer worktree (git-over-SSH) + transcript + credential |
| `cast remote pull <sid>` | Pull back (git fast-forward, never clobbers; surfaces conflicts) |
| `cast remote run <sid> "msg"` | One-shot prompt on the remote (print mode, acceptEdits) |
| `cast remote move <sid>` | **Atomic live handoff**: push + prep + flip ownership + resume on Mac |
| `cast remote back <sid>` | **Reverse**: pull + flip ownership back + resume locally |

## How it works

**Transfer**: git-over-SSH. The worktree branch is pushed to a clone on the
Mac (bootstrapped via bundle). Uncommitted changes travel as a WIP snapshot
commit. Gitignored files (.env) are scp'd via the manifest copy-list.

**Transcript**: the JSONL (`~/.claude/projects/<slug>/<sid>.jsonl`) is rsynced
into the Mac's project dir. `claude --resume <sid>` continues the conversation.

**Auth**: the CC OAuth credential is copied from the local Keychain to
`~/.claude/.credentials.json` on the Mac (plaintext file; the remote CC reads
it). The token is ~1h TTL; the move always copies a fresh one. For sessions
running >1h, re-push with `cast remote push`.

**Ownership**: a `devices` table in Convex tracks each machine. A session's
`owner_device_id` determines which daemon manages it. `move` flips it to the
Mac; `back` flips it to local. The single-owner invariant prevents both
daemons from managing the same session simultaneously.

**Daemon**: the Mac runs its own codecast daemon from source
(`bun run src/index.ts _daemon`), heartbeating as a distinct remote device.
A remote daemon only manages sessions it explicitly owns (safety gate in
`autoResumeSession` — never adopts unowned sessions).

## Setup (one-time per Mac)

1. **Provision**: Scaleway M1 Mac (24h minimum, ~€2.64/day). `cast remote provision` (or manually via Scaleway console + register in `~/.codecast/scaleway/hosts.json`).

2. **SSH key**: `~/.codecast/scaleway/<host-id>/id_ed25519` (generated at provision, registered with Scaleway IAM).

3. **Install toolchain on the Mac** (via SSH):
   ```bash
   # Claude Code
   curl -fsSL https://claude.ai/install.sh | bash
   # bun
   curl -fsSL https://bun.sh/install | bash
   # tmux (from source, no sudo)
   # (see scripts/mac-daemon-bootstrap.sh for the build)
   ```

4. **Transfer codecast source**: `git archive HEAD | gzip | scp` + `bun install --linker hoisted`.

5. **Auth codecast daemon**: copy your decrypted token to the Mac's `~/.codecast/config.json`.

6. **Bootstrap**: `bash scripts/mac-daemon-bootstrap.sh` (overlays CLI source, removes `daemon.js` shadow, starts daemon).

## Known constraints

- **24h minimum Mac billing** (Apple licensing — all cloud macOS, not just Scaleway).
- **Credential ~1h TTL** — move always copies fresh; for long sessions, re-push.
- **Worktree-only** — the bounded git branch makes the transfer reliable.
- **`daemon.js` shadow** — committed compiled JS shadows `daemon.ts` under bun. The bootstrap removes it.
- **First-run dialogs** — the Mac needs pre-seeded `~/.claude.json` (onboarding, theme, folder trust) or resumed sessions hang on interactive prompts. `cast remote move` handles this.

## Architecture

The Mac is "just another device":
- `device_id` derived from `~/.codecast/.machine_key` (unique per machine).
- Daemon heartbeats register the device + its local project roots.
- Sessions carry `owner_device_id` → single-owner invariant.
- Moving = flip ownership + enqueue `resume_session` daemon command.
- The Mac daemon resumes in tmux, syncs JSONL to Convex → visible in web.
- Web messages inject via the normal pending-message → daemon → tmux path.
