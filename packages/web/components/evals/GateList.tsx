// A rep's gates: the hard checks a reply must clear before any judged check
// counts. Failing gates come first. Each row has its own address
// (`#gate-<id>`), so a link from a list, a flip or a chat lands on it.

import { Link2 } from "lucide-react";
import type { GateResultJson } from "@codecast/shared/contracts/evalsApi";
import { VerdictGlyph } from "./parts";
import { gateAnchor, orderGates, gateEvidenceWords } from "@platform/evals/client";

/** A row's link to itself: a plain click moves the address in place (the page lands on it), a modified click is the browser's. */
export function AnchorLink({ anchor, href, onAnchor, label }: { anchor: string; href: string; onAnchor: (anchor: string) => void; label: string }) {
  return (
    <a
      className="ev-row-anchor"
      href={href}
      aria-label={label}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onAnchor(anchor);
      }}
    >
      <Link2 /> link
    </a>
  );
}

export function GateList({ gates, target, anchorHref, onAnchor }: { gates: readonly GateResultJson[]; target: string | null; anchorHref: (anchor: string) => string; onAnchor: (anchor: string) => void }) {
  if (!gates.length) return <div className="ev-rows"><div className="ev-empty-note">This surface declares no gates.</div></div>;
  return (
    <div className="ev-rows" data-ev-gates>
      {orderGates(gates).map((g) => {
        const anchor = gateAnchor(g.id);
        return (
          <div key={g.id} id={anchor} className={`ev-row${g.pass ? "" : " ev-row--gate-fail"}`} data-ev-gate={g.id} data-ev-gate-pass={g.pass} data-ev-target={target === anchor}>
            <div className="ev-row-line">
              {g.pass ? (
                <VerdictGlyph state={g.evidence.vacuous ? "dry" : "pass"} title={g.evidence.vacuous ? "held, nothing to check" : "held"} />
              ) : (
                <span className="ev-gate-x">
                  <VerdictGlyph state="crash" title="gate failed" />
                </span>
              )}
              <span className="ev-row-id">{g.id}</span>
              {g.title && <span className="ev-row-title">{g.title}</span>}
              {g.decidedBy && <span className="ev-chip ev-decided" title={g.decidedBy === "judge" ? "The judge decided this gate" : "Decided by code, no model involved"}>{g.decidedBy}</span>}
              <AnchorLink anchor={anchor} href={anchorHref(anchor)} onAnchor={onAnchor} label={`Link to gate ${g.id}`} />
            </div>
            <div className="ev-row-body">
              {gateEvidenceWords(g)}
              {!!g.evidence.excerpts?.length && g.evidence.scanned !== undefined && (
                <div className="ev-excerpt-count ev-tabular">
                  {g.evidence.excerpts.length} of {g.evidence.scanned} scanned
                </div>
              )}
              {g.evidence.excerpts?.map((x, i) => (
                <div key={i} className="ev-excerpt">
                  <span className="ev-excerpt-where">{x.where}</span>
                  <span className="ev-excerpt-text">{x.text}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
