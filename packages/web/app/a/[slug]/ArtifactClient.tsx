"use client";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams } from "next/navigation";
import { AppLoader } from "../../../components/AppLoader";
import { LogoMark } from "../../../components/Logo";
import { CONVEX_URL } from "../../../lib/localAuth";

function InvalidLink() {
  return (
    <main className="h-screen flex flex-col bg-sol-base03 items-center justify-center">
      <div className="text-center max-w-md px-4">
        <svg className="w-16 h-16 mx-auto mb-4 text-sol-base01" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
        <h1 className="text-xl text-sol-base0 mb-2">Invalid Link</h1>
        <p className="text-sol-base00 text-sm">
          This artifact link is invalid or the artifact has been unpublished.
        </p>
      </div>
    </main>
  );
}

export default function ArtifactClient() {
  const params = useParams();
  const slug = params.slug as string;

  const meta = useQuery(api.artifacts.getShared, { slug });
  const [copied, setCopied] = useState(false);

  const shareUrl = useMemo(
    () => (typeof window !== "undefined" ? window.location.href : `https://codecast.sh/a/${slug}`),
    [slug],
  );
  // The raw document is served by the Convex HTTP action (see convex/http.ts);
  // /cli/ because that's the prefix the Caddy proxy forwards to HTTP actions.
  const rawUrl = `${CONVEX_URL}/cli/a/${slug}`;

  useEffect(() => {
    if (meta?.title) document.title = `${meta.title} · codecast`;
  }, [meta?.title]);

  if (meta === undefined) {
    return <AppLoader className="min-h-0 h-screen bg-sol-base03" />;
  }
  if (meta === null) return <InvalidLink />;

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  };

  const nativeShare = async () => {
    try {
      await navigator.share({ title: meta.title, url: shareUrl });
    } catch {}
  };

  const canNativeShare = typeof navigator !== "undefined" && !!navigator.share;

  return (
    <main className="h-dvh w-full relative bg-white">
      {/* No allow-same-origin: the artifact runs as an opaque origin, matching
          the CSP sandbox the raw endpoint serves. Scripts still work. */}
      <iframe
        src={rawUrl}
        title={meta.title}
        sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock"
        className="w-full h-full border-0 block"
      />

      {/* Floating share pill — deliberately quiet until hovered. The pill is
          dark regardless of page theme, so pin the logo's C to its dark-chrome
          color (the themed default is #444, invisible here). */}
      <div className="fixed bottom-3 right-3 z-10 flex items-center gap-1 rounded-full border border-sol-border/50 bg-sol-base03/90 backdrop-blur px-2.5 py-1.5 shadow-lg opacity-70 hover:opacity-100 transition-opacity [--logo-c:#93a1a1]">
        <a
          href="https://codecast.sh"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 pr-1 text-sol-base0 hover:text-sol-base1 transition-colors"
          title="Published with codecast"
        >
          <LogoMark size={16} />
          <span className="text-xs font-medium hidden sm:inline">codecast</span>
        </a>
        <span className="hidden sm:inline max-w-[180px] truncate text-xs text-sol-base00 border-l border-sol-border/40 pl-2" title={meta.title}>
          {meta.title}
        </span>
        <span className="w-px h-3.5 bg-sol-border/40 mx-1" />
        <button
          onClick={copyLink}
          className="text-xs px-1.5 py-0.5 rounded text-sol-base0 hover:text-sol-base1 hover:bg-sol-base02/60 transition-colors"
          title="Copy link"
        >
          {copied ? "Copied" : "Copy link"}
        </button>
        {canNativeShare && (
          <button
            onClick={nativeShare}
            className="text-xs px-1.5 py-0.5 rounded text-sol-base0 hover:text-sol-base1 hover:bg-sol-base02/60 transition-colors"
            title="Share"
          >
            Share
          </button>
        )}
        <a
          href={rawUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="px-1 text-sol-base00 hover:text-sol-base1 transition-colors"
          title="Open full page"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </a>
      </div>
    </main>
  );
}
