"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Logo, LogoMark } from "@/components/Logo";
import { useMountEffect } from "@/hooks/useMountEffect";
import { InstallTabs } from "@/components/install-tabs";
import { useRouteMeta } from "../pageMeta";

// The server 302s this to the pinned dmg on dl.codecast.sh (release.sh bumps the pin).
const MAC_DOWNLOAD_URL = "https://codecast.sh/download/mac";
const APP_STORE_URL = "https://apps.apple.com/app/id6757820850";

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  // iPadOS reports platform "MacIntel" but is touch-first — send it to the App Store instead.
  return /Mac/.test(navigator.platform) && (navigator.maxTouchPoints ?? 0) <= 1;
}

function AppleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z" />
    </svg>
  );
}

/** Rounded-square app-icon tile used across the step illustrations. */
function AppTile({ size = 56 }: { size?: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-[22%] bg-[#fdf6e3] shadow-lg"
      style={{ width: size, height: size }}
    >
      <LogoMark size={size * 0.62} />
    </div>
  );
}

function Cursor({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="#fdf6e3" stroke="#002b36" strokeWidth="1.5">
      <path d="M5 3l14 8.5-6.1 1.3L10.5 19 5 3z" />
    </svg>
  );
}

/** Step 1 — browser download shelf with the finished dmg. */
function OpenIllustration({ version }: { version: string | null }) {
  const file = version ? `Codecast-${version}-arm64.dmg` : "Codecast-arm64.dmg";
  return (
    <div className="relative h-48 overflow-hidden rounded-t-xl bg-[#002b36]">
      {/* Browser chrome, cropped at the card edges like a zoomed-in corner */}
      <div className="absolute -right-8 left-8 top-7 rounded-tl-xl border border-[#094959] bg-[#073642]">
        <div className="flex items-center gap-2 py-2.5 pl-4 pr-12">
          <span className="h-2.5 w-2.5 rounded-full bg-[#dc322f]/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#b58900]/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#859900]/80" />
          <div className="ml-3 h-6 flex-1 rounded-md bg-[#002b36]/70" />
          {/* Download icon, ringed like an active download */}
          <span className="relative flex h-8 w-8 items-center justify-center rounded-full border-2 border-[#cb4b16]">
            <svg className="h-4 w-4 text-[#fdf6e3]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0 0l-4-4m4 4l4-4" />
            </svg>
          </span>
        </div>
        {/* Download shelf popup */}
        <div className="mx-4 mb-6 mt-1 flex items-center gap-3 rounded-lg bg-[#002b36] px-4 py-3 shadow-xl">
          <svg className="h-7 w-6 shrink-0 text-[#93a1a1]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M14 3v5h5" />
          </svg>
          <div className="min-w-0">
            <div className="truncate font-mono text-[13px] text-[#fdf6e3]">{file}</div>
            <div className="font-mono text-[11px] text-[#586e75]">98 MB &middot; Done</div>
          </div>
        </div>
      </div>
      <Cursor className="absolute bottom-6 left-1/2 h-6 w-6" />
    </div>
  );
}

/** Step 2 — drag the app icon into the Applications folder. */
function InstallIllustration() {
  return (
    <div className="relative flex h-48 items-center justify-center gap-10 overflow-hidden rounded-t-xl bg-[#002b36]">
      <div className="relative">
        <AppTile size={64} />
        <Cursor className="absolute -bottom-3 -right-3 h-6 w-6" />
      </div>
      {/* Dashed hand-drawn arrow */}
      <svg className="h-10 w-14 text-[#586e75]" fill="none" viewBox="0 0 56 40" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeDasharray="4 5" d="M4 28c14 8 30 8 44-6" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M40 20l8 2-3 8" />
      </svg>
      {/* Applications drop target */}
      <div className="flex h-24 w-24 items-center justify-center rounded-2xl border-2 border-dashed border-[#586e75]">
        <svg className="h-14 w-14" viewBox="0 0 64 64" fill="none">
          <path d="M6 18a4 4 0 014-4h14l5 6h29a4 4 0 014 4v26a4 4 0 01-4 4H10a4 4 0 01-4-4V18z" fill="#268bd2" />
          <path d="M6 26h56v24a4 4 0 01-4 4H10a4 4 0 01-4-4V26z" fill="#5db0e6" />
          <text x="32" y="47" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="18" fontWeight="700" fill="#fdf6e3">A</text>
        </svg>
      </div>
    </div>
  );
}

/** Step 3 — the dock with Codecast ready to launch. */
function LaunchIllustration() {
  return (
    <div className="relative flex h-48 items-end justify-center overflow-hidden rounded-t-xl bg-[#002b36] pb-8">
      <div className="flex items-center gap-3 rounded-2xl border border-[#094959] bg-[#073642]/80 px-4 py-3">
        <div className="h-11 w-11 rounded-[22%] bg-gradient-to-br from-[#268bd2] to-[#2aa198] opacity-60" />
        <div className="h-11 w-11 rounded-[22%] bg-gradient-to-br from-[#6c71c4] to-[#d33682] opacity-60" />
        <div className="relative">
          {/* Tooltip */}
          <div className="absolute -top-12 left-1/2 -translate-x-1/2 whitespace-nowrap">
            <span className="rounded-md bg-[#fdf6e3] px-2.5 py-1 font-mono text-xs font-medium text-[#002b36] shadow">Codecast</span>
          </div>
          <AppTile size={48} />
          <span className="absolute -bottom-2.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-[#fdf6e3]" />
          <Cursor className="absolute -bottom-2 -right-2 h-5 w-5" />
        </div>
        <div className="h-11 w-11 rounded-[22%] bg-gradient-to-br from-[#b58900] to-[#cb4b16] opacity-60" />
      </div>
    </div>
  );
}

function StepCard({
  step,
  title,
  children,
  illustration,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
  illustration: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-[#eee8d5] bg-white/40 shadow-sm">
      {illustration}
      <div className="px-6 py-5 text-left">
        <div className="font-mono text-[11px] uppercase tracking-wider text-[#93a1a1]">Step {step}</div>
        <h3 className="mt-1 font-mono text-xl font-bold text-[#002b36]">{title}</h3>
        <p className="mt-2 text-[15px] leading-relaxed text-[#657b83]">{children}</p>
      </div>
    </div>
  );
}

export default function DownloadPage() {
  useRouteMeta("/download");

  const [isMac, setIsMac] = useState(false);
  const [version, setVersion] = useState<string | null>(null);

  useMountEffect(() => {
    const mac = isMacPlatform();
    setIsMac(mac);

    fetch("/api/desktop/latest")
      .then((r) => r.json())
      .then((d) => {
        if (typeof d?.version === "string") setVersion(d.version);
      })
      .catch(() => {});

    // ?manual=1 opts out of the auto-start (links that shouldn't force a download).
    if (!mac || new URLSearchParams(window.location.search).has("manual")) return;
    // Kick off the download after a beat, like an installer page should. Navigating to
    // an attachment response doesn't unload the SPA, so the guide stays on screen.
    const t = setTimeout(() => {
      window.location.href = MAC_DOWNLOAD_URL;
    }, 900);
    return () => clearTimeout(t);
  });

  return (
    <main className="min-h-screen w-full overflow-x-hidden" style={{ backgroundColor: "#fdf6e3" }}>
      {/* Nav */}
      <nav className="sticky top-0 z-50 backdrop-blur-sm" style={{ borderBottom: "1px solid #eee8d5", backgroundColor: "rgba(253,246,227,0.8)" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/">
            <Logo size="md" className="[--logo-c:#444444] text-[#002b36]" />
          </Link>
          <div className="flex items-center gap-3">
            <Link href="/documentation" className="hidden px-3 py-1.5 text-sm font-medium sm:block" style={{ color: "#657b83" }}>
              Docs
            </Link>
            <Link href="/pricing" className="hidden px-3 py-1.5 text-sm font-medium sm:block" style={{ color: "#657b83" }}>
              Pricing
            </Link>
            <Link href="/login">
              <Button variant="ghost" className="font-medium" style={{ color: "#657b83" }}>
                Sign in
              </Button>
            </Link>
            <Link href="/signup">
              <Button className="font-medium text-white" style={{ backgroundColor: "#002b36" }}>
                Get started
              </Button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-6 pb-4 pt-16 text-center">
        <div className="mb-6 flex justify-center">
          <AppTile size={72} />
        </div>
        <h1 className="mb-4 font-mono text-4xl font-bold tracking-tight text-[#002b36] md:text-5xl">
          {isMac ? "Install and open the app" : "Codecast for Mac"}
        </h1>
        {isMac ? (
          <p className="mx-auto max-w-xl text-lg leading-relaxed text-[#657b83]">
            Your download should start automatically. If not,{" "}
            <a href={MAC_DOWNLOAD_URL} className="font-medium text-[#b58900] underline underline-offset-4 hover:text-[#cb4b16]">
              download manually
            </a>
            .
          </p>
        ) : (
          <>
            <p className="mx-auto mb-6 max-w-xl text-lg leading-relaxed text-[#657b83]">
              The desktop app runs on macOS with Apple Silicon. On iPhone or iPad, get the iOS app —
              on anything else, Codecast works fully in the browser.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <a href={MAC_DOWNLOAD_URL} className="inline-flex items-center gap-2 rounded-lg bg-[#002b36] px-5 py-2.5 font-medium text-white transition-colors hover:bg-[#073642]">
                <AppleIcon className="h-5 w-5" />
                Download for macOS
              </a>
              <a href={APP_STORE_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-[#93a1a1] px-5 py-2.5 font-medium text-[#586e75] transition-colors hover:bg-[#eee8d5]">
                <AppleIcon className="h-5 w-5" />
                iOS App
              </a>
            </div>
          </>
        )}
        <p className="mt-4 font-mono text-xs text-[#93a1a1]">
          {version ? `v${version} · ` : ""}macOS · Apple Silicon · 98 MB
        </p>
      </section>

      {/* Steps */}
      <section className="mx-auto max-w-6xl px-6 py-12">
        <div className="grid gap-6 md:grid-cols-3">
          <StepCard step={1} title="Open" illustration={<OpenIllustration version={version} />}>
            Open the Codecast dmg file from your downloads.
          </StepCard>
          <StepCard step={2} title="Install" illustration={<InstallIllustration />}>
            Drag Codecast into your Applications folder.
          </StepCard>
          <StepCard step={3} title="Launch" illustration={<LaunchIllustration />}>
            Open Codecast from Applications or Spotlight and sign in.
          </StepCard>
        </div>
      </section>

      {/* Why the desktop app */}
      <section className="mx-auto max-w-6xl px-6 pb-16">
        <div className="rounded-xl border border-[#eee8d5] bg-white/40 px-8 py-8">
          <div className="grid gap-8 text-left md:grid-cols-3">
            <div>
              <h3 className="mb-1 font-mono text-sm font-bold text-[#002b36]">Native notifications</h3>
              <p className="text-sm leading-relaxed text-[#657b83]">
                Get pinged the moment an agent needs input — no browser tab to keep alive.
              </p>
            </div>
            <div>
              <h3 className="mb-1 font-mono text-sm font-bold text-[#002b36]">Always within reach</h3>
              <p className="text-sm leading-relaxed text-[#657b83]">
                A dedicated window with menu bar access and a global shortcut to summon your inbox.
              </p>
            </div>
            <div>
              <h3 className="mb-1 font-mono text-sm font-bold text-[#002b36]">Everything the web has</h3>
              <p className="text-sm leading-relaxed text-[#657b83]">
                The full inbox: see, steer, and remember every coding agent session. Updates itself.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CLI — the piece that actually produces sessions */}
      <section className="mx-auto max-w-3xl px-6 pb-16 text-center">
        <h2 className="mb-3 font-mono text-2xl font-bold text-[#002b36]">
          Don&apos;t skip the CLI
        </h2>
        <p className="mx-auto mb-6 max-w-xl text-[#657b83]">
          The apps are windows into your sessions — the CLI is what records them. Run one command
          on each machine where your agents work; it installs, signs you in, and starts syncing.
        </p>
        <div className="mx-auto max-w-xl text-left">
          <InstallTabs />
        </div>
      </section>

      {/* Alternatives */}
      <section className="mx-auto max-w-3xl px-6 pb-20 text-center">
        <p className="text-sm text-[#657b83]">
          Prefer to install later?{" "}
          <Link href="/signup" className="font-medium text-[#b58900] hover:text-[#cb4b16]">
            Continue in the browser
          </Link>
          {" "}or get the{" "}
          <a href={APP_STORE_URL} target="_blank" rel="noopener noreferrer" className="font-medium text-[#b58900] hover:text-[#cb4b16]">
            iOS app
          </a>
          .
        </p>
      </section>

      {/* Footer */}
      <footer style={{ borderTop: "1px solid #eee8d5" }}>
        <div className="mx-auto max-w-6xl px-6 py-8 text-center text-sm text-[#839496]">
          &copy; 2026 Codecast &middot;{" "}
          <Link href="/privacy" className="hover:text-[#073642]">Privacy</Link> &middot;{" "}
          <Link href="/terms" className="hover:text-[#073642]">Terms</Link> &middot;{" "}
          <Link href="/support" className="hover:text-[#073642]">Support</Link>
        </div>
      </footer>
    </main>
  );
}
