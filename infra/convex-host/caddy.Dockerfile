# Caddy with the Cloudflare DNS provider compiled in. The stock image cannot
# answer a DNS challenge, and convex.codecast.sh needs its certificate issued
# before DNS points here, which only a DNS challenge can do.
FROM caddy:2-builder AS build
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2
COPY --from=build /usr/bin/caddy /usr/bin/caddy
