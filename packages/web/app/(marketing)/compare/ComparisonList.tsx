import Link from "next/link";
import { SOL } from "../blog/blogChrome";
import { COMPARISONS, compareHref } from "./comparisons";

/**
 * Every comparison as a linked title plus its one sentence dek. The compare
 * index renders it, and so does any page that should hand a reader (and a
 * crawler) a described link to each comparison page.
 */
export function ComparisonList() {
  return (
    <ul className="space-y-6">
      {COMPARISONS.map((c) => (
        <li key={c.slug} className="rounded-lg p-6" style={{ border: `1px solid ${SOL.base2}` }}>
          <Link href={compareHref(c.slug)}>
            <h3 className="font-mono text-xl font-bold mb-2 hover:underline" style={{ color: SOL.base03 }}>
              {c.title}
            </h3>
          </Link>
          <p className="text-sm leading-relaxed" style={{ color: SOL.base01 }}>{c.dek}</p>
        </li>
      ))}
    </ul>
  );
}
