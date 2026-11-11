# The production Convex host

What is actually running, as of 2026-11-10. The files beside this one are the
source of truth for configuration; this file records the facts about the machine
that no file in the repo can tell you.

## The machine

| | |
|---|---|
| Instance | `i-015ef3512c33009f0`, `r7g.16xlarge` (64 vCPU, 494 GB RAM, Graviton), launched 2026-11-10 from AMI `ami-058ffe161035c37b5` (a copy of the previous host's root disk) |
| Account / region | AWS `045275879943` (the default AWS CLI profile), `us-east-1d` |
| Address | `184.192.248.132`, an Elastic IP (`eipalloc-0fb9c5bd0778d91f6`) |
| Disk | 1.5 TB gp3 (`vol-00fc743a09f9540e7`, 16000 IOPS, 1000 MB/s) mounted at `/srv` by filesystem label `codecast-data`, restored from a snapshot of the previous host's data volume |
| SSH | `ssh convex-prod` (alias in `~/.ssh/config`; key `~/.ssh/codecast-union.pem`, `IdentitiesOnly` required) |
| DNS | `convex.codecast.sh`, an A record in Cloudflare, NOT proxied, TTL 60 |

**The previous host is parked and must stay stopped.** Until 2026-11-10 prod ran on
`i-008b985d1d176faa2` in Union's AWS account `767398104971` (Elastic IP
`35.174.124.200`, data volume `vol-0c1fb3f658ebb7d8e`). AWS restricted that account
after flagging access keys, and refused to start the host after a resize stop, so
prod was rebuilt here from snapshots with no data lost (down 19:16 to 23:17 UTC).
The old data volume is detached. Starting the old host with it reattached would
run a second Convex with its own crons and side effects against a stale copy.

It was an `r7g.8xlarge` (32 vCPU) from 2026-09-22 to 2026-10-23, when a day at
80 to 94% CPU from the growing agent fleet moved it to 64 vCPU (sd-1280).
It was an `r7g.4xlarge` (16 vCPU) until 2026-09-22. CPU, not memory, forced the
change: the box ran at 85 to 95% average CPU for four to eight hours on each of
four straight workdays, and API calls began to time out at peak (sd-189).

**The address is an Elastic IP because it has to be.** `convex.codecast.sh` is
unproxied, so DNS points straight at this machine. Before 2026-09-22 the box
used the automatically assigned public address, which changes on every stop and
start. Any resize, or AWS hardware maintenance, would have moved the address and
left the site pointing at nothing until someone noticed. Keep the Elastic IP
attached, and keep the DNS TTL at 60 so a planned move costs a minute.

## How it comes back after a reboot

Every container carries `restart=unless-stopped` and `docker.service` is
enabled, so a reboot brings the whole stack back with no human action. The
resize on 2026-09-22 took 2 minutes 20 seconds of downtime, end to end, on that
mechanism alone.

`codecast-convex.service` exists but is DISABLED, deliberately. Do not enable it
without reading the next paragraph: it runs `docker compose up -d` in
`/srv/convex`, which would start this directory's `caddy` service and fail,
because the Caddy container that is actually serving was started outside compose
and already holds ports 80 and 443.

## Known drift between this directory and the host

- **Caddy runs outside compose.** The live container is named `codecast-caddy`
  and carries no compose labels. The `caddy` service in `docker-compose.yml`
  describes it but does not manage it.
- **Postgres lives in its own project**, `/srv/postgres`, from
  `infra/host/postgres/docker-compose.yml`. It is a separate compose project on
  the shared external `codecast` network.

Both mean that `docker compose up -d` in `/srv/convex` is NOT how you restart
this stack. Restart one container by name instead.

## Function logs

The backend keeps its function log only in memory, about 70 seconds at
production load, so `npx convex logs --history` cannot reach anything older.
`logtail/` (its own compose project in `/srv/convex-logtail`, started
2026-10-09) streams it to `/srv/convex/logs/<YYYY-MM-DD>/<HH>*.jsonl.gz`, UTC
hours, one `convex logs --jsonl --success` event per line, kept 14 days. That is
about 1.1 GB a day gzipped. An hour can have several files (one per tail
restart); read them together:

```bash
ssh convex-prod 'zcat /srv/convex/logs/2026-10-09/17*.jsonl.gz' | grep '"accountSwitch:'
```

The tail starts from "now" whenever it restarts, so a restart leaves a gap of
seconds. The current hour's file is still open: it reads up to the last
5-second flush and then zcat warns "unexpected end of file", which is expected. Its admin key lives only in `/srv/convex-logtail/.env`.

## What the backend can reach from inside

Mods and deploy-target readers make server-side fetches to addresses users
choose. `convex/lib/guardedFetch.ts` refuses private, loopback, link-local and
metadata addresses, but it resolves the name once and `fetch` resolves it again,
so an attacker who runs their own DNS can still rebind a name to an internal
address. What that reaches, checked 2026-11-11:

| Target | Reachable from `convex-backend-1` | Exposure |
|---|---|---|
| Instance metadata `169.254.169.254` | yes, IMDSv1 (`HttpTokens=optional`, hop limit 1) | no IAM role and no user data, so instance facts only |
| Other hosts in `vpc-02f1e86a336a35ce7` | none exist; this is the account's only instance | none today |
| `codecast` docker network (postgres, dashboard 6791, pg-backup, logtail) | yes | dashboard and backend admin APIs need the admin key; postgres is not HTTP |
| Host services | only sshd on 22; Caddy has no admin listener, everything else binds 127.0.0.1 | none over HTTP |

Keep it that way: never attach an IAM role or user data with secrets to this
instance, and never put another service in this VPC, without first adding a
`DOCKER-USER` iptables rule that drops traffic from `172.18.0.0/16` to
`169.254.0.0/16` and the private ranges other than `172.18.0.0/16`, with an
exception for the VPC resolver `172.31.0.2` port 53, which the container's DNS
uses. Setting `HttpTokens=required` takes metadata away from containers
entirely (the hop limit of 1 already blocks their token request).

## Stopping and starting the machine

Downtime is about two and a half minutes. Do it in the overnight trough (the box
idles at 5 to 20% CPU between roughly 22:00 and 07:00 UTC).

1. Checkpoint Postgres so there is little WAL to replay:
   `sudo docker exec postgres psql -U postgres -c "CHECKPOINT;"`
2. Stop the instance. Let the OS shut the containers down; do NOT
   `docker stop` them, because an explicitly stopped container is not restarted
   on boot even with `restart=unless-stopped`. The 2026-10-23 resize stopped
   Postgres and the backend by hand and they stayed down: 5.5 minutes offline.
   If that happens, start them by name (`docker start postgres`, then
   `docker start convex-backend-1`), never `docker compose up -d` in
   `/srv/convex`, which also starts the stale compose Caddy (see Known drift).
3. Do the work, start the instance, then verify by what the stack DOES, not by
   whether ports answer: all four containers up, `pg_is_in_recovery()` false,
   `https://codecast.sh` 200, and one real query against Postgres
   (`_system/frontend/tableSize:default` on `messages`, admin key from
   `packages/convex/.env.local`).

Slow query lines in the Postgres log for the first minute after a start are the
cold cache, not a fault.

## Cost

About $2,500 a month for the instance on demand (r7g.16xlarge since 2026-10-23; $1,250 as an 8xlarge), plus about $120 for the volume (1.5 TB since 2026-10-22).
It was about $625 before the resize. Nothing here is on a reserved instance or a
savings plan yet, so the whole bill is on demand.
