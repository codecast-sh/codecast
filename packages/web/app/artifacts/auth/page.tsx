"use client";
// /pages/auth — identity relay for published-page comments.
//
// The published artifact pages are sandboxed into an opaque origin, so they
// can never read this app's auth. Instead the page's "Sign in" link lands
// here; we mint an identity token scoped to (user, artifact) and bounce back
// to the page with the token in the #i= fragment. One click when a session
// exists; via /login (which preserves return_to) when it doesn't.

import { useConvexAuth, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useRef, useState } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useSearchParams, useRouter } from "next/navigation";
import { AppLoader } from "../../../components/AppLoader";

export default function ArtifactAuthPage() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const mint = useMutation(api.artifacts.mintCommentIdentity);
  const searchParams = useSearchParams();
  const router = useRouter();
  const started = useRef(false);
  const [error, setError] = useState("");

  const slug = searchParams.get("slug") || "";
  const back = searchParams.get("back") || "";

  useWatchEffect(() => {
    if (isLoading || started.current) return;
    if (!/^[A-Za-z0-9]{6,32}$/.test(slug)) {
      setError("This page link is malformed.");
      return;
    }
    if (!isAuthenticated) {
      const returnPath = `/pages/auth?${searchParams.toString()}`;
      router.push(`/login?return_to=${encodeURIComponent(returnPath)}`);
      return;
    }
    started.current = true;
    (async () => {
      try {
        const res = (await mint({ slug })) as { token?: string; error?: string };
        if (!res?.token) {
          setError(res?.error || "Could not sign you in to this page.");
          return;
        }
        // Rebuild the destination on OUR origin only — `back` contributes its
        // query (gate tokens, deep-link params) and fragment, never its host.
        // Redirecting to a caller-supplied host would hand the identity token
        // to an arbitrary site.
        let search = "";
        let hash = "";
        try {
          const b = new URL(back);
          search = b.search;
          hash = b.hash;
        } catch {
          /* no usable back URL — plain landing */
        }
        const frag = new URLSearchParams(hash.replace(/^#/, ""));
        frag.set("i", res.token);
        window.location.replace(`${window.location.origin}/a/${slug}${search}#${frag.toString()}`);
      } catch {
        setError("Could not sign you in to this page.");
      }
    })();
  }, [isAuthenticated, isLoading, slug, back, router, mint]);

  return (
    <div className="min-h-screen bg-sol-bg flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-sol-bg-alt/50 rounded-lg p-8 border border-sol-border">
        {error ? (
          <p className="text-sm text-sol-text text-center">{error}</p>
        ) : (
          <AppLoader className="min-h-0 bg-transparent" size={32} label="Signing you in to this page..." />
        )}
      </div>
    </div>
  );
}
