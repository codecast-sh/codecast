# In-network Postgres backup job for the self-hosted Convex deployment.
# Runs INSIDE Railway so it reads postgres.railway.internal at private-network
# speed — the whole point, since the 162GB DB can't be pulled over the internet
# in a CI time budget (that's why the GitHub Actions `convex export` backup has
# failed since April). pg_dump streams straight to R2; nothing lands on disk.
FROM postgres:17-alpine
# postgres image already ships pg_dump 17; add the S3 client + GNU date for rotation.
RUN apk add --no-cache aws-cli coreutils bash
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
CMD ["/usr/local/bin/backup.sh"]
