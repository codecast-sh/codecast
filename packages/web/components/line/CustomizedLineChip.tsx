"use client";
// The mark on a run of a project's customized line (plan pl-838): the Line
// page's build rows, the task strip and the Runs list wear the same chip, and
// line settings uses the same chip for its own marks (LineChip). With an
// href it is a link to the project's stations in line settings; inside a row
// that is already a link it stays a plain mark.
import Link from "next/link";
import type { ReactNode } from "react";

const CLASS = "shrink-0 inline-flex items-center px-1.5 rounded text-[10px] leading-[16px]";
const toneStyle = (tone: "magenta" | "muted") => {
  const color = tone === "magenta" ? "var(--sol-magenta)" : "var(--sol-text-muted)";
  return { color, background: `color-mix(in srgb, ${color} 12%, transparent)` };
};

/** A small mark: magenta for what belongs to a customized line, muted for a plain fact. */
export function LineChip({ children, tone = "muted", ...rest }: { children: ReactNode; tone?: "magenta" | "muted" } & Partial<Record<`data-${string}` | "title", string>>) {
  return <span className={CLASS} style={toneStyle(tone)} {...rest}>{children}</span>;
}

export function CustomizedLineChip({ project, href }: { project?: string | null; href?: string }) {
  const title = `Runs ${project ? `${project}'s` : "this project's"} customized line, not the shipped one`;
  if (href) {
    return (
      <Link href={href} onClick={(e) => e.stopPropagation()} className={`${CLASS} hover:underline`} style={toneStyle("magenta")} title={`${title}. Open its stations.`} data-line-customized>
        customized
      </Link>
    );
  }
  return <LineChip tone="magenta" title={title} data-line-customized="">customized</LineChip>;
}
