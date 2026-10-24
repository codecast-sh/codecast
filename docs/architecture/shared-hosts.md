# Shared Linux hosts

A Linux cloud host that several teammates use at once. Each person has their own Linux user, codecast account, Claude subscription and daemon, and the box never shuts itself down.

```bash
cast hosts provision <id> --shared                                  # once, by the admin
cast hosts provision <id> --add-user cam --github cameron417        # per person; re-run to refresh keys and tools
```

Code: `packages/cli/src/browser/sharedHost.ts` (script generators), `addUserToHost` and the `shared` branch of `provisionLinuxHost` in `browser/provisionLinux.ts`, and `remote/sharedHostGuard.ts` (the host-side push refusal).

## Every daemon is a peer

A shared host runs only peer daemons, never remote devices (`is_remote`). That includes the admin's (owner's) own daemon.

Remote mode assumes one person's laptop owns the box. Placement works only from the laptop that registered the host. That laptop pushes its own Claude credential and agent logins. Wake-on-work boots a stopped box for one account. None of that fits several people with separate accounts.

A peer daemon is the same as a laptop's. It signs in with its own codecast token, runs Claude on its own `claude setup-token` token (`CLAUDE_CODE_OAUTH_TOKEN` from `~/.codecast/claude.env`), and creates worktrees itself when a spawn targets it (`cast spawn --device <id> --isolated`, or the web).

Peer mode gives up two things:

- **Wake-on-work.** A shared host has to stay up anyway: the idle watchdog sees only the owner's activity, so it would power the box off under everyone else. `--shared` therefore means `--idle 0`, and an explicit nonzero `--idle` is refused.
- **Laptop-driven placement.** Nobody needs it: anyone can spawn onto their own device on the box from anywhere.

None of this changes the server. `is_remote` follows each daemon's heartbeat. When a shared provision removes the owner's remote-device marker and its `CODECAST_REMOTE_DEVICE`, the next heartbeat clears the flag.

## Laptop logins reach only the admin's home

