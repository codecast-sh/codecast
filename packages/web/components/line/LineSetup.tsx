"use client";
// The start of a line that has nothing on it yet: what the line does, and the
// one step that starts it. A project's Line tab shows it for that project;
// /line in a workspace with no line shows it over the workspace's projects,
// each with its own step.
import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

const WHAT_IT_DOES = "The line listens to a project's sources, like its error tracker and its evals, and groups what they report into problems. For each one it proves the problem, builds and checks a fix, and brings it to you to ship, revise or drop. After a ship it watches for the problem to come back.";

/** `title` names the project ("Set up the line for <title>"); `children`
 *  replaces the single action, for a list of projects to start from. */
export function LineSetup({ title, heading, profiled = false, href, children }: { title?: string; heading?: string; profiled?: boolean; href?: string; children?: ReactNode }) {
  return (
    <section className="rounded-xl border border-sol-border/40 bg-sol-bg-alt/40 px-5 py-4 max-w-[46rem]" data-line-setup>
      <h2 className="text-[15px] font-semibold text-sol-text">{heading ?? (profiled ? "Nothing on the line yet" : `Set up the line for ${title}`)}</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-sol-text-muted">
        {profiled
          ? "The line is set up and no source has filed anything. When one does, its problem shows here with every step the line takes on it."
          : WHAT_IT_DOES}
      </p>
      {children ?? (href && (
        <Link href={href} className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-sol-cyan/50 text-[12.5px] font-medium text-sol-cyan hover:bg-sol-cyan/10 transition-colors" data-line-setup-action>
          {profiled ? "Open line settings" : "Set up the line"}
          <ArrowRight className="w-3.5 h-3.5" />
        </Link>
      ))}
    </section>
  );
}
