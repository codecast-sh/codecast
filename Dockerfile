FROM oven/bun:1 AS builder

WORKDIR /app

# Copy everything for workspace resolution
COPY . .

# Install dependencies
RUN bun install

# Build convex (types)
RUN cd packages/convex && bun run build 2>/dev/null || true

# Build web
RUN cd packages/web && rm -rf .next && bun run build

# Production image
FROM oven/bun:1-slim

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./

WORKDIR /app/packages/web

EXPOSE 3000

CMD ["bun", "run", "start"]
