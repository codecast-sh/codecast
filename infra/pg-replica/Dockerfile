# Streaming read replica of the Railway Postgres primary, used as the source
# for the nightly pg_dump (infra/pg-backup) so the dump's 70-minute full-table
# read never touches the primary again (2026-09-04: that read stalled every
# Convex write for the whole window). Same image as the primary — same major
# version, glibc and en_US.utf8 collation, which a standby must share — with an
# entrypoint that takes a base backup on first boot and then hands off to the
# template's normal startup.
FROM ghcr.io/railwayapp-templates/postgres-ssl:17
COPY --chmod=755 replica-entrypoint.sh /usr/local/bin/replica-entrypoint.sh
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/replica-entrypoint.sh"]
CMD ["postgres", "-p", "5432", "-c", "listen_addresses=*"]
