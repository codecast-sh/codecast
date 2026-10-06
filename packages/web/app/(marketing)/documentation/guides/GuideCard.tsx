"use client";

import Link from "next/link";
import { SOL } from "../../blog/blogChrome";
import { formatGuideDate, guideHref, type Guide } from "./guides";

/** A guide's card on the docs index and under every guide: title, date, dek. */
export function GuideCard({ guide }: { guide: Guide }) {
  return (
    <Link
      href={guideHref(guide.slug)}
      className="rounded-lg p-4 block transition-colors hover:shadow-sm"
      style={{ backgroundColor: `${SOL.base2}55`, border: `1px solid ${SOL.base2}` }}
    >
      <div className="font-mono text-sm font-semibold mb-1" style={{ color: SOL.base03 }}>{guide.title}</div>
      <div className="text-[13px] leading-relaxed" style={{ color: SOL.base00 }}>{guide.dek}</div>
      <time dateTime={guide.published} className="block mt-2 font-mono text-[11px]" style={{ color: SOL.base1 }}>
        {formatGuideDate(guide.published)}
      </time>
    </Link>
  );
}
