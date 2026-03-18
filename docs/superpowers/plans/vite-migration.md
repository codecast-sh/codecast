# Next.js to Vite Migration Plan

## Current State

- **Framework**: Next.js 15 App Router
- **Pages**: 55 routes, 111 components, ~17k lines TypeScript
- **Server features used**: Almost none. 3 pages use `generateMetadata`, 0 server actions, 0 real server components
- **API routes**: 6 (health check, desktop version, install script redirect, binary download redirects)
- **Deployment**: Railway (Node.js server running Next.js)
- **Desktop**: Tauri app loads the web app

The app is fundamentally a client-side SPA. Convex handles all data, auth is client-side. Next.js is providing file-based routing, font loading, and OG metadata on 3 share pages.

## Target State

- **Framework**: Vite + React Router v7
- **Deployment**: Static files on Railway (or Cloudflare Pages) + thin server for bot meta/API routes
- **Desktop**: Tauri loads the Vite build (better native support)

## Migration Phases

### Phase 1: Scaffolding & Router Setup

**Create Vite project structure alongside Next.js** (allows incremental validation):

1. Add `vite.config.ts`, `index.html` entry point
2. Install: `vite`, `@vitejs/plugin-react`, `react-router` v7
3. Create `src/main.tsx` (React root mount) and `src/App.tsx` (router + providers)
4. Move `providers.tsx` to new entry -- drop Next.js metadata exports, keep everything else as-is
5. Set up path aliases (`@/` -> `src/`) to match existing `tsconfig.json` paths

**Font loading**: Replace `next/font/google` with CSS `@font-face` declarations or Google Fonts `<link>` tags in `index.html`:
- JetBrains Mono (`--font-mono`)
- Fraunces (`--font-serif`)

**Environment variables**: Find-and-replace `process.env.NEXT_PUBLIC_` -> `import.meta.env.VITE_`. Rename vars in `.env` files.

### Phase 2: Route Tree

Convert Next.js file-based routes to explicit React Router route config.

**Layout mapping**:
```
Root layout        -> <App> wrapper (providers, html/body)
(marketing)/layout -> <MarketingLayout> (ForceLightMode + solarized bg)
settings/layout    -> <SettingsLayout>
palette/layout     -> <PaletteLayout>
```

**Route groups** (~55 routes):

| Next.js Path | React Router Path | Notes |
|---|---|---|
| `(marketing)/page.tsx` | `/` | Landing |
| `(marketing)/about/page.tsx` | `/about` | Static |
| `(marketing)/features/page.tsx` | `/features` | Static |
| `(marketing)/documentation/page.tsx` | `/documentation` | Static |
| `(marketing)/privacy/page.tsx` | `/privacy` | Static |
| `(marketing)/security/page.tsx` | `/security` | Static |
| `(marketing)/support/page.tsx` | `/support` | Static |
| `(marketing)/terms/page.tsx` | `/terms` | Static |
| `login/page.tsx` | `/login` | |
| `signup/page.tsx` | `/signup` | |
| `forgot-password/page.tsx` | `/forgot-password` | |
| `reset-password/page.tsx` | `/reset-password` | |
| `auth/cli/page.tsx` | `/auth/cli` | |
| `join/[code]/page.tsx` | `/join/:code` | |
| `dashboard/page.tsx` | `/dashboard` | |
| `inbox/page.tsx` | `/inbox` | |
| `feed/page.tsx` | `/feed` | |
| `search/page.tsx` | `/search` | |
| `explore/page.tsx` | `/explore` | |
| `timeline/page.tsx` | `/timeline` | |
| `notifications/page.tsx` | `/notifications` | |
| `conversation/[id]/page.tsx` | `/conversation/:id` | OG meta needed |
| `conversation/[id]/diff/page.tsx` | `/conversation/:id/diff` | |
| `share/[token]/page.tsx` | `/share/:token` | OG meta needed |
| `share/message/[token]/page.tsx` | `/share/message/:token` | OG meta needed |
| `commit/[owner]/[repo]/[sha]/page.tsx` | `/commit/:owner/:repo/:sha` | |
| `pr/[owner]/[repo]/[number]/page.tsx` | `/pr/:owner/:repo/:number` | |
| `review/[id]/page.tsx` | `/review/:id` | |
| `review/batch/page.tsx` | `/review/batch` | |
| `docs/page.tsx` | `/docs` | |
| `docs/[id]/page.tsx` | `/docs/:id` | |
| `plans/page.tsx` | `/plans` | |
| `plans/[id]/page.tsx` | `/plans/:id` | |
| `tasks/page.tsx` | `/tasks` | |
| `tasks/[id]/page.tsx` | `/tasks/:id` | |
| `team/page.tsx` | `/team` | |
| `team/activity/page.tsx` | `/team/activity` | |
| `team/[username]/page.tsx` | `/team/:username` | |
| `orchestration/page.tsx` | `/orchestration` | |
| `roadmap/page.tsx` | `/roadmap` | |
| `cli/page.tsx` | `/cli` | |
| `palette/page.tsx` | `/palette` | Separate layout |
| `admin/daemon-logs/page.tsx` | `/admin/daemon-logs` | |
| `settings/*` (8 pages) | `/settings/*` | Nested layout |

