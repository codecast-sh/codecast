# Contributing to Codecast

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) (package manager and runtime)
- [Convex](https://www.convex.dev) (self-hosted or cloud)
- Node.js 20+
- nginx (optional, for local domain routing)

### Setup

1. Clone the repo and install dependencies:
   ```bash
   git clone https://github.com/ashot/codecast.git
   cd codecast
   bun install
   ```

2. Copy environment files:
   ```bash
   cp packages/web/.env.example packages/web/.env.local
   cp packages/convex/.env.example packages/convex/.env.local
   cp packages/cli/.env.example packages/cli/.env.local
   ```

3. Configure your Convex instance URL in each `.env.local`.

4. Start the dev server:
   ```bash
   ./dev.sh      # http://local.codecast.sh
   ./dev.sh 1    # http://local.1.codecast.sh (multi-instance)
   ```

### Nginx (optional)

Copy the example nginx config and adjust as needed:
```bash
cp nginx.dev.conf.example nginx.dev.conf
```

This routes `local.codecast.sh` to the local dev server. Add `127.0.0.1 local.codecast.sh` to `/etc/hosts`.

## Architecture

Codecast is a Bun monorepo with these packages:

| Package | Description |
|---------|-------------|
| `packages/cli` | CLI daemon that watches coding sessions and syncs to Convex |
| `packages/convex` | Convex backend: schema, queries, mutations, auth |
| `packages/web` | React + Vite web dashboard |
| `packages/electron` | Electron desktop app |
| `packages/mobile` | Expo/React Native iOS app |
| `packages/shared` | Shared utilities (encryption, key derivation) |

## Code Conventions

### React: No Direct useEffect

`useEffect` is banned in `packages/web` (enforced by lint). Two escape hatches:

- **`useMountEffect(fn)`** -- one-time external sync on mount
- **`useEventListener(event, handler, target?, options?)`** -- event subscriptions with cleanup

Instead of useEffect, use these patterns:

1. **Derive state, don't sync it.** `const x = f(y)` instead of `useEffect(() => setX(f(y)), [y])`
2. **Data fetching belongs in the library.** Use Convex queries (`useQuery`, `usePaginatedQuery`).
3. **Event handlers, not effects.** User action? Put logic in onClick/onChange directly.
4. **`key` to reset, not effect choreography.** Pass `key={id}` to reset a component.
5. **Conditional mount over guarded effect.** Render only when `ready` is true.

### State Management

All UI state lives in `inboxStore` (Zustand at `packages/web/store/inboxStore.ts`), not in local `useState`. Local state is only for transient, component-scoped concerns (e.g., controlled input mid-edit).

All data mutations go through `inboxStore` actions (optimistic local-first updates), never via direct `useMutation` calls. The pattern:

1. Define an `action()` in `inboxStore.ts` that optimistically mutates local state
2. Add a matching handler in `packages/convex/convex/dispatch.ts` to persist
3. The mutative middleware dispatches to Convex after the optimistic update
4. Server failures trigger automatic rollback via inverse patches

### Styling

- Use Tailwind grayscale classes (`text-gray-300`, `text-gray-400`) for subdued text
- Avoid opacity on theme tokens (`text-sol-text-dim/30`) or `text-black/30`

## Testing

Set test credentials via environment variables:
```bash
export TEST_USER_EMAIL=you@example.com
export TEST_USER_PASSWORD=your-test-password
```

## Deployment

See [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md) for self-hosting instructions.

## Commits

Use [Conventional Commits](https://www.conventionalcommits.org/):
```
feat(api): add telemetry endpoint
fix(cli): handle missing config gracefully
refactor(web): extract sidebar into component
```
