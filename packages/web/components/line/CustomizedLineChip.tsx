"use client";
// The mark on a run of a project's customized line (plan pl-838): the Line
// page's build rows and the Runs list wear the same chip. With an href it is
// a link to the project's stations in line settings; inside a row that is
// already a link it stays a plain mark.
import Link from "next/link";

const STYLE = { color: "var(--sol-magenta)", background: "color-mix(in srgb, var(--sol-magenta) 12%, transparent)" };
const CLASS = "shrink-0 inline-flex items-center px-1.5 rounded text-[10px] leading-[16px]";

export function CustomizedLineChip({ project, href }: { project?: string | null; href?: string }) {
  const title = `Runs ${project ? `${project}'s` : "this project's"} customized line, not the shipped one`;
  if (href) {
    return (
      <Link href={href} onClick={(e) => e.stopPropagation()} className={`${CLASS} hover:underline`} style={STYLE} title={`${title}. Open its stations.`} data-line-customized>
        customized line
      </Link>
    );
  }
  return <span className={CLASS} style={STYLE} title={title} data-line-customized>customized</span>;
}