All routes should use `React.lazy()` for code splitting.

### Phase 3: Next.js Import Replacements

**`next/link` (41 files)**:
```
// Before
import Link from "next/link"
<Link href="/dashboard">

// After
import { Link } from "react-router"
<Link to="/dashboard">
```
- `href` -> `to`
- That's the only API difference for basic usage

**`next/navigation` (50 files)**:
```
// Before
import { useRouter, usePathname, useSearchParams } from "next/navigation"
const router = useRouter()
router.push("/foo")
router.replace("/foo")
router.back()
const pathname = usePathname()
const searchParams = useSearchParams()

// After
import { useNavigate, useLocation, useSearchParams } from "react-router"
const navigate = useNavigate()
navigate("/foo")
navigate("/foo", { replace: true })
navigate(-1)
const { pathname } = useLocation()
const [searchParams] = useSearchParams()
```

**`redirect` / `notFound` from next/navigation**:
- `redirect("/path")` -> `navigate("/path")` or `<Navigate to="/path" />`
- `notFound()` -> `throw new Response("Not Found", { status: 404 })` or navigate to a catch-all

**`next/font/google`**: Removed entirely, handled in Phase 1 via CSS.

**`@/` path alias**: Keep working via `vite.config.ts` resolve.alias.

### Phase 4: API Routes & Server Endpoints

The 6 API routes need to move to a small server. Options:

