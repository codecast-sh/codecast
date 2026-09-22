// The share group every code object carries: copy the page, hand it to a
// chat channel, open the same thing on GitHub. One menu, so a pull request,
// a commit, a file and a repository offer the same three verbs in the same
// order.

import type { ComponentType, ReactNode } from "react";
import { ExternalLink, Forward, Link2, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { copyToClipboard, shareOrigin, cn } from "../../lib/utils";
import { openForwardToChat } from "../../lib/forwardToChat";
import { useTeamFeature } from "../../lib/teamFeatures";

export async function copyText(text: string, ok = "Copied") {
  try {
    await copyToClipboard(text);
    toast.success(ok);
  } catch {
    toast.error("Couldn't copy");
  }
}

/** The public address of an in-app path, whatever pane the page is open in. */
export function sharePageUrl(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${shareOrigin()}${path.startsWith("/") ? path : `/${path}`}`;
}

const ITEM = "flex items-center gap-2 cursor-pointer text-[12px] text-sol-text";

export function CodeMenuItem({
  icon: Icon,
  onSelect,
  children,
  tone = "default",
}: {
  icon: ComponentType<{ className?: string }>;
  onSelect: () => void;
  children: ReactNode;
  tone?: "default" | "danger";
}) {
  return (
    <DropdownMenuItem
      className={cn(ITEM, tone === "danger" && "text-sol-red")}
      onSelect={() => onSelect()}
    >
      <Icon className={cn("w-3.5 h-3.5", tone === "danger" ? "" : "text-sol-text-dim")} />
      {children}
    </DropdownMenuItem>
  );
}

export function CodeMenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pt-1.5 pb-0.5 text-[10px] uppercase tracking-wider text-sol-text-dim">
      {children}
    </div>
  );
}

/** Copy link, send to chat, and GitHub. Renders inside an open menu. */
export function CodeShareItems({
  url,
  label,
  previewTitle,
  githubUrl,
}: {
  url: string;
  /** What is being sent, for the channel picker ("pull request", "commit"). */
  label: string;
  previewTitle?: string;
  githubUrl?: string;
}) {
  const chatOn = useTeamFeature("chat");
  return (
    <>
      <CodeMenuLabel>Share</CodeMenuLabel>
      <CodeMenuItem icon={Link2} onSelect={() => { void copyText(url, "Link copied"); }}>
        Copy link
      </CodeMenuItem>
      {chatOn && (
        <CodeMenuItem
          icon={Forward}
          onSelect={() => openForwardToChat({ url, label, previewTitle })}
        >
          Send to chat…
        </CodeMenuItem>
      )}
      {githubUrl && (
        <CodeMenuItem
          icon={ExternalLink}
          onSelect={() => window.open(githubUrl, "_blank", "noopener,noreferrer")}
        >
          Open on GitHub
        </CodeMenuItem>
      )}
    </>
  );
}

/** The same share group behind one button, for a header that has no menu yet. */
export function CodeShareMenu({
  url,
  label,
  previewTitle,
  githubUrl,
  children,
}: {
  url: string;
  label: string;
  previewTitle?: string;
  githubUrl?: string;
  /** More items, below a separator. */
  children?: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-md border border-sol-border/60 w-7 h-7 text-sol-text-muted hover:text-sol-text hover:border-sol-border transition-colors"
          aria-label="More actions"
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56 bg-sol-bg border-sol-border">
        <CodeShareItems url={url} label={label} previewTitle={previewTitle} githubUrl={githubUrl} />
        {children && (
          <>
            <DropdownMenuSeparator className="bg-sol-border" />
            {children}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
