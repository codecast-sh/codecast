// A silent keyed source's check, opened from its overview: send one test event
// with the source's key and watch it arrive. The key itself is never shown
// again after it was minted, so the command reads it from the sender's
// environment; a lost key is replaced with Rotate key beside it.
import { useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { CONVEX_URL } from "../../lib/convexUrl";
import { copyText } from "../../lib/copyText";
import { relTimeShort } from "../../lib/utils";
import { arrivedSince, testEventCommand } from "./sourceViewModel";
import type { OpsSource } from "./opsTypes";

export function SourceCheck({ source, lastAt, onClose }: { source: Pick<OpsSource, "name" | "key_prefix">; lastAt: number | null; onClose: () => void }) {
  const [openedAt] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const cmd = testEventCommand(CONVEX_URL);
  const arrived = arrivedSince(lastAt, openedAt);
  return (
    <section className="sov-check" aria-label={`Check ${source.name}`} data-ops-source-check data-arrived={arrived ? "true" : undefined}>
      <div className="sov-check-head">
        <b>Send a test event</b>
        {source.key_prefix && <span className="ops-dim ops-mono">key {source.key_prefix}…</span>}
        <span className="flex-1" />
        <button type="button" className="ops-btn" onClick={() => { void copyText(cmd, "Command copied"); setCopied(true); }}>
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} Copy
        </button>
        <button type="button" className="ops-btn" onClick={onClose}>Close</button>
      </div>
      <pre className="ops-code ops-mono">{cmd}</pre>
      <div className="sov-check-wait" role="status">
        {arrived ? (
          <><Check className="w-3.5 h-3.5" />Arrived {relTimeShort(lastAt!) === "now" ? "just now" : `${relTimeShort(lastAt!)} ago`}</>
        ) : (
          <><Loader2 className="w-3.5 h-3.5 animate-spin" />Waiting for an event</>
        )}
      </div>
    </section>
  );
}
