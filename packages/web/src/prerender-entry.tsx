/**
 * SSR entry for build-time prerendering of the marketing routes.
 *
 * scripts/prerender.mjs builds this file with `vite build --ssr` and calls
 * render(path) for every entry in lib/seoRoutes.ts, writing the resulting
 * HTML into dist/prerender/. The server (server/bot-meta.ts) serves those
 * snapshots to crawlers — search engines and LLM crawlers don't reliably
 * execute the SPA's JavaScript, so this is the only HTML they ever read.
 *
 * The pages are imported statically (no React.lazy): renderToString cannot
 * wait for lazy chunks, and bundle size is irrelevant for a build-time-only
 * artifact. The route table must mirror the marketing section of App.tsx —
 * the parity test in lib/__tests__/seoRoutes.test.ts guards the route LIST;
 * this file just maps each path to the same component modules.
 */
import { useCallback, useMemo } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter, Routes, Route } from "react-router";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { MarketingLayout } from "./layouts/MarketingLayout";
import { CONVEX_URL } from "@/lib/localAuth";

import Landing from "@/app/(marketing)/page";
import About from "@/app/(marketing)/about/page";
import Features from "@/app/(marketing)/features/page";
import Documentation from "@/app/(marketing)/documentation/page";
import DocumentationGuide from "@/app/(marketing)/documentation/guides/GuidePage";
import Privacy from "@/app/(marketing)/privacy/page";
import Security from "@/app/(marketing)/security/page";
import Support from "@/app/(marketing)/support/page";
import Terms from "@/app/(marketing)/terms/page";
import Changelog from "@/app/(marketing)/changelog/page";
import Pricing from "@/app/(marketing)/pricing/page";
import Download from "@/app/(marketing)/download/page";
import BlogIndex from "@/app/(marketing)/blog/page";
import BlogGitBlame from "@/app/(marketing)/blog/git-blame-for-ai-agents/page";
import BlogAgentInbox from "@/app/(marketing)/blog/an-inbox-for-your-agents/page";
import BlogTeamMemory from "@/app/(marketing)/blog/your-agents-forget-your-team-does-not/page";
import BlogTriggers from "@/app/(marketing)/blog/this-post-wrote-itself/page";
import BlogPublish from "@/app/(marketing)/blog/a-url-for-everything-your-agent-makes/page";
import CompareIndex from "@/app/(marketing)/compare/page";
import Compare from "@/app/(marketing)/compare/ComparePage";

export { SEO_ROUTES, SITE_URL, seoFor } from "@/lib/seoRoutes";

// One client for all renders; nothing subscribes during renderToString, so no
// WebSocket is ever opened.
const convex = new ConvexReactClient(CONVEX_URL);

/**
 * A crawler is a settled, logged-out visitor. Without this override,
 * useConvexAuth() reports isLoading=true for the entire synchronous render
 * (auth state only settles in effects, which never run in renderToString), so
 * pages that gate on it — the landing page — would prerender their loading
 * branch instead of their content. Nested INSIDE ConvexAuthProvider so it wins
 * the context for useConvexAuth consumers, while useAuthToken (useLocalAuth)
 * still resolves against the outer provider (to its initial null).
 */
function useSettledLoggedOutAuth() {
  const fetchAccessToken = useCallback(async () => null, []);
  return useMemo(
    () => ({ isLoading: false, isAuthenticated: false, fetchAccessToken }),
    [fetchAccessToken],
  );
}

export function render(path: string): string {
  return renderToString(
    <ConvexAuthProvider client={convex}>
      <ConvexProviderWithAuth client={convex} useAuth={useSettledLoggedOutAuth}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<MarketingLayout />}>
            <Route index element={<Landing />} />
            <Route path="about" element={<About />} />
            <Route path="features" element={<Features />} />
            <Route path="documentation" element={<Documentation />} />
            <Route path="documentation/:slug" element={<DocumentationGuide />} />
            <Route path="privacy" element={<Privacy />} />
            <Route path="security" element={<Security />} />
            <Route path="support" element={<Support />} />
            <Route path="terms" element={<Terms />} />
            <Route path="changelog" element={<Changelog />} />
            <Route path="pricing" element={<Pricing />} />
            <Route path="download" element={<Download />} />
            <Route path="blog" element={<BlogIndex />} />
            <Route path="blog/git-blame-for-ai-agents" element={<BlogGitBlame />} />
            <Route path="blog/an-inbox-for-your-agents" element={<BlogAgentInbox />} />
            <Route path="blog/your-agents-forget-your-team-does-not" element={<BlogTeamMemory />} />
            <Route path="blog/this-post-wrote-itself" element={<BlogTriggers />} />
            <Route path="blog/a-url-for-everything-your-agent-makes" element={<BlogPublish />} />
            <Route path="compare" element={<CompareIndex />} />
            <Route path="compare/:slug" element={<Compare />} />
          </Route>
        </Routes>
      </MemoryRouter>
      </ConvexProviderWithAuth>
    </ConvexAuthProvider>,
  );
}