`/etc/codecast/shared-host` marks a host as shared and names its admin
(`admin=<linux user>`, the provisioning user and the box's only sudoer). A
registered team machine's marker also carries `key=` and `team=`
(team-machines.md). Every remote command that receives a credential checks it
first: the Claude credential, the agent-logins bundle, and the provider-key
store. When the marker is there and the receiving user is not its admin, the
command discards its stdin and exits 4 with the reason.

The admin's home is private to them (only they have sudo), so their own
laptop's logins go there exactly as on a private host: provisioning, a wake,
`cast hosts sync-auth`, a session move and the daemon's periodic refresh all
push to it. Every other user's home is readable by the admin, so nothing of
any laptop's is pushed into it; those members sign in on the box with their
own accounts (team-machines.md: Claude through the browser flow).

The refusal lives on the host, so it holds no matter which laptop or which
path pushes. The marker is written right after the base stack, naming the
admin, before any credential step. From then on the host also refuses to link
a tool into `/usr/local/bin`, so a later update or wake cannot re-create the
links.

Two more rules:

- A later provision keeps the host shared, even when it runs from a laptop whose registry never recorded it: the provision reads the marker.
- `shared` also sets `browserSync: false`. The host's Chrome runs as the owner, and any user on the box can reach its debugging port, so no cookies are carried into it.

## Binaries live in each user's home

Ubuntu creates homes with mode 750. So a `/usr/local/bin` symlink into one user's home is "permission denied" for everyone else, and a systemd unit that runs one fails with 203/EXEC.

On a shared host:

- **No `/usr/local/bin` link points into a home.** `--shared` removes every such link, the link steps check the marker, and the owner's daemon unit runs `~/.local/bin/cast`. A cast built from source is the one exception: its `/usr/local/bin/cast` is a wrapper file that runs the owner's bun. Only the owner runs it, because everyone else's own cast comes first on PATH.
- **Each person gets their own copies.** `--add-user` installs bun, the published cast, the agent CLIs and node 22 into the new user's home, at the versions on the provisioning laptop. These tools update themselves per user (claude, cast) or carry per-user state (bun globals), so one shared copy would not work.
- **The per-user install hides `/usr/local/bin` from `PATH`.** Otherwise a tool linked there for the owner would satisfy the `command -v` guard, and the new user's own copy would never be installed.
- **Each user's `~/.bashrc` starts with a PATH line** that puts their own tool directories first. It sits above Ubuntu's "not interactive, return" guard. Ubuntu's bash reads `~/.bashrc` for commands run over ssh (it is built with `SSH_SOURCE_BASHRC`), so `ssh cam@host cast …` also finds cam's tools. The daemon unit sets the same PATH.

## The per-user daemon

Two system template units do the work:

- **`codecast-daemon-user@<user>.service`** runs the person's daemon:
  - `User=<user>`
  - `ExecStart=/home/<user>/.local/bin/cast _daemon`
  - `EnvironmentFile=-/home/<user>/.codecast/claude.env`
  - `ConditionPathExists` on their codecast config, and `ExecCondition` on `~/.codecast/daemon.wanted` (checked before every start, automatic restarts included; a `Condition=` is not)
  - `KillMode=process`, so a restart leaves their tmux sessions running
- **`codecast-daemon-user@<user>.path`** starts that service as soon as `~/.codecast/daemon.wanted` exists.

The person starts and stops their own daemon with that file, which they own:
`cast login` and `cast start` create it, `cast stop` removes it and stops the
daemon, and the service's condition then keeps Restart= from reviving it. No
sudo. Setup gives everyone already signed in the file, so converting a box
keeps their daemons running.

`--add-user` enables the path unit. The owner keeps `codecast-daemon.service`, which the update and restart paths already manage, with the same peer settings. A shared provision disables a hand-built `codecast-daemon-user@ubuntu` so the owner never runs two daemons.

## Claude's first-run screens

These are answered in configuration, with no login and no interactive accept (verified on Claude Code 2.1.301):

- **Onboarding and theme:** `hasCompletedOnboarding` and `theme` in `~/.claude.json`.
- **Trust:** `projects[$HOME].hasTrustDialogAccepted`. Trust is inherited by every folder under a trusted one, so this covers every worktree.
- **The bypass-permissions consent:** `skipDangerousModePermissionPrompt: true` in `~/.claude/settings.json`. The `.claude.json` `bypassPermissionsModeAccepted` flag alone still shows the dialog.

## What a person runs

`--add-user` prints these steps for a box nobody registered as a team machine; on a team machine, members join from the app instead (team-machines.md).

```bash
ssh cam@<host>
claude setup-token                 # their own Claude account
read -rsp 'Claude token: ' t && (umask 077; printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$t" > ~/.codecast/claude.env); echo
cast login <token>                 # codecast → Settings → CLI → Generate token; the daemon starts
```

If the Claude token arrives after the daemon has started, the person restarts their own daemon by killing it (`pkill -u $USER -f 'cast _daemon'`), and systemd starts it again on the new token. A tmux server that daemon already started outlives the restart (`KillMode=process`) and keeps the old environment, so if sessions ran before the token, run `tmux kill-server` too.

## Keys

`--github <login>` writes the user's `authorized_keys` from `github.com/<login>.keys`, plus their own `~/.ssh/authorized_keys.local`. Re-running `--add-user` refreshes the keys. There is no periodic sync.

## Moving union-shared onto this

union-shared was set up by hand, so move it in this order:

1. Move each user's `~/.config/union/claude.env` to `~/.codecast/claude.env` (mode 600).
2. Run `cast hosts add` for the box, then `cast hosts provision <id> --shared`. This replaces the template unit and disables `codecast-daemon-user@ubuntu`.
3. Remove `/etc/sudoers.d/union`. Its `codecast-daemon-user@*` wildcard lets any member stop anyone's daemon, and the path unit makes it unnecessary.
4. Run `--add-user` per person, to switch their unit to the path-started one and give them their own tools.
