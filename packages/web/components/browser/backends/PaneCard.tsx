"use client";
// One shape for every state a browser pane can be in: nothing listening, a
// site that will not embed, a backend that has not shipped yet. They all say
// the same kind of thing — what happened, at which address, and what you can
// do next — so they all look the same: a quiet centered card on the pane's own
// ground, never a full-bleed error page.

import type { ReactNode } from "react";

export function PaneCard({
  icon,
  headline,
  detail,
  host,
  actions,
}: {
  icon?: ReactNode;
  headline: string;
  /** One sentence. Two is a paragraph, and a paragraph in a pane is noise. */
  detail?: ReactNode;
  /** The address this is about, shown in mono so it reads as a machine fact. */
  host?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="h-full w-full flex items-center justify-center p-6 bg-sol-bg">
      <div className="max-w-[380px] flex flex-col items-center gap-2.5 text-center">
        {icon && <div className="text-sol-text-dim/60">{icon}</div>}
        {host && (
          <div className="text-[11px] font-mono text-sol-text-muted break-all">{host}</div>
        )}
        <div className="text-[13px] text-sol-text">{headline}</div>
        {detail && <div className="text-[11px] leading-relaxed text-sol-text-dim">{detail}</div>}
        {actions && <div className="mt-1.5 flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** The card's own button: quiet until you reach for it, like `.cc-panel__btn`,
 *  but wide enough to carry words. */
export function PaneCardButton({
  onClick,
  children,
  primary,
}: {
  onClick: () => void;
  children: ReactNode;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-2.5 py-1 rounded-[5px] border text-[11px] transition-colors ${
        primary
          ? "border-sol-cyan/40 text-sol-cyan hover:border-sol-cyan hover:bg-sol-cyan/10"
          : "border-sol-border/50 text-sol-text-muted hover:text-sol-text hover:border-sol-border"
      }`}
    >
      {children}
    </button>
  );
}