**Option A: Express/Hono server on Railway** (recommended -- you're already on Railway):

```ts
// server.ts - serves both static files and API routes
import { Hono } from 'hono'
import { serveStatic } from 'hono/serve-static'

app.get('/api/health', (c) => c.json({ ok: true }))
app.get('/api/desktop/version', (c) => /* version logic */)
app.get('/install', (c) => /* serve install.sh */)
app.get('/install.ps1', (c) => /* serve install.ps1 */)
app.get('/download/mac', (c) => c.redirect('...'))
app.get('/download/:binary', (c) => c.redirect(BINARIES[c.req.param('binary')]))

// Bot detection for OG meta (Phase 5)
app.use('*', botMetaMiddleware)

// SPA fallback
app.use('*', serveStatic({ root: './dist' }))
app.get('*', (c) => /* serve index.html for SPA routing */)
```

**Option B: Cloudflare Pages + Workers** (if you want edge deployment later).

### Phase 5: Bot Meta Middleware (OG Tags)

For the 3 routes needing OG metadata (`/conversation/:id`, `/share/:token`, `/share/message/:token`):

```ts
// middleware/botMeta.ts
import { isbot } from 'isbot'
import { ConvexHttpClient } from 'convex/browser'

const convex = new ConvexHttpClient(process.env.CONVEX_URL)

const META_ROUTES = [
  { pattern: /^\/conversation\/([a-z0-9]{32})$/, handler: getConversationMeta },
  { pattern: /^\/share\/(.+)$/, handler: getShareMeta },
  { pattern: /^\/share\/message\/(.+)$/, handler: getShareMessageMeta },
]

export async function botMetaMiddleware(c, next) {
  if (!isbot(c.req.header('user-agent'))) return next()

  const match = META_ROUTES.find(r => r.pattern.test(c.req.path))
  if (!match) return next()

  const meta = await match.handler(c.req.path)
  if (!meta) return next()

  return c.html(`<!DOCTYPE html>
    <html><head>
      <meta property="og:title" content="${meta.title}" />
      <meta property="og:description" content="${meta.description}" />
      <meta property="og:image" content="${meta.image || '/logo-final.png'}" />
      <meta property="og:url" content="https://codecast.sh${c.req.path}" />
      <meta name="twitter:card" content="summary" />
    </head><body></body></html>`)
}
```

Also serve default OG meta for marketing pages (landing, about, features) since those are now client-rendered. Same pattern -- just return static meta tags for bots on those paths.

### Phase 6: Desktop/Tauri Integration

Tauri already works well with Vite -- it's the recommended setup. Changes:

1. Update `packages/desktop/tauri.conf.json` to point at Vite dev server instead of Next.js dev server
2. Vite's dev server URL replaces Next.js dev URL for Tauri dev mode
3. Build output (`dist/`) is what Tauri bundles -- simpler than Next.js standalone output
4. The `/api/desktop/version` endpoint moves to the Hono server (Phase 4)

### Phase 7: Build & Deploy

**Vite build config**:
```ts
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          convex: ['convex', '@convex-dev/auth'],
          ui: ['@radix-ui/react-dialog', '@radix-ui/react-dropdown-menu', /* etc */],
          markdown: ['react-markdown', 'rehype-highlight', 'remark-gfm', 'prismjs'],
        }
      }
    }
  }
})
```

**Railway deployment**:
- Dockerfile runs `vite build` then starts the Hono server
- Server serves static `dist/` + API routes + bot meta middleware
- Simpler than current Next.js standalone server

**Dev script**: `vite` for web, Hono server runs alongside for API routes during dev (or just mock them).

### Phase 8: Cleanup

1. Remove all `next` dependencies from `package.json`
2. Remove `next.config.ts`, `next-env.d.ts`
3. Remove `eslint-config-next`
4. Remove `@next/bundle-analyzer` (use `rollup-plugin-visualizer` instead)
5. Remove `autoprefixer` if Tailwind v4 (built-in)
6. Update turbo.json pipeline if applicable
7. Update CI/CD scripts
8. Update `dev.sh` to start Vite instead of Next.js

## Risk Assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| Broken share link previews | Medium | Test with Twitter Card Validator, Facebook debugger, Slack preview before shipping |
| Missing route / broken navigation | Low | Automated test: crawl all routes, verify 200 status |
| Tauri build breaks | Low | Vite is Tauri's recommended bundler -- should improve |
| SEO regression on marketing pages | Low | Bot meta middleware covers this; verify with Google Search Console |
| Convex client initialization changes | Very Low | ConvexReactClient is framework-agnostic, no changes needed |

## Effort Breakdown

| Phase | Effort | Can Parallelize |
|---|---|---|
| 1. Scaffolding | Small | - |
| 2. Route tree | Medium | - |
| 3. Import replacements | Medium (mechanical) | Yes, per-file |
| 4. API routes server | Small | Yes, with Phase 2-3 |
| 5. Bot meta middleware | Small | Yes, with Phase 2-3 |
| 6. Tauri integration | Small | After Phase 1 |
| 7. Build & deploy | Medium | After Phase 1-5 |
| 8. Cleanup | Small | After everything |

Total: 3-5 focused sessions. The bulk is Phase 2-3 (route tree + import replacements) which is mechanical but touches many files.
