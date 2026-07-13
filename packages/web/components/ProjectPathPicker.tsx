"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Folder, FolderPlus, X } from "lucide-react";
import { useInboxStore } from "../store/inboxStore";
import { useConvexSync } from "../hooks/useConvexSync";
import {
  buildProjectPathOptions,
  displayPath,
  inferHomeDir,
  inferProjectBase,
  resolveCustomPath,
} from "../lib/utils";

type Option = { path: string; custom?: boolean };

/**
 * Shared "pick a project directory" combobox. Recents come from the same
 * getRecentProjectPaths query + store cache the new-session picker uses, so
 * both stay warm together. Typing filters recents; text that NAMES a directory
 * (absolute, ~/…, or a bare name resolved against where your projects cluster)
 * offers a "use this folder" row so any path stays reachable without typing
 * being the primary interface. A typed-but-unpicked query commits on blur so
 * "type a path, click the submit button" still works.
 */
export function ProjectPathPicker({
  value,
  onChange,
  placeholder = "pick a project…",
  className = "",
}: {
  value: string;
  onChange: (path: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const fresh = useQuery(api.users.getRecentProjectPaths, { limit: 15 });
  const cached = useInboxStore((s) => s.recentProjects);
  const setRecentProjects = useInboxStore((s) => s.setRecentProjects);
  useConvexSync(fresh, setRecentProjects);
  const recents = fresh ?? cached;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hi, setHi] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // A programmatic blur after select/escape fires onBlur while this render's
  // closure still holds the pre-pick query — without the flag, blur would
  // re-commit that stale text right over the chosen path.
  const skipBlurCommit = useRef(false);

  const home = useMemo(
    () => inferHomeDir([value || undefined, ...recents.map((p) => p.path)]),
    [value, recents],
  );
  const base = useMemo(
    () => inferProjectBase(value || undefined, recents.map((p) => p.path), home),
    [value, recents, home],
  );

  const options = useMemo<Option[]>(
    () =>
      buildProjectPathOptions({
        query,
        recentPaths: recents.map((p) => p.path),
        home,
        base,
        currentPath: value || undefined,
      }),
    [query, recents, home, base, value],
  );

  const clampedHi = Math.min(hi, Math.max(0, options.length - 1));

  const select = (path: string) => {
    onChange(path);
    setQuery("");
    setOpen(false);
    skipBlurCommit.current = true;
    inputRef.current?.blur();
  };

  // Preserve typed-but-unpicked intent: resolve what's in the box, else keep it
  // verbatim (the daemon takes the cwd as given). An empty box keeps the value —
  // focusing clears the text for browsing, and that alone must not clear a pick.
  const commitQuery = () => {
    const q = query.trim();
    if (q) onChange(resolveCustomPath(q, home, base) ?? q);
    setQuery("");
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setHi(Math.min(clampedHi + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHi(Math.max(clampedHi - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const pick = options[clampedHi]?.path;
      if (pick) {
        select(pick);
      } else {
        commitQuery();
        skipBlurCommit.current = true;
        inputRef.current?.blur();
      }
    } else if (e.key === "Escape") {
      setQuery("");
      setOpen(false);
      skipBlurCommit.current = true;
      inputRef.current?.blur();
    }
  };

  const shown = open ? query : value ? displayPath(value, home) : "";

  return (
    <div className={`relative ${className}`}>
      <input
        ref={inputRef}
        value={shown}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setHi(0);
          if (!open) setOpen(true);
        }}
        onFocus={() => {
          setQuery("");
          setHi(0);
          setOpen(true);
        }}
        onBlur={() => {
          if (skipBlurCommit.current) {
            skipBlurCommit.current = false;
            return;
          }
          commitQuery();
        }}
        onKeyDown={onKeyDown}
        className="w-full bg-sol-bg-alt border border-sol-border rounded-lg pl-3 pr-8 py-2 text-sm font-mono outline-none focus:border-sol-cyan placeholder:font-sans"
      />
      {value && !open && (
        <button
          type="button"
          aria-label="Clear project"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-sol-text-dim hover:text-sol-text"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
      {open && options.length > 0 && (
        <ul
          // Keep focus in the input so option clicks land before any blur.
          onMouseDown={(e) => e.preventDefault()}
          className="absolute z-30 mt-1 w-full max-h-64 overflow-y-auto bg-sol-bg border border-sol-border rounded-lg shadow-lg py-1"
        >
          {options.map((o, i) => {
            const name = o.path.split("/").filter(Boolean).pop() ?? o.path;
            return (
              <li key={o.path}>
                <button
                  type="button"
                  onClick={() => select(o.path)}
                  onMouseEnter={() => setHi(i)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm ${
                    i === clampedHi ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted"
                  }`}
                >
                  {o.custom ? (
                    <FolderPlus className="w-3.5 h-3.5 shrink-0 text-sol-cyan" />
                  ) : (
                    <Folder className="w-3.5 h-3.5 shrink-0 text-sol-text-dim" />
                  )}
                  {o.custom ? (
                    <span className="font-mono text-xs truncate">{displayPath(o.path, home)}</span>
                  ) : (
                    <>
                      <span className="font-medium truncate">{name}</span>
                      <span className="ml-auto font-mono text-[11px] text-sol-text-dim truncate pl-2">
                        {displayPath(o.path, home)}
                      </span>
                    </>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
