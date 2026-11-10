"use client";

// A dev server's address, as something you can look at.
//
// When an agent prints "http://localhost:3000" it is telling you where the
// thing it just built is running. Following that link takes you out of
// codecast; opening it as a pane puts it next to the conversation that made
// it, which is where it belongs. So the link renders as a pill that opens the
// pane, and keeps every ordinary link escape hatch: a modified click, the
// right-click menu, and the address itself in the tooltip.
//
// Deliberately the same chip language as PublishedPagePill — rounded-full on
// neutral chrome, not the rectangular accent shape of entity pills. Both mean
// "a web page", not "an object in codecast".
//
// Honest across machines: the address is served by whichever machine this
// window runs on, and the pill never checks whether anything answers there.
// A probe from the transcript would be a guess with a network cost on every
// render; the pane says the true thing once you open it ("nothing is
// listening on this address on this machine").

import { Globe } from "lucide-react";
import { ContextMenu, useContextMenu } from "./ui/context-menu";
import { browserPaneMenuItems } from "../lib/browserPaneMenuItems";
import { pageAddressLabel } from "../lib/browserPaneLinks";
import { openBrowserPane } from "../lib/stage";

const PILL =
  "group inline-flex max-w-xs items-center gap-1 rounded-full border border-sol-border bg-sol-bg-alt " +
  "py-px pl-1.5 pr-2 align-baseline text-[11px] font-mono leading-[1.4] text-sol-text-secondary no-underline " +
  "transition-colors hover:border-sol-cyan/50 hover:text-sol-text";

export function LoopbackUrlPill({ url, label }: { url: string; label?: string }) {
  const menu = useContextMenu<string>();
  const text = label || pageAddressLabel(url);

  return (
    <>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className={PILL}
        title={`${url}\nOpen as a pane beside this conversation`}
        onContextMenu={(e) => menu.open(e, url, { force: true })}
        onClick={(e) => {
          e.stopPropagation();
          // A modified click is the reader asking for their browser, not for
          // a pane — the same contract every other link in the app keeps.
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          openBrowserPane({ kind: "url", url });
        }}
      >
        <Globe className="h-3 w-3 flex-shrink-0 text-sol-text-dim transition-colors group-hover:text-sol-cyan" />
        <span className="truncate">{text}</span>
      </a>
      <ContextMenu state={menu}>{(target) => browserPaneMenuItems(target)}</ContextMenu>
    </>
  );
}
