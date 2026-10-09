// The pages a web search drew on, as one quiet line under its step: "Sources
// tomsguide.com · eufy.com", each site opening its page in a new tab. A
// person comparing purchases can check the claims; the line comes from the
// search's own result (lib/hostedReceipt searchedSources).
import type { Source } from "@platform/assistant/sources";
import { siteOf } from "../../lib/hostedReceipt";

export function HostedSources({ sources, className = "" }: { sources: Source[]; className?: string }) {
  if (sources.length === 0) return null;
  return (
    <p data-cc-hosted-sources className={`not-prose flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[12.5px] text-sol-text-dim ${className}`}>
      <span>Sources</span>
      {sources.map((source, i) => (
        <span key={source.url} className="inline-flex items-baseline gap-x-1.5">
          {i > 0 && <span aria-hidden>·</span>}
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            title={source.title ?? source.url}
            data-cc-inline-link
            className="text-sol-text-muted underline decoration-sol-border underline-offset-2 hover:text-sol-text"
          >
            {siteOf(source.url)}
          </a>
        </span>
      ))}
    </p>
  );
}
