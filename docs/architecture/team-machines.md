# Team machines

A team machine is a Linux box that belongs to a team, where every member runs
sessions as themselves: their own Linux user, their own daemon, their own
Claude login, their own worktrees. It is the server-side face of a shared host
(shared-hosts.md covers what is on the box). Lending a machine is the other
kind of sharing (device_shares: teammates' sessions run as the owner) and
stays for personal machines.

The jobs:

- **Admin**: turn a box into a team machine once, see who is on it and how
  loaded it is, remove a member.
- **Member**: join from the app with one confirm, sign in to Claude from the
  browser, then pick the machine like any of their own.

No step needs SSH. A member who also wants a shell gets their keys installed
on join (GitHub keys, plus the laptop key when joining from the CLI).

## Model

Two tables, one home per fact.

- `team_hosts`: the machine. `team_id` (who may see and join it), `name`,
  `host_key` (random, written into the box's marker), `admin_user_id`,
  `admin_device_id` and `admin_linux_user` (the daemon that runs as the box's
  sudoer and carries out joins and removals), `address` (for ssh) and
  `platform`.
- `team_host_members`: one row per person on the machine. `host_id`,
  `user_id`, `linux_user`, `device_id` (their daemon's device, once it beats),
  `status` (`joining`, `ready`, `failed`, `removing`), `step` and `error` while
  joining, and `voucher` (the one-hour setup token the admin daemon exchanges
  for the member's login; cleared the moment it is claimed, never returned by
  a query).

A member's device is still an ordinary row of theirs in `devices`. Its link to
the machine is the member row's `device_id`; nothing is copied onto the device.

## The marker is the machine's identity

`/etc/codecast/shared-host` holds `key=<host_key>`, `admin=<linux user>` and
`team=<team id>` lines once the machine is registered (an empty marker is a
shared host that is not registered). Every daemon on the box reads it and
sends `team_host: { key, linux_user }` on its heartbeat. The server finds the
machine by key and, when the beating user is on its team, upserts their member
row as `ready` with that device. This is the one way a member becomes ready,
so a box set up by hand and a box joined from the web converge on the same
rows.

## Joining

1. The member presses Join (web: Settings → Team → Machines, or the composer's
   machine menu; CLI: `cast hosts team join <machine>`). The confirm names
   the Linux user, that the admin has root on the box, and that sessions run
   on the member's own Claude account.
2. `teamHosts.join` checks team membership, picks the Linux user (GitHub login
   or email name, made unique on the machine), mints the voucher, writes the
   member row `joining`, and queues `team_host_member {member_id, action: add}`
   for the admin device.
3. The admin daemon claims the row (`teamHosts.claimMember`: admin device
   only, returns the voucher once), then runs the same scripts
   `cast hosts provision --add-user` runs (sharedHost.ts), locally: user and
   keys, the member's own tools, Claude's first-run answers, `cast login` with
   the voucher, the path unit. It reports each step (`teamHosts.reportMember`).
4. The member's daemon starts and beats; the row turns `ready`.
5. The member signs in to Claude on that device from the browser
   (`requestLoginFlow` with the code-paste page), the same flow every machine
   uses.

Leaving or removal queues `action: remove`: the admin daemon stops and
disables the member's daemon and locks the login, and the server revokes the
tokens bound to that device and deletes the row. The member's home stays; only
the admin deletes files, by hand.

## Logins

A member's sessions use the member's own logins. The box refuses laptop
credential pushes (shared-hosts.md) into every Linux user except the admin's:
the admin is the only sudoer, so their home is private to them, and their
laptop's logins go there exactly as on a private host. A member's home is
readable by the admin, so their logins are made on the box (Claude through
the browser flow above).

## Load

Every member's daemon already reports the box it runs on (machine_resources:
CPU, memory, and the processes of that member's own sessions). The machine's
load is the freshest member report; each member's usage is the sum of their
own sessions' processes. Both are rounded in `teamHosts.list`, so a quiet box
pushes nothing new. A machine is busy at the overload alert's bar: CPU at
`CPU_BUSY_PERCENT` or memory pressure (load average is never the signal: agent
fleets keep it far above the core count while the CPU idles). Settings shows
CPU and free memory per machine, and a machine chip in the composer turns
yellow and shows CPU when busy.

## One cast on the box

A member's `~/.local/bin/cast` runs the box's own bundle
(`/usr/local/lib/codecast`) on the member's own bun when the box was
provisioned from source, so every daemon there runs the admin's version and
follows its updates; otherwise each member gets the published release.

## Starting and stopping your own daemon

The per-user units key on `~/.codecast/daemon.wanted`, a file the member owns:
the path unit starts the daemon when it appears, and the service will not run
without it. `cast start` creates it, `cast stop` removes it and stops the
daemon, and Restart= then leaves the unit down. Nobody but the admin needs
sudo.

## ARM boxes

A Graviton type (`--type r8g.4xlarge`, `t4g.large`) launches Canonical's arm64
Ubuntu and provisions like any host, minus Chrome: Google ships it for x86_64
Linux only, so `cast browser` is unavailable there. A headless team machine
loses nothing it uses, and Graviton costs less for the same memory.

## Placement

A launch parks for laptop placement only on a machine some laptop manages
(`cloud_host` report). `cloudHostManaged` in contracts/cloudPlacement.ts is the
one predicate; the composer and the server both call it. Every other remote
machine, a team machine's member devices included, gets a plain start.
