"use client";
// The start of a line that has nothing on it yet: what the line does, and the
// one step that starts it. A project's Line tab shows it for that project;
// /line in a workspace with no line shows it over the workspace's projects,
// each with its own step.
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { modernButton } from "../ui/modernLook";

const WHAT_IT_DOES = "Sources report problems; the flow proves each, builds a fix, and asks you to ship";

/** `title` names the project ("Set up a flow for <title>"); `children`
 *  replaces the single action, for a list of projects to start from. */
export function LineSetup({ title, heading, profiled = false, href, children }: { title?: string; heading?: string; profiled?: boolean; href?: string; children?: ReactNode }) {
  return (
    <section className="rounded-xl border border-sol-border/40 bg-sol-bg-alt/40 px-5 py-4 max-w-[46rem]" data-line-setup>
      <h2 className="text-[15px] font-semibold text-sol-text">{heading ?? (profiled ? "Nothing in this flow yet" : `Set up a flow for ${title}`)}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-sol-text-muted">
        {profiled
          ? "No source has filed a problem yet"
          : WHAT_IT_DOES}
      </p>
      {children ?? (href && (
        <Link href={href} className={`mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-sol-cyan/50 text-[12.5px] font-medium text-sol-cyan hover:bg-sol-cyan/10 transition-colors ${modernButton({ variant: "primary", size: "md" })}`} data-line-setup-action>
          {profiled ? "Open flow settings" : "Set up a flow"}
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      ))}
    </section>
  );
}
