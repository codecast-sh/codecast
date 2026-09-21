# The production Convex host

What is actually running, as of 2026-09-22. The files beside this one are the
source of truth for configuration; this file records the facts about the machine
that no file in the repo can tell you.

## The machine

| | |
|---|---|
| Instance | `i-008b985d1d176faa2`, `r7g.8xlarge` (32 vCPU, 247 GB RAM, Graviton) |
| Account / region | Union AWS `767398104971`, `us-east-1d` |
| Address | `35.174.124.200`, an Elastic IP (`eipalloc-01460914a27378b22`) |
| Disk | 1 TB gp3 mounted at `/srv` by filesystem label `codecast-data` |
| SSH | `ssh convex-prod` (alias in `~/.ssh/config`; key `~/.ssh/codecast-union.pem`, `IdentitiesOnly` required) |
| DNS | `convex.codecast.sh`, an A record in Cloudflare, NOT proxied, TTL 60 |

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

## Stopping and starting the machine

Downtime is about two and a half minutes. Do it in the overnight trough (the box
idles at 5 to 20% CPU between roughly 22:00 and 07:00 UTC).

1. Checkpoint Postgres so there is little WAL to replay:
   `sudo docker exec postgres psql -U postgres -c "CHECKPOINT;"`
2. Stop the instance. Let the OS shut the containers down; do NOT
   `docker stop` them, because an explicitly stopped container is not restarted
   on boot even with `restart=unless-stopped`.
3. Do the work, start the instance, then verify by what the stack DOES, not by
   whether ports answer: all four containers up, `pg_is_in_recovery()` false,
   `https://codecast.sh` 200, and one real query against Postgres
   (`_system/frontend/tableSize:default` on `messages`, admin key from
   `packages/convex/.env.local`).

Slow query lines in the Postgres log for the first minute after a start are the
cold cache, not a fault.

## Cost

About $1,250 a month for the instance on demand, plus about $80 for the volume.
It was about $625 before the resize. Nothing here is on a reserved instance or a
savings plan yet, so the whole bill is on demand.
