"use client";
// One published-artifact card in the /artifacts gallery. Pure presentation —
// the row shape is whatever api.artifacts.listForWeb returns (see
// packages/convex/convex/artifacts.ts toCliRow + listForWeb extras).

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import {
  Copy,
  ExternalLink,
  Eye,
  Lock,
  Mail,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Settings2,
  Timer,
  Trash2,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ContextMenu, useContextMenu, CtxItem, CtxHeader, CtxSeparator } from "../ui/context-menu";
import { EntityIdPill } from "../EntityIdPill";
import { CONVEX_URL } from "../../lib/localAuth";
import { relativeTime, withEditParam } from "./artifactCardUtils";

export type ArtifactRow = {
  slug: string;
  title: string;
  source_path?: string;
  size: number;
  version: number;
  kind: string;
  session_short_id: string | null;
  created_at: number;
  updated_at: number;
  url: string;
  manage_url: string | null;
  edit_url: string | null;
  mine: boolean;
  author: { name: string | null; image: string | null } | null;
  can_team_edit: boolean;
  has_password?: boolean;
  email_gate?: boolean;
  expires_at?: number | null;
  edit_mode?: string;
  has_thumb: boolean;
  views: number;
  last_viewed_at: number | null;
  comments_open: number;
};

const KIND_GLYPH: Record<string, { glyph: string; cls: string; label: string }> = {
  html: { glyph: "</>", cls: "text-sol-cyan bg-sol-cyan/10", label: "html" },
  markdown: { glyph: "¶", cls: "text-sol-violet bg-sol-violet/10", label: "markdown" },
  bundle: { glyph: "▤", cls: "text-sol-orange bg-sol-orange/10", label: "bundle" },
};

function GateBadges({ a }: { a: ArtifactRow }) {
  const badges: Array<{ icon: React.ReactNode; title: string }> = [];
  if (a.has_password) badges.push({ icon: <Lock className="w-3 h-3" />, title: "Password protected" });
  if (a.email_gate) badges.push({ icon: <Mail className="w-3 h-3" />, title: "Email gate" });
  if (a.expires_at)
    badges.push({
      icon: <Timer className="w-3 h-3" />,
      title:
        a.expires_at < Date.now()
          ? "Expired"
          : `Expires ${new Date(a.expires_at).toLocaleString()}`,
    });
  if (badges.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-sol-yellow">
      {badges.map((b, i) => (
        <span key={i} title={b.title} className="inline-flex">
          {b.icon}
        </span>
      ))}
    </span>
  );
}

