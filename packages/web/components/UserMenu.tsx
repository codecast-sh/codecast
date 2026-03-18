import { useState, useRef, useCallback } from "react";
import { useMountEffect } from "../hooks/useMountEffect";
import { useEventListener } from "../hooks/useEventListener";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useRouter } from "next/navigation";

function UrlBarModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  useMountEffect(() => {
    setUrl(window.location.href);
    setTimeout(() => inputRef.current?.select(), 50);
  });

  const handleNavigate = useCallback(() => {
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.origin === window.location.origin) {
        router.push(parsed.pathname + parsed.search + parsed.hash);
      } else {
        window.location.href = url;
      }
      onClose();
    } catch {
      if (url.startsWith("/")) {
        router.push(url);
        onClose();
      }
    }
  }, [url, router, onClose]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [url]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleNavigate();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }, [handleNavigate, onClose]);

  return (
    <div ref={backdropRef} className="fixed inset-0 z-[200] flex items-start justify-center pt-[20vh] bg-black/60 backdrop-blur-sm" onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}>
      <div className="w-full max-w-lg bg-sol-bg border border-sol-border rounded-xl shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-sol-border flex items-center justify-between">
          <span className="text-xs font-mono uppercase tracking-wider text-sol-text-dim">URL Bar</span>
          <div className="flex items-center gap-1">
            <button onClick={() => { window.history.back(); setUrl(window.location.href); }} className="p-1.5 text-sol-text-dim hover:text-sol-text transition-colors rounded" title="Back">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
            </button>
            <button onClick={() => { window.history.forward(); setUrl(window.location.href); }} className="p-1.5 text-sol-text-dim hover:text-sol-text transition-colors rounded" title="Forward">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>
        </div>
        <div className="p-4 flex items-center gap-2">
          <input
            ref={inputRef}
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 px-3 py-2 bg-sol-bg-alt border border-sol-border rounded-lg text-sm font-mono text-sol-text placeholder-sol-text-dim focus:outline-none focus:border-sol-cyan"
            placeholder="https://codecast.sh/..."
          />
          <button onClick={handleCopy} className="px-3 py-2 text-xs font-medium rounded-lg border border-sol-border text-sol-text-dim hover:text-sol-text hover:border-sol-cyan transition-colors whitespace-nowrap">
            {copied ? "Copied" : "Copy"}
          </button>
          <button onClick={handleNavigate} className="px-3 py-2 text-xs font-medium rounded-lg bg-sol-cyan/15 text-sol-cyan border border-sol-cyan/30 hover:bg-sol-cyan/25 transition-colors">
            Go
          </button>
        </div>
      </div>
    </div>
  );
}

export function UserMenu() {
  const [open, setOpen] = useState(false);
  const [urlBarOpen, setUrlBarOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { signOut } = useAuthActions();
  const router = useRouter();
  const user = useQuery(api.users.getCurrentUser);

  useEventListener("mousedown", useCallback((e: MouseEvent) => {
    if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
      setOpen(false);
    }
  }, []), document);

  const handleLogout = async () => {
    await signOut();
    router.push("/");
  };

  const displayName = user?.name || user?.email?.split("@")[0] || "User";
  const initials = displayName.slice(0, 1).toUpperCase();
  const isAdmin = user?.email === "ashot@almostcandid.com";
  const isLocal = typeof window !== "undefined" && window.location.hostname.includes("local.");
  const menuBtnClass = "w-full px-4 py-2 text-left text-sm text-sol-base1 text-sol-text hover:bg-slate-700 hover:bg-sol-bg-alt transition-colors";

  const handleEnvSwitch = () => {
    const { pathname, search, hash } = window.location;
    const target = isLocal
      ? `https://codecast.sh${pathname}${search}${hash}`
      : `http://local.codecast.sh${pathname}${search}${hash}`;
    window.location.href = target;
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="w-8 h-8 rounded-full flex items-center justify-center text-sol-text-muted hover:text-sol-text transition-colors"
        aria-label="User menu"
      >
        <svg className={`w-5 h-5 ${isLocal ? "text-sol-green" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </button>
      {urlBarOpen && <UrlBarModal onClose={() => setUrlBarOpen(false)} />}
      {open && (
        <div className="absolute right-0 mt-2 w-56 bg-sol-base02 bg-sol-bg border border-sol-base01 border-sol-border rounded-lg shadow-lg py-1 z-50">
          <div className="px-4 py-3 border-b border-sol-base01 border-sol-border">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium text-sol-text">{displayName}</p>
              {isAdmin && (
                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sol-yellow/20 text-sol-yellow">admin</span>
              )}
            </div>
            {user?.email && (
              <p className="text-xs text-sol-base0 truncate">{user.email}</p>
            )}
          </div>
          <button
            onClick={() => { setOpen(false); router.push("/timeline"); }}
            className={menuBtnClass}
          >
            Timeline
          </button>
          <button
            onClick={() => { setOpen(false); router.push("/feed"); }}
            className={menuBtnClass}
          >
            Feed
          </button>
          <button
            onClick={() => { setOpen(false); router.push("/tasks"); }}
            className={menuBtnClass}
          >
            Tasks
          </button>
          <button
            onClick={() => { setOpen(false); router.push("/docs"); }}
            className={menuBtnClass}
          >
            Documents
          </button>
          <div className="border-t border-sol-border my-1" />
          <button
            onClick={() => { setOpen(false); router.push("/settings"); }}
            className={menuBtnClass}
          >
            Settings
          </button>
          {isAdmin && (
            <>
              <div className="border-t border-sol-border my-1" />
              <button onClick={handleEnvSwitch} className={menuBtnClass}>
                <span className="flex items-center justify-between">
                  Switch to {isLocal ? "prod" : "local"}
                  <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${isLocal ? "bg-sol-green/20 text-sol-green" : "bg-sol-red/20 text-sol-red"}`}>
                    {isLocal ? "local" : "prod"}
                  </span>
                </span>
              </button>
              <button
                onClick={() => { setOpen(false); router.push("/admin/daemon-logs"); }}
                className={menuBtnClass}
              >
                Daemon logs
              </button>
              <button
                onClick={() => { setOpen(false); setUrlBarOpen(true); }}
                className={menuBtnClass}
              >
                URL bar
              </button>
            </>
          )}
          <div className="border-t border-sol-border my-1" />
          <button
            onClick={handleLogout}
            className={menuBtnClass}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
