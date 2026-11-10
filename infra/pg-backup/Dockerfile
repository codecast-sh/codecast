# Postgres backup job for the self-hosted Convex deployment. Built on the
# production host as codecast/pg-backup and run nightly by the systemd timer in
# infra/host/pg-backup, on the `codecast` docker network, so it reads
# postgres:5432 directly. That is the whole point: the database is too large to
# pull over the internet in a CI time budget (a GitHub Actions `convex export`
# backup failed for that reason). pg_dump streams straight to R2; nothing lands
# on disk.
FROM postgres:17-alpine
# postgres image already ships pg_dump 17; add the S3 client + GNU date for rotation.
RUN apk add --no-cache aws-cli coreutils bash
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
CMD ["/usr/local/bin/backup.sh"]