export function ArtifactCard({
  artifact: a,
  onTeamEdit,
}: {
  artifact: ArtifactRow;
  onTeamEdit?: (a: ArtifactRow) => void;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const deleteArtifact = useMutation(api.artifacts.deleteForWeb);
  const kind = KIND_GLYPH[a.kind] ?? KIND_GLYPH.html;
  // The thumb endpoint refuses gated artifacts (no visual leak in unfurls), so
  // don't even try when a gate is on.
  const gated = !!a.has_password || !!a.email_gate;
  const showThumb = a.has_thumb && !gated && !thumbFailed;
  const thumbUrl = `${CONVEX_URL}/cli/a/${a.slug}?thumb=1&r=v${a.version}`;
  const age = relativeTime(a.updated_at);
  const expired = !!a.expires_at && a.expires_at < Date.now();

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(a.url);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy link");
    }
  };

  const deleteWithConfirm = async () => {
    if (!window.confirm(`Delete "${a.title}" and its whole version history? The link stops working immediately.`)) return;
    const r = await deleteArtifact({ slug: a.slug });
    if (r && "error" in r && r.error) toast.error(r.error);
    else toast.success("Page deleted");
  };

  const ctxMenu = useContextMenu();

  // ONE item list serves both the hover kebab and the right-click cursor menu,
  // so the two surfaces can never drift.
  const menuItems = (
    <>
      <CtxItem icon={ExternalLink} onSelect={() => window.open(a.url, "_blank", "noopener")}>
        Open
      </CtxItem>
      <CtxItem icon={Copy} onSelect={copyLink}>Copy link</CtxItem>
      {a.manage_url && (
        <>
          <CtxSeparator />
          {/* Manage opens the artifact's own owner sheet (#o= key stays in
              the fragment); rollback, gates, viewers and stats all live
              there. */}
          <CtxItem icon={Settings2} onSelect={() => window.open(a.manage_url!, "_blank", "noopener")}>
            Manage
          </CtxItem>
          <CtxItem
            icon={Pencil}
            onSelect={() => window.open(a.edit_url ?? withEditParam(a.manage_url!), "_blank", "noopener")}
          >
            Edit
          </CtxItem>
          <CtxSeparator />
          <CtxItem danger icon={Trash2} onSelect={deleteWithConfirm}>
            Delete
          </CtxItem>
        </>
      )}
      {a.can_team_edit && onTeamEdit && (
        <>
          <CtxSeparator />
          {/* Teammate editing goes through authed convex actions — no
              owner keys ever reach a teammate. */}
          <CtxItem icon={Pencil} onSelect={() => onTeamEdit(a)}>Edit (team)</CtxItem>
        </>
      )}
    </>
  );

  return (
    <div
      className="group relative flex flex-col rounded-lg border border-sol-border/40 bg-sol-bg-alt/40 overflow-hidden transition-colors hover:border-sol-border hover:bg-sol-bg-alt/70"
      onContextMenu={(e) => ctxMenu.open(e, undefined)}
    >
      {/* Thumbnail / kind glyph */}
      <a
        href={a.url}
        target="_blank"
        rel="noreferrer"
        className={`block aspect-[1.91/1] w-full overflow-hidden border-b border-sol-border/30 ${expired ? "opacity-50" : ""}`}
        title={`Open ${a.url}`}
      >
        {showThumb ? (
          <img
            src={thumbUrl}
            alt={a.title}
            loading="lazy"
            onError={() => setThumbFailed(true)}
            className="w-full h-full object-cover object-top"
          />
        ) : (
          <div className={`w-full h-full flex items-center justify-center ${kind.cls}`}>
            <span className="font-mono text-3xl opacity-70 select-none">{kind.glyph}</span>
          </div>
        )}
      </a>

      {/* Hover actions */}
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="p-1.5 rounded bg-sol-bg/90 border border-sol-border/60 text-sol-text-muted hover:text-sol-text shadow-sm"
              aria-label="Page actions"
            >
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[190px]">
            {menuItems}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Cursor-anchored twin of the kebab — same items, same handlers. */}
      <ContextMenu state={ctxMenu}>
        {() => (
          <>
            <CtxHeader title={a.title || a.slug} />
            {menuItems}
          </>
        )}
      </ContextMenu>

      {/* Body */}
      <div className="flex flex-col gap-1.5 p-3">
        <a
          href={a.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-sol-text truncate hover:text-sol-cyan transition-colors"
          title={a.title}
        >
          {a.title || a.slug}
        </a>

        <div className="flex items-center gap-2 text-[11px] text-sol-text-muted font-mono">
          <span className="px-1 py-px rounded bg-sol-bg-highlight border border-sol-border/40 text-sol-text-muted">
            v{a.version}
          </span>
          <span>{kind.label}</span>
          {age && (
            <>
              <span className="text-sol-text-dim">&middot;</span>
              <span title={new Date(a.updated_at).toLocaleString()}>{age}</span>
            </>
          )}
          {expired && <span className="text-sol-red">expired</span>}
        </div>

        <div className="flex items-center gap-3 text-[11px] text-sol-text-dim">
          <span className="inline-flex items-center gap-1" title={`${a.views} views`}>
            <Eye className="w-3 h-3" /> {a.views}
          </span>
          {a.comments_open > 0 && (
            <span
              className="inline-flex items-center gap-1 text-sol-orange"
              title={`${a.comments_open} open comment${a.comments_open === 1 ? "" : "s"}`}
            >
              <MessageSquare className="w-3 h-3" /> {a.comments_open}
            </span>
          )}
          <GateBadges a={a} />
        </div>

        {(a.session_short_id || a.author) && (
          <div className="flex items-center gap-2 min-w-0 max-w-full overflow-hidden whitespace-nowrap">
            {a.author && (
              <span className="inline-flex items-center gap-1.5 text-[11px] text-sol-text-muted min-w-0">
                {a.author.image ? (
                  <img src={a.author.image} alt="" className="w-3.5 h-3.5 rounded-full" />
                ) : null}
                <span className="truncate">{a.author.name ?? "teammate"}</span>
              </span>
            )}
            {a.session_short_id && <EntityIdPill shortId={a.session_short_id} type="session" />}
          </div>
        )}
      </div>
    </div>
  );
}
