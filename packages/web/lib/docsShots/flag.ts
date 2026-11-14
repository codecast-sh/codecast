import type { ConvexReactClient } from "convex/react";

// Docs shots: a dev-only mode that runs the real web app over the Acme fixture
// world (../acmeWorld) with no server and no account, for the public docs
// images (packages/web/docs-shots, scripts/docs-shots.ts). Start the dev
// server with VITE_DOCS_SHOTS=1 on a port of its own (scripts/docs-shots-dev.sh),
// so it has its own origin, storage and outbox. Never on in a production
// build: `import.meta.env.DEV` is false there, so every `if (DOCS_SHOTS)`
// folds away with the dynamic import inside it.
export const DOCS_SHOTS = import.meta.env.DEV && import.meta.env.VITE_DOCS_SHOTS === "1";

// Where published pages are served in this mode: the fixture origin of
// docs-shots/published-pages.ts (`serve`), never a real deployment. The app's
// page URLs (lib/publishedPageUrls) read it so frames, previews and page state
// make no request to prod.
export const DOCS_SHOTS_PAGES_ORIGIN = "http://127.0.0.1:3297";

// The offline Convex client, set by ./install before the app boots.
let client: ConvexReactClient | null = null;
export function setDocsShotsConvex(c: ConvexReactClient) {
  client = c;
}
export function docsShotsConvex(): ConvexReactClient {
  if (!client) throw new Error("docs shots: the app booted before lib/docsShots/install ran");
  return client;
}
