import React from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { CONVEX_URL } from "../lib/convexUrl";
import SharedMessage from "../app/share/message/[token]/page";
import SharedDoc from "../app/share/doc/[token]/page";
import SharedPlan from "../app/share/plan/[token]/page";

/**
 * Standalone boot for /share/message|doc|plan/<token> — see main.tsx.
 *
 * The prod server renders the page into #root and inlines the payload it
 * rendered from (window.__SHARE_PRELOAD__), so this hydrates rather than
 * renders: the visitor already sees the content, and the markup here must
 * match it. With no server markup (dev, or a server without the SSR bundle)
 * it renders from scratch exactly like the app did.
 *
 * No auth provider: share queries are public by token. No analytics module:
 * it would pull Sentry and PostHog into a graph that should stay small.
 */

// A hydration mismatch is the one recoverable error this boot can produce;
// React re-renders from the client, so log the cause rather than swallow it.
const onRecoverableError = (err: unknown) => console.error("[share] recoverable render error", err);

const convex = new ConvexReactClient(CONVEX_URL);

const tree = (
  <React.StrictMode>
    <BrowserRouter>
      <ConvexProvider client={convex}>
        <Routes>
          <Route path="share/message/:token" element={<SharedMessage />} />
          <Route path="share/doc/:token" element={<SharedDoc />} />
          <Route path="share/plan/:token" element={<SharedPlan />} />
        </Routes>
      </ConvexProvider>
    </BrowserRouter>
  </React.StrictMode>
);

const root = document.getElementById("root")!;
if (root.childElementCount > 0) {
  hydrateRoot(root, tree, { onRecoverableError });
} else {
  createRoot(root, { onRecoverableError }).render(tree);
}
