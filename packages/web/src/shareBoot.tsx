import React, { lazy, Suspense } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { CONVEX_URL } from "../lib/convexUrl";
import { recoveringWebSocket } from "@codecast/shared/network";
import SharedMessage from "../app/share/message/[token]/page";
import SharedDoc from "../app/share/doc/[token]/page";
import SharedPlan from "../app/share/plan/[token]/page";
import SharedTask from "../app/share/task/[token]/page";
import SharedCall from "../app/share/call/[token]/page";
import SharedProject from "../app/share/project/[token]/page";
import SharedInitiative from "../app/share/initiative/[token]/page";
import SharedDecision from "../app/share/decision/[token]/page";
import SharedStack from "../app/share/stack/[token]/page";
import SharedTrigger from "../app/share/trigger/[token]/page";
import SharedRun from "../app/share/run/[token]/page";
import type { ComponentType } from "react";

// A guest's meeting page (/meet/<token>) rides this boot for the same reason
// the share pages do: nobody signed in, nothing of the app in the way. It is
// lazy, because it carries the media stack (livekit-client) that no share
// page should download.
const GuestMeet = lazy(() => import("../app/meet/[token]/page"));
import type { SharedObjectKind } from "@codecast/shared/entities";

/**
 * Standalone boot for /share/<kind>/<token> — see main.tsx.
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

// One page per shared kind; the type makes a new kind a compile error here
// until it has one.
const SHARE_PAGES: Record<SharedObjectKind, ComponentType> = {
  message: SharedMessage,
  doc: SharedDoc,
  plan: SharedPlan,
  task: SharedTask,
  call: SharedCall,
  project: SharedProject,
  initiative: SharedInitiative,
  decision: SharedDecision,
  stack: SharedStack,
  trigger: SharedTrigger,
  run: SharedRun,
};

const convex = new ConvexReactClient(CONVEX_URL, { webSocketConstructor: recoveringWebSocket() });

const tree = (
  <React.StrictMode>
    <BrowserRouter>
      <ConvexProvider client={convex}>
        <Routes>
          {Object.entries(SHARE_PAGES).map(([kind, Page]) => (
            <Route key={kind} path={`share/${kind}/:token`} element={<Page />} />
          ))}
          <Route
            path="meet/:token"
            element={
              <Suspense fallback={<div className="h-dvh bg-[#002b36]" />}>
                <GuestMeet />
              </Suspense>
            }
          />
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
