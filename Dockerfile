FROM oven/bun:1 AS builder

WORKDIR /app

# Copy package files
COPY package.json bun.lockb ./
COPY packages/web/package.json packages/web/
COPY packages/convex/package.json packages/convex/
COPY packages/cli/package.json packages/cli/

# Install dependencies
RUN bun install

# Copy source files
COPY . .

# Build convex (types)
WORKDIR /app/packages/convex
RUN bun run build 2>/dev/null || true

# Build web
WORKDIR /app/packages/web
RUN rm -rf .next && bun run build

# Production image
FROM oven/bun:1-slim

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./

WORKDIR /app/packages/web

EXPOSE 3000

CMD ["bun", "run", "start"]
